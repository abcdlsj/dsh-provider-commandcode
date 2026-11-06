/**
 * Minimal Server-Sent Events framing for provider streams.
 *
 * The harness ships `eventsource-parser` inside its own adapter, but an
 * out-of-tree plugin should not add a runtime dependency for 80 lines of
 * framing, so this module implements the parts of the SSE grammar provider
 * streams actually use: `data` and `event` fields, multi-line data, comments as
 * heartbeats, CRLF or LF line endings, and a discarded unterminated tail.
 * @module dsh-commandcode/sse
 */

/** One dispatched SSE frame. */
export interface SseFrame {
  /** `event` field, when the stream names one. */
  readonly event?: string
  /** Concatenated `data` lines. */
  readonly data: string
}

/** Body shape accepted by {@link parseSse}: web streams and plain async iterables. */
export type SseBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

function isWebStream(body: SseBody): body is ReadableStream<Uint8Array> {
  return typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
}

async function* chunks(body: SseBody): AsyncGenerator<Uint8Array> {
  if (isWebStream(body)) {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) yield value
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    yield* body
  }
}

/**
 * Decode SSE frames in arrival order.
 * @param body - response bytes.
 * @param activity - pulse per chunk and per comment, for an idle watchdog.
 * @returns frames as soon as each blank-line-terminated block settles.
 */
export async function* parseSse(body: SseBody, activity: () => void = () => {}): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  let started = false

  function* frame(): Generator<SseFrame> {
    if (data.length === 0) {
      event = undefined
      return
    }
    const value: SseFrame = { data: data.join('\n'), ...event === undefined ? {} : { event } }
    data = []
    event = undefined
    yield value
  }

  for await (const chunk of chunks(body)) {
    activity()
    buffer += decoder.decode(chunk, { stream: true })
    if (!started) {
      started = true
      if (buffer.startsWith('\uFEFF')) buffer = buffer.slice(1)
    }
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) {
        yield* frame()
        continue
      }
      if (line.startsWith(':')) {
        activity()
        continue
      }
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') data.push(value)
      else if (field === 'event') event = value
      // `id`, `retry`, and unknown fields carry nothing a model stream needs.
    }
  }
  // A tail without its terminating blank line is an incomplete event; SSE
  // dispatch drops it, and a provider that ends mid-event is caught by the
  // missing end-of-stream marker in the wire translator.
}
