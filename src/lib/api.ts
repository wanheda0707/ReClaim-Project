import { getSupabaseClient, supabase } from "./supabase"

const TOKEN_KEY = "reclaim.session"
const REMEMBER_KEY = "reclaim.remember"
const API_BASE = import.meta.env.VITE_API_BASE || ""

export type ApiUser = {
  id: string
  name: string
  initials?: string
  accountType: "PLM Resident" | "PLM Student" | "PLM Staff" | "External User"
  email: string
  studentNumber?: string
  staffId?: string
  yearLevel?: string
  course?: string
  college?: string
  school?: string
  phone?: string
  photo?: string
  role: string
}

export type ApiItem = {
  id: number
  name: string
  category: string
  status: "Lost" | "Found" | "Pending Claim" | "Claimed" | "Returned"
  date: string
  location: string
  description: string
  image: string
  reporter: string
  reporterRole: string
  question?: string
  answer?: string
  mine?: boolean
  ownerId?: string
  rewardType?: "none" | "money" | "other"
  rewardAmount?: string
  rewardDescription?: string
  custodyDeskId?: string
  previousCustodyDesk?: string
  shelfTag?: string
  privacy?: "Held" | "Published"
  privateNotes?: string
  guestReport?: boolean
  guestEmail?: string
  guestPhone?: string
  guestMessages?: GuestMessage[]
  originalContent?: Pick<ApiItem, "name" | "description" | "image" | "question">
}

export type GuestMessage = { id: string; sender: "Desk" | "Guest"; text: string; createdAt: string }
export type GuestReport = Pick<ApiItem, "id" | "name" | "category" | "status" | "date" | "location" | "description"> & {
  reference: string
  kind: "Lost" | "Found"
  messages: GuestMessage[]
}

export type ApiClaim = {
  id: number
  itemId: number
  claimant: string
  claimantId?: string
  accountType: string
  status: "Pending" | "Approved" | "Rejected" | "Returned to another claimant"
  requested: string
  verified: boolean
  explanation: string
  proof?: string
}

export type MessageAttachment = { name: string; url: string }
export type ApiMessage = { id: number; mine: boolean; text: string; time: string; createdAt?: string; read?: boolean; attachment?: MessageAttachment }

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const messageClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const messageCalendar = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function formatMessageTime(message: Pick<ApiMessage, "time"> & Partial<Pick<ApiMessage, "id" | "createdAt">>) {
  const stored = message.createdAt || message.time
  const instant = /^\d{4}-\d{2}-\d{2}T/.test(stored) ? Date.parse(stored) : (message.id ?? 0) >= 1_000_000_000_000 ? Number(message.id) : NaN
  if (!Number.isFinite(instant)) return message.time === "Just now" ? "Time unavailable" : message.time
  const date = new Date(instant)
  return (date.toDateString() === new Date().toDateString() ? messageClock : messageCalendar).format(date)
}
export type ApiConversation = {
  id: number
  itemId: number
  user: string
  avatar: string
  unread: number
  messages: ApiMessage[]
}
export type ApiNotification = {
  id: string
  type: string
  title: string
  text: string
  time: string
  unread: boolean
  target: string
}
export type Bootstrap = {
  user: ApiUser
  isAdmin: boolean
  items: ApiItem[]
  claims: ApiClaim[]
  conversations: ApiConversation[]
  notifications: ApiNotification[]
}

export type AdminUser = Pick<ApiUser, "id" | "name" | "email" | "studentNumber" | "staffId" | "role">
export type AdminDesk = { id: string; name: string; active: boolean }
export type AdminOverview = {
  users: AdminUser[]
  items: ApiItem[]
  claims: ApiClaim[]
  desks: AdminDesk[]
  matches: { lostId: number; foundId: number; linked: boolean }[]
  notifications: ApiNotification[]
  readDeskActivity?: string[]
  claimThreads: { claimId: number; messages: ApiMessage[] }[]
  stats: {
    items: number
    pendingClaims: number
    returnedItems: number
    inCustody: number
    activeReports: number
    returnRate: number
    analytics: { location: string; reports: number; returned: number }[]
  }
}

type ApiError = Error & { status?: number; code?: string }
let renewingSession: { previous: string | null; next?: string; promise: Promise<void> } | undefined

function currentSessionToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData)) headers.set("Content-Type", "application/json")
  const token = currentSessionToken()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(`${API_BASE}/api${path}`, { ...init, headers })
  } catch {
    throw new Error("Could not reach the ReClaim API. Start the backend server and try again.")
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`) as ApiError
    error.status = response.status
    error.code = data.code
    throw error
  }
  return data as T
}

function rememberSession(token: string, remember = true) {
  localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
  ;(remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token)
  localStorage.setItem(REMEMBER_KEY, String(remember))
}

export function clearSession() {
  renewingSession = undefined
  localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REMEMBER_KEY)
}

export async function login(email: string, password: string, remember = true) {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (!error && data.session && data.user) {
    try {
      const result = await request<{ token: string }>("/auth/supabase-session", {
        method: "POST", body: JSON.stringify({ accessToken: data.session.access_token }),
      })
      rememberSession(result.token, remember)
      return
    } catch (failure) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => {})
      throw failure
    }
  }

  try {
    const result = await request<{ token: string }>("/auth/login", {
      method: "POST", body: JSON.stringify({ email, password }),
    })
    rememberSession(result.token, remember)
  } catch (failure) {
    if (error) throw error
    throw failure
  }
}

const otpRequests = new Set<string>()
const verifiedOtpRequests = new Set<string>()
const completedRegistrations = new Set<string>()

export async function register(input: Record<string, string>) {
  const supabase = getSupabaseClient()
  const email = String(input.email || "").trim().toLowerCase()
  if (!/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(String(input.password || ""))) {
    throw new Error("Password needs 8+ characters, an uppercase letter, a number, and a special character.")
  }
  if (completedRegistrations.has(email)) {
    throw new Error("This account has already been completed.")
  }
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw new Error("Could not restore the verified account session.")
  const session = sessionData.session
  if (!session?.access_token || !session.user || session.user.email?.toLowerCase() !== email) {
    throw new Error("No verified account session exists. Please verify the OTP again.")
  }
  const details = await request<{ phone: string; idNumber: string }>("/auth/registration-details", {
    method: "POST", body: JSON.stringify({ phone: input.phone, idNumber: input.idNumber, accountType: input.accountType, role: input.role, accessToken: session.access_token }),
  })
  const accountType = input.accountType === "External User" ? "External User" : input.role === "staff" ? "PLM Staff" : "PLM Resident"
  const { error: updateError } = await supabase.auth.updateUser({
    password: input.password,
    data: {
      full_name: input.name,
      student_number: accountType === "PLM Resident" ? details.idNumber : null,
      staff_id: accountType === "PLM Staff" ? details.idNumber : null,
      phone: details.phone,
      account_type: accountType,
    },
  })
  if (updateError) throw updateError

  const profile = {
    id: session.user.id,
    email: session.user.email || input.email,
    full_name: input.name,
  }
  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(profile, { onConflict: "id" })
  if (profileError) throw new Error(`Could not save the account profile: ${profileError.message}`)

  const registration = await request<{ token: string }>("/auth/supabase-session", {
    method: "POST", body: JSON.stringify({ accessToken: session.access_token }),
  })
  clearSession()
  await request("/auth/logout", {
    method: "POST", headers: { Authorization: `Bearer ${registration.token}` },
  }).catch(() => {})
  const { error: signOutError } = await supabase.auth.signOut({ scope: "local" })
  if (signOutError) throw signOutError
  completedRegistrations.add(email)
  return { message: "Account created. You can now sign in." }
}

export function startRegistration(email: string, accountType = "PLM") {
  const supabase = getSupabaseClient()
  const normalizedEmail = email.trim().toLowerCase()
  if (otpRequests.has(normalizedEmail) || verifiedOtpRequests.has(normalizedEmail)) {
    return Promise.resolve({ message: "A verification code was already sent to your email inbox." })
  }
  otpRequests.add(normalizedEmail)
  return supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: { shouldCreateUser: true },
  }).then(({ error }) => {
    if (error) {
      otpRequests.delete(normalizedEmail)
      throw error
    }
    return { message: "A verification code was sent to your email inbox." }
  })
}

export function verifyRegistrationEmail(email: string, code: string) {
  const supabase = getSupabaseClient()
  const normalizedEmail = email.trim().toLowerCase()
  if (verifiedOtpRequests.has(normalizedEmail)) {
    return supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw new Error("Could not preserve the verified account session.")
      if (!data.session) throw new Error("No verified account session exists. Please enter the OTP again.")
      return { verified: true, session: data.session }
    })
  }
  return supabase.auth.verifyOtp({ email, token: code, type: "email" })
    .then(async ({ data, error }) => {
      if (error) throw error
      if (!data.session) throw new Error("The verification code did not return a Supabase session.")
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw new Error("Could not preserve the verified account session.")
      if (!sessionData.session) throw new Error("No verified account session exists. Please enter the OTP again.")
      verifiedOtpRequests.add(normalizedEmail)
      return { verified: true, session: sessionData.session }
    })
}

export async function resendVerification(email: string) {
  const supabase = getSupabaseClient()
  const normalizedEmail = email.trim().toLowerCase()
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: { shouldCreateUser: true },
  })
  if (error) throw error
  return { message: "A new verification code was sent." }
}

let recoveryEmail: string | undefined

export async function requestPasswordReset(email: string) {
  recoveryEmail = undefined
  if (supabase) {
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: false } })
    if (error?.status === 429) throw new Error("Wait before requesting another recovery code.")
    if (error && error.code !== "otp_disabled" && error.code !== "user_not_found" && error.code !== "signup_disabled") {
      throw new Error("Could not send the recovery code. Try again shortly.")
    }
    return { message: "If the account exists, a recovery code was sent." }
  }
  return request<{ message: string; demoCode?: string }>("/auth/forgot-password", {
    method: "POST", body: JSON.stringify({ email }),
  })
}

export async function resetPassword(email: string, code: string, password: string) {
  if (supabase) {
    const canonical = email.trim().toLowerCase()
    const { data } = await supabase.auth.getSession()
    if (recoveryEmail !== canonical || data.session?.user.email?.toLowerCase() !== canonical) {
      throw new Error("Verify your recovery code before changing your password.")
    }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    recoveryEmail = undefined
    await supabase.auth.signOut().catch(() => {})
    clearSession()
    return { message: "Password updated." }
  }
  return request<{ message: string }>("/auth/reset-password", {
    method: "POST", body: JSON.stringify({ email, code, password }),
  })
}

export async function verifyPasswordReset(email: string, code: string) {
  if (supabase) {
    const canonical = email.trim().toLowerCase()
    const { data, error } = await supabase.auth.verifyOtp({ email: canonical, token: code, type: "email" })
    if (error || !data.session || data.user?.email?.toLowerCase() !== canonical) {
      throw new Error("The recovery code is incorrect or expired.")
    }
    recoveryEmail = canonical
    return { verified: true }
  }
  return request<{ verified: boolean }>("/auth/verify-password-reset", {
    method: "POST", body: JSON.stringify({ email, code }),
  })
}

async function withSession<T>(path: string, init: RequestInit = {}) {
  const { signal } = init
  const originalToken = currentSessionToken()
  try {
    return await request<T>(path, init)
  } catch (failure) {
    if ((failure as ApiError).status !== 401 || signal?.aborted || !supabase || localStorage.getItem(REMEMBER_KEY) === null) throw failure
    const authClient = supabase
    const remember = localStorage.getItem(REMEMBER_KEY) === "true"
    if (!remember && !sessionStorage.getItem(TOKEN_KEY)) throw failure
    if (renewingSession?.previous !== originalToken || (renewingSession.next && renewingSession.next !== currentSessionToken())) {
      if (originalToken !== currentSessionToken()) throw failure
      const renewal = {
        previous: originalToken,
        next: undefined as string | undefined,
        promise: Promise.resolve().then(async () => {
          try {
            const { data } = await authClient.auth.getSession()
            if (!data.session || renewingSession !== renewal) throw failure
            const result = await request<{ token: string }>("/auth/supabase-session", {
              method: "POST", body: JSON.stringify({ accessToken: data.session.access_token }),
            })
            if (renewingSession !== renewal || originalToken !== currentSessionToken()) throw failure
            rememberSession(result.token, remember)
            renewal.next = result.token
          } catch (error) {
            if (renewingSession === renewal) renewingSession = undefined
            throw error
          }
        }),
      }
      renewingSession = renewal
    }
    const renewal = renewingSession
    await renewal.promise
    if (signal?.aborted || !renewal.next || renewal.next !== currentSessionToken()) throw failure
    return request<T>(path, init)
  }
}

export function bootstrap(signal?: AbortSignal) {
  return withSession<Bootstrap>("/bootstrap", { signal })
}

export function requestPhoneChange(phone: string) {
  return request<{ demoCode?: string }>("/profile/phone/code", { method: "POST", body: JSON.stringify({ phone }) })
}

export function confirmPhoneChange(code: string) {
  return request<{ user: ApiUser }>("/profile/phone/confirm", { method: "POST", body: JSON.stringify({ code }) })
}

export function adminOverview(signal?: AbortSignal) {
  return request<AdminOverview>("/admin/overview", { signal })
}

export function markDeskActivityRead(key: string) {
  return adminWrite("/desk-activity/read", "POST", { key })
}

export function guestReports(signal?: AbortSignal) {
  return request<{ reports: GuestReport[] }>("/guest/reports", { signal })
}

export function submitGuestReport(input: Record<string, string>) {
  return request<{ report: GuestReport }>("/guest/reports", { method: "POST", body: JSON.stringify(input) })
}

export function messageGuestDesk(id: number, text: string) {
  return request<{ report: GuestReport }>(`/guest/reports/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) })
}

