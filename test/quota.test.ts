import { describe, expect, test, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AccountStore, parseCredits, parseSubscription } from '../src/account.js'
import { QuotaReader, formatAmount, formatCountdown, formatQuotaText } from '../src/quota.js'

describe('parseSubscription', () => {
  test('reads the fields the plugin uses', () => {
    expect(parseSubscription({
      success: true,
      data: { id: 'sub_1', planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-12-04T23:34:22.000Z', cancelAtPeriodEnd: false },
    })).toEqual({
      id: 'sub_1',
      planId: 'individual-goat',
      status: 'active',
      currentPeriodEnd: Date.parse('2026-12-04T23:34:22.000Z'),
      cancelAtPeriodEnd: false,
    })
  })

  test('ignores a body with no plan', () => {
    expect(parseSubscription({ data: { status: 'active' } })).toBeUndefined()
    expect(parseSubscription(null)).toBeUndefined()
  })
})

describe('parseCredits', () => {
  test('reads credits, windows, and sandbox minutes', () => {
    const reading = parseCredits({
      credits: { belowThreshold: false, monthlyCredits: 67.55, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1.03, cap: 14, exceeded: false, resetAt: 1793950228617 },
        weekly: { used: 2.44, cap: 35, exceeded: true, resetAt: 1794454011965 },
      },
      sandboxMinutes: { usedMinutes: 3, limitMinutes: 60, overageUsd: 0, resetAt: 1796083200000 },
    })
    expect(reading).toMatchObject({
      monthlyCredits: 67.55,
      purchasedCredits: 0,
      freeCredits: 0,
      fiveHour: { used: 1.03, cap: 14, exceeded: false, resetAt: 1793950228617 },
      weekly: { used: 2.44, cap: 35, exceeded: true },
      exceeded: true,
      sandbox: { usedMinutes: 3, limitMinutes: 60 },
    })
  })

  test('accepts numeric strings and seconds-based reset times', () => {
    const reading = parseCredits({ credits: { monthlyCredits: '10' }, windowLimits: { weekly: { used: '1', cap: '2', resetAt: 1_793_950_228 } } })
    expect(reading.monthlyCredits).toBe(10)
    expect(reading.weekly).toMatchObject({ used: 1, cap: 2, resetAt: 1_793_950_228_000 })
  })

  test('refuses a body that is not an object', () => {
    expect(() => parseCredits('nope')).toThrow(/not an object/u)
  })
})

