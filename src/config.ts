/**
 * Deployment configuration and the validated connection facts one request uses.
 * @module dsh-provider-commandcode/config
 */

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  CATALOG_CLI_VERSION, DEFAULT_BASE_URL, DEFAULT_MAX_IMAGES_PER_REQUEST, DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS, DEFAULT_MODELS_TIMEOUT_MS,
} from './catalog.js'
import type { CatalogModel, InputModality, ModelOverride, Wire } from './catalog-types.js'
import type { PlanChoice } from './plan.js'

/** How the Messages wire asks for extended thinking. */
export type ThinkingMode = 'effort' | 'budget' | 'disabled'

/** How the Chat Completions wire replays earlier reasoning. */
export type ReasoningBack = 'auto' | 'always' | 'never'

/** Deployment configuration; every field has a default, so the plugin works unconfigured. */
export interface Config {
  /** Credential reference resolved through the credentials service, then the launch environment. */
  apiKeyEnv?: string
  /** Whether a refused credential yields to the next configured source. */
  keyFallback?: boolean
  /**
   * Subscription tier whose models to advertise: `auto` reads the account's
   * plan, `all` filters nothing, or a fixed `go` / `goat` / `pro` / `max`.
   */
  plan?: PlanChoice
  /** Whether to refresh the official CLI catalog for efforts and plan floors. */
  referenceCatalog?: boolean
  /** Whether to expose the account quota reading and its status bar. */
  quota?: boolean
  /** Freshness of one refreshed CLI catalog, in milliseconds. */
  referenceMaxAgeMs?: number
  /**
   * Explicit command-code auth file to read after the credential reference.
   * Omission consults `$COMMANDCODE_AUTH_FILE`, then the CLI's own sign-in and
   * the pi/omp auth files.
   */
  authFile?: string
  /** Provider API root, without a trailing slash. */
  baseURL?: string
  /** Model listing endpoint; defaults to `<baseURL>/models`. */
  modelsURL?: string
  /** Whether to discover models from the network at all; `false` serves the bundled catalog. */
  discovery?: boolean
  /** How long a fetched listing stays fresh, in milliseconds. */
  modelsMaxAgeMs?: number
  /** Timeout of one model discovery request, in milliseconds. */
  modelsTimeoutMs?: number
  /** Deployment-declared models and per-model field overrides. */
  models?: ModelOverride[]
  /** `x-command-code-version` the CLI would send. */
  cliVersion?: string
  /** `x-project-slug`; defaults to the last segment of the harness working directory. */
  projectSlug?: string
  /** `x-session-id` for every request; defaults to one random id per process. */
  sessionId?: string
  /** Send `x-cmd-zdr: 1`, admitting only zero-data-retention upstreams. */
  zdr?: boolean
  /** How the Messages wire asks for thinking; `disabled` also removes the effort selector. */
  thinking?: ThinkingMode
  /** When earlier assistant reasoning is replayed on the Chat Completions wire. */
  reasoningBack?: ReasoningBack
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Base64-decoded image bytes one request may carry, before base64 expansion. */
  maxRequestImageBytes?: number
  /** Images one request may carry. */
  maxImagesPerRequest?: number
  /** Maximum provider idle time while one stream read is outstanding, in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig
}

const modalitySchema: z<InputModality> = z.union([z.const('text'), z.const('image')])
const wireSchema: z<Wire> = z.union([z.const('chat'), z.const('messages')])

const modelOverrideSchema: z<ModelOverride> = z.object({
  id: z.string().required(),
  name: z.string(),
  wire: wireSchema,
  contextWindow: z.natural(),
  maxTokens: z.natural(),
  inputModalities: z.array(modalitySchema),
  efforts: z.array(z.string()),
})

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().default('COMMANDCODE_API_KEY')
    .description('Credential reference (and environment variable) holding the Command Code API key.'),
  keyFallback: z.boolean().default(true)
    .description('On a 401, try the next configured credential source instead of failing the request.'),
  plan: z.union([z.const('auto'), z.const('all'), z.const('go'), z.const('goat'), z.const('pro'), z.const('max')])
    .default('auto').description('Subscription tier whose models to advertise; auto reads the account plan.'),
  referenceCatalog: z.boolean().default(true)
    .description('Refresh reasoning efforts and plan floors from the official command-code CLI catalog.'),
  quota: z.boolean().default(true)
    .description('Expose the account quota reading for the browser status bar and /commandcode quota.'),
  referenceMaxAgeMs: z.natural().default(6 * 60 * 60 * 1000)
    .description('Freshness of one refreshed CLI catalog.'),
  authFile: z.string().description('Optional explicit command-code auth.json path.'),
  baseURL: z.string().default(DEFAULT_BASE_URL).description('Command Code Provider API root.'),
  modelsURL: z.string().description('Model listing endpoint; defaults to <baseURL>/models.'),
  discovery: z.boolean().default(true).description('Discover models from the network.'),
  modelsMaxAgeMs: z.natural().default(5 * 60_000).description('Freshness of the discovered model listing.'),
  modelsTimeoutMs: z.natural().default(DEFAULT_MODELS_TIMEOUT_MS).description('Model discovery timeout.'),
  models: z.array(modelOverrideSchema).default([]).description('Declared models and per-model overrides.'),
  cliVersion: z.string().default(CATALOG_CLI_VERSION).description('x-command-code-version sent to the provider.'),
  projectSlug: z.string().description('x-project-slug sent to the provider.'),
  sessionId: z.string().description('x-session-id sent to the provider.'),
  zdr: z.boolean().default(false).description('Ask for Zero Data Retention upstreams only.'),
  thinking: z.union([z.const('effort'), z.const('budget'), z.const('disabled')]).default('effort')
    .description('How Claude requests ask for thinking on the Messages wire.'),
  reasoningBack: z.union([z.const('auto'), z.const('always'), z.const('never')]).default('auto')
    .description('When earlier assistant reasoning is replayed on the Chat Completions wire.'),
  maxTokens: z.natural().default(DEFAULT_MAX_TOKENS).description('Default per-request output cap.'),
  maxRequestImageBytes: z.natural().default(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    .description('Base64-decoded image bytes one request may carry.'),
  maxImagesPerRequest: z.natural().default(DEFAULT_MAX_IMAGES_PER_REQUEST).description('Images per request.'),
  streamIdleTimeoutMs: z.natural().default(180_000).description('Provider idle timeout for one stream read.'),
  retryPolicy: RetryPolicySchema,
})

/** Validated deployment facts one operation uses. */
export interface Connection {
  /** Provider API root, without a trailing slash. */
  readonly baseURL: string
  /** Model listing endpoint. */
  readonly modelsURL: string
  /** Every served model. */
  readonly models: readonly CatalogModel[]
  /** Credential reference resolved per request. */
  readonly apiKeyEnv: string
  /** Explicit auth file, when configured. */
  readonly authFile?: string
  /** CLI version string sent as `x-command-code-version`. */
  readonly cliVersion: string
  /** Project slug sent as `x-project-slug`, already header-safe. */
  readonly projectSlug: string
  /** Session id sent as `x-session-id`. */
  readonly sessionId: string
  /** Whether to send `x-cmd-zdr: 1`. */
  readonly zdr: boolean
  /** Configured plan choice. */
  readonly plan: PlanChoice
  /** Whether to refresh the CLI catalog. */
  readonly referenceCatalog: boolean
  /** Freshness of one refreshed CLI catalog. */
  readonly referenceMaxAgeMs: number
  /** How Claude requests ask for thinking. */
  readonly thinking: ThinkingMode
  /** When earlier reasoning is replayed. */
  readonly reasoningBack: ReasoningBack
  /** Default per-request output cap. */
  readonly maxTokens: number
  /** Request image byte budget, after decoding. */
  readonly maxRequestImageBytes: number
  /** Request image count budget. */
  readonly maxImagesPerRequest: number
  /** Provider idle timeout, in milliseconds. */
  readonly streamIdleTimeoutMs: number
  /** Provider-owned retry policy, already resolved. */
  readonly retryPolicy: ResolvedRetryPolicy
}

/** One header value no HTTP field can carry, or a malformed endpoint. */
function invalid(field: string, detail: string): Error {
  return new Error(`dsh-provider-commandcode: ${field} ${detail}`)
}

function endpoint(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (_unparseable) {
    throw invalid(field, 'must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid(field, 'must use http or https')
  return value.replace(/\/+$/u, '')
}

/** A header value with no control characters; anything else is rejected, never re-encoded silently. */
function headerSafe(value: string, field: string, pattern: RegExp, hint: string): string {
  if (!pattern.test(value)) throw invalid(field, hint)
  return value
}

/** `x-project-slug` carries one path segment; non-ASCII goes percent-encoded, as the CLI does. */
function slug(value: string): string {
  const name = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'root'
  return /^[\x20-\x7e\xa0-\xff]*$/u.test(name) && name.length > 0 ? name : encodeURIComponent(name || 'root')
}

/**
 * Resolve one validated connection from live configuration.
 * @param config - raw deployment configuration, already schema-validated.
 * @param models - served catalog for this generation.
 * @param workingDirectory - harness working directory, used for the project slug.
 * @returns detached connection facts.
 * @throws when an endpoint or a header value cannot be sent as configured.
 */
export function resolveConnection(
  config: Config,
  models: readonly CatalogModel[],
  workingDirectory: string,
): Connection {
  const baseURL = endpoint(config.baseURL ?? DEFAULT_BASE_URL, 'baseURL')
  const modelsURL = endpoint(config.modelsURL ?? `${baseURL}/models`, 'modelsURL')
  const cliVersion = headerSafe(
    config.cliVersion ?? CATALOG_CLI_VERSION, 'cliVersion', /^[\x20-\x7e]{1,64}$/u,
    'must be 1-64 printable ASCII characters',
  )
  const sessionId = headerSafe(
    config.sessionId ?? PROCESS_SESSION_ID, 'sessionId', /^[A-Za-z0-9._-]{1,128}$/u,
    'must match [A-Za-z0-9._-]{1,128}',
  )
  const projectSlug = headerSafe(
    slug(config.projectSlug ?? workingDirectory), 'projectSlug', /^[\x20-\x7e\xa0-\xff]{1,255}$/u,
    'must be a single path segment',
  )
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw invalid('maxTokens', 'must be a positive integer')
  const thinking = config.thinking ?? 'effort'
  return {
    baseURL,
    modelsURL,
    models,
    apiKeyEnv: config.apiKeyEnv ?? 'COMMANDCODE_API_KEY',
    plan: config.plan ?? 'auto',
    referenceCatalog: config.referenceCatalog ?? true,
    referenceMaxAgeMs: config.referenceMaxAgeMs ?? 6 * 60 * 60 * 1000,
    ...config.authFile === undefined ? {} : { authFile: config.authFile },
    cliVersion,
    projectSlug,
    sessionId,
    zdr: config.zdr ?? false,
    thinking,
    reasoningBack: config.reasoningBack ?? 'auto',
    maxTokens,
    maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    maxImagesPerRequest: config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 180_000,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-provider-commandcode.retryPolicy'),
  }
}

/** One process-wide session id, as one CLI session has. */
const PROCESS_SESSION_ID = globalThis.crypto.randomUUID()

/** One process-wide session id, as one CLI session has. */
export function processSessionId(): string {
  return PROCESS_SESSION_ID
}
