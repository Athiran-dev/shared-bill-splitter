import type { Context } from 'hono'
import { Hono } from 'hono'

type AppEnv = { Bindings: Env }
type Ctx = Context<AppEnv>

type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }

type ShareRow = {
  id: string
  bill_id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

const MAX_TEXT_LENGTH = 200

const app = new Hono<AppEnv>()

function fail(c: Ctx, status: 400 | 404 | 409 | 422, message: string) {
  return c.json({ error: message }, status)
}

/** Reads a JSON object body. Returns null for bad JSON or a non-object. */
async function readObject(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : null
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    memberId: row.member_id,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  }
}

async function homeExists(db: D1Database, homeId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  return row !== null
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.get('/api/homes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name FROM homes ORDER BY rowid').all<{
    id: string
    name: string
  }>()
  return c.json({ homes: results })
})

app.post('/api/homes', async (c) => {
  const body = await readObject(c)
  const name = cleanText(body?.name)
  if (!name) return fail(c, 422, 'name must be a non-empty string')
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return fail(c, 404, 'home not found')
  const body = await readObject(c)
  const name = cleanText(body?.name)
  if (!name) return fail(c, 422, 'name must be a non-empty string')
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()
  return c.json({ id, homeId, name }, 201)
})

app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) return fail(c, 404, 'home not found')
  const { results } = await c.env.DB.prepare(
    'SELECT id, name FROM members WHERE home_id = ? ORDER BY seq',
  )
    .bind(homeId)
    .all<{ id: string; name: string }>()
  return c.json({ members: results.map((m) => ({ id: m.id, homeId, name: m.name })) })
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const db = c.env.DB
  if (!(await homeExists(db, homeId))) return fail(c, 404, 'home not found')

  const body = await readObject(c)
  const title = cleanText(body?.title)
  const totalCents = body?.totalCents
  if (!title) return fail(c, 422, 'title must be a non-empty string')
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return fail(c, 422, 'totalCents must be a positive whole number')
  }

  const countRow = await db
    .prepare('SELECT COUNT(*) AS n FROM members WHERE home_id = ?')
    .bind(homeId)
    .first<{ n: number }>()
  if (!countRow || countRow.n === 0) return fail(c, 422, 'home has no members')

  const billId = crypto.randomUUID()
  // One batch is one transaction. The split is computed inside a single INSERT ... SELECT, so it
  // uses exactly the members present at that moment, in the order they were added: everyone gets
  // total / n, and the first (total % n) members get one extra cent. The shares always sum to total.
  await db.batch([
    db
      .prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
      .bind(billId, homeId, title, totalCents),
    db
      .prepare(
        `INSERT INTO shares (id, bill_id, member_id, amount_cents)
         SELECT lower(hex(randomblob(16))), ?1, m.id,
                CAST(?3 AS INTEGER) / c.n + CASE WHEN m.rn <= CAST(?3 AS INTEGER) % c.n THEN 1 ELSE 0 END
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY seq) AS rn
               FROM members WHERE home_id = ?2) AS m,
              (SELECT COUNT(*) AS n FROM members WHERE home_id = ?2) AS c
         ORDER BY m.rn`,
      )
      .bind(billId, homeId, totalCents),
  ])

  const { results } = await db
    .prepare('SELECT * FROM shares WHERE bill_id = ? ORDER BY seq')
    .bind(billId)
    .all<ShareRow>()
  return c.json({ id: billId, homeId, title, totalCents, shares: results.map(toShare) }, 201)
})

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const db = c.env.DB
  if (!(await homeExists(db, homeId))) return fail(c, 404, 'home not found')

  const bills = await db
    .prepare('SELECT id, title, total_cents FROM bills WHERE home_id = ? ORDER BY seq')
    .bind(homeId)
    .all<{ id: string; title: string; total_cents: number }>()
  const shares = await db
    .prepare(
      `SELECT s.* FROM shares s JOIN bills b ON b.id = s.bill_id
       WHERE b.home_id = ? ORDER BY s.seq`,
    )
    .bind(homeId)
    .all<ShareRow>()

  return c.json({
    bills: bills.results.map((bill) => ({
      id: bill.id,
      homeId,
      title: bill.title,
      totalCents: bill.total_cents,
      shares: shares.results.filter((s) => s.bill_id === bill.id).map(toShare),
    })),
  })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return fail(c, 400, 'Idempotency-Key header is required')
  if (key.length > 255) return fail(c, 400, 'Idempotency-Key is too long')

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const db = c.env.DB

  const existing = await db
    .prepare('SELECT id FROM shares WHERE id = ? AND bill_id = ?')
    .bind(shareId, billId)
    .first()
  if (!existing) return fail(c, 404, 'bill or share not found')

  // The conditional UPDATE is the lock: SQLite runs it atomically, so when two requests race only
  // one finds paid_at still NULL. The loser changes 0 rows and is answered from the stored key.
  await db
    .prepare(
      `UPDATE shares SET paid_at = ?, idempotency_key = ?
       WHERE id = ? AND bill_id = ? AND paid_at IS NULL`,
    )
    .bind(new Date().toISOString(), key, shareId, billId)
    .run()

  const current = await db
    .prepare('SELECT * FROM shares WHERE id = ? AND bill_id = ?')
    .bind(shareId, billId)
    .first<ShareRow>()
  if (!current) return fail(c, 404, 'bill or share not found')
  if (current.idempotency_key !== key) {
    return fail(c, 409, 'share already paid with a different Idempotency-Key')
  }
  return c.json(toShare(current), 200)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const db = c.env.DB
  if (!(await homeExists(db, homeId))) return fail(c, 404, 'home not found')
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id, m.name AS name,
              COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents END), 0) AS outstanding
       FROM members m LEFT JOIN shares s ON s.member_id = m.id
       WHERE m.home_id = ? GROUP BY m.id ORDER BY m.seq`,
    )
    .bind(homeId)
    .all<{ member_id: string; name: string; outstanding: number }>()
  return c.json({
    balances: results.map((r) => ({
      memberId: r.member_id,
      name: r.name,
      outstandingCents: r.outstanding,
    })),
  })
})

app.notFound((c) => c.json({ error: 'not found' }, 404))

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'internal server error' }, 500)
})

export default app
