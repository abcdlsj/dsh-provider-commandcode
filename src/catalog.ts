/**
 * Command Code model discovery: live `/provider/v1/models`, the bundled
 * fallback snapshot, and deployment overrides merged into one catalog.
 * @module dsh-provider-commandcode/catalog
 */

import { STATIC_MODELS } from './static-catalog.js'
import { STATIC_REFERENCE_INDEX, planCovers } from './reference.js'
import type { PlanId, ReferenceModel } from './reference-types.js'
import type { CatalogModel, InputModality, ModelOverride, StaticModel, Wire } from './catalog-types.js'

/** Default endpoint of Command Code's Provider API. */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'

/** Default request timeout for one catalog discovery. */
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000

/** Default maximum output tokens when neither the manifest nor configuration names one. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Default context capacity for a model no source describes. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** CLI manifest version this plugin mirrors in its request headers and fallback data. */
export const CATALOG_CLI_VERSION = '1.88.3'

/** Request-image byte budget one model request may carry, before base64 expansion. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 5 * 1024 * 1024

/** Request-image count budget one model request may carry. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 10

const CAPABILITIES = new Map(STATIC_MODELS.map((model) => [model.id, model]))

/** Every model of the bundled fallback snapshot, in discovery order. */
export const FALLBACK_MODELS: readonly CatalogModel[] = STATIC_MODELS.map((model) => materialize(model, 'static'))

function materialize(model: StaticModel, origin: CatalogModel['origin']): CatalogModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    wire: model.wire,
    inputModalities: model.inputModalities ?? ['text'],
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    efforts: model.efforts ?? [],
    origin,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Resolve the wire that serves one model from its advertised endpoints. */
export function wireFor(id: string, endpoints: readonly string[] | undefined): Wire {
  if (endpoints?.includes('/messages') === true) return 'messages'
  if (endpoints !== undefined && endpoints.length > 0) return 'chat'
  // No endpoint metadata: Claude models answer on Messages only, so the id is
  // the only signal left, and every other model keeps the universal wire.
  return /^claude-|^anthropic\//iu.test(id) ? 'messages' : 'chat'
}

function family(id: string): 'claude' | 'gpt' | 'gemini' | 'deepseek' | 'kimi' | 'qwen' | 'glm' | 'grok' | 'other' {
  const lower = id.toLowerCase()
  if (/^(claude-|anthropic\/)/u.test(lower)) return 'claude'
  if (/^(gpt-|openai\/gpt)/u.test(lower)) return 'gpt'
  if (/gemini/u.test(lower)) return 'gemini'
  if (lower.includes('deepseek')) return 'deepseek'
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'kimi'
  if (lower.includes('qwen')) return 'qwen'
  if (lower.includes('glm')) return 'glm'
  if (lower.includes('grok')) return 'grok'
  return 'other'
}

const FAMILY_EFFORTS: Readonly<Record<ReturnType<typeof family>, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  gpt: ['low', 'medium', 'high', 'xhigh', 'max'],
  gemini: ['low', 'medium', 'high'],
  deepseek: ['low', 'high', 'max'],
  kimi: ['low', 'high', 'max'],
  qwen: ['low', 'medium', 'xhigh'],
  glm: ['low', 'high', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh'],
  other: [],
}

const IMAGE_FAMILIES = new Set(['claude', 'gpt', 'gemini', 'kimi', 'qwen', 'glm', 'grok', 'deepseek'])

/**
 * Best-effort capabilities for a model the snapshot does not describe, so a
 * model Command Code publishes later still gets a full route.
 * @param id - exact model id.
 * @returns selectable efforts, safe to leave empty when the family is unknown.
 */
export function heuristicEfforts(id: string): readonly string[] {
  return FAMILY_EFFORTS[family(id)]
}

/**
 * Resolve the request modalities of an unknown model. Only families whose
 * vision support is routine are admitted; everything else stays text-only,
 * because a false positive fails a request while a false negative only hides
 * an attachment.
 * @param id - exact model id.
 * @returns accepted modalities.
 */
