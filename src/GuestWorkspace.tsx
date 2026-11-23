import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { formatMessageTime, guestReports, messageGuestDesk, submitGuestReport, type ApiUser, type GuestReport } from "./lib/api"
import { PhoneSettings, phoneInput, phonePattern } from "./PhoneSettings"
import { useLiveRefresh } from "./lib/useLiveRefresh"

const categories = ["Electronics", "Accessories", "IDs and Cards", "Books and Notes", "Clothing", "Others"]

export function GuestWorkspace({ user, brand, onSignOut }: { user: ApiUser; brand: ReactNode; onSignOut: () => Promise<void> }) {
  const [reports, setReports] = useState<GuestReport[]>([])
  const [tab, setTab] = useState<"submit" | "track" | "contact">("submit")
  const [selected, setSelected] = useState<number>()
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const requestVersion = useRef(0)
  const report = reports.find((entry) => entry.id === selected)
  const visible = reports.filter((entry) => entry.reference.toLowerCase().includes(query.trim().toLowerCase()))

  async function refresh() {
    const version = ++requestVersion.current
    setLoading(true)
    setError("")
    try {
      const { reports } = await guestReports()
      if (version === requestVersion.current) setReports(reports)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not load your reports.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  useLiveRefresh(tab === "track", async (signal) => {
    if (loading || saving) return
    const version = requestVersion.current
    const result = await guestReports(signal)
    if (!signal.aborted && version === requestVersion.current) setReports(result.reports)
  })

  async function save(event: FormEvent<HTMLFormElement>, reportId?: number) {
    event.preventDefault()
    requestVersion.current++
    const form = event.currentTarget
    const data = new FormData(form)
    setSaving(true)
    setError("")
    setNotice("")
    try {
      const result = reportId === undefined
        ? await submitGuestReport(Object.fromEntries(Array.from(data, ([key, value]) => [key, String(value)])))
        : await messageGuestDesk(reportId, String(data.get("text") ?? ""))
      const next = result.report
      setReports((previous) => reportId === undefined
        ? [next, ...previous.filter((entry) => entry.id !== next.id)]
        : previous.map((entry) => entry.id === next.id ? next : entry))
      setSelected(next.id)
      setQuery("")
      setTab("track")
      setNotice(reportId === undefined ? "Report submitted. Your reference is " + next.reference + "." : "Message sent to the campus desk.")
      form.reset()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save your changes.")
    } finally {
      setSaving(false)
    }
  }

  return <div className="min-h-screen bg-[#f5f2ec] text-[#4b2e1f]">
    <header className="border-b border-[#e9e4dc] bg-white px-5 py-4">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        {brand}
        <button className="admin-refresh" onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </header>
    <main className="mx-auto max-w-4xl px-5 py-8">
      <h1 className="font-display text-3xl font-bold">Guest reports</h1>
      <p className="mt-2">Submit a lost or found report and follow up privately with the campus desk. Bring valid ID and proof of ownership to claim an item.</p>
      <nav aria-label="Guest workspace" className="my-6 flex flex-wrap gap-3">
        <button aria-pressed={tab === "submit"} className={tab === "submit" ? "claim-approve" : "admin-refresh"} onClick={() => setTab("submit")}>Submit a report</button>
        <button aria-pressed={tab === "track"} className={tab === "track" ? "claim-approve" : "admin-refresh"} onClick={() => setTab("track")}>Track my reports</button>
        <button aria-pressed={tab === "contact"} className={tab === "contact" ? "claim-approve" : "admin-refresh"} onClick={() => setTab("contact")}>Contact settings</button>
      </nav>
      {error && <p role="alert" className="admin-feedback error">{error}</p>}
      {notice && <p role="status" className="admin-feedback">{notice}</p>}
      {tab === "contact" ? <section className="rounded-2xl bg-white p-5"><PhoneSettings phone={user.phone} /></section> : tab === "submit" ? <form className="admin-form rounded-2xl bg-white" onSubmit={(event) => void save(event)}>
        <label>Report type<select name="kind" required><option value="Lost">Lost item</option><option value="Found">Found item</option></select></label>
        <label>Contact name<input name="contactName" required maxLength={100} defaultValue={user.name} /></label>
        <label>Verified email<input type="email" value={user.email} readOnly /></label>
        <label>Phone (optional)<input name="phone" type="tel" pattern={phonePattern} title="Enter 10 digits beginning with 9, for example +63 912 345 6789." placeholder="+63 9XX XXX XXXX" defaultValue={phoneInput(user.phone || "")} onInput={(event) => { event.currentTarget.value = phoneInput(event.currentTarget.value) }} /></label>
        <label>Item name<input name="name" required maxLength={120} /></label>
        <label>Category<select name="category" required>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label>Where it was lost or found<input name="location" required maxLength={160} /></label>
        <label>Item details<textarea name="description" required maxLength={1500} /></label>
        <button className="claim-approve" disabled={loading || saving}>Submit report</button>
      </form> : <section className="rounded-2xl bg-white p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid flex-1 gap-1">Reference number<input className="rounded-lg border border-[#e9e4dc] p-2" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="RCL-…" /></label>
          <button className="admin-refresh" disabled={loading || saving} onClick={() => void refresh()}>Refresh reports</button>
        </div>
        <div className="admin-record-list">
          {visible.map((entry) => <article key={entry.id}>
            <button className="admin-activity-entry" aria-expanded={selected === entry.id} onClick={() => setSelected(entry.id)}><b>{entry.name}</b><p>{entry.reference} · {entry.status === "Returned" ? "Handover completed" : entry.status}</p></button>
          </article>)}
          {!visible.length && <p>{loading ? "Loading reports…" : "No reports found."}</p>}
        </div>
        {report && <section className="rounded-xl border border-[#e9e4dc] p-4">
          <h2 className="font-semibold">{report.reference} · {report.name}</h2>
          <p className="mt-1 text-sm">{report.kind} · {report.location} · {report.date}</p>
          <p className="mt-2 whitespace-pre-wrap">{report.description}</p>
          {report.messages.length > 0 && <div className="admin-record-list">{report.messages.map((message) =>
            <article key={message.id}><div><b>{message.sender === "Desk" ? "Campus desk" : "You"}</b><p className="whitespace-pre-wrap">{message.text}</p><small>{formatMessageTime({ time: message.createdAt })}</small></div></article>,
          )}</div>}
          <form key={report.id} className="admin-form" onSubmit={(event) => void save(event, report.id)}>
            <label>Message the campus desk<textarea name="text" required maxLength={2000} /></label>
            <button className="claim-approve" disabled={saving}>Send message</button>
          </form>
        </section>}
      </section>}
    </main>
  </div>
}
