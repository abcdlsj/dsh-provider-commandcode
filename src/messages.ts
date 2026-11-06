/**
 * Anthropic Messages wire: request serialization and SSE translation for the
 * Claude models Command Code serves on `/messages`.
 * @module dsh-commandcode/messages
 */

import { LlmError, ToolCallId, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { CatalogModel } from './catalog-types.js'
import type { ThinkingMode } from './config.js'
import { malformedResponse, providerError } from './errors.js'

/** Request inputs owned by the adapter. */
export interface MessagesRequestInput {
  /** Fully assembled harness request. */
  readonly options: GenerateOptions<string>
  /** Served model entry. */
  readonly model: CatalogModel
  /** Request image versions keyed by attachment id. */
  readonly images: ReadonlyMap<string, RequestImageAttachment>
  /** Adapter-owned effort selected for this request. */
  readonly effort: string | undefined
  /** How thinking is asked for. */
  readonly thinking: ThinkingMode
  /** Default per-request output cap. */
  readonly maxTokens: number
  /** Whether to omit `thinking`/`output_config` after the provider refused them. */
  readonly withoutThinking: boolean
}

type Json = Record<string, unknown>

/** Thinking budgets by effort for the `budget` thinking mode. */
const BUDGETS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 16_384,
  xhigh: 32_768,
  max: 32_768,
}

