import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { CanvasHost } from '../src/host.ts'
import type { Remote } from '../src/remote.ts'

// Model the upstream app's 600px inline height and its fullscreen class. No network.
const widget = `<!doctype html><html><head><style>
html,body,#root{height:100%;margin:0}
.mcp-app__canvas-layout{display:flex;flex-direction:column;height:600px;gap:8px}
.mcp-app__canvas-layout--fullscreen{position:fixed;inset:0}
.mcp-app__canvas-surface{height:600px;position:relative}
.mcp-app__canvas-surface--fullscreen{flex:1;min-height:0}
.tl-canvas{position:absolute;inset:0}
</style></head><body><div id="root"><div class="mcp-app__canvas-layout"><div class="mcp-app__canvas-surface"><div class="tl-canvas"></div></div></div></div>
<script>
window.contextUpdates=[];window.modeReplies=[];
const send=(method,params,id)=>parent.postMessage({jsonrpc:'2.0',method,params,...(id===undefined?{}:{id})},'*');
function apply(context){window.context=context;window.contextUpdates.push(context);const full=context.displayMode==='fullscreen';document.querySelector('.mcp-app__canvas-layout').classList.toggle('mcp-app__canvas-layout--fullscreen',full);document.querySelector('.mcp-app__canvas-surface').classList.toggle('mcp-app__canvas-surface--fullscreen',full)}
window.addEventListener('message',event=>{const m=event.data;if(m.id==='initialize'&&m.result){apply(m.result.hostContext);send('ui/notifications/initialized',{})}else if(m.method==='ui/notifications/host-context-changed'){apply(m.params)}else if(m.id==='mode'){window.modeReplies.push(m)}});
window.requestMode=mode=>send('ui/request-display-mode',{mode},'mode');
window.requestSize=()=>send('ui/notifications/size-changed',{width:400,height:600});
send('ui/initialize',{protocolVersion:'2026-01-26'},'initialize');
</script></body></html>`

async function assertFillsPane(page: Page) {
  const iframe = await page.locator('#canvas').boundingBox()
  const canvas = await page.frameLocator('#canvas').locator('.tl-canvas').boundingBox()
  assert.ok(iframe && canvas)
  assert.ok(Math.abs(canvas.height - iframe.height) <= 2, `Canvas ${canvas.height}px does not fill iframe ${iframe.height}px`)
  assert.ok(Math.abs(canvas.width - iframe.width) <= 2, `Canvas ${canvas.width}px does not fill iframe ${iframe.width}px`)
  const header = await page.locator('header').boundingBox()
  const viewport = page.viewportSize()!
  assert.ok(header)
  assert.ok(Math.abs(iframe.height + header.height - viewport.height) <= 2)
}

test('dedicated canvas fills tall/short panes and follows element resizes and display modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tldraw-layout-'))
  const remote: Remote = { connect: async () => {}, widget: async () => widget, call: async () => ({ content: [] }), close: async () => {} }
  const host = new CanvasHost({ remote, statePath: join(dir, 'canvas.json') })
  let browser: Browser | undefined
  try {
    await host.start()
    browser = await chromium.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 900, height: 1400 } })
    await page.goto(host.url)
    await page.getByText('Ready · shared with Pi').waitFor()
    await assertFillsPane(page)
    const frame = page.frames().find(f => f.url().includes('/widget/'))!
    assert.equal(await frame.evaluate(() => (window as any).context.displayMode), 'fullscreen')

    for (const height of [780, 480, 1600]) {
      await page.setViewportSize({ width: 900, height })
      await page.waitForFunction(() => document.querySelector('#canvas')!.clientHeight === innerHeight - 48)
      await frame.waitForFunction(expected => (window as any).context.containerDimensions.height === expected, height - 48)
      await assertFillsPane(page)
    }
    // Sidebar/container width changes need not emit window.resize.
    await page.locator('#canvas').evaluate(element => { (element as HTMLElement).style.width = '620px' })
    await frame.waitForFunction(() => (window as any).context.containerDimensions.width === 620)
    await assertFillsPane(page)

    for (const mode of ['inline', 'fullscreen']) {
      await frame.evaluate(mode => (window as any).requestMode(mode), mode)
      await frame.waitForFunction(mode => (window as any).context.displayMode === mode, mode)
      assert.equal(await frame.evaluate(() => (window as any).modeReplies.at(-1).result.mode), mode)
      await assertFillsPane(page)
    }
    const updates = await frame.evaluate(() => (window as any).contextUpdates.length)
    await frame.evaluate(() => { for (let i = 0; i < 10; i++) (window as any).requestSize() })
    await page.waitForTimeout(100)
    await assertFillsPane(page)
    assert.ok(await frame.evaluate(() => (window as any).contextUpdates.length) <= updates + 1, 'Repeated app size hints caused a resize feedback loop')
    await frame.evaluate(() => (window as any).requestMode('pip'))
    await frame.waitForFunction(() => (window as any).modeReplies.at(-1).error)
    await assertFillsPane(page)
  } finally {
    await browser?.close()
    await host.close()
    await rm(dir, { recursive: true, force: true })
  }
})
