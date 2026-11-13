import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export const DEFAULT_ENDPOINT = 'https://tldraw-mcp-app.tldraw.workers.dev/mcp'

export interface Remote {
  connect(): Promise<void>
  widget(): Promise<string>
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>
  close(): Promise<void>
}

/** One MCP connection shared by the model and widget callbacks. Never retry mutations. */
export class TldrawRemote implements Remote {
  private client = new Client({ name: 'pi-tldraw', version: '0.1.1' }, {
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
  })
  private connecting?: Promise<void>
  private resourceUri?: string

  constructor(private endpoint = DEFAULT_ENDPOINT) {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('TLDRAW_MCP_URL must use HTTPS (or HTTP on loopback).')
    }
  }

  connect(): Promise<void> {
    if (!this.connecting) {
      const attempt = this.client.connect(new StreamableHTTPClientTransport(new URL(this.endpoint)), {
        timeout: 20_000,
      }).then(async () => {
        const { tools } = await this.client.listTools({}, { timeout: 20_000 })
        const exec = tools.find(t => t.name === 'exec')
        const meta = exec?._meta as { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string } | undefined
        this.resourceUri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
        if (!this.resourceUri) throw new Error('This MCP server does not expose a tldraw exec app resource.')
      })
      this.connecting = attempt
      void attempt.catch(() => { if (this.connecting === attempt) this.connecting = undefined })
    }
    return this.connecting
  }

  async widget(): Promise<string> {
    await this.connect()
    const resource = await this.client.readResource({ uri: this.resourceUri! }, { timeout: 30_000 })
    const html = resource.contents.find(c => 'text' in c)?.text
    if (typeof html !== 'string') throw new Error('tldraw returned no HTML app resource.')
    return html
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    await this.connect()
    return await this.client.callTool({ name, arguments: args }, undefined, {
      signal, timeout: 90_000,
    }) as CallToolResult
  }

  async close() { await this.client.close() }
}