function unsupported(type: string): never {
  throw new LlmError(`Command Code Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Historical tool arguments Messages cannot represent use empty input; durable content stays unchanged. */
function toolInput(raw: string): Json {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}

function imageSource(block: Extract<ContentBlock, { type: 'image' }>, images: MessagesRequestInput['images']): Json {
  const version = images.get(block.attachment.attachmentId)
  if (version === undefined) {
    if (block.offloaded === true) return { type: 'text', text: textOnlyImageText(block.attachment) }
    throw new LlmError('Command Code request image is missing', 'INVALID_REQUEST')
  }
  return { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
}

/** Thinking fields for one request, already reconciled with the output cap. */
export function thinkingFields(
  mode: ThinkingMode,
  effort: string | undefined,
  maxTokens: number,
): { thinking?: Json; output_config?: Json } {
  if (mode === 'disabled' || effort === undefined || effort === 'off') return {}
  if (mode === 'budget') {
    // Anthropic requires budget_tokens < max_tokens, with room left for an answer.
    if (maxTokens <= 2048) return { thinking: { type: 'enabled' } }
    const budget = Math.max(1024, Math.min(BUDGETS[effort] ?? 8192, maxTokens - 1024))
    return { thinking: { type: 'enabled', budget_tokens: budget } }
  }
  return { thinking: { type: 'enabled' }, output_config: { effort } }
}

/**
 * Serialize one request as an Anthropic Messages body.
 * @param input - harness request, model, prepared images, and thinking policy.
 * @returns the JSON body sent to `/messages`.
 */
export function buildMessagesRequest(input: MessagesRequestInput): Json {
  const { options, model } = input
  const maxTokens = options.maxTokens ?? model.maxTokens ?? input.maxTokens
  const imageCapable = model.inputModalities.includes('image')
  const textOf = (blocks: readonly ContentBlock[]): string =>
    blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')

  const wireContent = (blocks: readonly ContentBlock[]): Json[] => blocks.flatMap((block): Json[] => {
    if (block.type === 'text') return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
    if (block.type === 'reasoning' || block.type === 'tool-call') return []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    if (!imageCapable || block.offloaded === true) {
      return [{ type: 'text', text: textOnlyImageText(block.attachment) }]
    }
    return [imageSource(block, input.images)]
  })

  const messages: { role: 'user' | 'assistant'; content: Json[] }[] = []
  let system: string | undefined
  for (const message of options.messages) {
    if (message.role === 'system') {
      // Command Code takes the leading system slot; a later snapshot replaces
      // it, as the harness's own durable prompt does.
      const text = textOf(message.content)
      if (text.length > 0) system = text
      continue
    }
    if (message.role === 'developer') {
      const text = textOf(message.content)
      if (text.length > 0) system = system === undefined ? text : `${system}\n\n${text}`
      continue
    }
    if (message.role === 'tool') {
      const block: Json = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: wireContent(message.content),
        ...message.isError === true ? { is_error: true } : {},
      }
      push(messages, 'user', block)
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content.flatMap((block): Json[] => {
        switch (block.type) {
          case 'text': return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
          case 'tool-call': return [{ type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }]
          // Thinking is never replayed: this adapter keeps no signatures, and a
          // thinking block without one is refused.
          case 'reasoning': return []
          default: return unsupported(`assistant content ${block.type}`)
        }
      })
      if (content.length === 0) continue
      push(messages, 'assistant', ...content)
      continue
    }
    const content = wireContent(message.content)
    if (content.length === 0) continue
    push(messages, 'user', ...content)
  }

  let pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.filter((block) => block.type === 'tool_use')
      pending = new Set(calls.map((block) => String(block.id)))
      if (pending.size !== calls.length) throw new LlmError('Command Code Messages duplicate tool call id', 'INVALID_REQUEST')
      continue
    }
    const results = message.content.filter((block) => block.type === 'tool_result')
    for (const result of results) {
      if (!pending.delete(String(result.tool_use_id))) {
        throw new LlmError('Command Code Messages tool result has no matching call', 'INVALID_REQUEST')
      }
    }
    if (pending.size > 0) throw new LlmError('Command Code Messages tool calls need immediate results', 'INVALID_REQUEST')
    message.content = [...results, ...message.content.filter((block) => block.type !== 'tool_result')]
  }
  if (pending.size > 0) throw new LlmError('Command Code Messages history ends with unresolved tools', 'INVALID_REQUEST')

  const thinking = input.withoutThinking
    ? {}
    : thinkingFields(input.thinking, input.effort, maxTokens)
  const thinkingEnabled = thinking.thinking !== undefined
  const systemText = [input.options.system, system].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
  return {
    model: model.id,
    stream: true,
    max_tokens: maxTokens,
    messages,
    ...systemText.length === 0 ? {} : { system: systemText },
    // Extended thinking requires the provider default temperature.
    ...input.options.temperature === undefined || thinkingEnabled ? {} : { temperature: input.options.temperature },
    ...input.options.stop === undefined ? {} : { stop_sequences: input.options.stop },
    ...thinking,
    ...input.options.tools === undefined || input.options.tools.length === 0 ? {} : {
      tools: input.options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    },
  }
}

/** Append content to the previous same-role turn, or start a new one. */
function push(messages: { role: 'user' | 'assistant'; content: Json[] }[], role: 'user' | 'assistant', ...content: Json[]): void {
  const previous = messages.at(-1)
  if (previous?.role === role) previous.content.push(...content)
  else messages.push({ role, content })
}

interface MessageBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  json: string
  id?: string
  name?: string
  closed: boolean
}

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformedResponse('expected a JSON object')
  return value as Json
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') return malformedResponse(`expected ${field} to be a string`)
  return value
}

function indexOf(event: Json): number {
  if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) return malformedResponse('invalid block index')
  return event.index as number
}

function updateUsage(usage: TokenUsage, raw: unknown): void {
  const fields = record(raw)
  const keys = {
    input_tokens: 'inputTokens',
    output_tokens: 'outputTokens',
    cache_read_input_tokens: 'cacheReadTokens',
    cache_creation_input_tokens: 'cacheWriteTokens',
  } as const
  for (const [wire, local] of Object.entries(keys)) {
    const value = fields[wire]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || (value as number) < 0) return malformedResponse(`invalid ${wire}`)
    usage[local] = value as number
  }
}

function stopReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
      return { kind: 'stop' }
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return malformedResponse(`unsupported stop reason ${String(raw)}`)
  }
}

/**
 * Translate Messages SSE events into harness stream chunks.
 * @param events - decoded provider events in arrival order.
 * @param options - model id for diagnostics.
 * @returns blocks in first-seen order, one usage value, and exactly one finish.
 */
export async function* translateMessages(
  events: AsyncIterable<Json>,
  options: { readonly model: string },
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, MessageBlock>()
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  // Harness block indexes count surfaced blocks only, so a wire block this
  // adapter drops does not leave a gap in the stream.
  let nextIndex = 0
  let started = false
  let reason: FinishReason | undefined
  for await (const event of events) {
    const type = String(event.type)
    if (type === 'message_start') {
      if (started) return malformedResponse('duplicate message_start')
      const message = record(event.message)
      if (message.usage !== undefined) updateUsage(usage, message.usage)
      started = true
      continue
    }
    if (type === 'content_block_start' || type === 'content_block_delta' || type === 'content_block_stop'
      || type === 'message_delta' || type === 'message_stop') {
      if (!started) return malformedResponse('event precedes message_start')
    } else if (type === 'error') {
      throw providerError(event, undefined)
    } else if (type === 'ping') {
      continue
    } else {
      // Anthropic adds event types over time; content-bearing events stay validated below.
      continue
    }
    if (type === 'content_block_start') {
      const wireIndex = indexOf(event)
      if (blocks.has(wireIndex) || reason !== undefined) return malformedResponse('block starts after settlement or repeats an index')
      const native = record(event.content_block)
      if (native.type === 'text' || native.type === 'thinking' || native.type === 'tool_use') {
        const block: MessageBlock = {
          index: nextIndex,
          kind: native.type === 'thinking' ? 'reasoning' : native.type === 'tool_use' ? 'tool-call' : 'text',
          text: '',
          json: '',
          closed: false,
          ...native.type === 'tool_use'
            ? { id: str(native.id, 'tool id'), name: str(native.name, 'tool name') }
            : { text: str(native.type === 'thinking' ? native.thinking : native.text, 'block text') },
        }
        nextIndex += 1
        blocks.set(wireIndex, block)
        yield { type: 'block-start', index: block.index, blockType: block.kind }
        if (block.kind === 'tool-call') {
          yield {
            type: 'tool-call-delta', index: block.index,
            id: ToolCallId(block.id as string),
            ...block.name === undefined ? {} : { name: block.name },
            argumentsDelta: '',
          }
        } else if (block.text.length > 0) {
          yield {
            type: block.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
            index: block.index,
            text: block.text,
          }
        }
      } else {
        // A block this adapter does not surface (for example redacted
        // thinking) keeps its wire index but yields no harness block.
        blocks.set(wireIndex, { index: -1, kind: 'text', text: '', json: '', closed: true })
      }
      continue
    }
    if (type === 'content_block_delta' || type === 'content_block_stop') {
      const block = blocks.get(indexOf(event))
      // A wire block this adapter does not surface settles silently at its stop.
      if (block !== undefined && block.index < 0) continue
      if (block === undefined || block.closed) return malformedResponse('delta/stop without an open block')
      if (type === 'content_block_delta') {
        const delta = record(event.delta)
        if (delta.type === 'text_delta' && block.kind === 'text') {
          const text = str(delta.text, 'text')
          block.text += text
          yield { type: 'text-delta', index: block.index, text }
        } else if (delta.type === 'thinking_delta' && block.kind === 'reasoning') {
          const text = str(delta.thinking, 'thinking')
          block.text += text
          yield { type: 'reasoning-delta', index: block.index, text }
        } else if (delta.type === 'signature_delta' && block.kind === 'reasoning') {
          // Replay state is not kept; the signature is dropped with it.
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool-call') {
          const argumentsDelta = str(delta.partial_json, 'partial_json')
          block.json += argumentsDelta
          yield { type: 'tool-call-delta', index: block.index, id: ToolCallId(block.id as string), argumentsDelta }
        } else {
          return malformedResponse(`unsupported delta ${String(delta.type)} for ${block.kind}`)
        }
        continue
      }
      block.closed = true
      yield { type: 'block-end', index: block.index, block: endBlock(block) }
      continue
    }
    if (type === 'message_delta') {
      const delta = record(event.delta)
      if (delta.stop_reason !== null && delta.stop_reason !== undefined) reason = stopReason(delta.stop_reason)
      if (event.usage !== undefined) updateUsage(usage, event.usage)
      continue
    }
    // message_stop
    if (reason === undefined || [...blocks.values()].some((block) => block.index >= 0 && !block.closed)) {
      return malformedResponse('message_stop without settled blocks and a stop reason')
    }
    const emitted = [...blocks.values()].filter((block) => block.index >= 0)
    if (emitted.length === 0 && reason.kind === 'stop') throw new LlmError('Command Code returned no content', 'EMPTY_RESPONSE')
    if (reason.kind !== 'max-tokens') {
      for (const block of emitted) {
        if (block.kind !== 'tool-call') continue
        try {
          record(JSON.parse(block.json.length === 0 ? '{}' : block.json))
        } catch (_invalidProviderToolJson) {
          return malformedResponse('tool input is invalid JSON')
        }
      }
    }
    usage.totalTokens = usage.inputTokens + usage.outputTokens
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    yield { type: 'usage', usage }
    yield { type: 'finish', reason }
    return
  }
  throw new LlmError('Command Code Messages stream ended before message_stop', 'STREAM_CLOSED')
}

/** The harness block a closed Messages block settles as. */
function endBlock(block: MessageBlock): ContentBlock {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  // Truncated tool JSON is kept as streamed and pruned by the shared assembler.
  return {
    type: 'tool-call',
    id: ToolCallId(block.id ?? ''),
    name: block.name ?? '',
    arguments: block.json.length > 0 ? block.json : '{}',
  }
}
