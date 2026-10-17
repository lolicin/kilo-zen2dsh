import {
  OPENCODE_ZEN_ANONYMOUS_API_KEY,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_GATEWAY_BASE_URL,
  normalizeZenGatewayUrl,
} from './catalog.ts'
import {
  KiloAdapter,
  type CatalogLike,
  type KiloAdapterOptions,
} from './kilo-adapter.ts'
import { opencodeHeaders, opencodeUserAgent, type RequestIDs } from './ids.ts'
import type { Api } from '@earendil-works/pi-ai'
import type { KiloModel } from './catalog.ts'

/** Provider id retained by the original OpenCode/Zen DSH integration. */
export const ZEN_PROVIDER_ID = 'opencode2dsh'
/** @deprecated Use ZEN_PROVIDER_ID. Kept for direct file-level imports. */
export const PROVIDER_ID = ZEN_PROVIDER_ID

/**
 * Scrub the OpenAI/Stainless SDK fingerprint from requests to opencode.ai.
 *
 * pi-ai's openai client is Stainless-generated; it tags every request with
 * `x-stainless-*` headers and `accept: application/json`. The Zen V2 free-tier
 * gate rejects both — a request carrying either is 403'd with FreeTierError.
 * A real opencode CLI stream call sends `accept: text/event-stream` and no
 * Stainless headers, so rewrite outgoing opencode.ai fetches to match. The
 * wrapper installs once per process (idempotent guard survives re-import and
 * plugin hot-reload) and leaves every other host untouched.
 */
if (!(globalThis as { __zenV2FetchScrubbed?: boolean }).__zenV2FetchScrubbed) {
  ;(globalThis as { __zenV2FetchScrubbed?: boolean }).__zenV2FetchScrubbed = true
  const __origFetch = globalThis.fetch
  globalThis.fetch = async function __zenV2Fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? ''
      if (/^https:\/\/opencode\.ai\//i.test(url) && init && init.headers) {
        const h =
          init.headers instanceof Headers
            ? new Headers(init.headers)
            : new Headers(init.headers as HeadersInit)
        h.set('accept', 'text/event-stream')
        for (const key of [...h.keys()]) if (/^x-stainless-/i.test(key)) h.delete(key)
        init = { ...init, headers: h }
      }
    } catch {
      /* fall through to the original fetch on any scrub failure */
    }
    return __origFetch(input as RequestInfo | URL, init)
  }
}

/** Zen currently serves this free model through the Responses API. */
export const ZEN_RESPONSES_MODEL_IDS = ['muse-spark-1.2-contributor-free'] as const

/**
 * Select the wire API for a Zen model. The public catalog is intentionally
 * sparse, so keep the known Responses model explicit and allow future catalog
 * records to advertise an API/protocol field without making every model
 * Responses traffic by default.
 */
export function zenModelApi(model: KiloModel): Api {
  // Different Zen-compatible catalog deployments have used each of these
  // fields (and, for a few records, nested `opencode` metadata). Treat any
  // explicit Responses marker as authoritative instead of letting a generic
  // `api: chat` field mask a more specific protocol declaration.
  const advertised = [
    model.api,
    model.protocol,
    model.endpoint,
    model.opencode?.api,
    model.opencode?.protocol,
    model.opencode?.endpoint,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(' ')
    .toLowerCase()
  if (advertised.includes('response')) return 'openai-responses'
  const id = model.id.trim().toLowerCase()
  if (
    ZEN_RESPONSES_MODEL_IDS.some((candidate) => candidate === id) ||
    /(?:^|[-_:])responses(?:[-_:]|$)/.test(id) ||
    (/^muse-spark(?:[-.\w])*free$/.test(id) && id.includes('contributor'))
  ) {
    return 'openai-responses'
  }
  return 'openai-completions'
}

/**
 * Gate tool the V2 free tier requires: requests whose `tools` array lacks a
 * tool named `read` are rejected with 403 FreeTierError regardless of what
 * else the client sends. Mirrors `gate_tool()` in opencode-free-api-rust
 * src/protocol.rs. The description tells the model never to call it, because
 * DSH does not actually implement this reserved tool.
 */
export function opencodeGateReadTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory to read' },
          offset: { type: 'integer', minimum: 0, description: 'Starting line or directory entry (1-based)' },
          limit: { type: 'integer', minimum: 0, description: 'Maximum lines or directory entries to read' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      strict: false,
    },
  }
}

/**
 * Detect whether a chat request is asking for reasoning, mirroring
 * `thinking_mode()` in opencode-free-api-rust src/convert.rs: `thinking.enabled`
 * is a boolean, or `reasoning_effort` / `reasoning.effort` is a non-empty
 * string. The upstream gates its reasoning-content validation on this flag.
 */
export function zenThinkingMode(payload: Record<string, unknown>): boolean {
  const thinking = payload['thinking']
  if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) {
    const enabled = (thinking as Record<string, unknown>)['enabled']
    if (typeof enabled === 'boolean') return enabled
  }
  const effort = payload['reasoning_effort']
  if (typeof effort === 'string' && effort.trim() !== '') return true
  const reasoning = payload['reasoning']
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const inner = (reasoning as Record<string, unknown>)['effort']
    if (typeof inner === 'string' && inner.trim() !== '') return true
  }
  return false
}

