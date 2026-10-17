import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  conversationSeed,
  currentOpencodeSessionId,
  deriveRequestIDs,
  kiloHeaders,
  kiloUserAgent,
  opencodeHeaders,
  opencodeUserAgent,
  opencodeV2SessionId,
  randomID,
  stableID,
} from '../src/adapter/ids.ts'

test('stableID is deterministic and sha256-truncated', () => {
  const first = stableID('ses', 'hello')
  const second = stableID('ses', 'hello')
  assert.equal(first, second)
  assert.ok(first.startsWith('ses_'))
  const hex = first.slice('ses_'.length)
  assert.equal(hex.length, 24, '12 bytes hex')
  const expected = createHash('sha256').update('ses\x00hello').digest().subarray(0, 12).toString('hex')
  assert.equal(hex, expected)
  assert.notEqual(stableID('ses', 'world'), first)
  assert.notEqual(stableID('prj', 'hello'), first, 'prefix is part of the hash input')
})

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('deriveRequestIDs keeps the session stable across turns and randomizes requests', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.equal(first.project, second.project)
  assert.ok(first.project.startsWith('prj_'))
  assert.equal(first.parentSession, '')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('kiloHeaders carries Kilo correlation headers without CLI spoofing', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = kiloHeaders(ids)
  assert.equal(headers['user-agent'], kiloUserAgent())
  assert.equal(headers['x-kilocode-editorname'], 'DSH/kilo2dsh')
  assert.equal(headers['x-kilocode-taskid'], ids.request)
  assert.equal(headers['x-kilocode-projectid'], ids.project)
  assert.equal(headers['x-opencode-client'], undefined)
  assert.ok(headers['user-agent'].startsWith('kilo2dsh'))
})

test('opencodeV2SessionId matches the opencode-free-api-rust format', () => {
  const id = opencodeV2SessionId(1_762_000_000_000)
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'ses_ + 12 lowercase hex + 14 base62')
  // Deterministic for a fixed timestamp (mirrors the Rust LCG seeded from ts).
  assert.equal(id, opencodeV2SessionId(1_762_000_000_000))
  assert.notEqual(id, opencodeV2SessionId(1_762_000_000_001), 'a different timestamp yields a different id')
})

test('currentOpencodeSessionId reuses the same id within the TTL', () => {
  const first = currentOpencodeSessionId(1_762_000_000_000)
  const second = currentOpencodeSessionId(1_762_000_000_000 + 60_000)
  assert.equal(first, second, 'id is cached for 30 minutes')
  const later = currentOpencodeSessionId(1_762_000_000_000 + 31 * 60_000)
  assert.notEqual(first, later, 'id is re-rolled after the 30-minute TTL')
})

test('opencodeHeaders carries Zen V2 compatibility identifiers independently', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }], 'opencode2dsh:default-project')
  const headers = opencodeHeaders(ids)
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.ok(headers['user-agent'].startsWith('opencode/latest/'))
  assert.ok(headers['user-agent'].endsWith('/cli'))
  assert.equal(headers['x-opencode-client'], 'cli')
  // The V2 free lane requires a valid V2 session id on these affinity headers;
  // the legacy sha256 `ids.session` is rejected upstream with FreeTierError.
  assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(headers['x-opencode-session'], headers['x-opencode-session-id'])
  assert.equal(headers['x-opencode-session'], headers['x-session-affinity'])
  assert.equal(headers['x-opencode-session'], headers['X-Session-Id'])
  assert.notEqual(headers['x-opencode-session'], ids.session, 'V2 id is not the sha256 conversation id')
  assert.equal(headers['x-opencode-project'], 'global')
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-kilocode-editorname'], undefined)
})
