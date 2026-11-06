/**
 * Command Code provider plugin for DeepSeek Harness.
 *
 * Registers the `commandcode` provider route over Command Code's Provider API:
 * Claude models on the Anthropic Messages wire, every other model on Chat
 * Completions, with live model discovery, the bundled fallback catalog, and
 * zero-config reuse of the command-code CLI's own sign-in.
 * @module dsh-provider-commandcode
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentAccess, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandCodeAdapter, PROVIDER_NAME } from './adapter.js'
import type { CommandCodeAdapterOptions } from './adapter.js'
import { CatalogCache, buildCatalog, fallbackCatalog, fetchModels } from './catalog.js'
import type { CatalogModel, ModelOverride } from './catalog-types.js'
import { resolveConnection } from './config.js'
import type { Config, Connection } from './config.js'
import { authFilePaths, describeSource, resolveApiKey, resolveApiKeyCandidates } from './credentials.js'
import type { CredentialService, ResolveKeyOptions, ResolvedKey } from './credentials.js'

export { Config } from './config.js'
export type { Config as CommandCodeConfig, Connection, ThinkingMode, ReasoningBack } from './config.js'
export { DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS, CATALOG_CLI_VERSION } from './catalog.js'
export { CommandCodeAdapter, PROVIDER_NAME } from './adapter.js'
export type { CommandCodeAdapterOptions } from './adapter.js'

/** Provider route this plugin owns. */
export const PROVIDER = 'commandcode'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-commandcode'

/** Services required to serve model requests. */
export const inject = ['llm']

/** Diagnostic sink: listing failures never fail a model request. */
const DISCOVERY_WARN = (message: string): void => { console.warn(`[llm-commandcode] ${message}`) }

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

interface PluginState {
  readonly cache: CatalogCache
  readonly options: () => Connection
  readonly keys: KeySelector
  /** Whether network discovery is enabled for this deployment. */
  readonly discovery: boolean
}

/**
 * Mount the provider.
 * @param ctx - plugin lifetime.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const overrides = (config.models ?? []) as readonly ModelOverride[]
  const lifecycle = new AbortController()
  const options = (): Connection => {
    const models = config.discovery === false ? fallbackCatalog(overrides) : cache.current().models
    return resolveConnection(config, models, process.cwd())
  }
  const keySources = (connection: Connection): ResolveKeyOptions => ({
    ref: connection.apiKeyEnv,
    ...connection.authFile === undefined ? {} : { authFile: connection.authFile },
    credentials: credentials(ctx),
    env: process.env,
    home: homedir(),
  })
  const keys = new KeySelector(keySources)
  const cache = new CatalogCache({
    maxAgeMs: config.modelsMaxAgeMs ?? 5 * 60_000,
    build: (entries) => buildCatalog(entries, overrides),
    fallback: () => fallbackCatalog(overrides),
    warn: DISCOVERY_WARN,
    load: async (signal) => {
      const connection = options()
      // Discovery also answers anonymously; a key only makes the listing
      // account-scoped when one is already resolvable.
      const key = config.discovery === false ? undefined : await keys.resolve(connection)
      return await fetchModels({
        url: connection.modelsURL,
        apiKey: key?.key,
        signal: AbortSignal.any([signal, lifecycle.signal]),
        timeoutMs: config.modelsTimeoutMs ?? 10_000,
        headers: { 'x-command-code-version': connection.cliVersion },
      })
    },
  })
  const listing = async (signal?: AbortSignal): Promise<readonly CatalogModel[]> => {
    if (config.discovery === false) return fallbackCatalog(overrides)
    return (await cache.view(signal)).models
  }
  const adapterOptions: CommandCodeAdapterOptions = {
    options,
    connect: async (signal) => resolveConnection(config, await listing(signal), process.cwd()),
    resolveKey: async (connection) => await keys.resolve(connection),
    ...config.keyFallback === false ? {} : { rejectKey: async (connection, key) => await keys.reject(connection, key) },
    discoverModels: async () => (await listing()).map((model) => catalogInfo(PROVIDER, model)),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAccess(ctx, attachments, ref),
    warn: DISCOVERY_WARN,
  }
  ctx.llm.registerAdapter([PROVIDER], new CommandCodeAdapter(adapterOptions))
  // Resolve the connection once at load, so an unusable endpoint or header value
  // fails the plugin instead of the first prompt.
  options()
  ctx.effect(() => () => { lifecycle.abort() })
  registerCommands(ctx, { cache, options, keys, discovery: config.discovery !== false })
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
      description: 'Inspect or refresh the Command Code provider (status | models [filter] | refresh)',
      input: { hint: 'status | models [filter] | refresh' },
      handler: async ({ rawInput, signal }): Promise<CommandResult> => {
        const [verb = 'status', ...rest] = rawInput.trim().split(/\s+/u)
        if (verb === 'status') return await statusResult(ctx, state)
        if (verb === 'models') {
          const filter = rest.join(' ').toLowerCase()
          const models = state.discovery
            ? await state.cache.view(signal).then((view) => view.models).catch(() => state.options().models)
            : state.options().models
          const shown = models.filter((model) => filter.length === 0 || model.id.toLowerCase().includes(filter))
          const lines = shown.map((model) => `${model.id}  [${model.wire}]  ${Math.round(model.contextWindow / 1000)}K`)
          return {
            kind: 'success',
            text: [`${shown.length}/${models.length} models`, ...lines].join('\n'),
          }
        }
        if (verb === 'refresh') {
          if (!state.discovery) return { kind: 'error', text: 'Model discovery is disabled by configuration.' }
          state.cache.reset()
          const view = await state.cache.refresh(signal)
          return {
            kind: view.warning === undefined ? 'success' : 'error',
            text: [
              `catalog: ${view.source} · ${view.models.length} models`,
              ...view.warning === undefined ? [] : [`warning: ${view.warning}`],
            ].join('\n'),
          }
        }
        return { kind: 'error', text: 'Usage: /commandcode status | models [filter] | refresh' }
      },
    })
  })
}

/** One status report that never prints the key. */
async function statusResult(ctx: Context, state: PluginState): Promise<CommandResult> {
  const connection = state.options()
  const view = state.discovery
    ? state.cache.current()
    : { models: connection.models, source: 'static' as const }
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
      `wire: Claude on /messages, every other model on /chat/completions`,
      `catalog: ${view.source} · ${view.models.length} models${view.warning === undefined ? '' : ` · warning: ${view.warning}`}`,
      `auth: ${auth}`,
      `thinking: ${connection.thinking} · reasoning replay: ${connection.reasoningBack} · ZDR: ${connection.zdr ? 'on' : 'off'}`,
      `auth files also read: ${authFilePaths(homedir()).join(', ')}`,
    ].join('\n'),
  }
}
