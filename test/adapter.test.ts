import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CommandCodeAdapter } from '../src/adapter.js'
import { fallbackCatalog } from '../src/catalog.js'
import { resolveConnection } from '../src/config.js'
import type { ResolvedKey } from '../src/credentials.js'
import type { Connection } from '../src/config.js'

const connection = (): Connection => resolveConnection({}, fallbackCatalog(), '/work/demo')

function sse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const chatBody = [
  'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const messagesBody = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

function adapter(overrides: { key?: string | undefined; rejectKey?: boolean } = {}) {
  const warnings: string[] = []
  let current: ResolvedKey | undefined = overrides.key === undefined
    ? undefined
    : { key: overrides.key, source: { kind: 'env', name: 'COMMANDCODE_API_KEY' } }
  const instance = new CommandCodeAdapter({
    options: connection,
    resolveKey: async () => current,
    ...overrides.rejectKey === false ? {} : {
      rejectKey: async () => {
        current = { key: 'user_backup', source: { kind: 'file', path: '/home/me/.pi/agent/auth.json' } }
        return current
      },
    },
    discoverModels: async () => [],
    warn: (message) => warnings.push(message),
  })
  return { instance, warnings }
}

function request(overrides: Partial<GenerateOptions<string>> = {}): GenerateOptions<string> {
  return {
    provider: 'commandcode',
    model: 'gpt-6-sol',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('CommandCodeAdapter', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => { globalThis.fetch = realFetch })

  test('sends a Chat Completions request with the CLI and attribution headers', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sse(chatBody))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance } = adapter({ key: 'user_abc' })
    const chunks = await collect(instance.stream(request({ reasoningEffort: 'high' as never })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.commandcode.ai/provider/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers).toMatchObject({
      'authorization': 'Bearer user_abc',
      'x-api-key': 'user_abc',
      'x-command-code-version': '1.88.3',
      'x-cli-environment': 'production',
      'x-project-slug': 'demo',
      'x-taste-learning': 'false',
      'accept': 'text/event-stream',
    })
    expect(headers['user-agent']).toMatch(/^deepseek-harness\//u)
    expect(headers['x-session-id']).toMatch(/^[A-Za-z0-9-]{36}$/u)
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'gpt-6-sol', stream: true, reasoning_effort: 'high' })
  })

  test('routes a Claude model to Messages and asks for thinking', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sse(messagesBody))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance } = adapter({ key: 'user_abc' })
    const chunks = await collect(instance.stream(request({ model: 'claude-opus-5', reasoningEffort: 'xhigh' as never })))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.commandcode.ai/provider/v1/messages')
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'enabled' },
      output_config: { effort: 'xhigh' },
    })
  })

  test('retries once without reasoning_effort when the model refuses it, and remembers', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort' } }), { status: 400 }))
      .mockResolvedValueOnce(sse(chatBody))
      .mockResolvedValueOnce(sse(chatBody))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance, warnings } = adapter({ key: 'user_abc' })
    await collect(instance.stream(request({ reasoningEffort: 'high' as never })))
    expect(warnings[0]).toMatch(/refused reasoning_effort/u)
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ reasoning_effort: 'high' })
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body))).not.toHaveProperty('reasoning_effort')
    // The next request already knows, and issues no extra round trip.
    await collect(instance.stream(request({ reasoningEffort: 'high' as never })))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String((fetchImpl.mock.calls[2] as [string, RequestInit])[1].body))).not.toHaveProperty('reasoning_effort')
  })

  test('adds earlier reasoning back when the model demands it', async () => {
    const assistant = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'because' }, { type: 'text', text: 'done' }],
      source: { provider: 'commandcode', model: 'gpt-6-sol' },
    })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Missing required parameter: 'messages[0].reasoning_content'" } }), { status: 400 }))
      .mockResolvedValueOnce(sse(chatBody))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance, warnings } = adapter({ key: 'user_abc' })
    await collect(instance.stream(request({ messages: [assistant, { role: 'user', content: [{ type: 'text', text: 'go' }] }] })))
    expect(warnings[0]).toMatch(/earlier reasoning back/u)
    const retried = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body)) as { messages: Record<string, unknown>[] }
    expect(retried.messages[0]).toMatchObject({ role: 'assistant', reasoning_content: 'because' })
  })

  test('retries without the thinking fields when Messages refuses them', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'thinking is not supported for this model' } }), { status: 400 }))
      .mockResolvedValueOnce(sse(messagesBody))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance, warnings } = adapter({ key: 'user_abc' })
    const chunks = await collect(instance.stream(request({ model: 'claude-opus-5', reasoningEffort: 'max' as never })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(warnings[0]).toMatch(/refused the thinking fields/u)
    const retried = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(retried).not.toHaveProperty('thinking')
    expect(retried).not.toHaveProperty('output_config')
  })

  test('retries with the next credential after a 401', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)['authorization']))
      return seen.length === 1
        ? new Response(JSON.stringify({ error: { message: "Invalid 'Authorization' header or token." } }), { status: 401 })
        : sse(chatBody)
    })
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance, warnings } = adapter({ key: 'user_stale' })
    await expect(collect(instance.stream(request()))).resolves.toBeDefined()
    expect(seen).toEqual(['Bearer user_stale', 'Bearer user_backup'])
    expect(warnings[0]).toMatch(/was refused; trying auth file/u)
  })

  test('reports the 401 when no further credential exists', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Invalid 'Authorization' header or token." } }), { status: 401 },
    ))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance } = adapter({ key: 'user_only', rejectKey: false })
    await expect(collect(instance.stream(request()))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  test('refuses a request with no credential', async () => {
    const fetchImpl = vi.fn()
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance } = adapter({ key: undefined })
    await expect(collect(instance.stream(request()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('surfaces a plan refusal and a provider error status', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'MODEL_NOT_IN_PLAN: GPT-6 Sol', type: 'permission_error' } }), { status: 403 },
    ))
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    const { instance } = adapter({ key: 'user_abc' })
    await expect(collect(instance.stream(request()))).rejects.toMatchObject({ code: 'PLAN_REQUIRED', failure: { status: 403 } })
  })

  test('reports the model catalog the discovery dependency returns', async () => {
    const { instance } = adapter({ key: 'user_abc' })
    expect(await instance.listModels('commandcode')).toEqual([])
  })

  test('serves exact model metadata, including declared efforts', async () => {
    const { instance } = adapter({ key: 'user_abc' })
    const info = await instance.resolveModel('commandcode', 'claude-opus-5')
    expect(info).toMatchObject({ provider: 'commandcode', id: 'claude-opus-5', context: { contextWindow: 1_000_000 } })
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(info.defaultMaxTokens).toBe(64_000)
  })
})
