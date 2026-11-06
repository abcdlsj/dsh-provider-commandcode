/**
 * Command Code provider adapter: one class over the two wires the Provider API
 * serves, with per-model downgrades learned from the provider's own refusals.
 * @module dsh-provider-commandcode/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, ImageAttachmentAccess, ImageAttachmentAccessResolver, LlmModelInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { modelAllowed, modelById } from './catalog.js'
import type { CatalogModel } from './catalog-types.js'
import { buildChatRequest, translateChat } from './chat.js'
import type { Connection } from './config.js'
import type { ResolvedKey } from './credentials.js'
import { describeSource } from './credentials.js'
import { emptyResponse, providerError, rejectsField, transportError } from './errors.js'
import { prepareImages } from './images.js'
import { buildMessagesRequest, translateMessages } from './messages.js'
import type { PlanResolution } from './plan.js'
import { parseSse } from './sse.js'

/** Idle-watchdog timeout code of one stream read. */
const IDLE_CODE = 'COMMANDCODE_IDLE'

/** Distinct credentials one request may try before it reports the refusal. */
const MAX_KEY_ATTEMPTS = 5

/** A 400 that says the Messages wire refused the thinking fields. */
const THINKING_REFUSED = /thinking|output_config|budget_tokens/iu
/** A 400 that says the Chat Completions wire refused `reasoning_effort`. */
const EFFORT_REFUSED = /reasoning_effort/iu
/** A 400 that asks for each earlier assistant message's reasoning back. */
const REASONING_REQUIRED =
  /reasoning_content\b[^"]{0,80}\b(?:missing|required|must be (?:passed|provided|included))|\b(?:missing|required)\b[^"]{0,80}\breasoning_content/iu

/** Operation-local dependencies the plugin owns. */
export interface CommandCodeAdapterOptions {
  /** Current connection facts, called once per operation. */
  readonly options: () => Connection
  /** Resolve the connection for one catalog-driven lookup, after discovery settled. */
  readonly connect?: (signal?: AbortSignal) => Promise<Connection>
  /** Resolve the API key one request should try first. */
  readonly resolveKey: (connection: Connection) => Promise<ResolvedKey | undefined>
  /**
   * Mark one refused key unusable and return the next candidate, if any.
   * Omission disables cross-source credential fallback.
   */
  readonly rejectKey?: (connection: Connection, key: string) => Promise<ResolvedKey | undefined>
  /** Discover catalog entries; a missing key still lets the public listing answer. */
  readonly discoverModels: (connection: Connection, signal?: AbortSignal) => Promise<readonly LlmModelInfo[]>
  /** Resolve the plan this request may use; omission admits every model. */
  readonly resolvePlan?: () => Promise<PlanResolution>
  /** Current durable attachment service; absence rejects image input. */
  readonly resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current tool execution world. */
  readonly resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /** Diagnostic sink; never receives prompt content or credentials. */
  readonly warn?: (message: string) => void
}

/** Display name of the provider route. */
export const PROVIDER_NAME = 'Command Code'

function effortName(id: string): string {
  switch (id) {
    case 'off': return 'Off'
    case 'minimal': return 'Minimal'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'xhigh': return 'Extra high'
    case 'max': return 'Max'
    default: return id
  }
}

/** Exact model metadata for one served entry. */
export function modelInfo(connection: Connection, provider: string, id: string): LlmResolvedModelInfo {
  const model = modelById(connection.models, id)
  const efforts = connection.thinking === 'disabled' && model.wire === 'messages' ? [] : model.efforts
  return {
    provider,
    id,
    name: model.name,
    inputModalities: [...model.inputModalities],
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
    ...efforts.length === 0 ? {} : {
      reasoning: {
        efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effortName(effort) })),
      },
    },
  }
}

/** The catalog entry a request dispatches to. */
function served(connection: Connection, id: string): CatalogModel {
  return modelById(connection.models, id)
}

