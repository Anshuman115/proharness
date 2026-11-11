import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Finds the omp binary: explicit setting, then PATH, then common install dirs. */
export function findOmp(explicit: string, env: NodeJS.ProcessEnv): string | null {
  if (explicit.trim()) {
    const path = explicit.trim().replace(/^~(?=\/)/, homedir())
    return existsSync(path) ? path : null
  }
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'omp')
    if (isExecutable(candidate)) return candidate
  }
  for (const candidate of [
    join(homedir(), '.local', 'bin', 'omp'),
    join(homedir(), '.bun', 'bin', 'omp'),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp'
  ]) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function ompVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 20_000, env, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const match = stdout.match(/omp\/([\w.+-]+)/) || stdout.match(/(\d+\.\d+\.\d+[\w.+-]*)/)
      resolve(match ? match[1] : stdout.trim().slice(0, 40) || null)
    })
  })
}
