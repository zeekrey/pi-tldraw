// Test the actual distributable with only runtime dependencies, using Pi as the host.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'pi-tldraw-package-'))
let child
try {
  const npm = process.env.npm_execpath
  assert.ok(npm, 'Run this check via npm run test:package')
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }))[0]
  const paths = packed.files.map(file => file.path)
  for (const required of ['src/index.ts', 'src/host.ts', 'src/remote.ts', 'assets/host.html', 'assets/host.js', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md']) assert.ok(paths.includes(required), `Missing ${required}`)
  assert.ok(paths.every(path => /^(src\/|assets\/|package.json$|README.md$|LICENSE$|CHANGELOG.md$|SECURITY.md$)/.test(path)), 'Unexpected private or development file in tarball')
  execFileSync('tar', ['-xzf', join(scratch, packed.filename), '-C', scratch])
  const installed = join(scratch, 'package')
  execFileSync(process.execPath, [npm, 'install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: installed, stdio: 'inherit' })
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*')
  assert.equal(manifest.peerDependencies.typebox, '*')
  await mkdir(join(scratch, 'profile'))
  const cli = resolve(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
  child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-mcp', '--extension', installed], {
    cwd: scratch,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(scratch, 'profile'), TLDRAW_PORT: undefined, TLDRAW_MCP_URL: undefined },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi package smoke check timed out. ${stderr}`)), 30_000)
    const fail = error => { clearTimeout(timer); reject(error) }
    child.once('error', fail)
    child.once('exit', code => fail(new Error(`Pi exited early (${code}). ${stderr}`)))
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      const lines = output.split('\n')
      const records = lines.slice(0, -1).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
      const response = records.find(record => record.id === 'package-commands' && record.type === 'response')
      if (!response) return
      try {
        assert.equal(response.success, true, JSON.stringify(response))
        assert.ok(response.data.commands.some(command => command.name === 'tldraw'), `Extension failed to load: ${stderr}`)
        clearTimeout(timer)
        resolve()
      } catch (error) { fail(error) }
    })
    child.stdin.write(JSON.stringify({ id: 'package-commands', type: 'get_commands' }) + '\n')
  })
  // RPC EOF disposes the runtime. No model request or remote MCP request was made.
  child.stdin.end()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Pi did not shut down')) }, 10_000)
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Pi exit ${code}: ${stderr}`)) })
  })
  console.log(`Production tarball smoke check passed (${paths.length} files).`)
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  await rm(scratch, { recursive: true, force: true })
}
