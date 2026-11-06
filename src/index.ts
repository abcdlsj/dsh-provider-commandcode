/**
 * Command Code provider plugin for DeepSeek Harness.
 *
 * Registers the `commandcode` provider route over Command Code's Provider API:
 * Claude models on the Anthropic Messages wire, every other model on Chat
 * Completions, with live model discovery, the bundled fallback catalog,
 * plan-aware filtering, quota telemetry for the composer status bar, and
 * zero-config reuse of the command-code CLI's own sign-in.
 * @module dsh-provider-commandcode
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentAccess, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { AccountStore } from './account.js'
import { CommandCodeAdapter, PROVIDER_NAME } from './adapter.js'
import type { CommandCodeAdapterOptions } from './adapter.js'
import { CatalogCache, DEFAULT_BASE_URL, buildCatalog, fallbackCatalog, fetchModels } from './catalog.js'
import type { CatalogModel, ModelOverride } from './catalog-types.js'
import { resolveConnection } from './config.js'
import type { Config, Connection } from './config.js'
import { authFilePaths, describeSource, resolveApiKey, resolveApiKeyCandidates } from './credentials.js'
import type { CredentialService, ResolveKeyOptions, ResolvedKey } from './credentials.js'
import { PlanGate, servedModels } from './plan.js'
import type { PlanResolution } from './plan.js'
import { QuotaReader, formatQuotaText } from './quota.js'
import { ReferenceCache, fetchReferenceCatalog } from './reference.js'
import type { ReferenceView } from './reference.js'
import { STATIC_REFERENCE_INDEX } from './reference.js'
import { CommandCodeQuota } from './remote.js'

export { Config } from './config.js'
export type { Config as CommandCodeConfig, Connection, ThinkingMode, ReasoningBack } from './config.js'
export { CATALOG_CLI_VERSION, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS } from './catalog.js'
export { CommandCodeAdapter, PROVIDER_NAME } from './adapter.js'
export type { CommandCodeAdapterOptions } from './adapter.js'
export { planInfo, servedModels } from './plan.js'
export type { PlanChoice, PlanInfo, PlanResolution, ResolvedPlanId } from './plan.js'
export { parseReferenceCatalog, planCovers, planRank } from './reference.js'
export type { ReferenceModel } from './reference-types.js'
export { CommandCodeQuota } from './remote.js'
export { QuotaReader } from './quota.js'
export type { QuotaSnapshot, QuotaUnconfigured } from './quota.js'

/** Provider route this plugin owns. */
export const PROVIDER = 'commandcode'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-commandcode'

/** Services required to serve model requests. */
export const inject = ['llm']

/** Diagnostic sink: listing and account failures never fail a model request. */
const WARN = (message: string): void => { console.warn(`[llm-commandcode] ${message}`) }

/**
 * One credential choice per process. A key the provider refuses is retired and
 * the next configured source is tried, so a stale CLI sign-in cannot shadow a
 * still-valid host credential.
 */
class KeySelector {
  private preferred: ResolvedKey | undefined
  private readonly refused = new Set<string>()

  constructor(private readonly sources: (connection: Connection) => ResolveKeyOptions) {}

  /** The key this process currently prefers, once one was resolved. */
  peek(): ResolvedKey | undefined {
    return this.preferred
  }

  /** The next candidate no refusal has retired, resolved lazily and then reused. */
  async resolve(connection: Connection): Promise<ResolvedKey | undefined> {
    if (this.preferred !== undefined) return this.preferred
    const candidates = await resolveApiKeyCandidates(this.sources(connection))
    this.preferred = candidates.find((candidate) => !this.refused.has(candidate.key))
    return this.preferred
  }

  /**
   * Retire one refused key and move to the next candidate, if any.
   *
   * Two model calls may be in flight at once (a conversation step and a title,
   * for example), so a refusal of the key another call already replaced returns
   * the current preference instead of clearing it: the newer choice is strictly
   * better information than this call's older one.
   */
  async reject(connection: Connection, key: string): Promise<ResolvedKey | undefined> {
    this.refused.add(key)
    if (this.preferred !== undefined && this.preferred.key !== key) return this.preferred
    this.preferred = undefined
    return await this.resolve(connection)
  }
}

/** Everything the diagnostics command reports. */
interface PluginState {
  readonly cache: CatalogCache
  readonly reference: ReferenceCache
  readonly options: () => Connection
  readonly keys: KeySelector
  readonly plan: PlanGate
  readonly quota: QuotaReader
  /** Whether network discovery is enabled for this deployment. */
  readonly discovery: boolean
  /** The served catalog for the current plan and discovery state. */
  readonly served: (signal?: AbortSignal) => Promise<ServedListing>
}

/** The catalog one plan may use, with where it came from. */
interface ServedListing {
  readonly models: readonly CatalogModel[]
  readonly plan: PlanResolution
  readonly source: 'live' | 'cache' | 'static'
  readonly warning?: string
}

