/**
 * One quota reading for the composer status bar and the `/commandcode quota`
 * command: the rolling windows a plan enforces, the month's credits, and the
 * balance bought or granted on top.
 * @module dsh-provider-commandcode/quota
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AccountStore, CreditWindow } from './account.js'
import { planInfo } from './plan.js'

/** One rolling window as the browser renders it. */
export interface QuotaWindow {
  /** Usage drawn in the window, in the plan's unit. */
  readonly used: number
  /** Window cap, in the plan's unit. */
  readonly limit: number
  /** Used share of the cap, from 0 through 100. */
  readonly percent: number
  /** Reset time, milliseconds since the epoch. */
  readonly resetsAt?: number
  /** Whether this window is exhausted. */
  readonly exceeded: boolean
}

/** The month's credits as one more budget row. */
export interface QuotaMonth {
  /** Usage drawn from the month's allowance. */
  readonly used: number
  /** The month's allowance plus bought and granted credits. */
  readonly limit: number
  /** Used share of the allowance, from 0 through 100. */
  readonly percent: number
  /** Credits left, including bought and granted ones. */
  readonly remaining: number
  /** End of the plan period, when one is known. */
  readonly renewsAt?: number
}

/** One complete quota reading. */
export interface QuotaSnapshot {
  /** Marker distinguishing a reading from the unconfigured reply. */
  readonly configured: true
  /** When this reading settled. */
  readonly fetchedAt: number
  /** Plan identity and renewal. */
  readonly plan?: {
    readonly id?: string
    readonly name?: string
    readonly renewsAt?: number
    readonly cancelAtPeriodEnd?: boolean
  }
  /** Unit of every amount in this reading. */
  readonly unit: 'credits' | 'usd'
  /** Rolling windows the plan enforces. */
  readonly windows: {
    readonly fiveHour?: QuotaWindow
    readonly weekly?: QuotaWindow
  }
  /** The month's allowance, when the plan gives one. */
  readonly monthly?: QuotaMonth
  /** The balance the plan month is drawn from. */
  readonly balance?: {
    readonly monthly?: number
    readonly purchased?: number
    readonly free?: number
  }
  /** Sandbox minutes, when the account reports them. */
  readonly sandbox?: {
    readonly usedMinutes: number
    readonly limitMinutes: number
    readonly resetsAt?: number
  }
  /** Whether any window is exhausted. */
  readonly exceeded: boolean
}

/** The reply the browser half hides the status bar for. */
export interface QuotaUnconfigured {
  readonly configured: false
}

/** One quota service bound to the account it describes. */
export class QuotaReader {
  private readonly now: () => number

  /**
   * @param account - account reader owning key resolution and caching.
   * @param now - clock for tests.
   */
  constructor(private readonly account: AccountStore, now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Read the account's quota.
   * @param force - bypass the account's short credit cache.
   * @returns the reading, or `{configured: false}` when no key is configured.
   * @throws LlmError with the account failure when a configured account cannot be read.
   */
  async read(force = false): Promise<QuotaSnapshot | QuotaUnconfigured> {
    let credits
    try {
      credits = await this.account.credits(force)
    } catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return { configured: false }
      throw error
    }
    const subscription = await this.account.subscription().catch(() => undefined)
    const info = planInfo(subscription?.planId)
    const unit = info?.unit ?? 'usd'
    const monthlyCredits = credits.monthlyCredits
    const purchased = credits.purchasedCredits
    const free = credits.freeCredits
    const known = monthlyCredits !== undefined || purchased !== undefined || free !== undefined
    const remaining = (monthlyCredits ?? 0) + (purchased ?? 0) + (free ?? 0)
    const allowance = info?.monthlyAllowance ?? 0
    const limit = allowance > 0 ? Math.max(allowance, monthlyCredits ?? 0) + (purchased ?? 0) + (free ?? 0) : remaining
    const used = Math.max(0, limit - remaining)
    const renewsAt = subscription?.currentPeriodEnd
    return {
      configured: true,
      fetchedAt: this.now(),
      unit,
      ...info === undefined && subscription === undefined ? {} : {
        plan: {
          ...subscription?.planId === undefined ? {} : { id: subscription.planId },
          ...info?.name === undefined ? {} : { name: info.name },
          ...renewsAt === undefined ? {} : { renewsAt },
          ...subscription?.cancelAtPeriodEnd === undefined ? {} : { cancelAtPeriodEnd: subscription.cancelAtPeriodEnd },
        },
      },
      windows: {
        ...windowReading(credits.fiveHour) === undefined ? {} : { fiveHour: windowReading(credits.fiveHour) as QuotaWindow },
        ...windowReading(credits.weekly) === undefined ? {} : { weekly: windowReading(credits.weekly) as QuotaWindow },
      },
      ...allowance <= 0 ? {} : {
        monthly: {
          used,
          limit,
          percent: limit === 0 ? 0 : clampPercent((100 * used) / limit),
          remaining,
          ...renewsAt === undefined ? {} : { renewsAt },
        },
      },
      ...known ? {
        balance: {
          ...monthlyCredits === undefined ? {} : { monthly: monthlyCredits },
          ...purchased === undefined ? {} : { purchased },
          ...free === undefined ? {} : { free },
        },
      } : {},
      ...credits.sandbox === undefined ? {} : {
        sandbox: {
          usedMinutes: credits.sandbox.usedMinutes ?? 0,
          limitMinutes: credits.sandbox.limitMinutes ?? 0,
          ...credits.sandbox.resetAt === undefined ? {} : { resetsAt: credits.sandbox.resetAt },
        },
      },
      exceeded: credits.exceeded === true,
    }
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10))
}

