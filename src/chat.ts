/**
 * OpenRouter-style Chat Completions wire: request serialization and SSE
 * translation for every non-Claude Command Code model.
 * @module dsh-provider-commandcode/chat
 */

import { LlmError, ToolCallId, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { CatalogModel } from './catalog-types.js'
import { malformedResponse, providerError } from './errors.js'
import { inlineSchemaRefs } from './google-schema.js'

/** Request inputs owned by the adapter. */
export interface ChatRequestInput {
  /** Fully assembled harness request. */
  readonly options: GenerateOptions<string>
  /** Served model entry. */
  readonly model: CatalogModel
  /** Request image versions keyed by attachment id. */
  readonly images: ReadonlyMap<string, RequestImageAttachment>
  /** Adapter-owned effort selected for this request. */
  readonly effort: string | undefined
  /** Whether earlier assistant reasoning is replayed as `reasoning_content`. */
  readonly reasoningBack: boolean
  /** Default per-request output cap. */
  readonly maxTokens: number
}

type Json = Record<string, unknown>

function unsupported(type: string): never {
  throw new LlmError(`Command Code Chat Completions cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Google's OpenAI-compatible endpoint rejects unresolved `$ref`, so its schemas are inlined. */
function isGoogleModel(id: string): boolean {
  return /^google\/|(?:^|\/)gemini/iu.test(id)
}

function toolParameters(parameters: Record<string, unknown>, model: string): Record<string, unknown> {
  return isGoogleModel(model) ? inlineSchemaRefs(parameters) : parameters
}

function imagePart(block: Extract<ContentBlock, { type: 'image' }>, images: ChatRequestInput['images']): Json {
  const version = images.get(block.attachment.attachmentId)
  if (version === undefined) {
    if (block.offloaded === true) return { type: 'text', text: textOnlyImageText(block.attachment) }
    throw new LlmError('Command Code request image is missing', 'INVALID_REQUEST')
  }
  const base64 = Buffer.from(version.data).toString('base64')
  return { type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${base64}` } }
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Serialize one request as an OpenAI-compatible Chat Completions body.
 * @param input - harness request, model, prepared images, and effort.
 * @returns the JSON body sent to `/chat/completions`.
 */
export function buildChatRequest(input: ChatRequestInput): Json {
  const { options, model } = input
  const system: string[] = options.system === undefined ? [] : [options.system]
  const messages: Json[] = []
  const imageCapable = model.inputModalities.includes('image')

  const content = (message: RequestMessage): string | Json[] => {
    const parts: Json[] = []
    let plain = ''
    for (const block of message.content) {
      if (block.type === 'text') {
        plain += block.text
        continue
      }
      if (block.type === 'image') {
        if (!imageCapable || block.offloaded === true) {
          plain += textOnlyImageText(block.attachment)
          continue
        }
        if (plain.length > 0) {
          parts.push({ type: 'text', text: plain })
          plain = ''
        }
        parts.push(imagePart(block, input.images))
        continue
      }
      if (block.type === 'reasoning') continue
      unsupported(`${message.role} content ${block.type}`)
    }
    if (parts.length === 0) return plain
    if (plain.length > 0) parts.push({ type: 'text', text: plain })
    return parts
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      system.push(textOf(message.content))
      continue
    }
    if (message.role === 'developer') {
      const text = textOf(message.content)
      if (text.length > 0) system.push(text)
      continue
    }
    if (message.role === 'tool') {
      // OpenAI-compatible tool results are text; an image is named, not sent.
      const body = message.content.flatMap((block) => block.type === 'text'
        ? [block.text]
        : block.type === 'image' ? [textOnlyImageText(block.attachment)] : [])
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: body.join('') })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      const toolCalls = message.content.flatMap((block) => block.type === 'tool-call'
        ? [{
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments.length === 0 ? '{}' : block.arguments },
        }]
        : [])
      const reasoning = message.content.flatMap((block) => block.type === 'reasoning' ? [block.text] : []).join('')
      if (text.length === 0 && toolCalls.length === 0) continue
      messages.push({
        role: 'assistant',
        content: text.length === 0 ? null : text,
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        ...!input.reasoningBack || reasoning.length === 0 ? {} : { reasoning_content: reasoning },
      })
      continue
    }
    const body = content(message)
    if (typeof body === 'string' && body.length === 0) continue
    messages.push({ role: 'user', content: body })
  }

  const systemText = system.filter((part) => part.length > 0).join('\n\n')
  return {
    model: model.id,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...systemText.length === 0 ? [] : [{ role: 'system', content: systemText }],
      ...messages,
    ],
    max_tokens: options.maxTokens ?? model.maxTokens ?? input.maxTokens,
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop: options.stop },
    ...input.effort === undefined ? {} : { reasoning_effort: input.effort },
    ...options.tools === undefined || options.tools.length === 0 ? {} : {
      tools: options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toolParameters(tool.parameters, model.id),
        },
      })),
    },
  }
}

interface ChatToolCall {
  readonly wireIndex: number
  readonly index: number
  id: string
  name: string
  arguments: string
}