/**
 * Mount the provider.
 * @param ctx - plugin lifetime.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const overrides = (config.models ?? []) as readonly ModelOverride[]
  const lifecycle = new AbortController()
  const keySources = (connection: Connection): ResolveKeyOptions => ({
    ref: connection.apiKeyEnv,
    ...connection.authFile === undefined ? {} : { authFile: connection.authFile },
    credentials: credentials(ctx),
    env: process.env,
    home: homedir(),
  })
  const keys = new KeySelector(keySources)
  const options = (): Connection => {
    const models = config.discovery === false ? fallbackCatalog(overrides, reference.current().models) : cache.current().models
    return resolveConnection(config, models, process.cwd())
  }
  const account = new AccountStore({
    baseURL: () => config.baseURL ?? DEFAULT_BASE_URL,
    apiKey: async () => (await keys.resolve(options()))?.key,
    ...config.keyFallback === false ? {} : {
      rejectKey: async (key: string) => (await keys.reject(options(), key))?.key,
    },
    warn: WARN,
  })
  const plan = new PlanGate({ choice: config.plan ?? 'auto', account, warn: WARN })
  const quota = new QuotaReader(account)
  const reference: ReferenceCache = new ReferenceCache({
    ...config.referenceMaxAgeMs === undefined ? {} : { maxAgeMs: config.referenceMaxAgeMs },
    warn: WARN,
    load: async (signal) => config.referenceCatalog === false
      ? STATIC_REFERENCE_INDEX
      : await fetchReferenceCatalog({ signal: abortable(signal, lifecycle.signal) }),
  })
  const cache = new CatalogCache({
    maxAgeMs: config.modelsMaxAgeMs ?? 5 * 60_000,
    build: (entries) => buildCatalog(entries, overrides, reference.current().models),
    fallback: () => fallbackCatalog(overrides, reference.current().models),
    warn: WARN,
    load: async (signal) => {
      const connection = options()
      // Discovery also answers anonymously; a key only makes the listing
      // account-scoped when one is already resolvable.
      const key = config.discovery === false ? undefined : await keys.resolve(connection)
      return await fetchModels({
        url: connection.modelsURL,
        apiKey: key?.key,
        signal: abortable(signal, lifecycle.signal),
        timeoutMs: config.modelsTimeoutMs ?? 10_000,
        headers: { 'x-command-code-version': connection.cliVersion },
      })
    },
  })
  const listing = async (signal?: AbortSignal): Promise<{ models: readonly CatalogModel[]; source: ServedListing['source']; warning?: string }> => {
    if (config.discovery === false) return { models: fallbackCatalog(overrides, reference.current().models), source: 'static' }
    // A refreshed CLI catalog changes plan floors and efforts before the next picker read.
    await reference.view(signal).catch((error: unknown) => {
      if (signal?.aborted === true) throw error
    })
    const view = await cache.view(signal)
    return { models: view.models, source: view.source, ...view.warning === undefined ? {} : { warning: view.warning } }
  }
  const served = async (signal?: AbortSignal): Promise<ServedListing> => {
    const [view, resolution] = await Promise.all([listing(signal), plan.current()])
    return {
      models: servedModels(view.models, resolution),
      plan: resolution,
      source: view.source,
      ...view.warning === undefined ? {} : { warning: view.warning },
    }
  }
  const adapterOptions: CommandCodeAdapterOptions = {
    options,
    connect: async (signal) => resolveConnection(config, (await served(signal)).models, process.cwd()),
    resolveKey: async (connection) => await keys.resolve(connection),
    ...config.keyFallback === false ? {} : { rejectKey: async (connection, key) => await keys.reject(connection, key) },
    resolvePlan: async () => await plan.current(),
    discoverModels: async () => (await served()).models.map((model) => catalogInfo(PROVIDER, model)),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAccess(ctx, attachments, ref),
    warn: WARN,
  }
  ctx.llm.registerAdapter([PROVIDER], new CommandCodeAdapter(adapterOptions))
  if (config.quota !== false) new CommandCodeQuota(ctx, quota)
  // Resolve the connection once at load, so an unusable endpoint or header value
  // fails the plugin instead of the first prompt.
  options()
  ctx.effect(() => () => { lifecycle.abort() })
  registerCommands(ctx, {
    cache, reference, options, keys, plan, quota, discovery: config.discovery !== false, served,
  })
}

/** Combine this plugin's lifetime with one operation's cancellation. */
function abortable(signal: AbortSignal, lifetime: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, lifetime])
}

/** Read the mounted credentials service, when the composition has one. */
function credentials(ctx: Context): CredentialService | undefined {
  return ctx.get('credentials') as CredentialService | undefined
}

/** Map one served entry to the selector vocabulary. */
function catalogInfo(provider: string, model: CatalogModel): LlmModelInfo {
  const context = `${Math.round(model.contextWindow / 1000)}K`
  const wire = model.wire === 'messages' ? 'Messages' : 'Chat Completions'
  return {
    provider,
    id: model.id,
    name: model.name,
    description: `${wire} · ${context} context · ${model.efforts.length === 0 ? 'no effort control' : `efforts: ${model.efforts.join(', ')}`}`,
    inputModalities: [...model.inputModalities],
    ...model.id.endsWith(':free')
      ? { badge: { text: { en: 'free', zh: '免费' }, tone: 'success' as const } }
      : {},
  }
}

