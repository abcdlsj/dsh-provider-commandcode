import { describe, expect, test, vi } from 'vitest'
import {
  CatalogCache, buildCatalog, fallbackCatalog, fetchModels, heuristicEfforts, modelById, parseListing, wireFor,
} from '../src/catalog.js'
import type { DiscoveryResult } from '../src/catalog.js'

const listing = (ids: string[]) => ({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model', name: id.toUpperCase(), context_length: 500_000, supported_endpoints: ['/chat/completions'] })),
})

describe('parseListing', () => {
  test('keeps valid entries in order and drops unusable ones', () => {
    const parsed = parseListing({
      data: [
        { id: 'a', name: 'A', context_length: 1000, supported_endpoints: ['/chat/completions', 7] },
        { id: 'a', name: 'duplicate' },
        { id: '', name: 'empty id' },
        42,
        { id: 'b' },
      ],
    })
    expect(parsed.entries).toEqual([
      { id: 'a', name: 'A', contextWindow: 1000, endpoints: ['/chat/completions'] },
      { id: 'b', name: 'b' },
    ])
    expect(parsed.dropped).toBe(3)
  })

  test('refuses a body with no data array', () => {
    expect(() => parseListing({ data: 'nope' })).toThrow(/no data array/u)
    expect(() => parseListing(null)).toThrow(/no data array/u)
  })
})

describe('wire selection', () => {
  test('uses the advertised endpoint, then the id heuristic', () => {
    expect(wireFor('claude-opus-5', ['/messages'])).toBe('messages')
    expect(wireFor('gpt-6-sol', ['/chat/completions', '/responses'])).toBe('chat')
    expect(wireFor('claude-opus-5', undefined)).toBe('messages')
    expect(wireFor('gpt-6-sol', undefined)).toBe('chat')
  })
})

describe('buildCatalog', () => {
  test('merges live identity with the bundled capabilities', () => {
    const [claude] = buildCatalog([{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 900_000, endpoints: ['/messages'] }])
    expect(claude).toMatchObject({
      id: 'claude-sonnet-5',
      contextWindow: 900_000,
      wire: 'messages',
      inputModalities: ['text', 'image'],
      origin: 'live',
    })
    expect(claude?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('applies overrides and adds declared models', () => {
    const models = buildCatalog(
      [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }],
      [
        { id: 'claude-sonnet-5', name: 'Sonnet (org)', efforts: [] },
        { id: 'acme/new-model', name: 'New', wire: 'chat', contextWindow: 100_000, efforts: ['low'] },
      ],
    )
    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-5', 'acme/new-model'])
    expect(models[0]).toMatchObject({ name: 'Sonnet (org)', efforts: [], origin: 'live' })
    expect(models[1]).toMatchObject({
      name: 'New', wire: 'chat', contextWindow: 100_000, efforts: ['low'], origin: 'config',
    })
  })

  test('keeps a live listing authoritative about what is served', () => {
    const models = buildCatalog([{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }])
    expect(models.map((model) => model.id)).toEqual(['gpt-6-sol'])
  })
})

describe('fallback catalog', () => {
  test('serves the bundled snapshot with overrides applied', () => {
    const models = fallbackCatalog([{ id: 'gpt-6-sol', name: 'Renamed', efforts: [] }])
    expect(models.find((model) => model.id === 'gpt-6-sol')).toMatchObject({ name: 'Renamed', efforts: [], origin: 'config' })
    expect(models.some((model) => model.id === 'claude-opus-5')).toBe(true)
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length)
  })

  test('describes unknown ids with family capabilities', () => {
    expect(modelById([], 'claude-opus-9')).toMatchObject({ wire: 'messages', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(modelById([], 'some-local-model')).toMatchObject({ wire: 'chat', inputModalities: ['text'], efforts: [] })
    expect(heuristicEfforts('google/gemini-9-flash')).toEqual(['low', 'medium', 'high'])
  })
})

describe('fetchModels', () => {
  test('sends the credential on both headers and parses the body', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(listing(['a', 'b'])), { status: 200 }))
    const result = await fetchModels({ url: 'https://example.test/models', apiKey: 'user_1', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'b'])
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.headers).toMatchObject({ authorization: 'Bearer user_1', 'x-api-key': 'user_1' })
  })

  test('refuses a failed request', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(fetchModels({ url: 'https://example.test/models', fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow(/HTTP 503/u)
  })
})

describe('CatalogCache', () => {
  const discovery = (ids: string[], fetchedAt = 1000): DiscoveryResult => ({
    entries: ids.map((id) => ({ id, name: id })),
    dropped: 0,
    fetchedAt,
  })

  test('reuses a fresh listing and refreshes a stale one', async () => {
    let now = 0
    const load = vi.fn(async () => discovery(['a'], now))
    const cache = new CatalogCache({
      load, maxAgeMs: 100, build: (entries) => buildCatalog(entries), fallback: () => fallbackCatalog(), now: () => now,
    })
    expect((await cache.view()).source).toBe('live')
    now = 50
    expect((await cache.view()).source).toBe('cache')
    expect(load).toHaveBeenCalledTimes(1)
    now = 500
    expect((await cache.view()).source).toBe('live')
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('serves the previous catalog after a failed refresh', async () => {
    let now = 0
    const warn = vi.fn()
    const load = vi.fn()
      .mockResolvedValueOnce(discovery(['a'], 0))
      .mockRejectedValueOnce(new Error('offline'))
    const cache = new CatalogCache({
      load, maxAgeMs: 10, build: (entries) => buildCatalog(entries), fallback: () => fallbackCatalog(), now: () => now, warn,
    })
    await cache.view()
    now = 100
    const view = await cache.view()
    expect(view.source).toBe('cache')
    expect(view.models.map((model) => model.id)).toEqual(['a'])
    expect(view.warning).toMatch(/offline/u)
    expect(warn).toHaveBeenCalledOnce()
  })

  test('serves the bundled catalog when discovery never succeeded', async () => {
    const cache = new CatalogCache({
      load: async () => { throw new Error('offline') },
      maxAgeMs: 10,
      build: (entries) => buildCatalog(entries),
      fallback: () => fallbackCatalog(),
    })
    const view = await cache.view()
    expect(view.source).toBe('static')
    expect(view.models.length).toBeGreaterThan(50)
  })

  test('shares one in-flight refresh', async () => {
    let release: (value: DiscoveryResult) => void = () => {}
    const load = vi.fn(async () => new Promise<DiscoveryResult>((resolve) => { release = resolve }))
    const cache = new CatalogCache({
      load, maxAgeMs: 10, build: (entries) => buildCatalog(entries), fallback: () => fallbackCatalog(),
    })
    const first = cache.refresh()
    const second = cache.refresh()
    release(discovery(['a']))
    await Promise.all([first, second])
    expect(load).toHaveBeenCalledTimes(1)
  })
})
