import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Remote } from './remote.ts'

const APP_TOOLS = new Set(['_exec_callback', 'save_checkpoint', 'read_checkpoint', '_get_canvas_state'])
const MAX_BODY = 20 * 1024 * 1024

type Checkpoint = { checkpointId: string; shapesJson: string; assetsJson?: string; bindingsJson?: string }
type Saved = { canvasId: string; checkpoint?: Checkpoint }
export type HostOptions = {
  remote: Remote
  statePath: string
  port?: number
  onMessage?: (text: string) => void
}

/** A capability-protected loopback host; the sandbox never receives its capability token. */
export class CanvasHost {
  private token = randomBytes(32).toString('hex')
  private widgetToken = randomBytes(32).toString('hex')
  private widgetHtml?: string
  private widgetScripts: string[] = []
  private server = createServer((req, res) => { void this.route(req, res).catch(error => {
    if (!res.headersSent) this.json(res, { error: String(error) }, 400)
    else res.end()
  }) })
  private stream?: ServerResponse
  private ready = false
  private origin = ''
  private saved: Saved = { canvasId: randomUUID() }
  private writes = Promise.resolve()
  private context = ''
  private lastCallback?: { key: string; resolve: (result: Record<string, unknown>) => void }
  private checkpointSaved?: () => void
  private closed = false

  constructor(private options: HostOptions) {}

  get url() { return `${this.origin}/#${this.token}` }
  get connected() { return !!this.stream && this.ready }
  get canvasId() { return this.saved.canvasId }
  get modelContext() { return this.context }

