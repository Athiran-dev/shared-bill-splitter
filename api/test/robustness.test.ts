import { describe, expect, it } from 'vitest'
import { call, createBill, createHome, type Share } from './helpers'

function pay(billId: string, shareId: string, key: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: { 'Idempotency-Key': key },
  })
}

describe('robustness', () => {
  it('lets only one of two simultaneous payments win', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const [a, b] = await Promise.all([
      pay(bill.body.id, share.id, 'key-a'),
      pay(bill.body.id, share.id, 'key-b'),
    ])

    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('answers 200 to many simultaneous requests with the same key', async () => {
    const { homeId } = await createHome(['Asha'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const results = await Promise.all(
      Array.from({ length: 5 }, () => pay(bill.body.id, share.id, 'same-key')),
    )

    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(new Set(results.map((r) => r.body.paidAt)).size).toBe(1)
  })

  it('does not accept a share through the wrong bill', async () => {
    const { homeId } = await createHome(['Asha'])
    const first = await createBill(homeId, 1000)
    const second = await createBill(homeId, 1000)
    const share = first.body.shares[0]
    if (!share) throw new Error('no share')

    const paid = await pay(second.body.id, share.id, 'k')

    expect(paid.status).toBe(404)
  })

  it('answers bad JSON and blank names with JSON errors, not a crash', async () => {
    const bad = await exportsFetch('{not json')
    expect(bad.status).toBe(422)
    const home = await call('POST', '/api/homes', { body: { name: '   ' } })
    expect(home.status).toBe(422)
  })

  it('always answers errors as JSON', async () => {
    const missing = await call<{ error: string }>('GET', '/api/nope')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toEqual(expect.any(String))
  })
})

async function exportsFetch(rawBody: string) {
  const { exports } = await import('cloudflare:workers')
  const response = await exports.default.fetch(
    new Request('http://localhost/api/homes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    }),
  )
  return { status: response.status }
}
