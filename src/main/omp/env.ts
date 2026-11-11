import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { shq, type WorkspaceHost } from '../host/host'

/**
 * GUI apps on macOS start with launchd's minimal PATH, so `omp`, `git`, and
 * the user's toolchains are invisible. Resolve the login-shell environment
 * once and reuse it for every child process.
 */

const MARKER = '__PROHARNESS_ENV__'
let cached: Promise<NodeJS.ProcessEnv> | null = null

function parseEnv(output: string): Record<string, string> {
  const start = output.indexOf(MARKER)
  const end = output.lastIndexOf(MARKER)
  if (start < 0 || end <= start) return {}
  const body = output.slice(start + MARKER.length, end)
  const env: Record<string, string> = {}
  for (const entry of body.split('\0')) {
    const index = entry.indexOf('=')
    if (index > 0) env[entry.slice(0, index).replace(/^\n/, '')] = entry.slice(index + 1)
  }
  return env
}

function fallbackPath(base: string | undefined): string {
  const home = homedir()
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]
  const parts = (base || '').split(delimiter).filter(Boolean)
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir)
  return parts.join(delimiter)
}

function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  // Inherited from Electron tooling; it would turn child Electron/Node apps into plain Node.
  delete next.ELECTRON_RUN_AS_NODE
  delete next.ELECTRON_NO_ATTACH_CONSOLE
  next.PATH = fallbackPath(next.PATH)
  return next
}

export function shellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached
  cached = new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const command = `printf '${MARKER}'; env -0; printf '${MARKER}'`
    execFile(
      shell,
      ['-ilc', command],
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const parsed = error && !stdout ? {} : parseEnv(stdout || '')
        resolve(cleanEnv({ ...process.env, ...parsed }))
      }
    )
  })
  return cached
}

/** Finds the omp binary: explicit setting (local only), then PATH, then common install dirs. */
export async function findOmp(host: WorkspaceHost, explicit: string): Promise<string | null> {
  if (host.kind === 'local' && explicit.trim()) {
    const path = explicit.trim().replace(/^~(?=\/)/, homedir())
    const check = await host.exec('sh', ['-c', `test -x ${shq(path)}`])
    return check.code === 0 ? path : null
  }
  const script = [
    'command -v omp 2>/dev/null',
    'for c in "$HOME/.local/bin/omp" "$HOME/.bun/bin/omp" /opt/homebrew/bin/omp /usr/local/bin/omp; do if [ -x "$c" ]; then printf "%s\\n" "$c"; break; fi; done'
  ].join('; ')
  const result = await host.exec('sh', ['-c', script])
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? null
}

export async function ompVersion(host: WorkspaceHost, path: string): Promise<string | null> {
  const result = await host.exec(path, ['--version'], { timeoutMs: 20_000 }).catch(() => null)
  if (!result || result.code !== 0) return null
  const match = result.stdout.match(/omp\/([\w.+-]+)/) || result.stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)/)
  return match ? match[1] : result.stdout.trim().slice(0, 40) || null
}
