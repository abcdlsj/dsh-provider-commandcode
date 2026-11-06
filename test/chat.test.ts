import { describe, expect, test } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { buildChatRequest, translateChat } from '../src/chat.js'
import type { CatalogModel } from '../src/catalog-types.js'

const gpt: CatalogModel = {
  id: 'gpt-6-sol',
  name: 'GPT-6 Sol',
  wire: 'chat',
  contextWindow: 1_050_000,
  inputModalities: ['text', 'image'],
  maxTokens: 64_000,
  efforts: ['low', 'medium', 'high'],
  origin: 'static',
}

const gemini: CatalogModel = { ...gpt, id: 'google/gemini-3.8-flash', inputModalities: ['text'] }

function request(overrides: Partial<GenerateOptions<string>> = {}): GenerateOptions<string> {
  return {
    provider: 'commandcode',
    model: gpt.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

function imageVersion(id: string): RequestImageAttachment {
  return {
    variantId: 'v1' as RequestImageAttachment['variantId'],
    attachment: { attachmentId: id } as unknown as ImageAttachmentRef,
    data: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

describe('buildChatRequest', () => {
  test('sends the system prompt, defaults, and tool declarations', () => {
    const body = buildChatRequest({
      options: request({
        system: 'one-shot system',
        maxTokens: 1000,
        temperature: 0.2,
        stop: ['END'],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
      }),
      model: gpt,
      images: new Map(),
      effort: 'high',
      reasoningBack: false,
      maxTokens: 64_000,
    })
    expect(body).toMatchObject({
      model: 'gpt-6-sol',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1000,
      temperature: 0.2,
      stop: ['END'],
      reasoning_effort: 'high',
      messages: [{ role: 'system', content: 'one-shot system' }, { role: 'user', content: 'hello' }],
    })
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } },
    }])
  })

  test('serializes tool calls, tool results, and replayed reasoning', () => {
    const callId = ToolCallId('call-1')
    const assistant = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { provider: 'commandcode', model: gpt.id },
    })
    const result = createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false })
    const body = buildChatRequest({
      options: request({ messages: [
        { role: 'user', content: [{ type: 'text', text: 'do it' }] },
        assistant,
        result,
      ] }),
      model: gpt,
      images: new Map(),
      effort: undefined,
      reasoningBack: true,
      maxTokens: 64_000,
    })
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'calling',
      reasoning_content: 'thinking',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    })
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'ok' })
  })

  test('omits replayed reasoning unless the route asks for it', () => {
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'visible' }],
      source: { provider: 'commandcode', model: gpt.id },
    })
    const body = buildChatRequest({
      options: request({ messages: [assistant] }), model: gpt, images: new Map(), effort: undefined,
      reasoningBack: false, maxTokens: 64_000,
    })
    expect((body.messages as Record<string, unknown>[])[0]).toEqual({ role: 'assistant', content: 'visible' })
    const replayed = buildChatRequest({
      options: request({ messages: [assistant] }), model: gpt, images: new Map(), effort: undefined,
      reasoningBack: true, maxTokens: 64_000,
    })
    expect((replayed.messages as Record<string, unknown>[])[0]).toMatchObject({ reasoning_content: 'secret' })
  })

  test('fills a reasoning slot a required model would otherwise reject', () => {
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: 'from another model' }],
      source: { provider: 'commandcode', model: gpt.id },
    })
    const body = buildChatRequest({
      options: request({ messages: [assistant] }), model: gpt, images: new Map(), effort: undefined,
      reasoningBack: true, maxTokens: 64_000,
    })
    expect((body.messages as Record<string, unknown>[])[0]).toMatchObject({ reasoning_content: '.' })
  })

  test('sends images as data URLs for a vision model and as text otherwise', () => {
    const ref = { attachmentId: 'sha256:abc' } as unknown as ImageAttachmentRef
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'image' as const, attachment: ref }] }]
    const vision = buildChatRequest({
      options: request({ messages }), model: gpt, images: new Map([['sha256:abc', imageVersion('sha256:abc')]]),
      effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })
    expect((vision.messages as Record<string, unknown>[])[0]).toMatchObject({
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } },
      ],
    })
    const textOnly = buildChatRequest({
      options: request({ messages }), model: gemini, images: new Map(),
      effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })
    const content = (textOnly.messages as Record<string, unknown>[])[0]?.content as string
    expect(content).toContain('look')
    expect(content).toContain('image omitted')
  })

  test('inlines non-$defs references for Google models only', () => {
    const parameters = {
      type: 'object',
      properties: {
        func: { type: 'object', properties: { triggers: { type: 'array', items: { type: 'string' } } } },
        extra: { type: 'array', items: { $ref: '#/properties/func/properties/triggers/items', description: 'again' } },
      },
    }
    const build = (model: CatalogModel) => buildChatRequest({
      options: request({ tools: [{ name: 'schedule', description: 'd', parameters }] }),
      model, images: new Map(), effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })
    const googleParameters = ((build(gemini).tools as Record<string, unknown>[])[0] as { function: { parameters: unknown } }).function.parameters
    expect(JSON.stringify(googleParameters)).not.toContain('$ref')
    const other = ((build(gpt).tools as Record<string, unknown>[])[0] as { function: { parameters: unknown } }).function.parameters
    expect(other).toBe(parameters)
  })

  test('omits an empty stop list and refuses a message-less request', () => {
    const body = buildChatRequest({
      options: request({ stop: [] }), model: gpt, images: new Map(), effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })
    expect(body).not.toHaveProperty('stop')
    expect(() => buildChatRequest({
      options: request({ messages: [{ role: 'user', content: [] }] }),
      model: gpt, images: new Map(), effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })).toThrow(/at least one conversation message/u)
  })

  test('refuses a content block the wire cannot carry', () => {
    expect(() => buildChatRequest({
      options: request({ messages: [{ role: 'user', content: [{ type: 'tool-addition', toolName: 'x' }] }] }),
      model: gpt, images: new Map(), effort: undefined, reasoningBack: false, maxTokens: 64_000,
    })).toThrow(/cannot represent user content tool-addition/u)
  })
})

