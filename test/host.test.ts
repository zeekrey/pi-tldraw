import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CanvasHost } from '../src/host.ts'
import { TldrawRemote } from '../src/remote.ts'
import type { Remote } from '../src/remote.ts'

class FakeRemote implements Remote {
  calls: string[] = []
  closed = false
  finish?: (result: CallToolResult) => void
  async connect() {}
  async widget() {
    // Real bundles can contain </head> in a template string; bootstrap must go at the LAST head end.
    return '<html><head><script type="module">const example = `</head>`;</script><script>window.__TLDRAW_BOOTSTRAP__={sessionId:"test"}</script></head><body></body></html>'
  }
  async call(name: string, _args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    this.calls.push(name)
    if (name === 'exec') return new Promise((resolve, reject) => {
      this.finish = resolve
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    if (name === '_exec_callback' && _args.execKey !== 'stale') this.finish?.({ content: [{ type: 'text', text: 'remote ok' }] })
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  async close() { this.closed = true }
}

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tldraw-test-'))
  const statePath = join(dir, 'canvas.json')
  const remote = new FakeRemote()
  const messages: string[] = []
  const host = await new CanvasHost({ remote, statePath, onMessage: text => messages.push(text) }).start()
  const url = new URL(host.url)
  const auth = { authorization: `Bearer ${url.hash.slice(1)}` }
  const api = (path: string, data?: unknown, headers: Record<string, string> = auth) => fetch(`${url.origin}/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { ...headers, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, statePath, remote, host, url, auth, api, messages }
}

async function openStream(s: Awaited<ReturnType<typeof setup>>, t: test.TestContext) {
  const controller = new AbortController()
  const stream = await fetch(`${s.url.origin}/api/events`, { headers: s.auth, signal: controller.signal })
  const reader = stream.body!.getReader()
  t.after(() => { controller.abort(); void reader.cancel().catch(() => {}) })
  await reader.read() // initial comment
  await s.api('ready', {})
  return reader
}

const cp = { checkpointId: 'checkpoint-1', shapesJson: '[{"id":"shape:test","type":"geo","props":{"text":"hello"}}]', assetsJson: '[]', bindingsJson: '[]' }

test('lazy connection, capability auth, origin/host checks, and app tool allowlist', async t => {
  const s = await setup(t)
  assert.deepEqual(s.remote.calls, [])
  assert.equal((await s.api('widget', undefined, {})).status, 401)
  assert.equal((await s.api('widget', undefined, { ...s.auth, origin: 'https://evil.example' })).status, 403)
  const rebound = await new Promise<number | undefined>(resolve => {
    const req = request(`${s.url.origin}/api/widget`, { headers: { ...s.auth, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.end()
  })
  assert.equal(rebound, 403)
  assert.equal((await s.api('tool', { name: 'exec', arguments: { code: 'bad' } })).status, 400)
  assert.equal((await s.api('tool', { name: '__proto__' })).status, 400)
  await assert.rejects(s.host.exec('return 1'), /Open the canvas/)
  assert.deepEqual(s.remote.calls, [])
  assert.equal((await s.api('unknown')).status, 404)
})

test('only one browser can own the canvas; disconnect clears readiness', async t => {
  const s = await setup(t)
  const reader = await openStream(s, t)
  assert.equal(s.host.connected, true)
  assert.equal((await s.api('events')).status, 409)
  await reader.cancel()
  // Wait for the local socket-close notification, not a network retry.
  for (let i = 0; i < 50 && s.host.connected; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(s.host.connected, false)
})

test('exec result/error propagation, stale callback rejection, checkpoint durability, restart', async t => {
  const s = await setup(t)
  const reader = await openStream(s, t)
  const pending = s.host.exec('return 42')
  await assert.rejects(s.host.exec('return 43'), /in progress/)
  const event = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1].trim())
  const args = event.params.arguments
  assert.equal(event.method, 'ui/notifications/tool-input')
  const key = createHash('sha256').update(`${s.host.canvasId}\n${args.code}`).digest('hex').slice(0, 32)
  // A stale callback must not become the current call's result.
  await s.api('tool', { name: '_exec_callback', arguments: { execKey: 'stale', result: { success: true, result: 999 } } })
  await s.api('tool', { name: '_exec_callback', arguments: { execKey: key, result: { success: true, result: 42 } } })
  await s.api('tool', { name: 'save_checkpoint', arguments: cp })
  assert.match(JSON.stringify(await pending), /42/)
  assert.doesNotMatch(JSON.stringify(await readFile(s.statePath, 'utf8')), /999/)
  const saved = JSON.parse(await readFile(s.statePath, 'utf8'))
  assert.equal(saved.checkpoint.shapesJson, cp.shapesJson)
  await s.host.close()
  assert.equal(s.remote.closed, true)
  const resumed = await new CanvasHost({ remote: new FakeRemote(), statePath: s.statePath }).start()
  t.after(() => resumed.close())
  assert.equal(resumed.canvasId, saved.canvasId)
  const u = new URL(resumed.url)
  const data = await (await fetch(`${u.origin}/api/widget`, { headers: { authorization: `Bearer ${u.hash.slice(1)}` } })).json()
  const html = await (await fetch(`${u.origin}${data.url}`)).text()
  assert.doesNotMatch(html, /const example/) // bundle is now a JS resource, not misparsed HTML
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1])
  assert.equal(scripts.length, 3)
  const bootstrap = await (await fetch(scripts[2], { headers: { origin: 'null' } })).text()
  const encoded = /atob\('([^']+)'\)/.exec(bootstrap)![1]
  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  assert.equal(decoded.shapes[0].id, 'shape:test')
})

test('app context and deliberate messages; bad checkpoints do not replace saved drawing', async t => {
  const s = await setup(t)
  await s.api('context', { content: [{ type: 'text', text: 'drawing data' }] })
  assert.match(s.host.modelContext, /drawing data/)
  await s.api('message', { text: 'Implement my drawing' })
  assert.deepEqual(s.messages, ['Implement my drawing'])
  assert.equal((await s.api('message', { text: 123 })).status, 400)
  await s.api('tool', { name: 'save_checkpoint', arguments: cp })
  assert.equal((await s.api('tool', { name: 'save_checkpoint', arguments: { ...cp, shapesJson: '{}' } })).status, 400)
  assert.equal(JSON.parse(await readFile(s.statePath, 'utf8')).checkpoint.shapesJson, cp.shapesJson)
})

test('abort is not retried and releases the pending execution', async t => {
  const s = await setup(t)
  await openStream(s, t)
  const controller = new AbortController()
  const pending = s.host.exec('return 1', controller.signal)
  controller.abort(new Error('test abort'))
  await assert.rejects(pending, /test abort/)
  assert.equal(s.remote.calls.filter(c => c === 'exec').length, 1)
})

test('remote endpoint refuses insecure non-loopback HTTP', () => {
  assert.throws(() => new TldrawRemote('http://example.com/mcp'), /HTTPS/)
  assert.throws(() => new TldrawRemote('file:///etc/passwd'), /HTTPS/)
  assert.doesNotThrow(() => new TldrawRemote('http://127.0.0.1:8787/mcp'))
})
