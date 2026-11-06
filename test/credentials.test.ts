import { describe, expect, test, vi } from 'vitest'
import { authFilePaths, describeSource, keyFromAuthFile, readKeyFromFiles, resolveApiKey } from '../src/credentials.js'

describe('keyFromAuthFile', () => {
  test('reads the CLI body', () => {
    expect(keyFromAuthFile({ apiKey: 'user_cli', userId: 'x' })).toBe('user_cli')
  })

  test('reads pi and omp provider entries in either stored form', () => {
    expect(keyFromAuthFile({ commandcode: 'user_bare' })).toBe('user_bare')
    expect(keyFromAuthFile({ commandcode: { type: 'oauth', access: 'user_access' } })).toBe('user_access')
    expect(keyFromAuthFile({ 'command-code': { type: 'api', key: 'user_key' } })).toBe('user_key')
    expect(keyFromAuthFile({ 'command-code': 'user_cmd' })).toBe('user_cmd')
  })

  test('ignores bodies with no Command Code credential', () => {
    expect(keyFromAuthFile({ deepseek: { type: 'api', key: 'user_other' } })).toBeUndefined()
    expect(keyFromAuthFile(null)).toBeUndefined()
    expect(keyFromAuthFile('user_raw')).toBeUndefined()
  })
})

describe('authFilePaths', () => {
  test('orders the CLI sign-in before the host auth files', () => {
    expect(authFilePaths('/home/me', { PI_CODING_AGENT_DIR: '/profiles/work' })).toEqual([
      '/home/me/.commandcode/auth.json',
      '/profiles/work/auth.json',
      '/home/me/.omp/agent/auth.json',
    ])
  })

  test('honours an explicit auth file first', () => {
    expect(authFilePaths('/home/me', { COMMANDCODE_AUTH_FILE: '/tmp/cc.json' })[0]).toBe('/tmp/cc.json')
  })
})

describe('readKeyFromFiles', () => {
  test('skips missing and malformed files', () => {
    const files: Record<string, string> = {
      '/a.json': '{not json',
      '/b.json': JSON.stringify({ commandcode: { access: 'user_b' } }),
      '/c.json': JSON.stringify({ apiKey: 'user_c' }),
    }
    const found = readKeyFromFiles(
      ['/missing.json', '/a.json', '/b.json', '/c.json'],
      (path) => files[path] as string,
      (path) => Object.hasOwn(files, path),
    )
    expect(found).toEqual({ key: 'user_b', source: { kind: 'file', path: '/b.json' } })
  })
})

describe('resolveApiKey', () => {
  const credentials = (value: string | undefined) => ({ resolve: vi.fn(async () => value === undefined ? undefined : { value }) })

  test('prefers the credentials service', async () => {
    const found = await resolveApiKey({
      ref: 'COMMANDCODE_API_KEY', credentials: credentials('user_store'), env: { COMMANDCODE_API_KEY: 'user_env' },
    })
    expect(found).toEqual({ key: 'user_store', source: { kind: 'credentials', ref: 'COMMANDCODE_API_KEY' } })
  })

  test('falls through an unset store to the environment', async () => {
    const found = await resolveApiKey({
      ref: 'COMMANDCODE_API_KEY', credentials: credentials(undefined), env: { COMMANDCODE_API_KEY: 'user_env' },
    })
    expect(found).toMatchObject({ key: 'user_env', source: { kind: 'env', name: 'COMMANDCODE_API_KEY' } })
  })

  test('falls through to the CLI sign-in', async () => {
    const found = await resolveApiKey({
      ref: 'COMMANDCODE_API_KEY',
      env: {},
      home: '/home/me',
      exists: (path) => path === '/home/me/.commandcode/auth.json',
      read: () => JSON.stringify({ apiKey: 'user_cli' }),
    })
    expect(found).toMatchObject({ key: 'user_cli', source: { kind: 'file', path: '/home/me/.commandcode/auth.json' } })
  })

  test('consults the configured auth file before the defaults', async () => {
    const read = vi.fn((_path: string) => JSON.stringify({ apiKey: 'user_explicit' }))
    const found = await resolveApiKey({
      ref: 'COMMANDCODE_API_KEY', authFile: '/tmp/explicit.json', env: {}, home: '/home/me',
      exists: () => true, read,
    })
    expect(found).toMatchObject({ key: 'user_explicit' })
    expect(read.mock.calls[0]?.[0]).toBe('/tmp/explicit.json')
  })

  test('reports no key when nothing is configured', async () => {
    expect(await resolveApiKey({ ref: 'COMMANDCODE_API_KEY', env: {}, home: '/home/me', exists: () => false }))
      .toBeUndefined()
  })

  test('refuses a key no HTTP header can carry instead of failing inside fetch', async () => {
    await expect(resolveApiKey({ ref: 'COMMANDCODE_API_KEY', env: { COMMANDCODE_API_KEY: 'user_bad\nkey' } }))
      .rejects.toThrow(/characters no HTTP header can carry/u)
  })

  test('describes where a key came from without printing it', () => {
    expect(describeSource({ kind: 'credentials', ref: 'R' })).toBe('credentials service (R)')
    expect(describeSource({ kind: 'env', name: 'R' })).toBe('environment variable R')
    expect(describeSource({ kind: 'file', path: '/x' })).toBe('auth file /x')
  })
})