/** Bridge one durable image reference into the tool execution world. */
function resolveImageAccess(
  ctx: Context,
  attachments: AttachmentStore,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const fs = ctx.get('fs') as { processPathFromHostPath?: (path: string) => string | undefined } | undefined
  const readonlyPath = fs?.processPathFromHostPath?.(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

/** `/commandcode` diagnostics and maintenance, when the composition has a command registry. */
function registerCommands(ctx: Context, state: PluginState): void {
  ctx.inject(['commands'], (child) => {
    child.commands.register({
      name: 'commandcode',
      description: 'Inspect Command Code: status | models [filter] | quota | plan | refresh',
      input: { hint: 'status | models [filter] | quota | plan | refresh' },
      handler: async ({ rawInput, signal }): Promise<CommandResult> => {
        const [verb = 'status', ...rest] = rawInput.trim().split(/\s+/u)
        if (verb === 'status') return await statusResult(ctx, state)
        if (verb === 'models') {
          const filter = rest.join(' ').toLowerCase()
          const listing = await state.served(signal)
          const total = state.options().models.length
          const shown = listing.models.filter((model) => filter.length === 0 || model.id.toLowerCase().includes(filter))
          const hidden = total - listing.models.length
          return {
            kind: 'success',
            text: [
              `${shown.length}/${listing.models.length} models served on the ${listing.plan.planName ?? listing.plan.plan} plan`
              + `${hidden > 0 ? ` (${hidden} above this plan)` : ''}`,
              ...shown.map((model) => `${model.id}  [${model.wire}]  ${Math.round(model.contextWindow / 1000)}K`),
            ].join('\n'),
          }
        }
        if (verb === 'quota') {
          return { kind: 'success', text: formatQuotaText(await state.quota.read(true)) }
        }
        if (verb === 'plan') {
          const resolution = await state.plan.current(true)
          const models = state.options().models
          const floors = ['go', 'goat', 'pro', 'max'].map((tier) =>
            `${tier}: ${models.filter((model) => model.minPlan === tier).length}`)
          return {
            kind: 'success',
            text: [
              `plan: ${resolution.planName ?? resolution.plan} (${resolution.source})`,
              `visibility: ${resolution.unrestricted ? 'unrestricted (bought or granted credits)' : `${resolution.plan} tier`}`,
              `models by lowest plan: ${floors.join(' · ')}`,
              ...resolution.planId === undefined ? [] : [`plan id: ${resolution.planId}`],
              ...resolution.warning === undefined ? [] : [`warning: ${resolution.warning}`],
            ].join('\n'),
          }
        }
        if (verb === 'refresh') {
          if (!state.discovery) return { kind: 'error', text: 'Model discovery is disabled by configuration.' }
          state.cache.reset()
          state.reference.reset()
          state.plan.invalidate()
          const view = await state.cache.refresh(signal)
          return {
            kind: view.warning === undefined ? 'success' : 'error',
            text: [
              `catalog: ${view.source} · ${view.models.length} models`,
              ...view.warning === undefined ? [] : [`warning: ${view.warning}`],
            ].join('\n'),
          }
        }
        return { kind: 'error', text: 'Usage: /commandcode status | models [filter] | quota | plan | refresh' }
      },
    })
  })
}

/** One status report that never prints the key. */
async function statusResult(ctx: Context, state: PluginState): Promise<CommandResult> {
  const connection = state.options()
  const view = state.discovery ? state.cache.current() : { models: connection.models, source: 'static' as const }
  const resolution = state.plan.peek()
  const reference: ReferenceView = state.reference.current()
  let auth = 'not configured (run `command-code` to sign in, or set COMMANDCODE_API_KEY)'
  try {
    const key = state.keys.peek() ?? await resolveApiKey({
      ref: connection.apiKeyEnv,
      ...connection.authFile === undefined ? {} : { authFile: connection.authFile },
      credentials: credentials(ctx),
      env: process.env,
      home: homedir(),
    })
    if (key !== undefined) auth = describeSource(key.source)
  } catch (error) {
    auth = `unusable credential: ${error instanceof Error ? error.message : String(error)}`
  }
  return {
    kind: 'success',
    text: [
      `provider: ${PROVIDER_NAME} (${PROVIDER})`,
      `endpoint: ${connection.baseURL}`,
      'wire: Claude on /messages, every other model on /chat/completions',
      `catalog: ${view.source} · ${view.models.length} models${view.warning === undefined ? '' : ` · warning: ${view.warning}`}`,
      `cli catalog: ${reference.source}${reference.warning === undefined ? '' : ` · warning: ${reference.warning}`}`,
      `plan: ${resolution === undefined ? `${connection.plan} (not resolved yet)` : `${resolution.planName ?? resolution.plan} (${resolution.source})`}`,
      `auth: ${auth}`,
      `thinking: ${connection.thinking} · reasoning replay: ${connection.reasoningBack} · ZDR: ${connection.zdr ? 'on' : 'off'}`,
      `auth files also read: ${authFilePaths(homedir()).join(', ')}`,
    ].join('\n'),
  }
}