  async start() {
    try {
      const saved = JSON.parse(await readFile(this.options.statePath, 'utf8')) as Saved
      if (typeof saved.canvasId !== 'string') throw new Error('Invalid canvas state')
      this.saved = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('No listening address')
    this.origin = `http://127.0.0.1:${address.port}`
    return this
  }

  private json(res: ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }

  private emit(method: string, params: unknown) {
    this.stream?.write(`data: ${JSON.stringify({ method, params })}\n\n`)
  }

  private async body(req: IncomingMessage) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) throw new Error('Request exceeds 20 MiB')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  private async persist() {
    const text = JSON.stringify(this.saved)
    const path = this.options.statePath
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(`${path}.tmp`, text, { mode: 0o600 })
      await rename(`${path}.tmp`, path)
    })
    await this.writes
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    // Host validation blocks DNS rebinding; no CORS, and no credentials in query strings.
    if (req.headers.host !== new URL(this.origin).host) return this.json(res, { error: 'Invalid host' }, 403)
    if (req.headers.origin && req.headers.origin !== this.origin && !(req.headers.origin === 'null' && req.method === 'GET' && req.url?.startsWith(`/widget/${this.widgetToken}/`))) return this.json(res, { error: 'Invalid origin' }, 403)
    const path = req.url
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'" })
      return res.end(await readFile(new URL('../assets/host.html', import.meta.url), 'utf8'))
    }
    if (req.method === 'GET' && path === '/host.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(await readFile(new URL('../assets/host.js', import.meta.url), 'utf8'))
    }
    const scriptIndex = new RegExp(`^/widget/${this.widgetToken}/(\\d+)\\.js$`).exec(path ?? '')?.[1]
    if (req.method === 'GET' && scriptIndex !== undefined && this.widgetScripts[Number(scriptIndex)] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      return res.end(this.widgetScripts[Number(scriptIndex)])
    }
    if (req.method === 'GET' && path === `/widget/${this.widgetToken}` && this.widgetHtml) {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src ${this.origin}/widget/${this.widgetToken}/ 'unsafe-eval' blob:; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data: blob: https:; font-src data: https://cdn.tldraw.com https://fonts.gstatic.com; connect-src ${this.origin}/widget/${this.widgetToken}/ https://cdn.tldraw.com; frame-ancestors 'self'` })
      return res.end(this.widgetHtml)
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.json(res, { error: 'Unauthorized' }, 401)
    if (path === '/api/widget' && req.method === 'GET') {
      let html = await this.options.remote.widget()
      const cp = this.saved.checkpoint
      const restore = { canvasId: this.canvasId, ...(cp ? {
        checkpointId: cp.checkpointId,
        shapes: JSON.parse(cp.shapesJson), assets: JSON.parse(cp.assetsJson ?? '[]'), bindings: JSON.parse(cp.bindingsJson ?? '[]'),
      } : {}) }
      const encoded = Buffer.from(JSON.stringify(restore)).toString('base64')
      const headEnd = html.lastIndexOf('</head>')
      if (headEnd === -1) throw new Error('Widget has no closing head tag')
      html = html.slice(0, headEnd) + `<script>Object.assign(window.__TLDRAW_BOOTSTRAP__ || (window.__TLDRAW_BOOTSTRAP__={}),JSON.parse(atob('${encoded}')))</script>` + html.slice(headEnd)
      // Serve inline bundles as JS resources: minified template strings can contain HTML
      // comment/script delimiters that confuse the browser's inline-script parser.
      this.widgetScripts = []
      this.widgetHtml = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (_all, attrs: string, js: string) => {
        if (/\bsrc\s*=/i.test(attrs)) throw new Error('Unexpected external widget script')
        const index = this.widgetScripts.push(js) - 1
        return `<script${attrs} src="${this.origin}/widget/${this.widgetToken}/${index}.js" crossorigin="anonymous"></script>`
      })
      return this.json(res, { url: `/widget/${this.widgetToken}` })
    }
    if (path === '/api/events' && req.method === 'GET') {
      if (this.stream) return this.json(res, { error: 'Canvas already open in another tab. Close it first.' }, 409)
      this.stream = res
      this.ready = false
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n')
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
      res.on('close', () => {
        clearInterval(heartbeat)
        if (this.stream === res) { this.stream = undefined; this.ready = false }
      })
      return
    }
    if (path === '/api/ready' && req.method === 'POST') {
      this.ready = !!this.stream
      return this.json(res, {})
    }
    if (path === '/api/context' && req.method === 'POST') {
      const data = await this.body(req)
      this.context = JSON.stringify(data).slice(0, 48_000)
      return this.json(res, {})
    }
    if (path === '/api/message' && req.method === 'POST') {
      const data = await this.body(req)
      if (typeof data.text !== 'string' || data.text.length > 16_000) throw new Error('Invalid message')
      this.options.onMessage?.(data.text)
      return this.json(res, {})
    }
    if (path === '/api/tool' && req.method === 'POST') {
      const { name, arguments: args = {} } = await this.body(req)
      if (!APP_TOOLS.has(name)) throw new Error('App tool not allowed')
      if (name === '_exec_callback' && args.result && args.execKey === this.lastCallback?.key) this.lastCallback?.resolve(args.result)
      if (name === 'save_checkpoint') {
        if (typeof args.checkpointId !== 'string' || typeof args.shapesJson !== 'string') throw new Error('Invalid checkpoint')
        for (const key of ['shapesJson', 'assetsJson', 'bindingsJson']) {
          if (!Array.isArray(JSON.parse(args[key] ?? '[]'))) throw new Error(`Invalid ${key}`)
        }
        this.saved.checkpoint = { checkpointId: args.checkpointId, shapesJson: args.shapesJson, assetsJson: args.assetsJson, bindingsJson: args.bindingsJson }
        await this.persist()
        this.checkpointSaved?.()
      }
      return this.json(res, await this.options.remote.call(name, args))
    }
    this.json(res, { error: 'Not found' }, 404)
  }

  async search(code: string, signal?: AbortSignal) {
    return this.options.remote.call('search', { code }, signal)
  }

  /** Sequential: a widget's pending-exec channel is singular. Never silently replay an exec. */
  async exec(code: string, signal?: AbortSignal): Promise<CallToolResult> {
    if (!this.connected) throw new Error(`Open the canvas and wait until it is ready: ${this.url}`)
    signal?.throwIfAborted()
    if (this.lastCallback) throw new Error('Another canvas execution is in progress.')
    // Unique per invocation: late callbacks and widget deduplication must not match a later call.
    code = `/* pi-tldraw:${randomUUID()} */\n${code}`
    let callback: Record<string, unknown> | undefined
    const key = createHash('sha256').update(`${this.canvasId}\n${code}`).digest('hex').slice(0, 32)
    this.lastCallback = { key, resolve: result => { callback = result } }
    const checkpoint = new Promise<void>(resolve => { this.checkpointSaved = resolve })
    const args = { code, canvasId: this.canvasId }
    try {
      const pending = this.options.remote.call('exec', args, signal)
      this.emit('ui/notifications/tool-input', { arguments: args })
      const result = await pending
      this.emit('ui/notifications/tool-result', result)
      if (callback?.success) {
        // The widget sends its result before saving. Wait for the local checkpoint, not
        // the remote upload, so immediate shutdown/resume does not lose the last edit.
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([checkpoint, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
        finally { clearTimeout(timer) }
      }
      await this.persist()
      // Some server versions return "still executing". Do not report that as verified success.
      if (callback) {
        return {
          content: [{ type: 'text', text: JSON.stringify(callback) }],
          structuredContent: { canvasId: this.canvasId },
          ...(callback.success === false ? { isError: true } : {}),
        }
      }
      return { ...result, content: [...result.content, { type: 'text', text: 'Execution is not confirmed by the widget yet. Inspect the canvas before retrying; edits may already have applied.' }] }
    } catch (error) {
      this.emit('ui/notifications/tool-cancelled', { reason: 'Request ended; edits may already have applied.' })
      throw error
    } finally { this.lastCallback = undefined; this.checkpointSaved = undefined }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.stream?.end()
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
    await this.writes
    await this.options.remote.close()
  }
}
