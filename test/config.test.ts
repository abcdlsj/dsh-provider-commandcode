import { describe, expect, test } from 'vitest'
import { fallbackCatalog } from '../src/catalog.js'
import { Config, resolveConnection } from '../src/config.js'

const models = fallbackCatalog()

describe('Config defaults', () => {
  test('works with no configuration at all', () => {
    const resolved = Config({})
    expect(resolved).toMatchObject({
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      discovery: true,
      zdr: false,
      thinking: 'effort',
      reasoningBack: 'auto',
    })
    expect(resolved.baseURL).toBe('https://api.commandcode.ai/provider/v1')
  })

  test('rejects an unknown thinking mode', () => {
    expect(() => Config({ thinking: 'sometimes' as never })).toThrow()
  })
})

describe('resolveConnection', () => {
  test('derives the endpoint, listing URL, and CLI headers', () => {
    const connection = resolveConnection({}, models, '/work/my-project')
    expect(connection.baseURL).toBe('https://api.commandcode.ai/provider/v1')
    expect(connection.modelsURL).toBe('https://api.commandcode.ai/provider/v1/models')
    expect(connection.projectSlug).toBe('my-project')
    expect(connection.cliVersion).toBe('1.88.3')
    expect(connection.sessionId).toMatch(/^[A-Za-z0-9-]{36}$/u)
    expect(connection.maxTokens).toBe(64_000)
    expect(connection.retryPolicy.mode).toBe('normal')
  })

  test('strips trailing slashes and keeps an explicit listing endpoint', () => {
    const connection = resolveConnection({
      baseURL: 'https://gateway.test/provider/v1///',
      modelsURL: 'https://gateway.test/models',
      projectSlug: '/tmp/slug-target',
    }, models, '/work/ignored')
    expect(connection.baseURL).toBe('https://gateway.test/provider/v1')
    expect(connection.modelsURL).toBe('https://gateway.test/models')
    expect(connection.projectSlug).toBe('slug-target')
  })

  test('percent-encodes a project slug a header cannot carry', () => {
    expect(resolveConnection({ projectSlug: '项目' }, models, '/w').projectSlug).toBe('%E9%A1%B9%E7%9B%AE')
  })

  test('refuses header injection and malformed endpoints before any request', () => {
    expect(() => resolveConnection({ sessionId: 'abc\ndef' }, models, '/w')).toThrow(/sessionId/u)
    expect(() => resolveConnection({ cliVersion: '1.0\r\nx-evil: 1' }, models, '/w')).toThrow(/cliVersion/u)
    expect(() => resolveConnection({ baseURL: 'not a url' }, models, '/w')).toThrow(/baseURL/u)
    expect(() => resolveConnection({ baseURL: 'file:///etc/passwd' }, models, '/w')).toThrow(/http/u)
    expect(() => resolveConnection({ maxTokens: 0 }, models, '/w')).toThrow(/maxTokens/u)
  })

  test('resolves a declared retry policy', () => {
    const connection = resolveConnection({ retryPolicy: { mode: 'always' } }, models, '/w')
    expect(connection.retryPolicy.mode).toBe('always')
  })
})
