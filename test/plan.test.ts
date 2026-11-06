import { describe, expect, test, vi } from 'vitest'
import type { AccountStore } from '../src/account.js'
import { buildCatalog, fallbackCatalog } from '../src/catalog.js'
import { PlanGate, planInfo, servedModels } from '../src/plan.js'

function account(subscription: unknown, credits: unknown = { monthlyCredits: 50, purchasedCredits: 0, freeCredits: 0 }) {
  return {
    subscription: vi.fn(async () => subscription),
    credits: vi.fn(async () => credits),
  } as unknown as AccountStore & { subscription: ReturnType<typeof vi.fn>; credits: ReturnType<typeof vi.fn> }
}

const GOAT = { id: 'sub_1', planId: 'individual-goat', status: 'active', currentPeriodEnd: 1_800_000_000_000 }

describe('planInfo', () => {
  test('maps every plan id, most specific prefix first', () => {
    expect(planInfo('individual-provider')).toMatchObject({ plan: 'all', name: 'Provider', monthlyAllowance: 0, unit: 'usd' })
    expect(planInfo('individual-ultra')).toMatchObject({ plan: 'all', name: 'Ultra', monthlyAllowance: 300 })
    expect(planInfo('individual-max')).toMatchObject({ plan: 'max', name: 'Max', monthlyAllowance: 150, unit: 'usd' })
    expect(planInfo('teams-pro')).toMatchObject({ plan: 'all', name: 'Teams', monthlyAllowance: 40 })
    expect(planInfo('individual-pro-v1')).toMatchObject({ plan: 'pro', monthlyAllowance: 80, unit: 'credits' })
    expect(planInfo('individual-pro')).toMatchObject({ plan: 'pro', monthlyAllowance: 30 })
    expect(planInfo('individual-goat')).toMatchObject({ plan: 'goat', name: 'GOAT', monthlyAllowance: 70 })
    expect(planInfo('individual-go')).toMatchObject({ plan: 'go', name: 'Go', monthlyAllowance: 10 })
  })

  test('normalizes case and underscores, and ignores unknown ids', () => {
    expect(planInfo('Individual_GOAT')).toMatchObject({ plan: 'goat' })
    expect(planInfo('enterprise')).toBeUndefined()
    expect(planInfo(undefined)).toBeUndefined()
  })
})

describe('PlanGate', () => {
  test('a configured tier needs no account read', async () => {
    const store = account(GOAT)
    const gate = new PlanGate({ choice: 'goat', account: store })
    await expect(gate.current()).resolves.toMatchObject({ plan: 'goat', source: 'config', unrestricted: false })
    expect(store.subscription).not.toHaveBeenCalled()
  })

  test('all disables filtering and needs no account read', async () => {
    const gate = new PlanGate({ choice: 'all', account: account(GOAT) })
    await expect(gate.current()).resolves.toMatchObject({ plan: 'all', unrestricted: true })
  })

  test('auto reads the account plan and its renewal', async () => {
    const store = account(GOAT)
    const gate = new PlanGate({ choice: 'auto', account: store, now: () => 1000 })
    const resolution = await gate.current()
    expect(resolution).toMatchObject({
      plan: 'goat', planId: 'individual-goat', planName: 'GOAT', source: 'account', unrestricted: false,
      renewsAt: 1_800_000_000_000, resolvedAt: 1000,
    })
    // Cached: a second read within the window asks nothing.
    await gate.current()
    expect(store.subscription).toHaveBeenCalledTimes(1)
    await gate.current(true)
    expect(store.subscription).toHaveBeenCalledTimes(2)
  })

  test('bought or granted credits make every model reachable', async () => {
    const store = account(GOAT, { monthlyCredits: 50, purchasedCredits: 5, freeCredits: 0 })
    const gate = new PlanGate({ choice: 'auto', account: store })
    await expect(gate.current()).resolves.toMatchObject({ plan: 'goat', unrestricted: true })
  })

  test('an unknown plan keeps every model listed, with a warning', async () => {
    const warn = vi.fn()
    const gate = new PlanGate({ choice: 'auto', account: account({ planId: 'enterprise' }), warn })
    await expect(gate.current()).resolves.toMatchObject({ plan: 'all', source: 'fallback', unrestricted: true })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unrecognized Command Code plan/u))
  })

  test('retries a failed plan read sooner than a good one', async () => {
    let now = 0
    const store = {
      subscription: vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ planId: 'individual-goat', status: 'active' }),
      credits: vi.fn(async () => ({})),
    } as unknown as AccountStore
    const gate = new PlanGate({ choice: 'auto', account: store, now: () => now, warn: () => {} })
    expect((await gate.current()).source).toBe('fallback')
    now = 30_000
    expect((await gate.current()).source).toBe('fallback')
    expect(store.subscription).toHaveBeenCalledTimes(1)
    now = 61_000
    expect((await gate.current()).source).toBe('account')
    expect(store.subscription).toHaveBeenCalledTimes(2)
  })

  test('an unreadable account fails open, never hiding models', async () => {
    const warn = vi.fn()
    const gate = new PlanGate({
      choice: 'auto',
      account: {
        subscription: vi.fn(async () => { throw new Error('offline') }),
        credits: vi.fn(async () => ({})),
      } as unknown as AccountStore,
      warn,
    })
    await expect(gate.current()).resolves.toMatchObject({ plan: 'all', source: 'fallback', unrestricted: true })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/every model stays listed/u))
  })
})

describe('servedModels', () => {
  const models = buildCatalog([
    { id: 'stealth/glyph-cluster:free', name: 'Glyph Cluster' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
  ])

  const resolution = (plan: 'go' | 'goat' | 'pro' | 'max' | 'all', unrestricted = false) => ({
    plan, source: 'account' as const, unrestricted,
  })

  test('hides models above the account tier', () => {
    expect(servedModels(models, resolution('go')).map((model) => model.id)).toEqual(['stealth/glyph-cluster:free'])
    expect(servedModels(models, resolution('goat')).map((model) => model.id)).toEqual(['stealth/glyph-cluster:free'])
    expect(servedModels(models, resolution('pro')).map((model) => model.id)).toEqual(['stealth/glyph-cluster:free', 'gpt-6-sol'])
    expect(servedModels(models, resolution('max'))).toHaveLength(3)
    expect(servedModels(models, resolution('all'))).toHaveLength(3)
  })

  test('extra credits restore every model', () => {
    expect(servedModels(models, resolution('go', true))).toHaveLength(3)
  })

  test('a model no source gates stays listed', () => {
    const unknown = buildCatalog([{ id: 'acme/new', name: 'New' }])
    expect(servedModels(unknown, resolution('go'))).toHaveLength(1)
  })

  test('the bundled catalog carries plan floors for filtering', () => {
    const catalog = fallbackCatalog()
    expect(catalog.find((model) => model.id === 'claude-opus-5')?.minPlan).toBe('max')
    expect(catalog.find((model) => model.id === 'gpt-6-sol')?.minPlan).toBe('pro')
  })
})
