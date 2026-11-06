/**
 * Plan resolution and filtering: which subscription tier this deployment may
 * use, and which catalog models that tier includes.
 * @module dsh-provider-commandcode/plan
 */

import type { AccountStore } from './account.js'
import { visibleCatalog } from './catalog.js'
import type { CatalogModel } from './catalog-types.js'
import type { PlanId } from './reference-types.js'

/** Configured plan choice: a fixed tier, `auto` (read the account), or `all`. */
export type PlanChoice = PlanId | 'auto' | 'all'

/** Plans the CLI catalog gates models on, plus `all` for no filtering. */
export type ResolvedPlanId = PlanId | 'all'

/** One plan catalog entry: which tier the account is, and how to describe it. */
export interface PlanInfo {
  /** Tier used for filtering. */
  readonly plan: ResolvedPlanId
  /** Subscription plan id as Command Code reports it. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Credits a month of the plan includes, in its own unit; 0 when it gives none. */
  readonly monthlyAllowance: number
  /** Unit of the monthly allowance. */
  readonly unit: 'credits' | 'usd'
}

/**
 * Plan table, most specific prefix first. `individual-pro-v1` is the old Pro
 * and must be read before `individual-pro`; `individual-goat` before
 * `individual-go`. Ultra, Provider, and Team plans see every model.
 */
const PLAN_TABLE: readonly (PlanInfo & { readonly prefix: string })[] = [
  { prefix: 'individual-provider', plan: 'all', id: 'individual-provider', name: 'Provider', monthlyAllowance: 0, unit: 'usd' },
  { prefix: 'individual-ultra', plan: 'all', id: 'individual-ultra', name: 'Ultra', monthlyAllowance: 300, unit: 'usd' },
  { prefix: 'individual-max', plan: 'max', id: 'individual-max', name: 'Max', monthlyAllowance: 150, unit: 'usd' },
  { prefix: 'teams', plan: 'all', id: 'teams', name: 'Teams', monthlyAllowance: 40, unit: 'usd' },
  { prefix: 'individual-pro-v1', plan: 'pro', id: 'individual-pro-v1', name: 'Pro', monthlyAllowance: 80, unit: 'credits' },
  { prefix: 'individual-pro', plan: 'pro', id: 'individual-pro', name: 'Pro', monthlyAllowance: 30, unit: 'credits' },
  { prefix: 'individual-goat', plan: 'goat', id: 'individual-goat', name: 'GOAT', monthlyAllowance: 70, unit: 'credits' },
  { prefix: 'individual-go', plan: 'go', id: 'individual-go', name: 'Go', monthlyAllowance: 10, unit: 'credits' },
]

/**
 * Resolve one plan id to its tier, name, and monthly allowance.
 * @param planId - Command Code plan id, such as `individual-goat`.
 * @returns the resolved plan, or `undefined` when the id names no known plan.
 */
export function planInfo(planId: string | undefined): PlanInfo | undefined {
  if (planId === undefined) return undefined
  const normalized = planId.trim().toLowerCase().replaceAll('_', '-')
  const found = PLAN_TABLE.find((entry) => normalized.startsWith(entry.prefix))
  if (found === undefined) return undefined
  const { prefix: _prefix, ...info } = found
  return { ...info, id: planId }
}

/** One plan resolution the adapter, picker, and diagnostics read. */
export interface PlanResolution {
  /** Tier filtering uses; `all` hides nothing. */
  readonly plan: ResolvedPlanId
  /** Subscription plan id, when one was read. */
  readonly planId?: string
  /** Display name of the plan. */
  readonly planName?: string
  /** Where this resolution came from. */
  readonly source: 'config' | 'account' | 'fallback'
  /** Whether bought or granted credits put every model in reach. */
  readonly unrestricted: boolean
  /** End of the current plan period, milliseconds since the epoch. */
  readonly renewsAt?: number
  /** Diagnostic when the account could not be read. */
  readonly warning?: string
  /** When this resolution settled. */
  readonly resolvedAt?: number
}

