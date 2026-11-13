// Small MCP Apps host subset. The opaque sandbox can only reach these explicitly handled methods.
const token = location.hash.slice(1)
const frame = document.querySelector('#canvas')
const status = document.querySelector('#status')
const errorBox = document.querySelector('#error')
document.querySelector('#reload').onclick = () => location.reload()
let initialized = false
let widgetLoaded = false

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error((await res.text()).slice(0, 1000))
  return res.json()
}
function showError(error) {
  status.textContent = 'Disconnected'
  errorBox.hidden = false
  errorBox.textContent = String(error)
}
function send(message) { frame.contentWindow.postMessage({ jsonrpc: '2.0', ...message }, '*') }
function notify(method, params) { send({ method, params }) }

const hostContext = () => ({
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web',
  containerDimensions: { width: frame.clientWidth, height: frame.clientHeight },
})

window.addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || !widgetLoaded) return
  const message = event.data
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return
  const { id, method, params = {} } = message
  const reply = result => { if (id !== undefined) send({ id, result }) }
  try {
    switch (method) {
      case 'ui/initialize':
        reply({
          protocolVersion: params.protocolVersion,
          hostInfo: { name: 'pi-tldraw', version: '0.1.0' },
          hostCapabilities: { serverTools: {}, updateModelContext: {}, message: { text: {} }, downloadFile: {} },
          hostContext: hostContext(),
        })
        break
      case 'ui/notifications/initialized':
        initialized = true
        await api('ready', {})
        status.textContent = 'Ready · shared with Pi'
        break
      case 'tools/call':
        reply(await api('tool', params))
        break
      case 'ui/update-model-context':
        await api('context', params)
        reply({})
        break
      case 'ui/message': {
        const text = (params.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
        if (!text) throw new Error('Only text messages are supported')
        await api('message', { text })
        reply({})
        break
      }
      case 'ui/request-display-mode': reply({ mode: 'inline' }); break
      case 'ui/notifications/size-changed': break // Canvas fills the available pane.
      case 'ui/download-file': {
        for (const item of params.contents ?? []) {
          const bytes = item.blob ? Uint8Array.from(atob(item.blob), c => c.charCodeAt(0)) : item.text ?? ''
          const url = URL.createObjectURL(new Blob([bytes], { type: item.mimeType ?? 'application/octet-stream' }))
          const a = document.createElement('a')
          a.href = url; a.download = item.name ?? 'tldraw-export'; a.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
        reply({})
        break
      }
      case 'ping': reply({}); break
      default:
        if (id !== undefined) send({ id, error: { code: -32601, message: `Unsupported app method: ${method}` } })
    }
  } catch (error) {
    if (id !== undefined) send({ id, error: { code: -32603, message: String(error) } })
  }
})

window.addEventListener('resize', () => {
  if (initialized) notify('ui/notifications/host-context-changed', hostContext())
})

async function start() {
  if (!token) throw new Error('Open the full URL from Pi, including its #fragment.')
  // Establish the event stream before loading the app, so "ready" can never race connection setup.
  const res = await fetch('/api/events', { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok || !res.body) throw new Error(await res.text())
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const pumping = (async () => {
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('Pi closed the canvas connection. Reopen it from Pi after /reload.')
      buffer += value
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const line = event.split('\n').find(l => l.startsWith('data: '))
        if (line) { const data = JSON.parse(line.slice(6)); notify(data.method, data.params) }
      }
    }
  })()
  void pumping.catch(showError)
  const widget = await api('widget')
  widgetLoaded = true
  frame.src = widget.url
}
void start().catch(showError)