export function adminReplyToGuest(id: number, text: string) {
  return adminWrite(`/guest-reports/${id}/messages`, "POST", { text })
}

export function adminVerifyGuestHandover(id: number, foundId: string, idVerified: boolean, ownershipVerified: boolean) {
  return adminWrite(`/guest-reports/${id}/handover`, "POST", { foundId, idVerified, ownershipVerified })
}

export function adminUpdateClaim(id: number, status: "Approved" | "Rejected") {
  return request<{ claim: ApiClaim; item: ApiItem }>(`/admin/claims/${id}`, {
    method: "PATCH", body: JSON.stringify({ status }),
  })
}

export function adminUpdateItemStatus(id: number, status: "Returned") {
  return request<{ item: ApiItem }>(`/admin/items/${id}/status`, {
    method: "PATCH", body: JSON.stringify({ status }),
  })
}

type WalkIn = {
  name: string; category: string; location: string; description: string
  deskId: string; shelfTag: string; question: string; answer: string; privateNotes: string
}
export function adminLogWalkIn(input: WalkIn) {
  return adminWrite("/items", "POST", input)
}

export function adminSetCustody(id: number, deskId: string | null, shelfTag: string) {
  return adminWrite(`/items/${id}/custody`, "PATCH", { deskId, shelfTag })
}

