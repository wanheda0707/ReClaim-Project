import { useState, type FormEvent } from "react"
import { confirmPhoneChange, requestPhoneChange } from "./lib/api"

export const phonePattern = "\\+63 9[0-9]{9}"

export function phoneInput(value: string) {
  let digits = value.replace(/[^0-9]/g, "")
  if (digits.startsWith("63")) digits = digits.slice(2)
  if (digits.startsWith("0")) digits = digits.slice(1)
  return digits ? `+63 ${digits.slice(0, 10)}` : ""
}

export function studentInput(value: string) {
  const digits = value.replace(/[^0-9]/g, "").slice(0, 9)
  if (digits.length <= 8 && digits.length > 4) return `${digits.slice(0, 4)}-${digits.slice(4)}`
  return digits
}

export function PhoneSettings({ phone }: { phone?: string }) {
  const [current, setCurrent] = useState(phone)
  const [next, setNext] = useState("")
  const [code, setCode] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      if (sent) {
        const { user } = await confirmPhoneChange(code)
        setCurrent(user.phone)
        setSent(false)
        setNext("")
        setCode("")
        setNotice("Contact number updated.")
      } else {
        const response = await requestPhoneChange(next)
        setSent(true)
        setNotice(response.demoCode ? "Local verification code: " + response.demoCode : "Enter the code sent to your account email.")
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the contact number.")
    } finally {
      setBusy(false)
    }
  }

  return <form className="settings-fields" onSubmit={(event) => void submit(event)}>
    <p>Current contact number <b>{current ? phoneInput(current) : "Not provided"}</b></p>
    <label className="field-label">New contact number
      <input className="plain-input w-full" type="tel" pattern={phonePattern} title="Enter 10 digits beginning with 9, for example +63 912 345 6789." placeholder="+63 9XX XXX XXXX" value={next} onChange={(event) => setNext(phoneInput(event.target.value))} readOnly={sent} required />
    </label>
    {sent && <label className="field-label">Email verification code
      <input className="plain-input w-full" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} pattern="[0-9]{6}" required />
    </label>}
    <div className="flex flex-wrap gap-2">
      <button className="btn-tertiary" disabled={busy}>{sent ? "Verify and update" : "Email a verification code"}</button>
      {sent && <button className="btn-tertiary" type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); setNotice(""); setError("") }}>Change number or resend</button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>
}
