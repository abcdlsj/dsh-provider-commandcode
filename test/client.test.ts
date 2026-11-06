import { beforeAll, describe, expect, test, vi } from 'vitest'

interface RegisteredSlot {
  options: Record<string, unknown>
  component: unknown
}

interface ClientDefinition {
  id: string
  factory: (require: (name: string) => unknown) => {
    inject: string[]
    apply: (ctx: unknown) => void
  }
}

const react = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
}

let definition: ClientDefinition | undefined

beforeAll(async () => {
  vi.stubGlobal('window', { __ModuleLoader__: { load: (value: ClientDefinition) => { definition = value } } })
  await import('../client.js')
})

function client() {
  if (definition === undefined) throw new Error('the client bundle registered no definition')
  const loaded = definition.factory((name: string) => {
    if (name === 'react') return react
    throw new Error(`unexpected module ${name}`)
  })
  const slots: RegisteredSlot[] = []
  const dictionaries: Record<string, unknown>[] = []
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value: { configured: true } })) }
  const ctx = {
    effect: (callback: () => unknown) => { callback() },
    locale: {
      register: (name: string, dictionary: unknown) => {
        dictionaries.push({ name, dictionary })
        return () => {}
      },
      bind: () => (key: string, params?: Record<string, unknown>) => `${key}${params === undefined ? '' : JSON.stringify(params)}`,
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback() },
      register: (options: Record<string, unknown>, component: unknown) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    get: (name: string) => name === 'connection' ? { rpc } : undefined,
  }
  loaded.apply(ctx)
  return { slots, dictionaries, rpc, inject: loaded.inject }
}

describe('client half', () => {
  test('registers one dock entry and its dictionaries', () => {
    const { slots, dictionaries } = client()
    expect(slots.map((slot) => [slot.options.name, slot.options.id, slot.options.order])).toEqual([
      ['conversation.composer.dock', 'commandcode-quota', 2],
    ])
    expect(dictionaries[0]?.name).toBe('commandcode')
    expect(dictionaries[0]?.dictionary).toMatchObject({ zh: expect.any(Object), en: expect.any(Object) })
  })

  test('calls the host quota endpoint through the shared channel', async () => {
    const { slots, rpc } = client()
    const inject = slots[0]?.options.inject as () => { fetchQuota: (force?: boolean) => Promise<unknown> }
    const { fetchQuota } = inject()
    await expect(fetchQuota(true)).resolves.toEqual({ configured: true })
    expect(rpc.call).toHaveBeenCalledWith('/api', 'commandcode/usage', { args: { force: true } })
  })

  test('surfaces a refused call as copy', async () => {
    const { slots, rpc } = client()
    rpc.call.mockResolvedValueOnce({ ok: false, error: { message: 'account unavailable' } } as never)
    const inject = slots[0]?.options.inject as () => { fetchQuota: (force?: boolean) => Promise<unknown> }
    await expect(inject().fetchQuota()).rejects.toThrow(/account unavailable/u)
  })

  test('declares the client modules it requires', () => {
    expect(client().inject).toEqual(['slots', 'locale', 'connection'])
  })
})
