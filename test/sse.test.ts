import { describe, expect, test } from 'vitest'
import { parseSse } from '../src/sse.js'
import type { SseFrame } from '../src/sse.js'

async function* byteStream(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size)
}

async function frames(text: string, size?: number): Promise<SseFrame[]> {
  const collected: SseFrame[] = []
  for await (const frame of parseSse(byteStream(text, size))) collected.push(frame)
  return collected
}

describe('parseSse', () => {
  test('dispatches each blank-line-terminated block', async () => {
    expect(await frames('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual([
      { data: '{"a":1}' },
      { data: '{"b":2}' },
    ])
  })

  test('joins multi-line data and keeps the event name', async () => {
    expect(await frames('event: content_block_delta\ndata: {"a":\ndata: 1}\n\n')).toEqual([
      { event: 'content_block_delta', data: '{"a":\n1}' },
    ])
  })

  test('accepts CRLF and a leading BOM', async () => {
    expect(await frames('\uFEFFdata: one\r\n\r\n')).toEqual([{ data: 'one' }])
  })

  test('strips exactly one leading space of a value', async () => {
    expect(await frames('data:  two spaces\n\n')).toEqual([{ data: ' two spaces' }])
  })

  test('counts comments as activity and drops them', async () => {
    let beats = 0
    const collected: SseFrame[] = []
    for await (const frame of parseSse(byteStream(': keep-alive\n\ndata: x\n\n'), () => { beats += 1 })) collected.push(frame)
    expect(collected).toEqual([{ data: 'x' }])
    expect(beats).toBeGreaterThanOrEqual(2)
  })

  test('drops an unterminated tail, as SSE dispatch does', async () => {
    expect(await frames('data: complete\n\ndata: cut off')).toEqual([{ data: 'complete' }])
  })

  test('survives chunk boundaries inside a field', async () => {
    expect(await frames('data: abcdefghij\n\n', 3)).toEqual([{ data: 'abcdefghij' }])
  })

  test('reads a web stream as well as an async iterable', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: web\n\n'))
        controller.close()
      },
    })
    const collected: SseFrame[] = []
    for await (const frame of parseSse(body)) collected.push(frame)
    expect(collected).toEqual([{ data: 'web' }])
  })
})