describe('AccountStore', () => {
  test('caches each reading on its own clock and re-reads on force', async () => {
    let now = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      return path.endsWith('/subscriptions')
        ? new Response(JSON.stringify({ data: { planId: 'individual-goat', status: 'active' } }))
        : new Response(JSON.stringify({ credits: { monthlyCredits: 50 } }))
    })
    const store = new AccountStore({
      baseURL: () => 'https://api.test/provider/v1',
      apiKey: async () => 'user_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    })
    await store.subscription()
    await store.subscription()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now = 60_000
    await store.credits()
    await store.credits()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await store.credits(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const call = fetchImpl.mock.calls[0]?.[0]
    expect(String(call)).toBe('https://api.test/alpha/billing/subscriptions')
  })

  test('classifies a refused read with the inference failure codes', async () => {
    const store = new AccountStore({
      baseURL: () => 'https://api.test/provider/v1',
      apiKey: async () => 'user_1',
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch,
    })
    await expect(store.credits()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL', failure: { status: 401 } })
  })

  test('retries an account read with the next credential after a 401', async () => {
    let key = 'user_stale'
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string>).authorization)
      return authorization === 'Bearer user_stale'
        ? new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
        : new Response(JSON.stringify({ data: { planId: 'individual-goat', status: 'active' } }))
    })
    const store = new AccountStore({
      baseURL: () => 'https://api.test/provider/v1',
      apiKey: async () => key,
      rejectKey: async () => { key = 'user_fresh'; return key },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(store.subscription()).resolves.toMatchObject({ planId: 'individual-goat' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('reports a missing credential instead of calling out', async () => {
    const fetchImpl = vi.fn()
    const store = new AccountStore({
      baseURL: () => 'https://api.test/provider/v1',
      apiKey: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(store.subscription()).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

const reader = (subscription: unknown, credits: unknown, now = () => 1000) => {
  const store = {
    subscription: vi.fn(async () => subscription),
    credits: vi.fn(async () => credits),
  } as unknown as AccountStore
  return new QuotaReader(store, now)
}

describe('QuotaReader', () => {
  const GOAT = { id: 'sub_1', planId: 'individual-goat', status: 'active', currentPeriodEnd: 1_800_000_000_000 }

  test('reports windows, the month, and the balance in credits', async () => {
    const quota = reader(GOAT, {
      monthlyCredits: 60, purchasedCredits: 2, freeCredits: 1,
      fiveHour: { used: 3.5, cap: 14, exceeded: false, resetAt: 1_800_000_000_000 },
      weekly: { used: 7, cap: 35, exceeded: false },
    })
    const snapshot = await quota.read()
    expect(snapshot).toMatchObject({
      configured: true,
      fetchedAt: 1000,
      unit: 'credits',
      plan: { id: 'individual-goat', name: 'GOAT', renewsAt: 1_800_000_000_000 },
      windows: {
        fiveHour: { used: 3.5, limit: 14, percent: 25, resetsAt: 1_800_000_000_000, exceeded: false },
        weekly: { used: 7, limit: 35, percent: 20, exceeded: false },
      },
      // GOAT includes 70 credits a month; 63 remain of that pool plus 3 extra.
      monthly: { used: 10, limit: 73, remaining: 63, renewsAt: 1_800_000_000_000 },
      balance: { monthly: 60, purchased: 2, free: 1 },
      exceeded: false,
    })
  })

  test('omits the month row on a plan with no monthly allowance', async () => {
    const quota = reader({ planId: 'individual-provider', status: 'active' }, { monthlyCredits: 12, purchasedCredits: 0, freeCredits: 0 })
    const snapshot = await quota.read()
    expect(snapshot).toMatchObject({ unit: 'usd', balance: { monthly: 12 } })
    expect('monthly' in snapshot).toBe(false)
  })

  test('reports the unconfigured marker when no key is stored', async () => {
    const store = {
      subscription: vi.fn(),
      credits: vi.fn(async () => { throw new LlmError('no key', 'MISSING_CREDENTIAL') }),
    } as unknown as AccountStore
    await expect(new QuotaReader(store).read()).resolves.toEqual({ configured: false })
  })

  test('propagates an account failure', async () => {
    const store = {
      subscription: vi.fn(async () => GOAT),
      credits: vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'TRANSPORT' }) }),
    } as unknown as AccountStore
    await expect(new QuotaReader(store).read()).rejects.toThrow(/offline/u)
  })
})

describe('quota formatting', () => {
  test('formats amounts in their unit', () => {
    expect(formatAmount(3, 'usd')).toBe('$3')
    expect(formatAmount(3.456, 'usd')).toBe('$3.46')
    expect(formatAmount(67.55, 'credits')).toBe('67.55')
  })

  test('formats countdowns in the coarsest useful unit', () => {
    const now = 1_000_000
    expect(formatCountdown(now + 30_000, now)).toBe('1m')
    expect(formatCountdown(now + 3 * 3_600_000, now)).toBe('3h 0m')
    expect(formatCountdown(now + 50 * 3_600_000, now)).toBe('2d 2h')
    expect(formatCountdown(undefined, now)).toBeUndefined()
  })

  test('renders a full reading as terminal text', async () => {
    const snapshot = await reader(
      { planId: 'individual-goat', status: 'active', currentPeriodEnd: 1_800_000_000_000 },
      { monthlyCredits: 60, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 7, cap: 14, resetAt: 1_100_000 } },
    ).read()
    const text = formatQuotaText(snapshot, 1_000_000)
    expect(text).toContain('plan: GOAT (renews in')
    expect(text).toContain('5-hour: 50% used · 7 / 14')
    expect(text).toContain('month: 14.3% used')
    expect(text).toContain('updated: 1970-01-01T00:00:01.000Z')
  })

  test('renders the unconfigured reply', () => {
    expect(formatQuotaText({ configured: false })).toMatch(/no Command Code credential/u)
  })
})
