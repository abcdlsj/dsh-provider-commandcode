import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { Config, apply } from '../src/index.js'

interface FakeCommand {
  name: string
  handler: (invocation: { rawInput: string; signal: AbortSignal }) => Promise<CommandResult>
}

function fakeContext() {
  const adapters: { providers: string[]; adapter: LlmAdapter }[] = []
  const commands: FakeCommand[] = []
  const ctx = {
    llm: { registerAdapter: (providers: string[], adapter: LlmAdapter) => { adapters.push({ providers, adapter }) } },
    get: (name: string) => name === 'commands' ? { register: (command: FakeCommand) => { commands.push(command) } } : undefined,
    effect: () => {},
    inject: (_deps: string[], callback: (child: Record<string, unknown>) => void) => {
      callback({ commands: { register: (command: FakeCommand) => { commands.push(command) } } })
    },
  }
  return { ctx: ctx as unknown as Context, adapters, commands }
}

const invoke = async (command: FakeCommand, input = ''): Promise<CommandResult> =>
  await command.handler({ rawInput: input, signal: new AbortController().signal })

describe('plugin apply', () => {
  test('registers one provider route with a usable adapter', async () => {
    const { ctx, adapters } = fakeContext()
    apply(ctx, Config({ discovery: false }))
    expect(adapters).toHaveLength(1)
    expect(adapters[0]?.providers).toEqual(['commandcode'])
    const models = await adapters[0]!.adapter.listModels('commandcode')
    expect(models.length).toBeGreaterThan(50)
    expect(models.find((model) => model.id === 'claude-opus-5')).toMatchObject({
      name: 'Claude Opus 5',
      inputModalities: ['text', 'image'],
    })
    expect(models.find((model) => model.id === 'stealth/glyph-cluster:free')?.badge).toEqual({
      text: { en: 'free', zh: '免费' }, tone: 'success',
    })
    expect(await adapters[0]!.adapter.resolveModel('commandcode', 'gpt-6-sol')).toMatchObject({
      id: 'gpt-6-sol',
      defaultMaxTokens: 64_000,
    })
  })

  test('discovers the live catalog when enabled', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'acme/only-model', name: 'Only', context_length: 1234, supported_endpoints: ['/chat/completions'] }],
    }), { status: 200 }))
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const { ctx, adapters } = fakeContext()
      apply(ctx, Config({}))
      const models = await adapters[0]!.adapter.listModels('commandcode')
      expect(models.map((model) => model.id)).toEqual(['acme/only-model'])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('registers the diagnostics command', async () => {
    const { ctx, commands } = fakeContext()
    apply(ctx, Config({ discovery: false }))
    expect(commands.map((command) => command.name)).toEqual(['commandcode'])
    const models = await invoke(commands[0]!, 'models claude-opus')
    expect(models.kind).toBe('success')
    expect(models.text).toContain('claude-opus-5')
    expect(await invoke(commands[0]!, 'nonsense')).toMatchObject({ kind: 'error' })
    const status = await invoke(commands[0]!, 'status')
    expect(status.text).toContain('catalog: static')
    expect(status.text).toContain('endpoint: https://api.commandcode.ai/provider/v1')
    // The report never carries a credential value, only where one would come from.
    expect(status.text).not.toMatch(/user_[A-Za-z0-9]+/u)
  })

  test('refreshes the catalog on demand', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'acme/fresh', name: 'Fresh', context_length: 1000 }],
    }), { status: 200 }))
    const realFetch = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      const { ctx, commands } = fakeContext()
      apply(ctx, Config({}))
      const refreshed = await invoke(commands[0]!, 'refresh')
      expect(refreshed).toMatchObject({ kind: 'success' })
      expect(refreshed.text).toContain('1 models')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('refuses an unusable endpoint at load', () => {
    const { ctx } = fakeContext()
    expect(() => apply(ctx, Config({ baseURL: 'not a url' }))).toThrow(/baseURL/u)
  })
})