export function heuristicModalities(id: string): readonly InputModality[] {
  return IMAGE_FAMILIES.has(family(id)) ? ['text', 'image'] : ['text']
}

/** One model entry as `GET /provider/v1/models` describes it. */
export interface ListEntry {
  id: string
  name: string
  contextWindow?: number
  endpoints?: readonly string[]
}

/** The parsed body of a model listing, with the count of entries it dropped. */
export interface ParsedListing {
  entries: ListEntry[]
  dropped: number
}

/**
 * Parse a Command Code model listing without trusting any field.
 * @param raw - decoded JSON body.
 * @returns valid entries in listing order, plus how many malformed entries were dropped.
 */
export function parseListing(raw: unknown): ParsedListing {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new Error('the model listing has no data array')
  }
  const entries: ListEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const item of raw.data) {
    if (!isRecord(item)) { dropped += 1; continue }
    const id = nonEmptyString(item.id)
    if (id === undefined || seen.has(id)) { dropped += 1; continue }
    const contextLength = item.context_length
    const contextWindow = typeof contextLength === 'number' && Number.isInteger(contextLength) && contextLength > 0
      ? contextLength
      : undefined
    const endpoints = Array.isArray(item.supported_endpoints)
      ? item.supported_endpoints.filter((value): value is string => typeof value === 'string')
      : undefined
    seen.add(id)
    entries.push({
      id,
      name: nonEmptyString(item.name) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...endpoints === undefined ? {} : { endpoints },
    })
  }
  return { entries, dropped }
}

/**
 * Build the served catalog from live entries, the fallback snapshot, and
 * deployment overrides, in that precedence order.
 * @param entries - live listing entries, in discovery order.
 * @param overrides - deployment-declared models and field overrides.
 * @returns model entries the adapter serves, with live order first.
 */
export function buildCatalog(
  entries: readonly ListEntry[],
  overrides: readonly ModelOverride[] = [],
  reference: ReadonlyMap<string, ReferenceModel> = STATIC_REFERENCE_INDEX,
): CatalogModel[] {
  const overrideById = new Map(overrides.map((override) => [override.id, override]))
  const result: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    seen.add(entry.id)
    const known = CAPABILITIES.get(entry.id)
    const override = overrideById.get(entry.id)
    const referenceModel = reference.get(entry.id)
    result.push({
      id: entry.id,
      name: override?.name ?? entry.name ?? referenceModel?.name,
      wire: override?.wire ?? known?.wire ?? wireFor(entry.id, entry.endpoints),
      contextWindow: override?.contextWindow ?? entry.contextWindow ?? referenceModel?.contextWindow
        ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      inputModalities: override?.inputModalities ?? known?.inputModalities ?? heuristicModalities(entry.id),
      maxTokens: override?.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      // The CLI catalog is the authority on selectable efforts; the bundled
      // manifest only stands in for a model it does not describe.
      efforts: override?.efforts
        ?? (referenceModel !== undefined && referenceModel.efforts.length > 0 ? referenceModel.efforts : undefined)
        ?? known?.efforts ?? heuristicEfforts(entry.id),
      origin: 'live',
      ...referenceModel?.minPlan === undefined ? {} : { minPlan: referenceModel.minPlan },
    })
  }
  // A live listing is authoritative about what exists, so a model it omits is
  // not served: only overrides add entries beyond it.
  for (const override of overrides) {
    if (seen.has(override.id)) continue
    seen.add(override.id)
    const known = CAPABILITIES.get(override.id)
    const referenceModel = reference.get(override.id)
    result.push({
      id: override.id,
      name: override.name ?? referenceModel?.name ?? known?.name ?? override.id,
      wire: override.wire ?? known?.wire ?? wireFor(override.id, undefined),
      contextWindow: override.contextWindow ?? referenceModel?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      inputModalities: override.inputModalities ?? known?.inputModalities ?? heuristicModalities(override.id),
      maxTokens: override.maxTokens ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      efforts: override.efforts
        ?? (referenceModel !== undefined && referenceModel.efforts.length > 0 ? referenceModel.efforts : undefined)
        ?? known?.efforts ?? heuristicEfforts(override.id),
      origin: 'config',
      ...referenceModel?.minPlan === undefined ? {} : { minPlan: referenceModel.minPlan },
    })
  }
  return result
}

