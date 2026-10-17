import { createHash, randomBytes } from 'node:crypto'

import { KILO_USER_AGENT } from './catalog.ts'

/** Correlation identifiers used by Kilo's task/project headers. */
export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable and non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/** Derive stable per-conversation and per-request IDs without storing content. */
export function deriveRequestIDs(
  messages: Array<{ role: string; content: unknown }>,
  projectNamespace = 'kilo2dsh:default-project',
): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: stableID('ses', signal),
    request: randomID('req', 16),
    project: stableID('prj', projectNamespace),
    parentSession: '',
  }
}

/** User-Agent identifies this integration; it does not impersonate Kilo CLI. */
export function kiloUserAgent(): string {
  const version = process.env.KILO2DSH_VERSION?.trim()
  return version ? `${KILO_USER_AGENT}/${version}` : KILO_USER_AGENT
}

/**
 * OpenCode-compatible user agent used only by the optional Zen free lane.
 * The V2 free-tier upstream (opencode-free-api-rust `DEFAULT_USER_AGENT`)
 * gates anonymous requests on the `opencode/<...>/cli` marker; keep the
 * version override explicit so users can update it without rebuilding.
 * Observed behavior: https://github.com/anomalyco/opencode/issues/42500
 */
export function opencodeUserAgent(): string {
  const version = process.env.OPENCODE2DSH_VERSION?.trim() || '2.0.29'
  return `opencode/latest/${version}/cli`
}

/**
 * Alphabet used for the random tail of an OpenCode V2 session id. Mirrors
 * `ID_CHARS` in opencode-free-api-rust src/protocol.rs: digits, then upper,
 * then lower case, so the modulo index selects the same character as the Rust
 * implementation for a given seed byte.
 */
const ZEN_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZEN_SESSION_TTL_MS = 30 * 60 * 1000

/** Cached V2 session id (timestamp, id), mirroring `SESSION` in protocol.rs. */
let zenSessionCache: { at: number; id: string } | null = null

/**
 * Build a V2 OpenCode Zen session id for a timestamp.
 *
 * Mirrors `opencode_session_id()` in opencode-free-api-rust src/protocol.rs:
 * `ses_` + 12 lowercase hex of `~(ts_ms * 0x1000 + 1)` (low 48 bits) + 14
 * Base62 characters produced by the same LCG (seeded from the timestamp).
 * The upstream free tier validates the first 12 hex against this complement
 * shape; the legacy sha256-derived id is rejected with 403 FreeTierError.
 */
export function opencodeV2SessionId(timestampMs: number = Date.now()): string {
  const ts = BigInt(Math.max(0, Math.floor(timestampMs)))
  const low48 = (1n << 48n) - 1n
  const m64 = (1n << 64n) - 1n
  const complement = ~((ts * 0x1000n + 1n) & low48) & low48
  const timeHex = complement.toString(16).padStart(12, '0')
  let seed = (ts ^ 0x9e3779b97f4a7c15n) & m64
  let tail = ''
  for (let i = 0; i < 14; i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & m64
    tail += ZEN_ID_CHARS[Number((seed >> 33n) % 62n)]
  }
  return `ses_${timeHex}${tail}`
}

/**
 * Return the current OpenCode Zen session id, reusing the same id across
 * requests within a 30-minute window (mirrors `current_session_id()` in
 * protocol.rs, which keeps upstream session affinity and avoids hammering the
 * free tier with a freshly-rolled id per request).
 */
export function currentOpencodeSessionId(now: number = Date.now()): string {
  if (zenSessionCache && now - zenSessionCache.at < ZEN_SESSION_TTL_MS) return zenSessionCache.id
  const id = opencodeV2SessionId(now)
  zenSessionCache = { at: now, id }
  return id
}

export interface KiloHeaderOptions {
  userAgent?: string
  editorName?: string
  mode?: string
  organizationId?: string
  feature?: string
}

/** Build the documented KiloCode request headers. */
export function kiloHeaders(ids: RequestIDs, options: KiloHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? kiloUserAgent(),
    'content-type': 'application/json',
    'x-kilocode-editorname': options.editorName ?? 'DSH/kilo2dsh',
    'x-kilocode-taskid': ids.request,
    'x-kilocode-projectid': ids.project,
  }
  if (ids.parentSession) headers['x-kilocode-parent-taskid'] = ids.parentSession
  if (options.mode) headers['x-kilocode-mode'] = options.mode
  if (options.organizationId) headers['x-kilocode-organizationid'] = options.organizationId
  if (options.feature) headers['x-kilocode-feature'] = options.feature
  return headers
}

export interface OpenCodeHeaderOptions {
  userAgent?: string
  client?: string
  /** Value sent in `x-opencode-project`; the V2 free lane uses `global`. */
  project?: string
}

/**
 * Headers expected by the OpenCode Zen V2 free lane. Mirrors
 * `add_v2_session_headers()` in opencode-free-api-rust src/protocol.rs: the
 * session affinity headers carry a V2-format session id (`currentOpencodeSessionId`),
 * `x-opencode-client` is `cli`, and `x-opencode-project` is `global` (not a
 * per-conversation `prj_` id). `Authorization: Bearer public` is added by the
 * adapter's keyless transport, not here, so callers can still override it.
 */
export function opencodeHeaders(ids: RequestIDs, options: OpenCodeHeaderOptions = {}): Record<string, string> {
  const session = currentOpencodeSessionId()
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? opencodeUserAgent(),
    'x-opencode-client': options.client ?? 'cli',
    'x-opencode-project': options.project ?? 'global',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
  }
  if (ids.request) headers['x-opencode-request'] = ids.request
  if (ids.parentSession) {
    const parent = currentOpencodeSessionId()
    headers['x-opencode-parent-session-id'] = parent
    headers['x-parent-session-id'] = parent
  }
  return headers
}

/** Compatibility spelling retained for downstream users of opencode2dsh. */
export const disguiseHeaders = opencodeHeaders