/** Every header one request carries, including the harness's own attribution. */
export function requestHeaders(connection: Connection, key: string, wire: CatalogModel['wire']): Record<string, string> {
  return {
    ...attributionHeaders(),
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'authorization': `Bearer ${key}`,
    'x-api-key': key,
    'x-command-code-version': connection.cliVersion,
    'x-cli-environment': 'production',
    'x-project-slug': connection.projectSlug,
    'x-taste-learning': 'false',
    'x-session-id': connection.sessionId,
    ...connection.zdr ? { 'x-cmd-zdr': '1' } : {},
    ...wire === 'messages' ? { 'anthropic-version': '2023-06-01' } : {},
  }
}

/** The wire endpoint of one model. */
export function endpointFor(connection: Connection, wire: CatalogModel['wire']): string {
  return `${connection.baseURL}/${wire === 'messages' ? 'messages' : 'chat/completions'}`
}

/** Refusals this process has already learned for one model. */
interface ModelDowngrades {
  /** The Messages wire refused the thinking fields. */
  withoutThinking: boolean
  /** The Chat Completions wire refused `reasoning_effort`. */
  withoutEffort: boolean
  /** The Chat Completions wire requires earlier reasoning in `reasoning_content`. */
  reasoningBack: boolean
}

function readBody(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch (_nonJsonFailure) {
    return { message: text.slice(0, 600) }
  }
}

/** Command Code provider over the Provider API's two supported wires. */
export class CommandCodeAdapter extends LlmAdapter {
  private readonly downgrades = new Map<string, ModelDowngrades>()
  /** Credential refusals already reported, so parallel calls warn once. */
  private readonly reportedRefusals = new Set<string>()