/** The catalog served before any discovery has succeeded. */
export function fallbackCatalog(
  overrides: readonly ModelOverride[] = [],
  reference: ReadonlyMap<string, ReferenceModel> = STATIC_REFERENCE_INDEX,
): CatalogModel[] {
  return buildCatalog([], overrides, reference).concat(
    FALLBACK_MODELS
      .filter((model) => !overrides.some((override) => override.id === model.id))
      .map((model) => mergeReference(model, reference.get(model.id), undefined)),
  )
}

/** Fold the CLI catalog's name, context, efforts, and plan floor into one entry. */
function mergeReference(
  model: CatalogModel,
  reference: ReferenceModel | undefined,
  override: ModelOverride | undefined,
): CatalogModel {
  if (reference === undefined) return model
  return {
    ...model,
    name: override?.name ?? model.name,
    contextWindow: override?.contextWindow ?? model.contextWindow ?? reference.contextWindow ?? model.contextWindow,
    efforts: override?.efforts ?? (reference.efforts.length > 0 ? reference.efforts : model.efforts),
    ...reference.minPlan === undefined ? {} : { minPlan: reference.minPlan },
  }
}

/** Resolve the served entry for one model, falling back to the capabilities the id implies. */
export function modelById(models: readonly CatalogModel[], id: string): CatalogModel {
  const found = models.find((model) => model.id === id)
  if (found !== undefined) return found
  const known = CAPABILITIES.get(id)
  const base = known !== undefined
    ? materialize(known, 'static')
    : {
      id,
      name: id,
      wire: wireFor(id, undefined),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      inputModalities: heuristicModalities(id),
      maxTokens: DEFAULT_MAX_TOKENS,
      efforts: heuristicEfforts(id),
      origin: 'static' as const,
    }
  return mergeReference(base, STATIC_REFERENCE_INDEX.get(id), undefined)
}

/** Whether one plan may call a model. */
export function modelAllowed(
  model: CatalogModel,
  plan: PlanId | 'all',
  unrestrictedByCredits = false,
): boolean {
  if (plan === 'all' || unrestrictedByCredits) return true
  if (model.minPlan === undefined) return true
  return planCovers(plan, model.minPlan)
}

/** The entries one plan may call, in served order. */
export function visibleCatalog(
  models: readonly CatalogModel[],
  plan: PlanId | 'all',
  unrestrictedByCredits = false,
): CatalogModel[] {
  return models.filter((model) => modelAllowed(model, plan, unrestrictedByCredits))
}

/** One discovery result: the entries plus how many the endpoint returned unusable. */
export interface DiscoveryResult extends ParsedListing {
  /** Timestamp the request settled, for cache freshness. */
  fetchedAt: number
}

/** Transport inputs for one discovery request. */
export interface FetchModelsOptions {
  /** Endpoint serving the listing. */
  url: string
  /** Credential sent when available; the listing also answers anonymously. */
  apiKey?: string | undefined
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
  /** Per-request timeout, in milliseconds. */
  timeoutMs?: number
  /** Fetch implementation for tests. */
  fetchImpl?: typeof fetch
  /** Extra headers the provider requires on every request. */
  headers?: Readonly<Record<string, string>>
}

/**
 * Fetch and parse the live model listing.
 * @param options - endpoint, credential, cancellation, and timeout.
 * @returns parsed entries with the settle time.
 * @throws when the endpoint fails, times out, or returns a body with no `data` array.
 */
