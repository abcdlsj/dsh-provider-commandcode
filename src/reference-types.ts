/**
 * Value types shared by the CLI reference catalog, plan filtering, and quota.
 * @module dsh-provider-commandcode/reference-types
 */

/** Subscription tiers in ascending capability order, as `reference/models.md` names them. */
export type PlanId = 'go' | 'goat' | 'pro' | 'max'

/** One row of the official `command-code` CLI catalog. */
export interface ReferenceModel {
  /** Exact model id. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Combined request/response context capacity, when disclosed. */
  readonly contextWindow?: number
  /** Reasoning effort ids the CLI accepts, in catalog order. */
  readonly efforts: readonly string[]
  /** Lowest plan that may call the model, when disclosed. */
  readonly minPlan?: PlanId
}
