/**
 * Normalize Command Code HTTP, in-band, and transport failures into stable
 * harness failure codes.
 * @module dsh-commandcode/errors
 */

import {
  EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, LlmError, ProviderRequestId,
  isContextWindowExceededError, isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'

const MAX_MESSAGE = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  return undefined
}

/** Read the provider's error object without trusting arbitrary response fields. */
function errorFields(raw: unknown): { message?: string | undefined; type?: string | undefined; code?: string | undefined } {
  const envelope = isRecord(raw) ? raw : {}
  const nested = isRecord(envelope.error) ? envelope.error : {}
  return {
    message: text(nested.message) ?? text(envelope.message) ?? text(envelope.error),
    type: text(nested.type),
    code: text(nested.code),
  }
}

/** Bounded, single-line provider failure text safe to show in a transcript. */
function bounded(message: string): string {
  const flat = message.replace(/\s+/gu, ' ').trim()
  return flat.length <= MAX_MESSAGE ? flat : `${flat.slice(0, MAX_MESSAGE - 1)}…`
}

/**
 * Classify one refused request.
 * @param raw - decoded response body, when it was JSON.
 * @param status - HTTP status, or `undefined` for an in-band stream failure.
 * @param headers - response headers, for retry delay and request identity.
 * @returns a stable `LlmError`.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const { message, type, code } = errorFields(raw)
  const written = message === undefined ? undefined : bounded(message)
  const detail = [type, code, written].filter((value): value is string => value !== undefined).join(' ')
  let failure: string
  if (status === 401) {
    failure = `${written ?? 'Command Code refused this credential'}`
      + ' (run `command-code` and sign in again, set COMMANDCODE_API_KEY, or point authFile at a valid auth.json)'
  } else if (status === 403 && /upgrade_required/u.test(detail)) {
    failure = 'Command Code Provider API access is required (403 upgrade_required). The Go plan has no API access;'
      + ' use a plan with Provider API entitlement. See https://commandcode.ai/docs/provider.'
  } else if (status === 403) {
    failure = written ?? 'Command Code refused this request for the current plan or credential'
  } else if (status === 402) {
    failure = written ?? 'Command Code reports no remaining credits or plan allowance'
  } else if (isQuotaExceededError(detail)) {
    failure = written ?? 'Command Code reports the plan allowance exhausted'
  } else if (status === 429) {
    failure = written ?? 'Command Code rate limit reached'
  } else if (isContextWindowExceededError(detail)) {
    failure = written ?? 'Command Code rejected the request as exceeding the model context window'
  } else if (status === 422) {
    failure = written ?? 'Command Code rejected the request as unprocessable'
  } else if (status === undefined) {
    failure = written ?? 'Command Code reported a stream failure'
  } else {
    failure = written ?? `Command Code request failed (HTTP ${status})`
  }

  let retry: number | undefined
  const retryAfter = headers?.get('retry-after')
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(seconds) && seconds > 0) retry = seconds
  }
  const requestId = headers?.get('x-trace-id') ?? headers?.get('x-request-id') ?? headers?.get('request-id')
  return new LlmError(failure, failureCode(status, detail), {
    ...status === undefined ? {} : { status },
    ...retry === undefined ? {} : { providerRetryAfterMs: retry },
    ...requestId === null || requestId === undefined || requestId.length === 0
      ? {}
      : { requestId: ProviderRequestId(requestId) },
  })
}

/** Stable failure code for one refusal. */
function failureCode(status: number | undefined, detail: string): string {
  if (status === 401) return INVALID_CREDENTIAL_CODE
  if (status === 403 && /upgrade_required/u.test(detail)) return INVALID_CREDENTIAL_CODE
  if (/MODEL_NOT_IN_PLAN|permission_error/u.test(detail) || status === 403) return 'PLAN_REQUIRED'
  if (status === 402 || isQuotaExceededError(detail)) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST'
  if (status === undefined || status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Whether a refusal body says the request asked for a field this route does not take. */
export function rejectsField(raw: unknown, pattern: RegExp): boolean {
  const { message, code, type } = errorFields(raw)
  return pattern.test([code, type, message].filter(Boolean).join(' '))
}

/**
 * Wrap one transport failure.
 * @param error - the thrown value.
 * @param signal - caller cancellation.
 * @param idleTimedOut - whether this plugin's idle watchdog fired.
 * @returns a stable `LlmError`.
 */
export function transportError(error: unknown, signal: AbortSignal | undefined, idleTimedOut = false): LlmError {
  if (error instanceof LlmError) return error
  if (idleTimedOut) return new LlmError('Command Code stream idle timeout', 'TIMEOUT', { cause: error })
  if (signal?.aborted === true) return new LlmError('Command Code request aborted', 'ABORTED', { cause: error })
  return new LlmError('Command Code transport failed', 'TRANSPORT', { cause: error })
}

/** A response body that ended without any content. */
export function emptyResponse(): LlmError {
  return new LlmError('Command Code returned no content', EMPTY_RESPONSE_CODE)
}

/** Refuse a provider stream this translator cannot read. */
export function malformedResponse(detail: string): never {
  throw new LlmError(`Command Code stream: ${detail}`, 'MALFORMED_RESPONSE')
}
