import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from urllib.parse import quote

import httpx

from common import ApiError, PASSWORD_RULE, clean, find, identifier, phone_number, required, student_number, timestamp

logger = logging.getLogger("uvicorn.error")


def valid_plm_email(email):
    return re.fullmatch(r"[^\s@]+@plm\.edu\.ph", email, re.I) is not None


def is_external(user):
    return user["accountType"] == "External User" or not valid_plm_email(user["email"])


def email_from(data, error="Enter a valid email address."):
    email = required(data.get("email"), "Email", 254).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ApiError(400, error)
    return email


def new_password(data, key, label):
    password = required(data.get(key), label, 200)
    if not re.fullmatch(r"(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}", password):
        raise ApiError(400, PASSWORD_RULE)
    return password


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    password_bytes = password.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode()
    derived = hashlib.scrypt(password_bytes, salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
    return f"{salt}:{derived.hex()}"


def password_matches(password, stored):
    return bool(stored and ":" in stored and hmac.compare_digest(password_hash(password, stored.split(":", 1)[0]), stored))


def public_user(user):
    result = {key: value for key, value in user.items() if key not in ("passwordHash", "readDeskActivity")}
    for key in ("accountType", "role"):
        if result.get(key) in ("PLM", "PLM Student"):
            result[key] = "PLM Resident"
    if result.get("studentNumber"):
        try:
            result["studentNumber"] = student_number(result["studentNumber"])
        except ApiError:
            pass
    return result


class Auth:
    def __init__(self, store, client):
        self.store = store
        self.users = store.data["users"]
        self.client = client
        self.sessions = {}
        self.challenges = {}
        self.preverified = {}
        self.reset_verified = {}
        self.pending_phones = {}
        self.graph_token = None
        self.graph_expires = 0
        self.production = os.getenv("NODE_ENV") == "production"
        self.supabase_url = (
            os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
            or "https://sqicephynnalidwgbxof.supabase.co"
        ).rstrip("/")
        self.public_key = os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY") or os.getenv("VITE_SUPABASE_ANON_KEY")
        self.service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    def session(self, token):
        return self.sessions.get(token, {})

    def require_user(self, token):
        user = find(self.users, id=self.session(token).get("userId"))
        if user is None:
            raise ApiError(401, "Sign in to continue.")
        return user

    def make_session(self, user, auth_id=None):
        token = secrets.token_hex(32)
        self.sessions[token] = {"userId": user["id"], "authId": auth_id}
        return {"token": token, "user": public_user(user)}

    def revoke_sessions(self, user_id, except_token=None):
        for token, session in list(self.sessions.items()):
            if session["userId"] == user_id and token != except_token:
                del self.sessions[token]

    def profile(self, auth_id):
        if not self.service_key:
            # Sign-in verification only needs the public Supabase key. Without
            # the server-only key, treat the optional profile row as absent;
            # admin checks will safely resolve to False.
            return {}
        response = self.client.get(
            f"{self.supabase_url}/rest/v1/profiles",
            params={"select": "full_name,is_admin", "id": f"eq.{auth_id}", "limit": 1},
            headers={"apikey": self.service_key, "Authorization": f"Bearer {self.service_key}"},
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not response.is_success:
            details = payload if isinstance(payload, dict) else {}
            raise ApiError(502, details.get("message") or details.get("error") or "Supabase request failed.")
        if not isinstance(payload, list):
            raise ApiError(502, "Supabase returned an invalid profile response.")
        return payload[0] if payload else {}

    def is_admin(self, token):
        auth_id = self.session(token).get("authId")
        return bool(auth_id and self.profile(auth_id).get("is_admin") is True)

    def unique_detail(self, field, value, owner=None):
        normalize = phone_number if field == "phone" else student_number
        canonical = normalize(value)
        for existing in self.users:
            if existing is owner or not existing.get(field):
                continue
            try:
                other = normalize(existing[field])
            except ApiError:
                continue
            if canonical.lstrip("+") == other.lstrip("+"):
                label = "contact number" if field == "phone" else "student number"
                raise ApiError(409, f"That {label} is already in use.")
        return canonical

    def start_phone_change(self, user, token, data):
        phone = self.unique_detail("phone", data.get("phone"), user)
        current = self.pending_phones.get(user["id"])
        if current and current["sent"] + 60 > time.monotonic():
            raise ApiError(429, "Wait 60 seconds before requesting another code.")
        graph_ready = all(os.getenv(f"MS_GRAPH_{key}") for key in ("TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "SENDER"))
        supabase_id = self.session(token).get("authId")
        use_supabase = not graph_ready and bool(supabase_id and self.public_key)
        if use_supabase:
            response = self.client.post(f"{self.supabase_url}/auth/v1/otp", headers={"apikey": self.public_key},
                                        json={"email": user["email"], "create_user": False})
            if not response.is_success:
                raise ApiError(response.status_code if response.status_code == 429 else 502, "Could not send the email code. Try again shortly.")
            delivery = {}
        else:
            delivery = self.deliver_code(user["email"], "phone-change")
        self.pending_phones[user["id"]] = {
            "phone": phone, "token": token, "sent": time.monotonic(), "attempts": 0,
            "supabaseId": supabase_id if use_supabase else None,
        }
        return 200, {"message": "A code was sent to your account email.", **delivery}

    def finish_phone_change(self, user, token, data):
        current = self.pending_phones.get(user["id"])
        if not current or current["token"] != token:
            raise ApiError(400, "Request a contact change code first.")
        phone = self.unique_detail("phone", current["phone"], user)
        code = clean(data.get("code"), 12)
        if current["supabaseId"]:
            if current["sent"] + 900 < time.monotonic() or current["attempts"] >= 5:
                del self.pending_phones[user["id"]]
                raise ApiError(400, "That code is expired. Request a new one.")
            current["attempts"] += 1
            response = self.client.post(f"{self.supabase_url}/auth/v1/verify", headers={"apikey": self.public_key},
                                        json={"email": user["email"], "token": code, "type": "email"})
            if not response.is_success or (response.json().get("user") or {}).get("id") != current["supabaseId"]:
                raise ApiError(400, "The verification code is incorrect or expired.")
        else:
            self.verify_code(user["email"], "phone-change", code)
        user["phone"] = phone
        self.store.save()
        del self.pending_phones[user["id"]]
        return 200, {"user": public_user(user)}

    def verified_identity(self, data):
        if not self.public_key:
            raise ApiError(503, "Supabase sign-in is not configured on the backend.")
        access_token = required(data.get("accessToken"), "Supabase access token", 16_000)
        response = self.client.get(
            f"{self.supabase_url}/auth/v1/user",
            headers={"apikey": self.public_key, "Authorization": f"Bearer {access_token}"},
        )
        if response.status_code in (401, 403):
            raise ApiError(401, "Supabase could not verify this sign-in.")
        if not response.is_success:
            raise ApiError(502, "Supabase Auth could not verify the session.")
        identity = response.json()
        email = (identity.get("email") or "").lower()
        auth_id = identity.get("id")
        if not auth_id or not email or not identity.get("email_confirmed_at"):
            raise ApiError(403, "Confirm your Supabase email before signing in.")
        return identity, email, auth_id

    def check_registration(self, data):
        _, email, auth_id = self.verified_identity(data)
        owner = find(self.users, supabaseAuthId=auth_id) or find(self.users, email=email)
        if owner and owner.get("supabaseAuthId"):
            raise ApiError(409, "This account is already registered.")
        phone = self.unique_detail("phone", data.get("phone"), owner)
        number = ""
        if data.get("accountType") != "External User" and valid_plm_email(email):
            if data.get("role") == "staff":
                number = required(data.get("idNumber"), "Staff ID", 40)
            else:
                number = self.unique_detail("studentNumber", data.get("idNumber"), owner)
        return 200, {"phone": phone, "idNumber": number}

    def exchange_session(self, data):
        identity, email, auth_id = self.verified_identity(data)
        profile = self.profile(auth_id)
        user = find(self.users, supabaseAuthId=auth_id)
        if user is None:
            user = find(self.users, email=email)
            metadata = identity.get("user_metadata") or {}
            if user and user.get("supabaseAuthId") and user["supabaseAuthId"] != auth_id:
                raise ApiError(409, "This email is assigned to a different Supabase account. Delete that Auth user and try again.")
            is_new = user is None
            if is_new:
                name = clean(profile.get("full_name"), 100) or clean(metadata.get("full_name"), 100) or email.split("@")[0]
                account_type = "PLM Resident" if valid_plm_email(email) else "External User"
                user = {
                    "id": identifier("u_"), "name": name, "email": email, "accountType": account_type,
                    "role": account_type, "emailVerified": True, "createdAt": timestamp(),
                }
            details = {}
            for key, source in (("phone", "phone"), ("studentNumber", "student_number")):
                if not user.get(key) and metadata.get(source):
                    if key == "studentNumber" and (not valid_plm_email(email) or metadata.get("account_type") in ("External User", "PLM Staff")):
                        continue
                    details[key] = self.unique_detail(key, metadata[source], user)
            if metadata.get("staff_id") and valid_plm_email(email):
                details["staffId"] = clean(metadata["staff_id"], 40)
            if metadata.get("full_name"):
                details["name"] = clean(metadata["full_name"], 100)
            user.update(details)
            if not valid_plm_email(email) or metadata.get("account_type") == "External User":
                user["accountType"] = "External User"
            elif user["accountType"] != "External User" and metadata.get("account_type") in ("PLM Resident", "PLM Staff"):
                user["accountType"] = metadata["account_type"]
            user["supabaseAuthId"] = auth_id
            if is_new:
                self.users.append(user)
            self.store.save()
        session = self.make_session(user, auth_id)
        session["user"]["role"] = "Admin" if profile.get("is_admin") is True else user["accountType"]
        return 200, session

    def deliver_code(self, email, purpose):
        code = f"{secrets.randbelow(1_000_000):06}"
        tenant, client_id, secret, sender = (os.getenv(f"MS_GRAPH_{key}") for key in (
            "TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", "SENDER",
        ))
        demo = {}
        if all((tenant, client_id, secret, sender)):
            self.send_graph_mail(tenant, client_id, secret, sender, email, purpose, code)
        elif self.production:
            raise ApiError(503, "Email delivery is not configured. Contact the ReClaim administrator.")
        else:
            logger.info("[ReClaim demo] %s code for %s: %s", purpose, email, code)
            if not client_id:
                demo["demoCode"] = code
        self.challenges[purpose, email] = {"code": code, "expires": time.monotonic() + 900, "attempts": 0}
        return demo

    def send_graph_mail(self, tenant, client_id, secret, sender, email, purpose, code):
        if not self.graph_token or self.graph_expires < time.monotonic() + 60:
            response = self.client.post(
                f"https://login.microsoftonline.com/{quote(tenant, safe='')}/oauth2/v2.0/token",
                data={
                    "client_id": client_id, "client_secret": secret,
                    "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials",
                },
            )
            if not response.is_success:
                raise ApiError(502, "Microsoft email service could not authorize ReClaim.")
            payload = response.json()
            self.graph_token = payload["access_token"]
            self.graph_expires = time.monotonic() + int(payload.get("expires_in") or 3600)
        if purpose == "reset":
            subject = "ReClaim password reset code"
            message = f"Your ReClaim password reset code is {code}. It expires in 15 minutes. If you did not request this, ignore this email."
        elif purpose == "phone-change":
            subject = "Confirm your ReClaim contact number change"
            message = f"Your ReClaim contact number change code is {code}. It expires in 15 minutes. If you did not request this, ignore this email."
        else:
            subject = "Verify your email for ReClaim"
            message = f"Your ReClaim verification code is {code}. It expires in 15 minutes. Enter it in ReClaim to continue creating your account."
        response = self.client.post(
            f"https://graph.microsoft.com/v1.0/users/{quote(sender, safe='')}/sendMail",
            headers={"Authorization": f"Bearer {self.graph_token}"},
            json={
                "message": {
                    "subject": subject, "body": {"contentType": "Text", "content": message},
                    "toRecipients": [{"emailAddress": {"address": email}}],
                },
                "saveToSentItems": True,
            },
        )
        if not response.is_success:
            raise ApiError(502, "Could not deliver the verification email.")

    def verify_code(self, email, purpose, code):
        key = (purpose, email)
        challenge = self.challenges.get(key)
        if not challenge or challenge["expires"] < time.monotonic() or challenge["attempts"] >= 5:
            self.challenges.pop(key, None)
            raise ApiError(400, "That code is expired. Request a new one.")
        challenge["attempts"] += 1
        if challenge["code"] != clean(code, 6):
            raise ApiError(400, "The verification code is incorrect.")
        del self.challenges[key]

    def registration(self, action, data):
        if action == "register":
            required(data.get("email"), "Email", 254)
            required(data.get("password"), "Password", 200)
        email = email_from(data)
        external = data.get("accountType") == "External User"
        if action != "verify-registration-email" and not external and not valid_plm_email(email):
            raise ApiError(400, "Use your official @plm.edu.ph email address for a PLM account.")
        if action == "register":
            password = new_password(data, "password", "Password")
        if find(self.users, email=email):
            raise ApiError(409, "An account with this email already exists.")
        if action == "start-registration":
            return 200, {"message": "A verification code was sent to your email inbox.", **self.deliver_code(email, "verify")}
        if action == "verify-registration-email":
            self.verify_code(email, "verify", data.get("code"))
            self.preverified[email] = time.monotonic() + 1800
            return 200, {"verified": True}
        if self.preverified.get(email, 0) < time.monotonic():
            raise ApiError(403, "Verify your email before submitting your details.")
        account_type = "External User" if external else ("PLM Staff" if data.get("role") == "staff" else "PLM Resident")
        user = {
            "id": identifier("u_"), "name": required(data.get("name"), "Full name", 100),
            "email": email, "accountType": account_type, "role": account_type,
            "phone": self.unique_detail("phone", data.get("phone")), "passwordHash": password_hash(password),
            "emailVerified": True, "createdAt": timestamp(),
        }
        if external:
            user["school"] = clean(data.get("school"), 120)
        elif account_type == "PLM Staff":
            user["staffId"] = required(data.get("idNumber"), "Staff ID", 40)
        else:
            user["studentNumber"] = self.unique_detail("studentNumber", data.get("idNumber"))
        self.users.append(user)
        self.store.save()
        del self.preverified[email]
        return 201, {"message": "Account created. You can now sign in."}

    def legacy_verification(self, action, data):
        email = required(data.get("email"), "Email", 254).lower()
        if not valid_plm_email(email):
            raise ApiError(400, "Use your official @plm.edu.ph email address.")
        user = find(self.users, email=email)
        if action == "verify":
            if user is None:
                raise ApiError(404, "Account not found.")
            self.verify_code(email, "verify", data.get("code"))
            user["emailVerified"] = True
            self.store.save()
            return 200, self.make_session(user)
        if user is None:
            return 200, {"message": "If the account exists, a new code was generated."}
        if user.get("emailVerified"):
            raise ApiError(409, "This email is already verified.")
        return 200, {"message": "A new verification code was sent.", **self.deliver_code(email, "verify")}

    def login(self, data):
        email = email_from(data, "Enter the email address you used to register.")
        user = find(self.users, email=email)
        if not user or not password_matches(str(data.get("password") or ""), user.get("passwordHash")):
            raise ApiError(401, "Email or password is incorrect.")
        if not user.get("emailVerified"):
            raise ApiError(403, "Verify your email before signing in.", "EMAIL_NOT_VERIFIED")
        return 200, self.make_session(user)

    def reset(self, action, data):
        email = email_from(data)
        user = find(self.users, email=email)
        if action == "forgot-password":
            if user is None:
                return 200, {"message": "If the account exists, a reset code was generated."}
            return 200, {"message": "A reset code was sent to your account email.", **self.deliver_code(email, "reset")}
        if action == "verify-password-reset":
            if user is None:
                raise ApiError(404, "If the account exists, a reset code was sent.")
            self.verify_code(email, "reset", data.get("code"))
            self.reset_verified[email] = time.monotonic() + 900
            return 200, {"verified": True}
        password = new_password(data, "password", "New password")
        if user is None:
            raise ApiError(404, "Account not found.")
        if self.reset_verified.get(email, 0) < time.monotonic():
            raise ApiError(403, "Verify the reset code before choosing a new password.")
        user["passwordHash"] = password_hash(password)
        self.store.save()
        del self.reset_verified[email]
        self.revoke_sessions(user["id"])
        return 200, {"message": "Password updated."}

    def change_password(self, user, token, data):
        current = data.get("currentPassword") or ""
        if not password_matches(str(current), user.get("passwordHash")):
            raise ApiError(403, "Current password is incorrect.")
        password = new_password(data, "newPassword", "New password")
        if password == current:
            raise ApiError(400, "Choose a password you have not used before.")
        user["passwordHash"] = password_hash(password)
        self.store.save()
        self.revoke_sessions(user["id"], except_token=token)
        return 200, {"message": "Password updated."}
