/**
 * The official `command-code` CLI model catalog: the column set the public
 * Provider API listing omits, refreshed from the published CLI package.
 *
 * The listing at `/provider/v1/models` answers anonymously with ids, names, and
 * context lengths only. Reasoning efforts and the lowest plan that includes a
 * model are published in the CLI's own `reference/models.md`, which this module
 * parses so plan filtering and effort selection track each CLI release. A
 * bundled snapshot serves the same data when the package host is unreachable.
 * @module dsh-provider-commandcode/reference
 */

import { STATIC_REFERENCE } from './static-reference.js'
import type { PlanId, ReferenceModel } from './reference-types.js'

/** Model catalog shipped inside the published `command-code` package. */
const REFERENCE_PATH = 'dist/bundled/command-code-knowledge/reference/models.md'

/** Catalog hosts in preference order; unpkg tracks `@latest` most promptly. */
export const REFERENCE_URLS: readonly string[] = [
  `https://unpkg.com/command-code@latest/${REFERENCE_PATH}`,
  `https://cdn.jsdelivr.net/npm/command-code@latest/${REFERENCE_PATH}`,
]

/** Default freshness of one fetched catalog. */
export const DEFAULT_REFERENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Default timeout of one catalog request. */
export const DEFAULT_REFERENCE_TIMEOUT_MS = 15_000

const PLAN_ORDER: Readonly<Record<PlanId, number>> = { go: 0, goat: 1, pro: 2, max: 3 }

/** Whether one plan is at least as high as another. */
export function planCovers(plan: PlanId, required: PlanId): boolean {
  return PLAN_ORDER[plan] >= PLAN_ORDER[required]
}

/** Rank of one plan, for sorting or comparisons outside this module. */
export function planRank(plan: PlanId): number {
  return PLAN_ORDER[plan]
}

/** The tier a catalog `Min plan` cell names. */
export function minPlanOf(cell: string | undefined): PlanId | undefined {
  const head = cell?.trim().split(/\s+/u)[0]?.toLowerCase()
  return head === 'go' || head === 'goat' || head === 'pro' || head === 'max' ? head : undefined
}

/** Parse one context cell such as `1M`, `1.05M`, or `256K`. */
function contextOf(cell: string | undefined): number | undefined {
  const match = /^([\d.]+)\s*([KM])$/u.exec(cell?.trim() ?? '')
  if (match === null) return undefined
  const value = Number(match[1]) * (match[2] === 'M' ? 1_000_000 : 1_000)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/** Parse one `Efforts` cell; an em dash means no selectable effort. */
function effortsOf(cell: string | undefined): string[] {
  const text = cell?.trim() ?? ''
  if (text.length === 0 || text === '—' || text === '-') return []
  return text.split(',').map((part) => part.trim().toLowerCase()).filter((part) => /^[a-z]+$/u.test(part))
}

/**
 * Parse the CLI catalog markdown into model rows.
 * @param markdown - contents of `reference/models.md`.
 * @returns rows keyed by exact model id, in catalog order.
 * @throws when the document carries no model table, so a changed format fails
 *   loudly instead of silently dropping plan data.
 */
export function parseReferenceCatalog(markdown: string): Map<string, ReferenceModel> {
  const models = new Map<string, ReferenceModel>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
    if (cells.length < 6) continue
    const id = (cells[0] ?? '').replace(/^`|`$/gu, '')
    if (id.length === 0) continue
    const contextWindow = contextOf(cells[2])
    models.set(id, {
      id,
      name: cells[1] ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      efforts: effortsOf(cells[3]),
      ...minPlanOf(cells[5]) === undefined ? {} : { minPlan: minPlanOf(cells[5]) as PlanId },
    })
  }
  if (models.size === 0) throw new Error('the Command Code CLI catalog carries no model table')
  return models
}

/** The bundled snapshot as a lookup, computed once. */
export const STATIC_REFERENCE_INDEX: ReadonlyMap<string, ReferenceModel> = new Map(
  STATIC_REFERENCE.map((model) => [model.id, model]),
)

