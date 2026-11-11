import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix } from 'node:path'

/**
 * Where a workspace lives. Local workspaces use the Mac's filesystem and
 * processes; SSH workspaces run every operation on the remote host.
 * Paths passed to a host are always absolute paths on that host.
 */

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface ExecOptions {
  cwd?: string
  /** Bytes written to stdin, then closed. */
  input?: string | Buffer
  timeoutMs?: number
  maxBuffer?: number
  env?: Record<string, string>
}

export interface StatInfo {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface SpawnSpec {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

export interface WorkspaceHost {
  readonly kind: 'local' | 'ssh'
  /** "local" or the ssh destination, e.g. "devbox". */
  readonly id: string

  /** Runs a program (no shell) and resolves even on non-zero exit. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<Buffer>
  readText(path: string): Promise<string>
  /** Atomic write: temp file then rename. Creates parent directories. */
  writeText(path: string, content: string): Promise<void>
  appendText(path: string, content: string): Promise<void>
  mkdirp(path: string): Promise<void>
  /** null when the path does not exist. */
  stat(path: string): Promise<StatInfo | null>
  readdir(path: string): Promise<DirEntry[]>
  realpath(path: string): Promise<string>
  /** Spawns a long-lived child whose stdio is piped through to the host process. */
  spawn(spec: SpawnSpec): ChildProcessWithoutNullStreams
  /** Environment for programs on this host (login PATH etc.). Local only; ssh returns {}. */
  env(): Promise<NodeJS.ProcessEnv>
  /** Path helpers for this host's filesystem. */
  readonly path: typeof posix
  dispose(): void
}

/** Quotes one argument for a POSIX shell. */
export function shq(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function shellLine(command: string, args: string[]): string {
  return [command, ...args].map(shq).join(' ')
}

/** Resolves when `child` exits, collecting output. */
export function collect(
  child: ChildProcessWithoutNullStreams,
  options: { input?: string | Buffer; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<ExecResult> {
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: ExecResult | Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          finish(new Error(`Command timed out after ${Math.round((options.timeoutMs || 0) / 1000)}s.`))
        }, options.timeoutMs)
      : null
    timer?.unref()
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBuffer) {
        child.kill('SIGKILL')
        finish(new Error('Command output exceeded the buffer limit.'))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => finish(error))
    child.on('close', (code) =>
      finish({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? 1 })
    )
    child.stdin.on('error', () => undefined)
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export function spawnPiped(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  return spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
}