interface ChatBlockState {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  call?: ChatToolCall
}

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformedResponse('expected a JSON object')
  }
  return value as Json
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') return malformedResponse(`expected ${field} to be a string`)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return malformedResponse(`invalid ${field}`)
  return value as number
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function usageOf(raw: unknown): TokenUsage {
  const fields = record(raw)
  const prompt = number(fields.prompt_tokens)
  const completion = number(fields.completion_tokens)
  const details = typeof fields.prompt_tokens_details === 'object' && fields.prompt_tokens_details !== null
    ? fields.prompt_tokens_details as Json
    : {}
  const completionDetails = typeof fields.completion_tokens_details === 'object' && fields.completion_tokens_details !== null
    ? fields.completion_tokens_details as Json
    : undefined
  // Command Code reports cache hits under `cached_tokens` and also mirrors the
  // Anthropic-shaped counters, so either spelling of a cache read counts once.
  const cached = number(details.cached_tokens) || number(details.cache_read_input_tokens)
  const cacheWrite = number(details.cache_creation_input_tokens) || number(details.cache_write_tokens)
  const reasoning = completionDetails === undefined ? 0 : number(completionDetails.reasoning_tokens)
  const total = typeof fields.total_tokens === 'number' ? fields.total_tokens : prompt + completion
  const billedPrompt = prompt - cached
  return {
    inputTokens: Math.max(0, billedPrompt),
    outputTokens: completion,
    totalTokens: total,
    ...cached === 0 ? {} : { cacheReadTokens: cached },
    ...cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
}

function finishReason(raw: unknown): FinishReason | undefined {
  switch (raw) {
    case null:
    case undefined: return undefined
    case 'stop': return { kind: 'stop' }
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'content_filter': return { kind: 'stop' }
    default: return malformedResponse(`unsupported finish reason ${String(raw)}`)
  }
}

/**
 * Translate Chat Completions SSE events into harness stream chunks.
 * @param events - decoded provider events in arrival order, excluding `[DONE]`.
 * @param options - cancellation-independent translation flags.
 * @returns blocks in first-seen order, one usage value, and exactly one finish.
 */
export async function* translateChat(
  events: AsyncIterable<Json>,
  options: { readonly model: string },
): AsyncGenerator<StreamChunk> {
  const blocks: ChatBlockState[] = []
  const tools = new Map<number, ChatToolCall>()
  let text: ChatBlockState | undefined
  let reasoning: ChatBlockState | undefined
  let usage: TokenUsage | undefined
  let reason: FinishReason | undefined

  const start = (kind: ChatBlockState['kind']): ChatBlockState => {
    const block: ChatBlockState = { index: blocks.length, kind, text: '' }
    blocks.push(block)
    return block
  }

  for await (const event of events) {
    if (typeof event.error !== 'undefined' && event.error !== null) throw providerError(event, undefined)
    if (event.usage !== null && event.usage !== undefined) usage = usageOf(event.usage)
    const choices = Array.isArray(event.choices) ? event.choices : []
    for (const raw of choices) {
      const choice = record(raw)
      if (choice.index !== 0 && choice.index !== undefined) continue
      const delta = record(choice.delta ?? {})
      const contentAfterFinish = reason !== undefined
        && (typeof delta.content === 'string' || typeof delta.reasoning_content === 'string'
          || typeof delta.reasoning === 'string' || Array.isArray(delta.tool_calls))
      if (contentAfterFinish) return malformedResponse(`content after finish reason for ${options.model}`)
      const reasoningDelta = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : undefined
      if (reasoningDelta !== undefined && reasoningDelta.length > 0) {
        if (reasoning === undefined) {
          reasoning = start('reasoning')
          yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
        }
        reasoning.text += reasoningDelta
        yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (text === undefined) {
          text = start('text')
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.text += delta.content
        yield { type: 'text-delta', index: text.index, text: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall)
          const wireIndex = nonNegativeInteger(call.index ?? 0, 'tool call index')
          const fn = call.function === undefined ? {} : record(call.function)
          let state = tools.get(wireIndex)
          if (state === undefined) {
            const block = start('tool-call')
            state = {
              wireIndex,
              index: block.index,
              id: typeof call.id === 'string' ? call.id : '',
              name: typeof fn.name === 'string' ? fn.name : '',
              arguments: '',
            }
            block.call = state
            tools.set(wireIndex, state)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(state.id.length === 0 ? `call_${wireIndex}` : state.id),
              ...state.name.length === 0 ? {} : { name: state.name },
              argumentsDelta: '',
            }
          } else {
            if (typeof call.id === 'string' && call.id.length > 0) state.id = call.id
            if (typeof fn.name === 'string' && fn.name.length > 0) {
              state.name = state.name.length === 0
                ? fn.name
                : fn.name.startsWith(state.name) ? fn.name : state.name + fn.name
            }
          }
          const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
          if (argumentsDelta.length > 0) {
            state.arguments += argumentsDelta
            yield {
              type: 'tool-call-delta',
              index: state.index,
              id: ToolCallId(state.id.length === 0 ? `call_${wireIndex}` : state.id),
              ...state.name.length === 0 ? {} : { name: state.name },
              argumentsDelta,
            }
          }
        }
      }
      const settled = finishReason(choice.finish_reason)
      if (settled !== undefined) reason = settled
    }
  }

  if (reason === undefined) return malformedResponse(`stream ended before a finish reason for ${options.model}`)
  for (const block of blocks) {
    if (block.kind === 'text') {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      continue
    }
    if (block.kind === 'reasoning') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      continue
    }
    const call = block.call as ChatToolCall
    if (call.id.length === 0) call.id = `call_${call.wireIndex}`
    if (call.name.length === 0) return malformedResponse('tool call without a name')
    if (reason.kind !== 'max-tokens' && call.arguments.length > 0) {
      try {
        JSON.parse(call.arguments)
      } catch (_invalidToolArguments) {
        return malformedResponse(`tool call ${call.name} has invalid JSON arguments`)
      }
    }
    yield {
      type: 'block-end',
      index: block.index,
      block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments.length === 0 ? '{}' : call.arguments },
    }
  }
  if (blocks.length === 0) throw new LlmError('Command Code returned no content', 'EMPTY_RESPONSE')
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason }
}
