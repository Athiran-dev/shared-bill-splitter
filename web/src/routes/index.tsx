import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
type Bill = { id: string; homeId: string; title: string; totalCents: number; shares: Share[] }
type Member = { id: string; homeId: string; name: string }
type HomeInfo = { id: string; name: string }

const REQUEST_TIMEOUT_MS = 8000
const HOME_KEY = 'bill-splitter:homeId'

function errorMessageOf(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const message = (data as { error: unknown }).error
    if (typeof message === 'string') return message
  }
  return `Request failed (${status})`
}

/** Calls the API. Always throws an Error with a readable message, never anything else. */
async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(errorMessageOf(data, response.status))
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The server took too long to answer. Please try again.')
    }
    if (error instanceof Error) throw error
    throw new Error('Something went wrong.')
  } finally {
    clearTimeout(timer)
  }
}

function readStoredHome(): string | null {
  try {
    return localStorage.getItem(HOME_KEY)
  } catch {
    return null
  }
}

function storeHome(id: string | null) {
  try {
    if (id) localStorage.setItem(HOME_KEY, id)
    else localStorage.removeItem(HOME_KEY)
  } catch {
    // Storage can be blocked; the page still works without it.
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function Home() {
  const [homeId, setHomeId] = useState<string | null>(readStoredHome)
  return (
    <main style={styles.page}>
      <h1>Bill Splitter</h1>
      {homeId ? (
        <HomeView
          homeId={homeId}
          onLeave={() => {
            storeHome(null)
            setHomeId(null)
          }}
        />
      ) : (
        <CreateHome
          onCreated={(id) => {
            storeHome(id)
            setHomeId(id)
          }}
        />
      )}
    </main>
  )
}

function CreateHome({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const home = await api<HomeInfo>('POST', '/api/homes', { body: { name } })
      onCreated(home.id)
    } catch (e) {
      setError(messageOf(e, 'Could not create the home.'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={styles.card}>
      <h2>Create a home</h2>
      <input
        aria-label="Home name"
        placeholder="Flat 4B"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />{' '}
      <button type="submit" disabled={busy || name.trim() === ''}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </form>
  )
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; members: Member[]; bills: Bill[] }

function HomeView({ homeId, onLeave }: { homeId: string; onLeave: () => void }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async () => {
    try {
      const [members, bills] = await Promise.all([
        api<{ members: Member[] }>('GET', `/api/homes/${homeId}/members`),
        api<{ bills: Bill[] }>('GET', `/api/homes/${homeId}/bills`),
      ])
      setState({ status: 'ready', members: members.members, bills: bills.bills })
    } catch (e) {
      setState({ status: 'error', message: messageOf(e, 'Could not load.') })
    }
  }, [homeId])

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') {
    return (
      <div role="alert" style={styles.card}>
        <p style={styles.error}>{state.message}</p>
        <button
          type="button"
          onClick={() => {
            setState({ status: 'loading' })
            void load()
          }}
        >
          Try again
        </button>{' '}
        <button type="button" onClick={onLeave}>
          Use another home
        </button>
      </div>
    )
  }

  const names = new Map(state.members.map((m) => [m.id, m.name]))
  return (
    <>
      <p>
        <button type="button" onClick={onLeave}>
          Switch home
        </button>
      </p>
      <AddMember homeId={homeId} onAdded={load} members={state.members} />
      <AddBill homeId={homeId} onAdded={load} disabled={state.members.length === 0} />
      <h2>Bills</h2>
      {state.bills.length === 0 ? (
        <p>No bills yet. Add members, then add a bill.</p>
      ) : (
        state.bills.map((bill) => (
          <BillCard key={bill.id} bill={bill} names={names} onPaid={load} />
        ))
      )}
    </>
  )
}

function AddMember({
  homeId,
  members,
  onAdded,
}: {
  homeId: string
  members: Member[]
  onAdded: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api<Member>('POST', `/api/homes/${homeId}/members`, { body: { name } })
      setName('')
      await onAdded()
    } catch (e) {
      setError(messageOf(e, 'Could not add the member.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={styles.card}>
      <h2>Members</h2>
      <p>{members.length === 0 ? 'No members yet.' : members.map((m) => m.name).join(', ')}</p>
      <input
        aria-label="Member name"
        placeholder="Member name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />{' '}
      <button type="submit" disabled={busy || name.trim() === ''}>
        {busy ? 'Adding…' : 'Add member'}
      </button>
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </form>
  )
}

function AddBill({
  homeId,
  disabled,
  onAdded,
}: {
  homeId: string
  disabled: boolean
  onAdded: () => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    // Money is typed in dollars but sent as whole cents.
    const cents = Math.round(Number(amount) * 100)
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api<Bill>('POST', `/api/homes/${homeId}/bills`, { body: { title, totalCents: cents } })
      setTitle('')
      setAmount('')
      await onAdded()
    } catch (e) {
      setError(messageOf(e, 'Could not add the bill.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={styles.card}>
      <h2>New bill</h2>
      <input
        aria-label="Bill title"
        placeholder="Electricity"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />{' '}
      <input
        aria-label="Amount in dollars"
        placeholder="10.00"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />{' '}
      <button type="submit" disabled={busy || disabled || title.trim() === ''}>
        {busy ? 'Adding…' : 'Split bill'}
      </button>
      {disabled && <p>Add at least one member first.</p>}
      {error && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </form>
  )
}

function BillCard({
  bill,
  names,
  onPaid,
}: {
  bill: Bill
  names: Map<string, string>
  onPaid: () => Promise<void>
}) {
  return (
    <section style={styles.card}>
      <h3>
        {bill.title} — {money(bill.totalCents)}
      </h3>
      <ul style={{ paddingLeft: 0, listStyle: 'none' }}>
        {bill.shares.map((share) => (
          <ShareRow
            key={share.id}
            billId={bill.id}
            share={share}
            name={names.get(share.memberId) ?? 'Unknown member'}
            onPaid={onPaid}
          />
        ))}
      </ul>
    </section>
  )
}

function ShareRow({
  billId,
  share,
  name,
  onPaid,
}: {
  billId: string
  share: Share
  name: string
  onPaid: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per share: a retry after a timeout reuses it, so the server never pays twice.
  const [key] = useState(() => crypto.randomUUID())

  async function pay() {
    setBusy(true)
    setError(null)
    try {
      await api<Share>('POST', `/api/bills/${billId}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': key },
      })
      await onPaid()
    } catch (e) {
      // The share stays unpaid on screen; the user can retry.
      setError(messageOf(e, 'Payment failed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li style={{ marginBottom: 8 }}>
      {name}: {money(share.amountCents)}{' '}
      {share.paidAt ? (
        <strong style={{ color: 'green' }}>Paid</strong>
      ) : (
        <button type="button" onClick={pay} disabled={busy}>
          {busy ? 'Paying…' : 'Pay'}
        </button>
      )}
      {error && (
        <span role="alert" style={styles.error}>
          {' '}
          {error}
        </span>
      )}
    </li>
  )
}

const styles = {
  page: { padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '0 auto' },
  card: { border: '1px solid #ccc', borderRadius: 8, padding: 12, marginBottom: 16 },
  error: { color: '#b00020' },
} as const
