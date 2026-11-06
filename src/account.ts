/**
 * Command Code account reads: the subscription tier and the credit windows
 * behind one API key.
 *
 * These are account endpoints under `/alpha`, not inference routes; they only
 * report, and never consume a model request. Each reading is cached on its own
 * clock because `billing/subscriptions` is slow while `billing/credits` answers
 * quickly enough to poll.
 * @module dsh-provider-commandcode/account
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { providerError } from './errors.js'

/** One rolling allowance window as `/alpha/billing/credits` reports it. */
export interface CreditWindow {
  /** Usage drawn in the window. */
  readonly used?: number
  /** Window cap; absent when the plan gives none. */
  readonly cap?: number
  /** Whether this window is exhausted. */
  readonly exceeded?: boolean
  /** Reset time, milliseconds since the epoch. */
  readonly resetAt?: number
}

/** The account's plan period and renewal state. */
export interface Subscription {
  /** Subscription id. */
  readonly id: string
  /** Plan id, such as `individual-goat`. */
  readonly planId: string
  /** Subscription status, such as `active`. */
  readonly status: string
  /** End of the current period, milliseconds since the epoch. */
  readonly currentPeriodEnd?: number
  /** Whether the plan stops at the period end. */
  readonly cancelAtPeriodEnd?: boolean
}

