/**
 * Command Code credential resolution: the harness credential store first,
 * then the launch environment, then the command-code CLI's own sign-in.
 * @module dsh-provider-commandcode/credentials
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'

/** Structural view of the harness credentials service this plugin needs. */
export interface CredentialService {
  /** Resolve one reference; `undefined` means nothing is stored for it. */
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Where one resolved key came from, for diagnostics that never print the key. */
export type KeySource =
  | { readonly kind: 'credentials'; readonly ref: string }
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string }

/** One resolved credential. */
export interface ResolvedKey {
  /** Usable API key. */
  readonly key: string
  /** Where it came from. */
  readonly source: KeySource
}

/** Environment variable names the command-code CLI and its integrations use. */
const AMBIENT_KEY_VARS = ['COMMANDCODE_API_KEY', 'COMMAND_CODE_API_KEY'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read the key out of one provider credential object, in either stored form. */
function keyFromCredential(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return stringValue(value.access) ?? stringValue(value.key)
}

/**
 * Read a Command Code key from one auth file body. The command-code CLI stores
 * `apiKey`; pi and omp store the provider credential under `commandcode` or
 * `command-code`, either bare or as `{type, access|key}`.
 * @param body - decoded JSON of one auth file.
 * @returns the key, or `undefined` when this file does not hold one.
 */
export function keyFromAuthFile(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const direct = stringValue(body.apiKey)
  if (direct !== undefined) return direct
  for (const field of ['commandcode', 'command-code'] as const) {
    const raw = body[field]
    const key = stringValue(raw) ?? keyFromCredential(raw)
    if (key !== undefined) return key
  }
  return undefined
}

/**
 * Auth files consulted after the environment, in precedence order.
 * @param home - home directory.
 * @param env - process environment, for the pi agent-directory override.
 * @returns absolute auth file paths, most authoritative first.
 */
export function authFilePaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const piAgentDir = stringValue(env.PI_CODING_AGENT_DIR) ?? join(home, '.pi', 'agent')
  const explicit = stringValue(env.COMMANDCODE_AUTH_FILE)
  return [
    ...explicit === undefined ? [] : [explicit],
    join(home, '.commandcode', 'auth.json'),
    join(piAgentDir, 'auth.json'),
    join(home, '.omp', 'agent', 'auth.json'),
  ]
}

/**
 * Read every usable key out of an ordered list of auth files, without repeats.
 * @param paths - absolute candidate paths, most authoritative first.
 * @param read - file reader, for tests.
 * @param exists - existence probe, for tests.
 * @returns one key per file that holds one, in candidate order.
 */
export function readKeysFromFiles(
  paths: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  exists: (path: string) => boolean = existsSync,
): ResolvedKey[] {
  const keys: ResolvedKey[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (!exists(path)) continue
    let body: unknown
    try {
      body = JSON.parse(read(path))
    } catch (_malformedAuthFile) {
      continue
    }
    const key = keyFromAuthFile(body)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    keys.push({ key, source: { kind: 'file', path } })
  }
  return keys
}

/**
 * Read the first usable key out of an ordered list of auth files.
 * @param paths - absolute candidate paths, most authoritative first.
 * @param read - file reader, for tests.
 * @param exists - existence probe, for tests.
 * @returns the key and the file it came from, when one file holds a key.
 */
export function readKeyFromFiles(
  paths: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  exists: (path: string) => boolean = existsSync,
): ResolvedKey | undefined {
  return readKeysFromFiles(paths, read, exists)[0]
}

/** Everything one key lookup may consult. */
export interface ResolveKeyOptions {
  /** Credential reference from configuration. */
  readonly ref: string
  /** Explicit auth file from configuration, consulted before the defaults. */
  readonly authFile?: string | undefined
  /** Mounted credentials service, when the composition has one. */
  readonly credentials?: CredentialService | undefined
  /** Process environment. */
  readonly env?: NodeJS.ProcessEnv
  /** Home directory. */
  readonly home?: string
  /** File reader, for tests. */
  readonly read?: (path: string) => string
  /** Existence probe, for tests. */
  readonly exists?: (path: string) => boolean
}

/**
 * Resolve every distinct API key one request may try, in precedence order.
 *
 * Precedence: the credentials service value for the configured reference, the
 * configured reference in the environment, the ambient Command Code variables,
 * then the command-code CLI's own sign-in and the pi/omp auth files. A value
 * that the credentials service stores stays authoritative when configured,
 * while an unset reference deliberately falls through to the CLI sign-in, which
 * is what makes the plugin zero-config for existing CLI users.
 *
 * Listing every candidate — instead of only the first — is what lets a stale
 * CLI sign-in yield to a still-valid host credential after one 401, rather than
 * failing a request the machine can already authenticate.
 * @param options - reference, mounts, environment, and file probes.
 * @returns usable keys and their origins, most authoritative first.
 * @throws LlmError `INVALID_CREDENTIAL` when a value cannot be an HTTP header.
 */
export async function resolveApiKeyCandidates(options: ResolveKeyOptions): Promise<ResolvedKey[]> {
  const env = options.env ?? process.env
  const ref = options.ref
  const candidates: ResolvedKey[] = []
  const seen = new Set<string>()
  const add = (key: string, source: KeySource): void => {
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ key, source })
  }
  const credentials = options.credentials
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.trim().length > 0) {
      add(assertUsableApiKey(hit.value, 'dsh-provider-commandcode', ref), { kind: 'credentials', ref })
    }
  }
  for (const name of [ref, ...AMBIENT_KEY_VARS]) {
    const value = env[name]
    if (value === undefined || value.trim().length === 0) continue
    add(assertUsableApiKey(value, 'dsh-provider-commandcode', name), { kind: 'env', name })
  }
  const paths = [
    ...options.authFile === undefined ? [] : [options.authFile],
    ...authFilePaths(options.home ?? homedir(), env),
  ]
  for (const found of readKeysFromFiles(paths, options.read, options.exists)) {
    const origin = found.source.kind === 'file' ? found.source.path : ref
    add(assertUsableApiKey(found.key, 'dsh-provider-commandcode', origin), found.source)
  }
  return candidates
}

/**
 * Resolve the API key one request should try first.
 * @param options - reference, mounts, environment, and file probes.
 * @returns the most authoritative usable key, or `undefined` when none is configured.
 */
export async function resolveApiKey(options: ResolveKeyOptions): Promise<ResolvedKey | undefined> {
  return (await resolveApiKeyCandidates(options))[0]
}

/** Human-readable origin for diagnostics. */
export function describeSource(source: KeySource): string {
  switch (source.kind) {
    case 'credentials': return `credentials service (${source.ref})`
    case 'env': return `environment variable ${source.name}`
    case 'file': return `auth file ${source.path}`
  }
}
