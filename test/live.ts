// Opt-in: contacts the configured tldraw service. Uses an isolated temporary canvas.
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { CanvasHost } from '../src/host.ts'
import { TldrawRemote } from '../src/remote.ts'

const dir = await mkdtemp(join(tmpdir(), 'pi-tldraw-live-'))
const statePath = join(dir, 'canvas.json')
const browser = await chromium.launch({ args: ['--no-sandbox'] })
let host = new CanvasHost({ remote: new TldrawRemote(process.env.TLDRAW_MCP_URL), statePath })
try {
  await host.start()
  const page = await browser.newPage()
  page.on('response', async response => { if (response.status() >= 400) console.error('HTTP error:', response.url(), response.status(), (await response.text()).slice(0, 1000)) })
  page.on('pageerror', error => console.error('Browser error:', error.message))
  page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text().slice(0, 1000)) })
  await page.goto(host.url)
  await page.getByText('Ready · shared with Pi').waitFor({ timeout: 60_000 })
  const search = await host.search('return Object.keys(spec)')
  assert.ok(!search.isError, JSON.stringify(search))
  console.log('API discovery passed')
  // Tests protocol execution, not visual layout; a single isolated shape.
  const created = await host.exec("editor.createShape({ _type: 'rectangle', shapeId: 'live-test', x: 100, y: 100, w: 240, h: 120, text: 'Pi test' }); return editor.getCurrentPageShapes()")
  assert.ok(!created.isError, JSON.stringify(created))
  assert.match(JSON.stringify(created), /Pi test/)
  console.log('Create/read passed')
  const edited = await host.exec("editor.updateShape({ shapeId: 'live-test', text: 'Updated' }); return editor.getCurrentPageShapes()")
  assert.ok(!edited.isError, JSON.stringify(edited))
  assert.match(JSON.stringify(edited), /Updated/)
  console.log('Edit passed')
  await page.waitForTimeout(3000)
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.ok(saved.checkpoint?.shapesJson.includes('Updated'))
  assert.ok(host.modelContext.includes('Updated'))
  console.log('Checkpoint and app context passed')
  await page.close()
  await host.close()
  host = await new CanvasHost({ remote: new TldrawRemote(process.env.TLDRAW_MCP_URL), statePath }).start()
  const resumed = await browser.newPage()
  await resumed.goto(host.url)
  await resumed.getByText('Ready · shared with Pi').waitFor({ timeout: 60_000 })
  const restored = await host.exec('return editor.getCurrentPageShapes()')
  assert.match(JSON.stringify(restored), /Updated/)
  console.log('Restore across host/remote restart passed')
  // Draw through the actual editor UI, rather than issuing another agent mutation.
  const canvas = resumed.frameLocator('#canvas').locator('.tl-canvas')
  await canvas.waitFor()
  const bounds = await canvas.boundingBox()
  assert.ok(bounds)
  await canvas.click({ position: { x: 40, y: 40 } })
  await resumed.keyboard.press('d')
  await resumed.mouse.move(bounds.x + 50, bounds.y + 70)
  await resumed.mouse.down()
  await resumed.mouse.move(bounds.x + 90, bounds.y + 90, { steps: 4 })
  await resumed.mouse.move(bounds.x + 130, bounds.y + 60, { steps: 4 })
  await resumed.mouse.up()
  const sketch = await host.exec('return editor.getCurrentPageShapes()')
  assert.match(JSON.stringify(sketch), /draw/)
  console.log('Manual freehand sketch → agent feedback passed')
  const deleted = await host.exec("editor.deleteShapes(['live-test']); return editor.getCurrentPageShapes()")
  assert.ok(!deleted.isError, JSON.stringify(deleted))
  assert.doesNotMatch(JSON.stringify(deleted), /Updated/)
  console.log('Delete passed')
} finally {
  await browser.close()
  await host.close()
  await rm(dir, { recursive: true, force: true })
}
