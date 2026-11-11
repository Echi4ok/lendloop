'use client'

import { ClerkProvider, SignInButton, UserButton, useAuth } from '@clerk/nextjs'
import { ConvexError } from 'convex/values'
import { Authenticated, AuthLoading, ConvexReactClient, Unauthenticated, useMutation, useQuery } from 'convex/react'
import { ConvexProviderWithClerk } from 'convex/react-clerk'
import type { FunctionReturnType } from 'convex/server'
import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'

type DashboardData = FunctionReturnType<typeof api.tools.dashboard>
type Tool = DashboardData['tools'][number]
type Loan = DashboardData['myRequests'][number]
type View = 'browse' | 'listings' | 'requests' | 'incoming' | 'admin'

const navigation: { value: View; label: string }[] = [
  { value: 'browse', label: 'Browse tools' },
  { value: 'listings', label: 'My listings' },
  { value: 'requests', label: 'My requests' },
  { value: 'incoming', label: 'Incoming requests' },
  { value: 'admin', label: 'All loans' },
]

const availabilityLabel = { available: 'Available', reserved: 'Reserved', loaned: 'On loan' }
const statusLabel = { pending: 'Pending', approved: 'Approved', declined: 'Declined', returned: 'Returned' }
const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const formatDay = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`))

function getError(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === 'string') return error.data
  return 'The change could not be saved. Please try again.'
}

export function Workspace({ clerkKey, convexUrl }: { clerkKey: string; convexUrl: string }) {
  const [convex] = useState(() => new ConvexReactClient(convexUrl))
  return <ClerkProvider publishableKey={clerkKey}>
    <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
      <header className="topbar">
        <div className="shell topbar-inner">
          <a className="brand" href="/" aria-label="LendLoop home"><span className="brand-icon" aria-hidden="true">↻</span>LendLoop</a>
          <Unauthenticated><SignInButton mode="modal"><button className="button secondary">Sign in</button></SignInButton></Unauthenticated>
          <Authenticated><UserButton /></Authenticated>
        </div>
      </header>
      <main className="shell">
        <AuthLoading><p className="notice" role="status">Opening the tool library…</p></AuthLoading>
        <Unauthenticated><PublicCatalog /></Unauthenticated>
        <Authenticated><Dashboard /></Authenticated>
      </main>
    </ConvexProviderWithClerk>
  </ClerkProvider>
}

function PublicCatalog() {
  const tools = useQuery(api.tools.publicTools)
  return <>
    <section className="hero">
      <h1>Borrow what you need.<br />Lend what you don’t.</h1>
      <p>A tool library for neighbors. Find what you need for the next job and share the tools you have.</p>
      <SignInButton mode="modal"><button className="button primary">Sign in to lend or borrow</button></SignInButton>
    </section>
    <section className="catalog" aria-labelledby="public-tools">
      <h2 id="public-tools">Available tools</h2>
      {tools === undefined ? <p role="status">Loading tools…</p> : tools.length === 0 ?
        <Empty>No tools are available yet.</Empty> :
        <ul className="cards">
          {tools.map(tool => <li className="card" key={tool._id}><span className="category">{tool.category}</span><h3>{tool.name}</h3></li>)}
        </ul>}
    </section>
  </>
}

function Dashboard() {
  const data = useQuery(api.tools.dashboard)
  const create = useMutation(api.tools.create)
  const update = useMutation(api.tools.update)
  const remove = useMutation(api.tools.remove)
  const trustLender = useMutation(api.tools.trustLender)
  const request = useMutation(api.loans.request)
  const decide = useMutation(api.loans.decide)
  const markReturned = useMutation(api.loans.markReturned)
  const [view, setView] = useState<View>('browse')
  const [category, setCategory] = useState('')
  const [editor, setEditor] = useState<Tool | 'new' | null>(null)
  const [borrow, setBorrow] = useState<Tool | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<Id<'tools'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)

  async function save(action: () => Promise<unknown>, success: string, after?: () => void) {
    setBusy(true)
    setFeedback(null)
    try {
      await action()
      after?.()
      setFeedback({ text: success, error: false })
    } catch (error) {
      setFeedback({ text: getError(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <p className="notice" role="status">Loading your workspace…</p>

  const currentView = view === 'admin' && !data.viewer.isAdmin ? 'browse' : view
  const currentNav = navigation.find(item => item.value === currentView)!
  const categories = [...new Set(data.tools.map(tool => tool.category))].sort()
  const shownTools = currentView === 'listings' ? data.myListings : data.tools.filter(tool => !category || tool.category === category)
  const loans = currentView === 'requests' ? data.myRequests : currentView === 'incoming' ? data.incoming : data.allLoans

  function switchView(nextView: View) {
    setEditor(null)
    setBorrow(null)
    setConfirmRemove(null)
    setFeedback(null)
    setView(nextView)
  }

  function submitListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const fields = new FormData(event.currentTarget)
    const values = {
      name: String(fields.get('name')).trim(),
      category: String(fields.get('category')).trim(),
      condition: String(fields.get('condition')).trim(),
      description: String(fields.get('description')).trim(),
    }
    void save(() => editor === 'new' ? create(values) : update({ id: editor._id, ...values }),
      editor === 'new' ? 'Tool listed.' : 'Listing updated.', () => { setEditor(null); setView('listings') })
  }

  function submitBorrow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!borrow) return
    const fields = new FormData(event.currentTarget)
    const startDate = String(fields.get('startDate'))
    const endDate = String(fields.get('endDate'))
    if (endDate < startDate) {
      setFeedback({ error: true, text: 'The return date must be on or after the pickup date.' })
      return
    }
    const toolId = borrow._id
    void save(() => request({ toolId, startDate, endDate }), 'Request sent to the lender.', () => { setBorrow(null); setView('requests') })
  }

  const editing = editor && editor !== 'new' ? editor : null
  return <section className="dashboard">
    <div className="heading-row">
      <div><p className="eyebrow">Tool library</p><h1>{currentNav.label}</h1></div>
      <button className="button primary" disabled={busy} onClick={() => { setBorrow(null); setEditor('new'); setFeedback(null) }}>List a tool</button>
    </div>
    <nav className="views" aria-label="Workspace views">
      {navigation.filter(item => item.value !== 'admin' || data.viewer.isAdmin).map(item =>
        <button className="view" key={item.value} aria-current={currentView === item.value ? 'page' : undefined}
          disabled={busy} onClick={() => switchView(item.value)}>{item.label}</button>)}
    </nav>
    {feedback && <p className={feedback.error ? 'feedback error' : 'feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {editor && <form className="panel form" onSubmit={submitListing} key={editing?._id ?? 'new'}>
      <h2>{editing ? 'Edit listing' : 'List a tool'}</h2>
      <div className="fields">
        <label>Name<input name="name" required maxLength={80} defaultValue={editing?.name} /></label>
        <label>Category<input name="category" required maxLength={40} defaultValue={editing?.category} list="tool-categories" /></label>
        <label>Condition<input name="condition" required maxLength={80} defaultValue={editing?.condition} placeholder="e.g. Like new" /></label>
      </div>
      <datalist id="tool-categories">{[...new Set([...categories, 'Power tools', 'Garden', 'Kitchen', 'Camping'])].map(name => <option key={name} value={name} />)}</datalist>
      <label>Description<textarea name="description" rows={3} required maxLength={600} defaultValue={editing?.description} /></label>
      <div className="actions"><button className="button primary" disabled={busy}>Save listing</button><button type="button" className="button secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button></div>
    </form>}
    {borrow && <form className="panel form" onSubmit={submitBorrow} key={borrow._id}>
      <h2>Request {borrow.name}</h2>
      <div className="fields">
        <label>Pickup date<input name="startDate" type="date" required min={new Date().toISOString().slice(0, 10)} /></label>
        <label>Return date<input name="endDate" type="date" required min={new Date().toISOString().slice(0, 10)} /></label>
      </div>
      <p className="muted">Dates are inclusive and use UTC.</p>
      <div className="actions"><button className="button primary" disabled={busy}>Send request</button><button className="button secondary" type="button" disabled={busy} onClick={() => setBorrow(null)}>Cancel</button></div>
    </form>}
    {currentView === 'browse' && <label className="filter">Category<select value={category} onChange={event => setCategory(event.target.value)}>
      <option value="">All categories</option>{categories.map(name => <option key={name}>{name}</option>)}
    </select></label>}
    {currentView === 'browse' || currentView === 'listings' ? (
      shownTools.length === 0 ? <Empty>{currentView === 'listings' ? 'You haven’t listed a tool yet.' : 'No tools match this category.'}</Empty> :
        <ul className="cards">{shownTools.map(tool => <li className="card" key={tool._id}>
          <div className="card-meta"><span className="category">{tool.category}</span><span className={`status ${tool.availability}`}>{availabilityLabel[tool.availability]}</span></div>
          <h3>{tool.name}</h3>
          <p className="muted">{tool.condition}{tool.isTrusted ? ' · Trusted lender' : ''}</p>
          <p className="description">{tool.description}</p>
          <div className="actions">
            {!tool.isMine && <button className="button secondary" disabled={busy} onClick={() => { setEditor(null); setBorrow(tool); setFeedback(null) }}>Request dates</button>}
            {tool.isMine && <button className="button secondary" disabled={busy} onClick={() => { setBorrow(null); setEditor(tool); setFeedback(null) }}>Edit</button>}
            {data.viewer.isAdmin && !tool.isTrusted && <button className="button secondary" disabled={busy}
              onClick={() => void save(() => trustLender({ id: tool._id }), 'Lender marked as trusted.')}>Mark lender trusted</button>}
            {(tool.isMine || data.viewer.isAdmin) && <button className="button secondary danger" disabled={busy}
              onClick={() => setConfirmRemove(tool._id)}>Remove</button>}
          </div>
          {confirmRemove === tool._id && <div className="remove-confirm">
            <p>Remove this listing from the catalog?</p>
            <div className="actions"><button className="button secondary danger" disabled={busy}
              onClick={() => void save(() => remove({ id: tool._id }), 'Listing removed.', () => setConfirmRemove(null))}>Confirm removal</button>
            <button className="button secondary" disabled={busy} onClick={() => setConfirmRemove(null)}>Keep listing</button></div>
          </div>}
        </li>)}</ul>
    ) : <LoanList loans={loans} renderActions={loan => {
      if (currentView !== 'incoming') return null
      if (loan.status === 'pending') return <>
        <button className="button primary" disabled={busy} onClick={() => void save(() => decide({ id: loan._id, decision: 'approved' }), 'Request approved.')}>Approve</button>
        <button className="button secondary" disabled={busy} onClick={() => void save(() => decide({ id: loan._id, decision: 'declined' }), 'Request declined.')}>Decline</button>
      </>
      if (loan.status === 'approved') return <button className="button secondary" disabled={busy}
        onClick={() => void save(() => markReturned({ id: loan._id }), 'Tool marked as returned.')}>Mark returned</button>
      return null
    }} />}
  </section>
}

function LoanList({ loans, renderActions }: { loans: Loan[]; renderActions: (loan: Loan) => ReactNode }) {
  if (loans.length === 0) return <Empty>No requests to show yet.</Empty>
  return <ul className="loan-list">{loans.map(loan => <li className="panel loan" key={loan._id}>
    <div>
      <div className="card-meta"><h3>{loan.toolName}</h3><span className={`status ${loan.status}`}>{statusLabel[loan.status]}</span></div>
      <p className="muted">{formatDay(loan.startDate)} to {formatDay(loan.endDate)}</p>
      {loan.reminderSentAt !== undefined && <p className="muted">Last overdue reminder: <time dateTime={new Date(loan.reminderSentAt).toISOString()}>{dateFormat.format(loan.reminderSentAt)}</time></p>}
    </div>
    <div className="actions">{renderActions(loan)}</div>
  </li>)}</ul>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>
}