async function* events(items: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  yield* items
}

async function collect(items: Record<string, unknown>[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateChat(events(items), { model: 'gpt-6-sol' })) chunks.push(chunk)
  return chunks
}

const chunk = (delta: Record<string, unknown>, finish: unknown = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
})

describe('translateChat', () => {
  test('translates text, a trailing usage chunk, and the finish reason', async () => {
    const chunks = await collect([
      chunk({ role: 'assistant', content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  test('allocates reasoning before text and reports cached input', async () => {
    const chunks = await collect([
      chunk({ reasoning_content: 'why' }),
      chunk({ content: 'answer' }),
      chunk({}, 'stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      },
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'why' })
    expect(chunks[2]).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, reasoningTokens: 7 },
    })
  })

  test('reads either cache-counter spelling once', async () => {
    const chunks = await collect([
      chunk({ content: 'x' }),
      chunk({}, 'stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 6 },
        },
      },
    ])
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 54, cacheReadTokens: 30, cacheWriteTokens: 6 },
    })
  })

  test('assembles a fragmented tool call', async () => {
    const chunks = await collect([
      chunk({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"comm' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }),
      chunk({}, 'tool_calls'),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'bash', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'bash', argumentsDelta: '{"comm' },
      { type: 'tool-call-delta', index: 0, id: 'call_9', name: 'bash', argumentsDelta: 'and":"ls"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  test('substitutes the wire index when the provider never sends a call id', async () => {
    const chunks = await collect([
      chunk({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ])
    expect(chunks.find((item) => item.type === 'tool-call-delta')).toMatchObject({ id: 'call_0' })
    expect(chunks.find((item) => item.type === 'block-end')).toMatchObject({ block: { id: 'call_0' } })
  })

  test('keeps truncated tool arguments on a length stop', async () => {
    const chunks = await collect([
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{"partial' } }] }),
      chunk({}, 'length'),
    ])
    expect(chunks.at(-2)).toMatchObject({ type: 'block-end', block: { arguments: '{"partial' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  test('refuses invalid completed tool arguments', async () => {
    await expect(collect([
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'bash', arguments: '{oops' } }] }),
      chunk({}, 'tool_calls'),
    ])).rejects.toThrow(/invalid JSON arguments/u)
  })

  test('refuses a stream without a finish reason', async () => {
    await expect(collect([chunk({ content: 'x' })])).rejects.toThrow(/before a finish reason/u)
  })

  test('refuses an unsupported finish reason and stray content after one', async () => {
    await expect(collect([chunk({}, 'eos')])).rejects.toThrow(/unsupported finish reason/u)
    await expect(collect([chunk({}, 'stop'), chunk({ content: 'late' })])).rejects.toThrow(/after finish reason/u)
  })

  test('reports an empty response and an in-band error', async () => {
    await expect(collect([chunk({}, 'stop')])).rejects.toThrow(/returned no content/u)
    await expect(collect([{ error: { message: 'upstream exploded', type: 'api_error' } }]))
      .rejects.toThrow(/upstream exploded/u)
  })
})
