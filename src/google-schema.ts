/**
 * JSON-Schema `$ref` inlining for Google-hosted models.
 *
 * Gemini's OpenAI-compatible surface accepts only references to direct
 * children of root-level `$defs`/`definitions`; any other JSON pointer is
 * rejected, so those are written out for a Google model while the accepted
 * ones go as they came. Only Google routes are rewritten. Adapted from
 * magpie-community's Command Code plugin (MIT).
 * @module dsh-commandcode/google-schema
 */

const DEFINITION_REF = /^#\/(?:\$defs|definitions)\/[^/]+$/u
const MAX_DEPTH = 32
const MAP_FIELDS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const SINGLE_FIELDS = [
  'items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
  'unevaluatedProperties', 'unevaluatedItems', 'contentSchema', 'additionalItems',
]
const LIST_FIELDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve one JSON pointer against the schema root. */
function pointerTarget(root: unknown, ref: string): unknown {
  if (ref !== '#' && !ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const raw of ref.split('/').slice(1)) {
    let token = raw
    try {
      token = decodeURIComponent(raw)
    } catch (_malformedPointerEscape) {
      // A token that is not valid percent-encoding is used as written.
    }
    token = token.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isRecord(current) && !Array.isArray(current)) return undefined
    if (!Object.hasOwn(current, token)) return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

function walk(value: unknown, root: unknown, open: readonly string[], depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, root, open, depth))
  if (!isRecord(value)) return value
  if (typeof value.$ref === 'string') {
    const ref = value.$ref
    const target = pointerTarget(root, ref)
    // A ref to a direct child of root-level $defs/definitions is accepted, and
    // left alone; every other pointer is written out here.
    const accepted = DEFINITION_REF.test(ref) && target !== undefined
    if (!accepted && isRecord(target)) {
      const { $ref: _ref, ...notes } = value
      if (open.includes(ref) || depth >= MAX_DEPTH) {
        return typeof target.type === 'string' ? { ...notes, type: target.type } : notes
      }
      return walk({ ...target, ...notes }, root, [...open, ref], depth + 1)
    }
  }
  const out: Record<string, unknown> = { ...value }
  for (const field of MAP_FIELDS) {
    const nested = out[field]
    if (isRecord(nested)) {
      out[field] = Object.fromEntries(Object.entries(nested).map(([name, child]) => [name, walk(child, root, open, depth)]))
    }
  }
  for (const field of SINGLE_FIELDS) {
    if (isRecord(out[field])) out[field] = walk(out[field], root, open, depth)
  }
  for (const field of LIST_FIELDS) {
    const nested = out[field]
    if (Array.isArray(nested)) out[field] = nested.map((child) => walk(child, root, open, depth))
  }
  return out
}

/**
 * Inline every resolvable `$ref` in a tool parameter schema.
 * @param schema - tool parameters as the harness declared them.
 * @returns the same schema when it carries no `$ref`, otherwise a rewritten copy.
 */
export function inlineSchemaRefs(schema: Record<string, unknown>): Record<string, unknown> {
  if (!JSON.stringify(schema).includes('"$ref"')) return schema
  return walk(schema, schema, [], 0) as Record<string, unknown>
}