export function adminEditLostReport(id: number, details: Pick<ApiItem, "name" | "location" | "description">) {
  return adminWrite(`/items/${id}/details`, "PATCH", details)
}

export function adminModerate(id: number, input: { action: "hold" } | { action: "publish"; name: string; description: string; question?: string }) {
  return adminWrite(`/items/${id}/privacy`, "PATCH", input)
}

export function adminLinkMatch(lostId: number, foundId: number) {
  return adminWrite("/matches", "POST", { lostId, foundId })
}

export function adminSetDesk(id: string, active: boolean) {
  return adminWrite(`/desks/${id}`, "PATCH", { active })
}

export function adminMessageClaimant(id: number, text: string) {
  return adminWrite(`/claims/${id}/messages`, "POST", { text })
}

function adminWrite(path: string, method: "POST" | "PATCH", input: object) {
  return request<unknown>(`/admin${path}`, { method, body: JSON.stringify(input) })
}

export async function logout() {
  try { await request<{ ok: boolean }>("/auth/logout", { method: "POST" }) }
  finally {
    clearSession()
    await supabase?.auth.signOut({ scope: "local" }).catch(() => {})
  }
}

export async function createItem(input: Omit<ApiItem, "id" | "date" | "reporter" | "reporterRole" | "ownerId" | "mine">) {
  return (await request<{ item: ApiItem }>("/items", { method: "POST", body: JSON.stringify(input) })).item
}

export async function createClaim(input: { itemId: number; answer: string; explanation: string; proof: string }) {
  return request<{ claim: ApiClaim }>("/claims", { method: "POST", body: JSON.stringify(input) })
}

export function verifyAnswer(itemId: number, answer: string) {
  return request<{ verified: boolean }>(`/items/${itemId}/verify-answer`, {
    method: "POST", body: JSON.stringify({ answer }),
  })
}

export async function startConversation(itemId: number) {
  return (await withSession<{ conversation: ApiConversation }>("/conversations", {
    method: "POST", body: JSON.stringify({ itemId }),
  })).conversation
}

export async function updateClaim(id: number, status: "Approved" | "Rejected") {
  return request<{ claim: ApiClaim; item: ApiItem }>(`/claims/${id}`, { method: "PATCH", body: JSON.stringify({ status }) })
}

export async function markReturned(id: number) {
  return request<{ item: ApiItem }>(`/items/${id}/returned`, { method: "PATCH", body: "{}" })
}

export async function undoReturned(id: number) {
  return request<{ item: ApiItem }>(`/items/${id}/undo-return`, { method: "PATCH", body: "{}" })
}

export async function sendMessage(conversationId: number, text: string, attachment?: MessageAttachment) {
  return withSession<{ message: ApiMessage }>(`/conversations/${conversationId}/messages`, {
    method: "POST", body: JSON.stringify({ text, attachment }),
  })
}

export function markConversationRead(conversationId: number) {
  return withSession<{ ok: boolean }>(`/conversations/${conversationId}/read`, {
    method: "PATCH", body: "{}",
  })
}

export async function setNotificationRead(id: string, unread: boolean) {
  return request<{ notification: ApiNotification }>(`/notifications/${id}`, {
    method: "PATCH", body: JSON.stringify({ unread }),
  })
}

export async function saveProfile(input: { photo: string }) {
  return (await request<{ user: ApiUser }>("/profile", { method: "PATCH", body: JSON.stringify(input) })).user
}

export function changePassword(currentPassword: string, newPassword: string) {
  return request<{ message: string }>("/profile/password", {
    method: "PUT", body: JSON.stringify({ currentPassword, newPassword }),
  })
}

