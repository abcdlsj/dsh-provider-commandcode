import { describe, expect, test } from 'vitest'
import { inlineSchemaRefs } from '../src/google-schema.js'

describe('inlineSchemaRefs', () => {
  test('returns the same schema when it has no reference', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(inlineSchemaRefs(schema)).toBe(schema)
  })

  test('writes out a pointer into the schema', () => {
    const trigger = { type: 'object', properties: { on: { type: 'string' } } }
    const schema = {
      type: 'object',
      properties: {
        func: { type: 'object', properties: { triggers: { type: 'array', items: trigger } } },
        extra: { type: 'array', items: { $ref: '#/properties/func/properties/triggers/items', description: 'another' } },
      },
    }
    const inlined = inlineSchemaRefs(schema)
    expect(JSON.stringify(inlined)).not.toContain('$ref')
    expect((inlined.properties as Record<string, unknown>).extra).toEqual({
      type: 'array',
      items: { ...trigger, description: 'another' },
    })
    // The declaration is copied, never mutated in place.
    expect((schema.properties.extra.items as { $ref: string }).$ref).toBe('#/properties/func/properties/triggers/items')
  })

  test('leaves a reference to a root-level definition, as Gemini accepts it', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: 'object', properties: { x: { $ref: '#/properties/a' } } } },
    }
    const inlined = inlineSchemaRefs(schema)
    expect((inlined.properties as Record<string, unknown>).a).toEqual({ $ref: '#/$defs/A' })
    expect(JSON.stringify(inlined.$defs)).toContain('$ref')
  })

  test('terminates on a self-referencing schema', () => {
    const schema: Record<string, unknown> = { type: 'object', properties: {} }
    ;(schema.properties as Record<string, unknown>).self = { $ref: '#' }
    const inlined = inlineSchemaRefs(schema)
    expect(JSON.stringify(inlined).length).toBeLessThan(2000)
  })
})
