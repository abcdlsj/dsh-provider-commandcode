import { describe, expect, test, vi } from 'vitest'
import {
  ReferenceCache, fetchReferenceCatalog, parseReferenceCatalog, planCovers, planRank, STATIC_REFERENCE_INDEX,
} from '../src/reference.js'

const markdown = `# Command Code Models

| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`acme/alpha\` | Alpha | 1M | off, high, max | $1/$2 | Go and above | fast |
| \`acme/beta\` | Beta | 1.05M | low, medium, high, xhigh, max | $1/$2 | Pro and above | smart |
| \`acme/gamma\` | Gamma | — | — | $1/$2 | Max | big |
| \`acme/delta\` | Delta | 256K | — | $1/$2 | GOAT and above | cheap |
`

describe('parseReferenceCatalog', () => {
  test('reads context, efforts, and plan floors from the CLI table', () => {
    const models = parseReferenceCatalog(markdown)
    expect(models.get('acme/alpha')).toEqual({
      id: 'acme/alpha', name: 'Alpha', contextWindow: 1_000_000, efforts: ['off', 'high', 'max'], minPlan: 'go',
    })
    expect(models.get('acme/beta')).toMatchObject({ contextWindow: 1_050_000, minPlan: 'pro' })
    expect(models.get('acme/gamma')).toMatchObject({ efforts: [], minPlan: 'max' })
    expect(models.get('acme/delta')).toMatchObject({ contextWindow: 256_000, minPlan: 'goat' })
    expect(models.get('acme/gamma')).not.toHaveProperty('contextWindow')
  })

  test('refuses a document with no model table', () => {
    expect(() => parseReferenceCatalog('# nothing here')).toThrow(/no model table/u)
  })

  test('the bundled snapshot covers every model the live listing serves', () => {
    const claude = STATIC_REFERENCE_INDEX.get('claude-opus-5')
    expect(claude?.minPlan).toBe('max')
    expect(STATIC_REFERENCE_INDEX.get('deepseek/deepseek-v4-flash')).toMatchObject({
      efforts: ['off', 'high', 'max'], minPlan: 'go',
    })
    expect(STATIC_REFERENCE_INDEX.size).toBeGreaterThan(50)
  })
})

describe('plan ordering', () => {
  test('orders tiers and compares them', () => {
    expect(planRank('go')).toBeLessThan(planRank('goat'))
    expect(planRank('goat')).toBeLessThan(planRank('pro'))
    expect(planCovers('max', 'pro')).toBe(true)
    expect(planCovers('pro', 'max')).toBe(false)
    expect(planCovers('goat', 'goat')).toBe(true)
  })
})

describe('fetchReferenceCatalog', () => {
  test('uses the first host that answers, then the next', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('redirect body', { status: 200 }))
      .mockResolvedValueOnce(new Response(markdown, { status: 200 }))
    const models = await fetchReferenceCatalog({ urls: ['https://a.test/x', 'https://b.test/x'], fetchImpl: fetchImpl as unknown as typeof fetch })
    // The first host's body has no table, so parsing fails and the second is tried.
    expect(models.get('acme/beta')).toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('reports every host failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(fetchReferenceCatalog({ urls: ['https://a.test/x'], fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/no Command Code CLI catalog host answered.*HTTP 503/u)
  })
})

describe('ReferenceCache', () => {
  test('serves the bundled snapshot before a first fetch', () => {
    const cache = new ReferenceCache({ load: async () => STATIC_REFERENCE_INDEX })
    expect(cache.current()).toMatchObject({ source: 'static' })
  })

  test('refreshes stale data and keeps the last good table on failure', async () => {
    let now = 0
    const warn = vi.fn()
    const load = vi.fn()
      .mockResolvedValueOnce(parseReferenceCatalog(markdown))
      .mockRejectedValueOnce(new Error('offline'))
    const cache = new ReferenceCache({ load, maxAgeMs: 10, now: () => now, warn })
    expect((await cache.view()).source).toBe('live')
    now = 100
    const view = await cache.view()
    expect(view.source).toBe('cache')
    expect(view.models.get('acme/alpha')).toBeDefined()
    expect(view.warning).toMatch(/offline/u)
    expect(warn).toHaveBeenCalledOnce()
  })
})