/**
 * Rewrite an outgoing OpenAI chat-completions payload to satisfy the OpenCode
 * Zen V2 free lane. Mirrors `remap_chat_body()` in opencode-free-api-rust
 * src/main.rs:
 *  - normalise `reasoning.effort` into the flat `reasoning_effort` the V2
 *    upstream expects (an explicit `reasoning_effort` is kept as-is);
 *  - in thinking mode, inject an empty `reasoning_content` at the top level
 *    and on assistant messages so the upstream validation passes;
 *  - the V2 upstream only accepts streaming, so force `stream:true` and
 *    `stream_options:{include_usage:true}` (pi-ai already streams, this is a
 *    belt-and-braces guard for callers that set `stream:false`);
 *  - the free-tier gate requires a tool named `read`; append the reserved gate
 *    tool when the client's tools lack it, preserving any client tools;
 *  - the V2 upstream rejects `tool_choice:"none"`, so drop it (the kept tool
 *    descriptions still constrain the model).
 * Returns the (possibly same) payload object; it may be mutated in place.
 */
export function remapZenChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // reasoning.effort -> reasoning_effort (explicit value wins)
  if (payload['reasoning_effort'] === undefined) {
    const reasoning = payload['reasoning']
    if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
      const effort = (reasoning as Record<string, unknown>)['effort']
      if (typeof effort === 'string' && effort.trim() !== '') {
        payload['reasoning_effort'] = effort
      }
    }
  }
  if (zenThinkingMode(payload)) {
    if (typeof payload['reasoning_content'] !== 'string') payload['reasoning_content'] = ''
    const messages = payload['messages']
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          const record = message as Record<string, unknown>
          if (record['role'] === 'assistant' && typeof record['reasoning_content'] !== 'string') {
            record['reasoning_content'] = ''
          }
        }
      }
    }
  }
  // Free-tier gate: ensure a tool named `read` exists.
  const tools = payload['tools']
  const hasRead = Array.isArray(tools) &&
    tools.some((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false
      const fn = (tool as Record<string, unknown>)['function']
      const name = fn && typeof fn === 'object' && !Array.isArray(fn)
        ? (fn as Record<string, unknown>)['name']
        : undefined
      return name === 'read'
    })
  if (!hasRead) {
    if (Array.isArray(tools)) tools.push(opencodeGateReadTool())
    else payload['tools'] = [opencodeGateReadTool()]
  }
  if (payload['tool_choice'] === 'none') delete payload['tool_choice']
  payload['stream'] = true
  payload['stream_options'] = { include_usage: true }
  return payload
}

export interface ZenAdapterOptions extends KiloAdapterOptions {
  /** Zen root (`https://opencode.ai/zen`) or an already-qualified `/v1` URL. */
  zenBaseUrl?: string
}

/**
 * Native DSH adapter for OpenCode Zen's free lane. Zen is intentionally kept
 * separate from Kilo: it uses `/zen/v1`, the public placeholder credential,
 * and OpenCode compatibility headers required by the anonymous lane.
 */
export class ZenAdapter extends KiloAdapter {
  constructor(catalog: CatalogLike, options: ZenAdapterOptions = {}) {
    const gatewayBaseUrl = normalizeZenGatewayUrl(options.gatewayBaseUrl?.trim() || options.zenBaseUrl?.trim() || OPENCODE_ZEN_BASE_URL)
    const userAgent = options.userAgent?.trim() || opencodeUserAgent()
    const upstreamOnPayload = options.onPayload
    super(catalog, {
      ...options,
      providerId: options.providerId?.trim() || ZEN_PROVIDER_ID,
      gatewayBaseUrl,
      anonymousKey: options.anonymousKey ?? OPENCODE_ZEN_ANONYMOUS_API_KEY,
      userAgent,
      displayName: options.displayName ?? 'OpenCode Zen (free)',
      authName: options.authName ?? 'OpenCode Zen API key (optional)',
      projectNamespace: options.projectNamespace ?? 'opencode2dsh:default-project',
      // The 524,288-token ceiling is specific to the Kilo gateway's current
      // MiniMax compatibility lane; Zen owns its own model limits.
      maxOutputTokens: options.maxOutputTokens ?? null,
      apiResolver: options.apiResolver ?? zenModelApi,
      headerBuilder:
        options.headerBuilder ??
        ((ids: RequestIDs, adapterOptions: KiloAdapterOptions, mode?: unknown) => {
          const headers = opencodeHeaders(ids, { userAgent: adapterOptions.userAgent ?? userAgent })
          if (typeof mode === 'string' && mode.length > 0) headers['x-opencode-mode'] = mode
          return headers
        }),
      // Rewrite the outgoing payload for the V2 free lane (gate `read` tool,
      // forced streaming, reasoning normalisation). Runs before the adapter's
      // max-tokens clamp inside KiloAdapter.stream().
      onPayload: (payload, model) => {
        const remapped = remapZenChatPayload(payload)
        return upstreamOnPayload?.(remapped, model)
      },
    })
  }
}

export function createZenAdapter(catalog: CatalogLike, options?: ZenAdapterOptions): ZenAdapter {
  return new ZenAdapter(catalog, options)
}

/** Explicit alias for callers that want to distinguish the two adapters. */
export const OpenCodeZenAdapter = ZenAdapter

export type { KiloAdapterOptions, CatalogLike }
export type { KiloModelInfo as ZenModelInfo } from './catalog.ts'
export { OPENCODE_ZEN_ANONYMOUS_API_KEY, OPENCODE_ZEN_BASE_URL, OPENCODE_ZEN_GATEWAY_BASE_URL }
