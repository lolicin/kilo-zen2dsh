import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  ZenAdapter,
  ZEN_PROVIDER_ID,
  opencodeGateReadTool,
  remapZenChatPayload,
  zenThinkingMode,
} from '../src/adapter/zen-adapter.ts'

test('opencodeGateReadTool exposes a function named read', () => {
  const tool = opencodeGateReadTool() as { function: { name: string } }
  assert.equal(tool.type, 'function')
  assert.equal(tool.function.name, 'read')
})

test('zenThinkingMode detects the documented markers', () => {
  assert.equal(zenThinkingMode({ thinking: { enabled: true } }), true)
  assert.equal(zenThinkingMode({ thinking: { enabled: false } }), false)
  assert.equal(zenThinkingMode({ reasoning_effort: 'high' }), true)
  assert.equal(zenThinkingMode({ reasoning_effort: '' }), false)
  assert.equal(zenThinkingMode({ reasoning: { effort: 'high' } }), true)
  assert.equal(zenThinkingMode({ reasoning: { effort: '' } }), false)
  assert.equal(zenThinkingMode({ messages: [] }), false)
})

test('remapZenChatPayload injects the gate read tool when tools are absent', () => {
  const out = remapZenChatPayload({ model: 'm', messages: [] })
  const tools = out['tools'] as Array<{ function: { name: string } }>
  assert.equal(tools.length, 1)
  assert.equal(tools[0].function.name, 'read')
  assert.equal(out['stream'], true)
  assert.deepEqual(out['stream_options'], { include_usage: true })
})

test('remapZenChatPayload appends the gate read tool when client tools lack it', () => {
  const out = remapZenChatPayload({
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'edit', parameters: { type: 'object' } } },
    ],
  })
  const names = (out['tools'] as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
  assert.deepEqual(names, ['bash', 'edit', 'read'])
})

test('remapZenChatPayload keeps an existing client read without duplicating it', () => {
  const out = remapZenChatPayload({
    model: 'm',
    messages: [],
    tools: [
      { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { whatever: { type: 'number' } } } } },
    ],
  })
  const names = (out['tools'] as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
  assert.deepEqual(names, ['bash', 'read'])
})

test('remapZenChatPayload injects empty reasoning_content in thinking mode', () => {
  const out = remapZenChatPayload({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
    thinking: { enabled: true },
  })
  assert.equal(out['reasoning_content'], '')
  const assistant = (out['messages'] as Array<Record<string, unknown>>).find((message) => message['role'] === 'assistant')
  assert.equal(assistant!['reasoning_content'], '')
})

test('remapZenChatPayload normalises reasoning.effort into reasoning_effort', () => {
  const out = remapZenChatPayload({ model: 'm', messages: [], reasoning: { effort: 'high' } })
  assert.equal(out['reasoning_effort'], 'high')
  assert.equal(out['reasoning_content'], '', 'thinking mode kicks in via the merged effort')
})

test('remapZenChatPayload keeps an explicit reasoning_effort and drops tool_choice none', () => {
  const out = remapZenChatPayload({
    model: 'm',
    messages: [],
    reasoning_effort: 'low',
    reasoning: { effort: 'high' },
    tool_choice: 'none',
  })
  assert.equal(out['reasoning_effort'], 'low')
  assert.equal(out['tool_choice'], undefined, 'V2 upstream rejects tool_choice:none')
})

test('remapZenChatPayload forces stream even when the caller asked for non-stream', () => {
  const out = remapZenChatPayload({ model: 'm', messages: [], stream: false })
  assert.equal(out['stream'], true)
  assert.deepEqual(out['stream_options'], { include_usage: true })
})

test('ZenAdapter sends the gate read tool and V2 session headers to the upstream', async () => {
  let seenBody = ''
  let seenHeaders: Record<string, string | string[] | undefined> = {}
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      seenBody = data
      seenHeaders = req.headers
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        `data: ${JSON.stringify({ id: 'z1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}`,
        '',
        `data: ${JSON.stringify({ id: 'z1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const adapter = new ZenAdapter(
      {
        list: () => ['big-pickle'],
        decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
        get: () => ({ id: 'big-pickle', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } }),
      },
      { zenBaseUrl: `http://127.0.0.1:${address.port}/zen` },
    )
    for await (const _chunk of adapter.stream({
      provider: ZEN_PROVIDER_ID,
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      // consume
    }
    const payload = JSON.parse(seenBody)
    const names = (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    assert.ok(names.includes('read'), 'gate read tool is present on the wire')
    assert.equal(payload.stream, true)
    assert.deepEqual(payload.stream_options, { include_usage: true })
    // V2 session headers carry a valid V2-format session id, not a sha256 id.
    assert.match(String(seenHeaders['x-opencode-session']), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.equal(seenHeaders['x-opencode-session-id'], seenHeaders['x-opencode-session'])
    assert.equal(seenHeaders['x-opencode-project'], 'global')
    assert.match(String(seenHeaders['user-agent']), /^opencode\/latest\/[^/]+\/cli$/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
