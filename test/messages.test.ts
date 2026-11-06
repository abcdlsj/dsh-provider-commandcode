import { describe, expect, test } from 'vitest'
import { ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { buildMessagesRequest, thinkingFields, translateMessages } from '../src/messages.js'
import type { CatalogModel } from '../src/catalog-types.js'

const claude: CatalogModel = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  wire: 'messages',
  contextWindow: 1_000_000,
  inputModalities: ['text', 'image'],
  maxTokens: 64_000,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  origin: 'static',
}

function request(overrides: Partial<GenerateOptions<string>> = {}): GenerateOptions<string> {
  return {
    provider: 'commandcode',
    model: claude.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

function build(overrides: Partial<GenerateOptions<string>> = {}, extra: Partial<Parameters<typeof buildMessagesRequest>[0]> = {}) {
  return buildMessagesRequest({
    options: request(overrides),
    model: claude,
    images: new Map(),
    effort: undefined,
    thinking: 'effort',
    maxTokens: 64_000,
    withoutThinking: false,
    ...extra,
  })
}

describe('thinkingFields', () => {
  test('maps effort ids without clamping', () => {
    expect(thinkingFields('effort', 'xhigh', 64_000)).toEqual({
      thinking: { type: 'enabled' },
      output_config: { effort: 'xhigh' },
    })
  })

  test('turns effort into a budget that fits the output cap', () => {
    expect(thinkingFields('budget', 'max', 64_000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 32_768 },
    })
    expect(thinkingFields('budget', 'max', 4096)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 3072 },
    })
  })

  test('asks for nothing when thinking is off or disabled', () => {
    expect(thinkingFields('effort', undefined, 64_000)).toEqual({})
    expect(thinkingFields('effort', 'off', 64_000)).toEqual({})
    expect(thinkingFields('disabled', 'high', 64_000)).toEqual({})
  })
})

describe('buildMessagesRequest', () => {
  test('merges system snapshots into the top-level slot', () => {
    const body = build({
      system: 'one-shot',
      messages: [
        createSystemMessage('durable'),
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    })
    expect(body.system).toBe('one-shot\n\ndurable')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  test('serializes tool calls and results, dropping replayed thinking', () => {
    const callId = ToolCallId('toolu_1')
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'using a tool' },
        { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { provider: 'commandcode', model: claude.id },
    })
    const result = createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: true })
    const body = build({ messages: [assistant, result] })
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'using a tool' },
          { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }], is_error: true }] },
    ])
  })

  test('keeps images native for a vision model and as text otherwise', () => {
    const ref = { attachmentId: 'sha256:abc' } as unknown as ImageAttachmentRef
    const version = {
      variantId: 'v1', attachment: ref, data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png',
      bytes: 4, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
    } as unknown as RequestImageAttachment
    const messages = [{ role: 'user' as const, content: [{ type: 'image' as const, attachment: ref }] }]
    expect(build({ messages }, { images: new Map([['sha256:abc', version]]) }).messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } }] },
    ])
    const textOnly = build({ messages }, { model: { ...claude, inputModalities: ['text'] } }).messages as { content: { type: string; text?: string }[] }[]
    expect(textOnly[0]?.content[0]?.type).toBe('text')
    expect(textOnly[0]?.content[0]?.text).toContain('image omitted')
  })

  test('declares tools with the Messages input schema', () => {
    const body = build({ tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] })
    expect(body.tools).toEqual([{ name: 'bash', description: 'run', input_schema: { type: 'object' } }])
  })

  test('enables thinking and drops temperature when thinking is on', () => {
    const body = build({ temperature: 0.5 }, { effort: 'high' })
    expect(body).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'high' } })
    expect(body.temperature).toBeUndefined()
    const noThinking = build({ temperature: 0.5 }, { withoutThinking: true, effort: 'high' })
    expect(noThinking.thinking).toBeUndefined()
    expect(noThinking.temperature).toBe(0.5)
  })

  test('refuses tool calls without immediate results and unresolved history', () => {
    const callId = ToolCallId('toolu_2')
    const assistant = createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { provider: 'commandcode', model: claude.id },
    })
    expect(() => build({ messages: [assistant] })).toThrow(/unresolved tools|immediate results/u)
  })
})

async function* events(items: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  yield* items
}

async function collect(items: Record<string, unknown>[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateMessages(events(items), { model: claude.id })) chunks.push(chunk)
  return chunks
}

const start = (event: Record<string, unknown>) => ({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 }, ...event } })

describe('translateMessages', () => {
  test('translates text blocks with usage and stop reason', async () => {
    const chunks = await collect([
      start({}),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  test('translates thinking, tool use, and cache usage', async () => {
    const chunks = await collect([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'bash', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'hmm' })
    expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } })
    expect(chunks[3]).toEqual({ type: 'block-start', index: 1, blockType: 'tool-call' })
    expect(chunks.at(-2)).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 0, totalTokens: 110, cacheReadTokens: 100, cacheWriteTokens: 7 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.find((item) => item.type === 'block-end' && item.index === 1)).toMatchObject({
      block: { type: 'tool-call', id: 'toolu_9', name: 'bash', arguments: '{"command":"ls"}' },
    })
  })

  test('drops a block this adapter does not surface', async () => {
    const chunks = await collect([
      start({}),
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'visible' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ])
    expect(chunks.filter((item) => item.type.startsWith('block'))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'visible' } },
    ])
  })

  test('maps stop reasons and reports failures', async () => {
    const stop = (reason: string) => collect([
      start({}),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])
    expect((await stop('max_tokens')).at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect((await stop('stop_sequence')).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    await expect(stop('weird')).rejects.toThrow(/unsupported stop reason/u)
    await expect(collect([start({})])).rejects.toThrow(/before message_stop/u)
    await expect(collect([{ type: 'error', error: { message: 'boom', type: 'api_error' } }]))
      .rejects.toThrow(/boom/u)
    await expect(collect([
      start({}),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])).rejects.toThrow(/returned no content/u)
  })
})
