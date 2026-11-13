import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import extension from '../src/index.ts'

// Exercise the public factory without a model, credentials, or Pi's interactive UI.
test('extension loads lazily, registers tools/command, and cleans up on shutdown', async () => {
  const tools: Parameters<ExtensionAPI['registerTool']>[0][] = []
  const handlers = new Map<string, (...args: any[]) => any>()
  const commands = new Map<string, any>()
  const messages: any[] = []
  const pi = {
    registerTool: (tool: typeof tools[number]) => tools.push(tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    sendMessage: (message: any) => messages.push(message),
    sendUserMessage: () => { throw new Error('No message expected') },
  } as unknown as ExtensionAPI
  extension(pi)
  assert.deepEqual(tools.map(t => t.name), ['tldraw_open', 'tldraw_search', 'tldraw_exec', 'tldraw_scene'])
  assert.ok(tools.every(t => t.executionMode === 'sequential'))
  assert.equal(handlers.get('before_agent_start')!(), undefined)
  const cwd = await mkdtemp(`${tmpdir()}/pi-tldraw-extension-`)
  const ctx = { cwd, sessionManager: { getSessionId: () => 'test-session' } } as ExtensionContext
  try {
    await commands.get('tldraw').handler('', ctx)
    assert.match(messages[0].content, /http:\/\/127\.0\.0\.1:\d+\/#/)
    assert.match(messages[0].content, /open this URL/)
    const scene = tools.find(t => t.name === 'tldraw_scene')!
    await assert.rejects(scene.execute('id', {}, undefined, undefined, ctx as any), /Open the canvas/)
  } finally {
    await handlers.get('session_shutdown')!()
    await handlers.get('session_shutdown')!() // idempotent
    await rm(cwd, { recursive: true, force: true })
  }
})