  constructor(private readonly dependencies: CommandCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_NAME }
  }

  override providerRetryPolicy() {
    return this.dependencies.options().retryPolicy
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return await this.dependencies.discoverModels(this.dependencies.options(), undefined)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return modelInfo(await this.connection(signal), provider, model)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = await this.connection(signal)
    return { model: modelInfo(connection, provider, model), stream: (options) => this.generate(options, connection) }
  }

  override stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk> {
    return this.generate(options, this.dependencies.options())
  }

  private connection(signal: AbortSignal | undefined): Promise<Connection> {
    return this.dependencies.connect?.(signal) ?? Promise.resolve(this.dependencies.options())
  }

  private flag(model: string): ModelDowngrades {
    let flags = this.downgrades.get(model)
    if (flags === undefined) {
      flags = { withoutThinking: false, withoutEffort: false, reasoningBack: false }
      this.downgrades.set(model, flags)
    }
    return flags
  }

  private async * generate(options: GenerateOptions<string>, connection: Connection): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, IDLE_CODE)
    const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse() })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, IDLE_CODE) !== undefined) throw transportError(error, options.signal, true)
      throw transportError(error, options.signal)
    } finally {
      consumer.abort()
      void iterator.return(undefined).catch(() => {})
    }
  }

  private async * request(
    options: GenerateOptions<string>,
    connection: Connection,
    signal: AbortSignal,
    activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const model = served(connection, options.model)
    const plan = await this.dependencies.resolvePlan?.()
    if (plan !== undefined && !modelAllowed(model, plan.plan, plan.unrestricted)) {
      throw new LlmError(
        `Command Code model "${model.id}" needs the ${model.minPlan?.toUpperCase()} plan or above;`
        + ` the current plan is ${plan.planName ?? plan.plan}.`,
        'PLAN_REQUIRED',
      )
    }
    const prepared = await prepareImages({
      messages: options.messages,
      model,
      attachments: this.dependencies.resolveAttachments?.(),
      access: (ref) => {
        const attachments = this.dependencies.resolveAttachments?.()
        return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref)
      },
      maxBytes: connection.maxRequestImageBytes,
      maxImages: connection.maxImagesPerRequest,
      signal,
    })
    const flags = this.flag(model.id)
    const history = { ...options, messages: prepared.messages } as GenerateOptions<string>
    const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    let keyAttempts = 0
    let degraded = false

    while (true) {
      const resolved = await this.dependencies.resolveKey(connection)
      if (resolved === undefined) {
        throw new LlmError(
          `no Command Code API key: store ${connection.apiKeyEnv} through the credentials service,`
          + ' export COMMANDCODE_API_KEY, or sign in with the command-code CLI',
          'MISSING_CREDENTIAL',
        )
      }
      const body = model.wire === 'messages'
        ? buildMessagesRequest({
          options: history,
          model,
          images: prepared.versions,
          effort: flags.withoutThinking ? undefined : effort,
          thinking: connection.thinking,
          maxTokens: connection.maxTokens,
          withoutThinking: flags.withoutThinking,
        })
        : buildChatRequest({
          options: history,
          model,
          images: prepared.versions,
          effort: flags.withoutEffort ? undefined : effort,
          reasoningBack: connection.reasoningBack === 'always' || flags.reasoningBack,
          maxTokens: connection.maxTokens,
        })
      const response = await fetch(endpointFor(connection, model.wire), {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: requestHeaders(connection, resolved.key, model.wire),
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const raw = readBody(text)
        if (response.status === 401 && this.dependencies.rejectKey !== undefined && keyAttempts < MAX_KEY_ATTEMPTS) {
          keyAttempts += 1
          const next = await this.dependencies.rejectKey(connection, resolved.key)
          if (next !== undefined) {
            if (!this.reportedRefusals.has(resolved.key)) {
              this.reportedRefusals.add(resolved.key)
              this.dependencies.warn?.(
                `dsh-provider-commandcode: ${describeSource(resolved.source)} was refused; trying ${describeSource(next.source)}`,
              )
            }
            continue
          }
        }
        if (!degraded && this.degrade(model, flags, response.status, raw, effort)) {
          degraded = true
          continue
        }
        throw providerError(raw, response.status, response.headers)
      }
      if (response.body === null) throw emptyResponse()
      const events = this.events(response.body, activity)
      yield* model.wire === 'messages'
        ? translateMessages(events, { model: model.id })
        : translateChat(events, { model: model.id })
      return
    }
  }

  /** Learn one refusal this process can work around; `true` asks for one retry. */
  private degrade(
    model: CatalogModel,
    flags: ModelDowngrades,
    status: number,
    raw: unknown,
    effort: string | undefined,
  ): boolean {
    if (status !== 400) return false
    if (model.wire === 'messages' && !flags.withoutThinking && effort !== undefined && effort !== 'off'
      && rejectsField(raw, THINKING_REFUSED)) {
      flags.withoutThinking = true
      this.dependencies.warn?.(`dsh-provider-commandcode: ${model.id} refused the thinking fields; retrying without them`)
      return true
    }
    if (model.wire === 'chat' && !flags.withoutEffort && effort !== undefined && rejectsField(raw, EFFORT_REFUSED)) {
      flags.withoutEffort = true
      this.dependencies.warn?.(`dsh-provider-commandcode: ${model.id} refused reasoning_effort; retrying without it`)
      return true
    }
    if (model.wire === 'chat' && !flags.reasoningBack && rejectsField(raw, REASONING_REQUIRED)) {
      flags.reasoningBack = true
      this.dependencies.warn?.(`dsh-provider-commandcode: ${model.id} requires earlier reasoning back; retrying with it`)
      return true
    }
    return false
  }

  /** Decode one provider stream into JSON events, ending at the wire's own terminator. */
  private async * events(body: ReadableStream<Uint8Array>, activity: () => void): AsyncGenerator<Record<string, unknown>> {
    for await (const frame of parseSse(body, activity)) {
      if (frame.data === '[DONE]') return
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch (_invalidJson) {
        throw new LlmError('Command Code stream contains invalid JSON', 'MALFORMED_RESPONSE')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new LlmError('Command Code stream contains a non-object event', 'MALFORMED_RESPONSE')
      }
      const event = parsed as Record<string, unknown>
      if (typeof event.type === 'string' && frame.event !== undefined && frame.event !== event.type) {
        throw new LlmError('Command Code stream event type mismatch', 'MALFORMED_RESPONSE')
      }
      yield event
    }
  }
}