/** Inputs of one plan gate. */
export interface PlanGateOptions {
  /** Configured choice. */
  readonly choice: PlanChoice
  /** Account reader. */
  readonly account: AccountStore
  /** How long an automatic resolution is reused. */
  readonly maxAgeMs?: number
  /** Clock for tests. */
  readonly now?: () => number
  /** Diagnostic sink. */
  readonly warn?: (message: string) => void
}

/**
 * Resolve the plan this deployment may use; `auto` reads the account through
 * {@link AccountStore}. A failed read never hides models: it serves `all` with
 * a warning, which is the pre-filter behaviour.
 */
export class PlanGate {
  private cached: PlanResolution | undefined
  private inflight: Promise<PlanResolution> | undefined
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(private readonly options: PlanGateOptions) {
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000
  }

  /** The last resolution, when one settled. */
  peek(): PlanResolution | undefined {
    return this.options.choice === 'auto' ? this.cached : this.configured()
  }

  /** The current resolution, reading the account when `auto` and stale. */
  async current(force = false): Promise<PlanResolution> {
    if (this.options.choice !== 'auto') return this.configured()
    if (!force && this.cached !== undefined) {
      // A failed read is retried sooner than a good one, so a key configured a
      // moment later starts filtering without waiting the full window.
      const maxAge = this.cached.source === 'fallback' ? Math.min(this.maxAgeMs, 60_000) : this.maxAgeMs
      if (this.now() - (this.cached.resolvedAt ?? 0) < maxAge) return this.cached
    }
    this.inflight ??= this.resolve().finally(() => { this.inflight = undefined })
    return await this.inflight
  }

  /** Drop the cached resolution, so the next access reads the account again. */
  invalidate(): void {
    this.cached = undefined
  }

  private configured(): PlanResolution {
    const choice = this.options.choice
    if (choice === 'all' || choice === 'auto') return { plan: 'all', source: 'config', unrestricted: true }
    const info = planInfo(`individual-${choice}`)
    return {
      plan: choice,
      source: 'config',
      unrestricted: false,
      planName: info?.name ?? choice.toUpperCase(),
    }
  }

  private async resolve(): Promise<PlanResolution> {
    const resolvedAt = this.now()
    try {
      const subscription = await this.options.account.subscription()
      const credits = await this.options.account.credits()
      const info = planInfo(subscription?.planId)
      const unrestricted = (credits.purchasedCredits ?? 0) > 0 || (credits.freeCredits ?? 0) > 0
      if (info === undefined) {
        const warning = subscription === undefined
          ? 'the account reports no Command Code subscription; every model stays listed'
          : `unrecognized Command Code plan ${JSON.stringify(subscription.planId)}; every model stays listed`
        this.options.warn?.(warning)
        const fallback: PlanResolution = { plan: 'all', source: 'fallback', unrestricted: true, warning, resolvedAt }
        this.cached = fallback
        return fallback
      }
      const resolution: PlanResolution = {
        plan: info.plan,
        planId: info.id,
        planName: info.name,
        source: 'account',
        unrestricted,
        ...subscription?.currentPeriodEnd === undefined ? {} : { renewsAt: subscription.currentPeriodEnd },
        resolvedAt,
      }
      this.cached = resolution
      return resolution
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const warning = `could not read the Command Code plan; every model stays listed: ${error instanceof Error ? error.message : String(error)}`
      this.options.warn?.(warning)
      const fallback: PlanResolution = { plan: 'all', source: 'fallback', unrestricted: true, warning, resolvedAt }
      this.cached = fallback
      return fallback
    }
  }
}

/** The catalog entries one resolution exposes. */
export function servedModels(models: readonly CatalogModel[], resolution: PlanResolution): CatalogModel[] {
  return visibleCatalog(models, resolution.plan, resolution.unrestricted)
}