/** Read one rolling window, when it discloses both a usage and a cap. */
function windowReading(window: CreditWindow | undefined): QuotaWindow | undefined {
  if (window === undefined || window.used === undefined || window.cap === undefined || window.cap <= 0) return undefined
  return {
    used: window.used,
    limit: window.cap,
    percent: clampPercent((100 * window.used) / window.cap),
    ...window.resetAt === undefined ? {} : { resetsAt: window.resetAt },
    exceeded: window.exceeded === true,
  }
}

/** Render one amount in the reading's own unit. */
export function formatAmount(value: number, unit: 'credits' | 'usd'): string {
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2)
  return unit === 'usd' ? `$${rounded}` : rounded
}

/** Render one reset countdown in the coarsest useful unit. */
export function formatCountdown(at: number | undefined, now = Date.now()): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Render one quota reading as terminal text for `/commandcode quota`.
 * @param reading - the snapshot, or the unconfigured marker.
 * @param now - clock for countdowns.
 * @returns one multi-line report with no credential in it.
 */
export function formatQuotaText(reading: QuotaSnapshot | QuotaUnconfigured, now = Date.now()): string {
  if (reading.configured === false) return 'quota: no Command Code credential is configured'
  const unit = reading.unit
  const lines: string[] = []
  const plan = reading.plan?.name ?? reading.plan?.id ?? 'unknown plan'
  const renew = formatCountdown(reading.plan?.renewsAt, now)
  lines.push(`plan: ${plan}${renew === undefined ? '' : ` (renews in ${renew})`}${reading.exceeded ? ' · a window is exhausted' : ''}`)
  const window = (label: string, entry: QuotaSnapshot['windows']['fiveHour']): void => {
    if (entry === undefined) return
    const reset = formatCountdown(entry.resetsAt, now)
    lines.push(
      `${label}: ${entry.percent}% used · ${formatAmount(entry.used, unit)} / ${formatAmount(entry.limit, unit)}`
      + `${reset === undefined ? '' : ` · resets in ${reset}`}${entry.exceeded ? ' · exhausted' : ''}`,
    )
  }
  window('5-hour', reading.windows.fiveHour)
  window('weekly', reading.windows.weekly)
  if (reading.monthly !== undefined) {
    const month = reading.monthly
    const reset = formatCountdown(month.renewsAt, now)
    lines.push(
      `month: ${month.percent}% used · ${formatAmount(month.remaining, unit)} of ${formatAmount(month.limit, unit)} left`
      + `${reset === undefined ? '' : ` · renews in ${reset}`}`,
    )
  }
  const balance = reading.balance
  if (balance !== undefined && (balance.purchased ?? 0) + (balance.free ?? 0) > 0) {
    lines.push(`extra: ${formatAmount(balance.purchased ?? 0, unit)} bought · ${formatAmount(balance.free ?? 0, unit)} granted`)
  }
  if (reading.sandbox !== undefined && reading.sandbox.limitMinutes > 0) {
    lines.push(`sandbox: ${reading.sandbox.usedMinutes} / ${reading.sandbox.limitMinutes} minutes`)
  }
  lines.push(`updated: ${new Date(reading.fetchedAt).toISOString()}`)
  return lines.join('\n')
}