/** The credits and rolling windows of one account. */
export interface CreditReading {
  /** Credits left in the plan's month, in the plan's own unit. */
  readonly monthlyCredits?: number
  /** Bought credits on top of the plan. */
  readonly purchasedCredits?: number
  /** Granted credits on top of the plan. */
  readonly freeCredits?: number
  /** Whether the account crossed its low-balance threshold. */
  readonly belowThreshold?: boolean
  /** The five-hour window, when the plan has one. */
  readonly fiveHour?: CreditWindow
  /** The weekly window, when the plan has one. */
  readonly weekly?: CreditWindow
  /** Whether any reported window is exhausted. */
  readonly exceeded?: boolean
  /** Sandbox minutes and their monthly allowance. */
  readonly sandbox?: { readonly usedMinutes?: number; readonly limitMinutes?: number; readonly overageUsd?: number; readonly resetAt?: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return undefined
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

function epoch(value: unknown): number | undefined {
  if (typeof value === 'string' && RFC3339.test(value)) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const number = positiveNumber(value)
  if (number === undefined || number <= 0) return undefined
  return number < 1_000_000_000_000 ? number * 1000 : number
}

function windowOf(value: unknown): CreditWindow | undefined {
  if (!isRecord(value)) return undefined
  const used = positiveNumber(value.used)
  const cap = positiveNumber(value.cap)
  if (used === undefined && cap === undefined) return undefined
  return {
    ...used === undefined ? {} : { used },
    ...cap === undefined ? {} : { cap },
    exceeded: value.exceeded === true,
    ...epoch(value.resetAt) === undefined ? {} : { resetAt: epoch(value.resetAt) as number },
  }
}

/** Read one subscription reply into the fields this plugin uses. */
export function parseSubscription(raw: unknown): Subscription | undefined {
  if (!isRecord(raw)) return undefined
  const data = isRecord(raw.data) ? raw.data : raw
  const planId = typeof data.planId === 'string' ? data.planId : undefined
  if (planId === undefined) return undefined
  const periodEnd = epoch(data.currentPeriodEnd)
  return {
    id: typeof data.id === 'string' ? data.id : planId,
    planId,
    status: typeof data.status === 'string' ? data.status : 'unknown',
    ...periodEnd === undefined ? {} : { currentPeriodEnd: periodEnd },
    ...typeof data.cancelAtPeriodEnd === 'boolean' ? { cancelAtPeriodEnd: data.cancelAtPeriodEnd } : {},
  }
}

/** Read one credits reply into the fields this plugin uses. */
export function parseCredits(raw: unknown): CreditReading {
  if (!isRecord(raw)) throw new Error('the credits reply is not an object')
  const credits = isRecord(raw.credits) ? raw.credits : {}
  const limits = isRecord(raw.windowLimits) ? raw.windowLimits : {}
  const sandbox = isRecord(raw.sandboxMinutes) ? raw.sandboxMinutes : undefined
  const fiveHour = windowOf(limits.fiveHour)
  const weekly = windowOf(limits.weekly)
  return {
    ...positiveNumber(credits.monthlyCredits) === undefined ? {} : { monthlyCredits: positiveNumber(credits.monthlyCredits) as number },
    ...positiveNumber(credits.purchasedCredits) === undefined ? {} : { purchasedCredits: positiveNumber(credits.purchasedCredits) as number },
    ...positiveNumber(credits.freeCredits) === undefined ? {} : { freeCredits: positiveNumber(credits.freeCredits) as number },
    ...credits.belowThreshold === true ? { belowThreshold: true } : {},
    ...fiveHour === undefined ? {} : { fiveHour },
    ...weekly === undefined ? {} : { weekly },
    ...limits.exceeded === true || fiveHour?.exceeded === true || weekly?.exceeded === true ? { exceeded: true } : {},
    ...sandbox === undefined ? {} : {
      sandbox: {
        ...positiveNumber(sandbox.usedMinutes) === undefined ? {} : { usedMinutes: positiveNumber(sandbox.usedMinutes) as number },
        ...positiveNumber(sandbox.limitMinutes) === undefined ? {} : { limitMinutes: positiveNumber(sandbox.limitMinutes) as number },
        ...positiveNumber(sandbox.overageUsd) === undefined ? {} : { overageUsd: positiveNumber(sandbox.overageUsd) as number },
        ...epoch(sandbox.resetAt) === undefined ? {} : { resetAt: epoch(sandbox.resetAt) as number },
      },
    },
  }
}

/** Inputs every account read shares. */
export interface AccountStoreOptions {
  /** Provider API root; account endpoints live at its origin. Read lazily so a bad value fails as configuration. */
  readonly baseURL: () => string
  /** Resolve the current key; `undefined` means the account is not configured. */
  readonly apiKey: () => Promise<string | undefined>
  /**
   * Retire one refused key and resolve the next candidate, if any. Omission
   * makes an account `401` final instead of yielding to another source.
   */
  readonly rejectKey?: (key: string) => Promise<string | undefined>
  /** Fetch implementation for tests. */
  readonly fetchImpl?: typeof fetch
  /** Clock for tests. */
  readonly now?: () => number
  /** Freshness of one subscription read. */
  readonly subscriptionMaxAgeMs?: number
  /** Freshness of one credits read. */
  readonly creditsMaxAgeMs?: number
  /** Per-request timeout. */
  readonly timeoutMs?: number
  /** Diagnostic sink. */
  readonly warn?: (message: string) => void
}

interface Cached<T> {
  readonly value: T
  readonly at: number
}

/** Read and cache the account's subscription and credit windows. */
export class AccountStore {
  private subscriptionCache: Cached<Subscription | undefined> | undefined
  private creditsCache: Cached<CreditReading> | undefined
  private readonly now: () => number

  constructor(private readonly options: AccountStoreOptions) {
    this.now = options.now ?? Date.now
  }

  /** Origin of the configured Provider API root. */
  private origin(): string {
    return new URL(this.options.baseURL()).origin
  }

  /** Drop every reading, so the next access refetches. */
  invalidate(): void {
    this.subscriptionCache = undefined
    this.creditsCache = undefined
  }

  /**
   * The account's plan, cached for ten minutes by default.
   * @param force - bypass the cache.
   * @returns the subscription, or `undefined` when the account reports none.
   */
  async subscription(force = false): Promise<Subscription | undefined> {
    const maxAge = this.options.subscriptionMaxAgeMs ?? 10 * 60_000
    if (!force && this.subscriptionCache !== undefined && this.now() - this.subscriptionCache.at < maxAge) {
      return this.subscriptionCache.value
    }
    const raw = await this.read('/alpha/billing/subscriptions')
    const value = parseSubscription(raw)
    this.subscriptionCache = { value, at: this.now() }
    return value
  }

  /**
   * The account's credits and windows, cached for twenty seconds by default.
   * @param force - bypass the cache.
   * @returns the reading.
   */
  async credits(force = false): Promise<CreditReading> {
    const maxAge = this.options.creditsMaxAgeMs ?? 20_000
    if (!force && this.creditsCache !== undefined && this.now() - this.creditsCache.at < maxAge) {
      return this.creditsCache.value
    }
    const raw = await this.read('/alpha/billing/credits')
    const value = parseCredits(raw)
    this.creditsCache = { value, at: this.now() }
    return value
  }

  /** One authenticated account GET, classified with the inference failure codes. */
  private async read(path: string): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    // Account reads follow the same credential fallback as inference: a stale
    // CLI sign-in must not be the reason the plan or quota cannot be read.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const key = await this.options.apiKey()
      if (key === undefined) throw new LlmError('no Command Code API key is configured', 'MISSING_CREDENTIAL')
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000)
      const response = await fetchImpl(`${this.origin()}${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: timeout,
      })
      if (response.ok) return await response.json()
      const text = await response.text().catch(() => '')
      if (response.status === 401 && this.options.rejectKey !== undefined) {
        const next = await this.options.rejectKey(key)
        if (next !== undefined) continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (_nonJson) {
        raw = { error: { message: text.slice(0, 300) } }
      }
      if (this.options.warn !== undefined && response.status !== 401 && response.status !== 403) {
        this.options.warn(`Command Code account read ${path} failed with HTTP ${response.status}`)
      }
      throw providerError(raw, response.status, response.headers)
    }
    throw new LlmError('every configured Command Code credential was refused', 'INVALID_CREDENTIAL')
  }
}