/** Transport inputs of one catalog refresh. */
export interface FetchReferenceOptions {
  /** Catalog URLs in preference order. */
  readonly urls?: readonly string[]
  /** Per-request timeout. */
  readonly timeoutMs?: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
  /** Fetch implementation for tests. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Fetch the CLI catalog from the first host that answers with a usable table.
 * @param options - hosts, timeout, cancellation.
 * @returns the parsed rows.
 * @throws with every host's failure once none answers.
 */
export async function fetchReferenceCatalog(options: FetchReferenceOptions = {}): Promise<Map<string, ReferenceModel>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const failures: string[] = []
  for (const url of options.urls ?? REFERENCE_URLS) {
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REFERENCE_TIMEOUT_MS)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      const response = await fetchImpl(url, { signal, redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parseReferenceCatalog(await response.text())
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`no Command Code CLI catalog host answered (${failures.join('; ')})`)
}

/** One resolved catalog view. */
export interface ReferenceView {
  /** Rows by exact model id. */
  readonly models: ReadonlyMap<string, ReferenceModel>
  /** Where the rows came from. */
  readonly source: 'live' | 'cache' | 'static'
  /** When the live catalog was fetched. */
  readonly fetchedAt?: number
  /** Diagnostic for a failed refresh; the served rows stay usable. */
  readonly warning?: string
}

/** Inputs for one cached catalog. */
export interface ReferenceCacheOptions {
  /** Fetch the live catalog. */
  readonly load: (signal: AbortSignal) => Promise<ReadonlyMap<string, ReferenceModel>>
  /** Bundle-host time-to-live, in milliseconds. */
  readonly maxAgeMs?: number
  /** Clock for tests. */
  readonly now?: () => number
  /** Diagnostic sink. */
  readonly warn?: (message: string) => void
}

/** Serve the freshest CLI catalog available, falling back to the snapshot. */
export class ReferenceCache {
  private last: { models: ReadonlyMap<string, ReferenceModel>; fetchedAt: number } | undefined
  private inflight: Promise<ReferenceView> | undefined
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(private readonly options: ReferenceCacheOptions) {
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_REFERENCE_MAX_AGE_MS
  }

  /** The best catalog available without waiting for I/O. */
  current(): ReferenceView {
    if (this.last !== undefined) return { models: this.last.models, source: 'cache', fetchedAt: this.last.fetchedAt }
    return { models: STATIC_REFERENCE_INDEX, source: 'static' }
  }

  /** The served catalog, refreshing a stale one. */
  async view(signal?: AbortSignal): Promise<ReferenceView> {
    if (this.last !== undefined && this.now() - this.last.fetchedAt < this.maxAgeMs) {
      return { models: this.last.models, source: 'live', fetchedAt: this.last.fetchedAt }
    }
    return await this.refresh(signal)
  }

  /** Force one refresh, sharing a concurrent request. */
  async refresh(signal?: AbortSignal): Promise<ReferenceView> {
    this.inflight ??= this.fetchOnce(signal).finally(() => { this.inflight = undefined })
    return await this.inflight
  }

  /** Drop the cached catalog, so the next view fetches again. */
  reset(): void {
    this.last = undefined
  }

  private async fetchOnce(signal?: AbortSignal): Promise<ReferenceView> {
    try {
      const models = await this.options.load(signal ?? new AbortController().signal)
      const fetchedAt = this.now()
      this.last = { models, fetchedAt }
      return { models, source: 'live', fetchedAt }
    } catch (error) {
      if (signal?.aborted === true) throw error
      const warning = `Command Code CLI catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
      this.options.warn?.(warning)
      return this.last === undefined
        ? { models: STATIC_REFERENCE_INDEX, source: 'static', warning }
        : { models: this.last.models, source: 'cache', fetchedAt: this.last.fetchedAt, warning }
    }
  }
}
