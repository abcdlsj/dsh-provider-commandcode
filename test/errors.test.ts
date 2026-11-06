import { describe, expect, test } from 'vitest'
import { emptyResponse, providerError, rejectsField, transportError } from '../src/errors.js'

const headers = (values: Record<string, string>) => new Headers(values)

describe('providerError', () => {
  test('maps status codes to stable harness codes', () => {
    expect(providerError({ error: { message: 'bad key' } }, 401).code).toBe('INVALID_CREDENTIAL')
    expect(providerError({ error: { message: 'no credits' } }, 402).code).toBe('QUOTA')
    expect(providerError({ error: { message: 'slow down' } }, 429).code).toBe('RATE_LIMIT')
    expect(providerError({ error: { message: 'bad body' } }, 400).code).toBe('INVALID_REQUEST')
    expect(providerError({ error: { message: 'broke' } }, 500).code).toBe('SERVER')
    expect(providerError({ message: 'odd' }, 418).code).toBe('HTTP_418')
  })

  test('names the two Command Code refusals a user can act on', () => {
    const upgrade = providerError({ error: { code: 'upgrade_required', message: 'upgrade' } }, 403)
    expect(upgrade.code).toBe('INVALID_CREDENTIAL')
    expect(upgrade.message).toMatch(/Go plan has no API access/u)
    const plan = providerError({ error: { message: 'MODEL_NOT_IN_PLAN: GPT-6 Sol', type: 'permission_error' } }, 403)
    expect(plan.code).toBe('PLAN_REQUIRED')
    const auth = providerError(undefined, 401)
    expect(auth.message).toMatch(/command-code.*sign in|COMMANDCODE_API_KEY|authFile/u)
  })

  test('keeps retry delay and request identity from the headers', () => {
    const error = providerError({ error: { message: 'slow' } }, 429, headers({ 'retry-after': '3', 'x-trace-id': 'trace-1' }))
    expect(error.failure.providerRetryAfterMs).toBe(3000)
    expect(error.failure.requestId).toBe('trace-1')
    expect(error.failure.status).toBe(429)
  })

  test('reads the error text without trusting unrelated fields', () => {
    expect(providerError({ error: 'plain text' }, 500).message).toContain('plain text')
    expect(providerError('not json', undefined).message).toMatch(/stream failure/u)
    expect(providerError({}, undefined).message).toMatch(/stream failure/u)
  })

  test('caps a runaway provider message', () => {
    expect(providerError({ error: { message: 'x'.repeat(2000) } }, 400).message.length).toBeLessThanOrEqual(601)
  })
})

describe('rejectsField', () => {
  test('matches the refused field in any error slot', () => {
    expect(rejectsField({ error: { message: 'Unsupported parameter: reasoning_effort' } }, /reasoning_effort/iu)).toBe(true)
    expect(rejectsField({ error: { code: 'thinking_disabled' } }, /thinking/iu)).toBe(true)
    expect(rejectsField({ error: { message: 'rate limited' } }, /reasoning_effort/iu)).toBe(false)
  })
})

describe('transportError', () => {
  test('classifies idle timeouts, aborts, and transport failures', () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(transportError(new Error('x'), aborted.signal).code).toBe('ABORTED')
    expect(transportError(new Error('x'), undefined, true).code).toBe('TIMEOUT')
    expect(transportError(new Error('x'), undefined).code).toBe('TRANSPORT')
  })

  test('preserves an LlmError and its code', () => {
    const original = emptyResponse()
    expect(transportError(original, undefined)).toBe(original)
  })
})
