/**
 * Catalog value types shared by discovery, configuration, and the adapter.
 * @module dsh-provider-commandcode/catalog-types
 */

import type { PlanId } from './reference-types.js'

/** Provider API wire that serves one model. */
export type Wire = 'chat' | 'messages'

/** Accepted request modality for one model. */
export type InputModality = 'text' | 'image'

/** One model entry of the bundled fallback catalog. */
export interface StaticModel {
  /** Model id accepted by the Provider API. */
  readonly id: string
  /** Selector label. */
  readonly name: string
  /** Max combined request and response context, in tokens. */
  readonly contextWindow: number
  /** Wire that serves this model. */
  readonly wire: Wire
  /** Accepted request modalities; omission means text only. */
  readonly inputModalities?: readonly InputModality[]
  /** Maximum output tokens when the upstream manifest publishes one. */
  readonly maxTokens?: number
  /** Selectable reasoning efforts from least to greatest. */
  readonly efforts?: readonly string[]
}

/** Lowest subscription tier that may call one model, when the CLI catalog discloses it. */
export type { PlanId } from './reference-types.js'

/** One model this adapter serves, after fallback data and configuration are merged. */
export interface CatalogModel {
  /** Model id accepted by the Provider API. */
  readonly id: string
  /** Selector label. */
  readonly name: string
  /** Max combined request and response context, in tokens. */
  readonly contextWindow: number
  /** Wire that serves this model. */
  readonly wire: Wire
  /** Accepted request modalities. */
  readonly inputModalities: readonly InputModality[]
  /** Maximum output tokens materialized when the caller omits one. */
  readonly maxTokens: number
  /** Selectable reasoning efforts; empty means the route exposes no effort selector. */
  readonly efforts: readonly string[]
  /** Origin of this entry, used by diagnostics. */
  readonly origin: 'live' | 'static' | 'config'
  /** Lowest plan that includes the model; absent when no source discloses one. */
  readonly minPlan?: PlanId
}

/** One model entry a deployment declares or overrides through configuration. */
export interface ModelOverride {
  /** Exact model id. */
  readonly id: string
  /** Selector label; defaults to the id. */
  readonly name?: string
  /** Wire serving this model; defaults to the discovery result or the id heuristic. */
  readonly wire?: Wire
  /** Context capacity; defaults to the discovery result or 200000. */
  readonly contextWindow?: number
  /** Maximum output tokens; defaults to the upstream manifest or 64000. */
  readonly maxTokens?: number
  /** Accepted modalities; omission keeps the discovered/known capability. */
  readonly inputModalities?: InputModality[]
  /** Selectable reasoning efforts; an empty list removes the selector. */
  readonly efforts?: string[]
}