export async function fetchModels(options: FetchModelsOptions): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const response = await fetchImpl(options.url, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
      ...options.apiKey === undefined ? {} : {
        'authorization': `Bearer ${options.apiKey}`,
        'x-api-key': options.apiKey,
      },
      ...options.headers,
    },
    signal,
  })
  if (!response.ok) throw new Error(`model listing failed with HTTP ${response.status}`)
  const parsed = parseListing(await response.json())
  return { ...parsed, fetchedAt: Date.now() }
}

/** Cache view returned to selectors and to the adapter. */
export interface CatalogView {
  /** Served catalog. */
  readonly models: readonly CatalogModel[]
  /** Where the served catalog came from. */
  readonly source: 'live' | 'cache' | 'static'
  /** When the live listing was fetched, when one ever was. */
  readonly fetchedAt?: number
  /** Diagnostic for a failed refresh; the served catalog stays usable. */
  readonly warning?: string
}

/** Inputs for one cached discovery. */
export interface CatalogCacheOptions {
  /** Load the live listing. */
  readonly load: (signal: AbortSignal) => Promise<DiscoveryResult>
  /** Materialize the served catalog from one listing. */
  readonly build: (entries: readonly ListEntry[]) => readonly CatalogModel[]
  /** Fallback catalog served before a first successful fetch and after cache expiry failures. */
  readonly fallback: () => readonly CatalogModel[]
  /** How long a fetched listing stays fresh, in milliseconds. */
  readonly maxAgeMs: number
  /** Clock for tests. */
  readonly now?: () => number
  /** Diagnostic sink for a failed refresh. */
  readonly warn?: (message: string) => void
}

/**
 * Own the served catalog: a fresh live listing, then the last successful one,
 * then the bundled fallback. Concurrent refreshes share one request.
 */
export class CatalogCache {
  private last: DiscoveryResult | undefined
  private inflight: Promise<CatalogView> | undefined
  private readonly now: () => number

  constructor(private readonly options: CatalogCacheOptions) {
    this.now = options.now ?? Date.now
  }

  /** The best catalog available without waiting for I/O. */
  current(): CatalogView {
    if (this.last !== undefined) return this.served('cache') ?? { models: this.options.fallback(), source: 'static' }
    return { models: this.options.fallback(), source: 'static' }
  }

  /** The served catalog, refreshing a stale one unless the caller aborts. */
  async view(signal?: AbortSignal): Promise<CatalogView> {
    if (this.last !== undefined && this.now() - this.last.fetchedAt < this.options.maxAgeMs) {
      return this.freshView()
    }
    return this.refresh(signal)
  }

  /** Force one refresh, sharing a concurrent request. */
  async refresh(signal?: AbortSignal): Promise<CatalogView> {
    this.inflight ??= this.fetchOnce(signal).finally(() => { this.inflight = undefined })
    return await this.inflight
  }

  /** Drop the cached listing, so the next view fetches again. */
  reset(): void {
    this.last = undefined
  }

  private freshView(): CatalogView {
    return this.served('cache') ?? { models: this.options.fallback(), source: 'static' }
  }

  private served(source: 'live' | 'cache'): CatalogView | undefined {
    if (this.last === undefined) return undefined
    return { models: this.options.build(this.last.entries), source, fetchedAt: this.last.fetchedAt }
  }

  private async fetchOnce(signal?: AbortSignal): Promise<CatalogView> {
    try {
      const result = await this.options.load(signal ?? new AbortController().signal)
      this.last = result
      if (result.dropped > 0) this.options.warn?.(`Command Code model listing dropped ${result.dropped} unusable entries`)
      return this.served('live') ?? { models: this.options.fallback(), source: 'static' }
    } catch (error) {
      const warning = `Command Code model discovery failed: ${error instanceof Error ? error.message : String(error)}`
      this.options.warn?.(warning)
      return this.last === undefined
        ? { models: this.options.fallback(), source: 'static', warning }
        : { ...this.served('cache') as CatalogView, warning }
    }
  }
}
