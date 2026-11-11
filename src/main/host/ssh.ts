import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { collect, shellLine, shq, spawnPiped, type DirEntry, type ExecOptions, type ExecResult, type SpawnSpec, type StatInfo, type WorkspaceHost } from './host'

/**
 * Env for the local ssh client. macOS ssh forwards LANG/LC_* (SendEnv), and
 * servers without that locale print setlocale warnings, so drop them.
 */
export function sshClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'LANG' || key === 'LANGUAGE' || key.startsWith('LC_')) continue
    next[key] = value
  }
  return next
}

/** One multiplexed OpenSSH connection reused for every operation on a host. */
export class SshHost implements WorkspaceHost {
  readonly kind = 'ssh' as const
  readonly path = posix
  private readonly controlPath: string

  constructor(
    /** An ~/.ssh/config alias or user@host. */
    readonly id: string,
    private readonly localEnv: () => Promise<NodeJS.ProcessEnv>
  ) {
    // macOS caps unix socket paths at 104 bytes and $TMPDIR is long, so use
    // ~/.ssh (short, already private) for the control sockets.
    const dir = join(homedir(), '.ssh', 'ph')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.controlPath = join(dir, '%C')
  }

  get label(): string {
    return this.id
  }

  /** Options shared by every ssh invocation. */
  sshArgs(extra: string[] = []): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', 'ControlPersist=10m',
      '-o', 'LogLevel=ERROR',
      ...extra,
      this.id
    ]
  }

  /**
   * Wraps a command line so it runs in the remote login environment
   * (PATH from ~/.profile etc.) inside `cwd`. A quiet C.UTF-8 locale avoids
   * setlocale warnings on servers without the client's locale installed.
   */
  remoteScript(line: string, cwd?: string, env?: Record<string, string>): string {
    const exports = Object.entries(env || {})
      .map(([key, value]) => `export ${key}=${shq(value)}; `)
      .join('')
    const body = `${exports}${cwd ? `cd ${shq(cwd)} && ` : ''}${line}`
    return `export LC_ALL=C.UTF-8 LANG=C.UTF-8; exec "\${SHELL:-/bin/sh}" -lc ${shq(body)}`
  }

  private async local(): Promise<NodeJS.ProcessEnv> {
    return sshClientEnv(await this.localEnv())
  }

  async env(): Promise<NodeJS.ProcessEnv> {
    return {}
  }

  async run(line: string, options: ExecOptions = {}): Promise<ExecResult> {
    const child = spawnPiped('ssh', [...this.sshArgs(['-T']), this.remoteScript(line, options.cwd, options.env)], {
      env: await this.local()
    })
    const result = await collect(child, { input: options.input, timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: options.maxBuffer })
    if (result.code === 255 && /ssh:|Permission denied|Connection|Host key|Could not resolve/i.test(result.stderr)) {
      throw new Error(`SSH to ${this.id} failed: ${result.stderr.trim().split('\n').pop()}`)
    }
    return result
  }

  exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(shellLine(command, args), options)
  }

  private async must(line: string, what: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.run(line, options)
    if (result.code !== 0) throw new Error(`${what} failed on ${this.id}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`)
    return result
  }

  async readFile(path: string): Promise<Buffer> {
    const result = await this.must(`base64 < ${shq(path)}`, `Reading ${path}`, { maxBuffer: 64 * 1024 * 1024 })
    return Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64')
  }

  async readText(path: string): Promise<string> {
    return (await this.readFile(path)).toString('utf8')
  }

  async writeText(path: string, content: string): Promise<void> {
    const dir = posix.dirname(path)
    const tmp = `${path}.ph-${Date.now()}.tmp`
    await this.must(`mkdir -p ${shq(dir)} && cat > ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(path)}`, `Writing ${path}`, {
      input: content
    })
  }

  async appendText(path: string, content: string): Promise<void> {
    await this.must(`mkdir -p ${shq(posix.dirname(path))} && cat >> ${shq(path)}`, `Appending to ${path}`, { input: content })
  }

  async mkdirp(path: string): Promise<void> {
    await this.must(`mkdir -p ${shq(path)}`, `Creating ${path}`)
  }

  async stat(path: string): Promise<StatInfo | null> {
    const result = await this.run(`stat -L -c '%F|%s|%Y' -- ${shq(path)} 2>/dev/null`)
    if (result.code !== 0 || !result.stdout.trim()) return null
    const [type, size, mtime] = result.stdout.trim().split('|')
    return {
      isFile: type.startsWith('regular'),
      isDirectory: type === 'directory',
      size: Number(size) || 0,
      mtimeMs: (Number(mtime) || 0) * 1000
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const result = await this.must(
      `find ${shq(path)} -mindepth 1 -maxdepth 1 -printf '%y %f\\0'`,
      `Listing ${path}`
    )
    return result.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => ({ name: entry.slice(2), isDirectory: entry[0] === 'd' }))
  }

  async realpath(path: string): Promise<string> {
    const result = await this.must(`realpath -- ${shq(path)}`, `Resolving ${path}`)
    return result.stdout.trim()
  }

  /** Home directory on the remote host. */
  async home(): Promise<string> {
    const result = await this.must('printf %s "$HOME"', 'Reading $HOME')
    return result.stdout.trim()
  }

  spawn(spec: SpawnSpec): ChildProcessWithoutNullStreams {
    const line = shellLine(spec.command, spec.args)
    const ttyFlags = spec.tty ? ['-tt'] : ['-T']
    // ssh needs the env synchronously here; fall back to the parent env.
    return spawnPiped('ssh', [...this.sshArgs(ttyFlags), this.remoteScript(spec.tty ? line : `exec ${line}`, spec.cwd, spec.env)], {
      env: sshClientEnv({ ...process.env, ...this.cachedLocal })
    })
  }

  private cachedLocal: NodeJS.ProcessEnv = {}

  /** Opens (or reuses) the control connection and caches the local env for spawn(). */
  async connect(): Promise<void> {
    this.cachedLocal = await this.localEnv()
    await this.must('true', 'Connecting')
  }

  dispose(): void {
    const child = spawnPiped('ssh', ['-o', `ControlPath=${this.controlPath}`, '-O', 'exit', this.id], { env: process.env })
    child.on('error', () => undefined)
    child.stdin.end()
  }
}

/** Host aliases from ~/.ssh/config, without wildcards. */
export function parseSshConfigHosts(config: string): string[] {
  const hosts = new Set<string>()
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*Host\s+(.+)$/i)
    if (!match) continue
    for (const host of match[1].trim().split(/\s+/)) {
      if (!/[*?!]/.test(host)) hosts.add(host)
    }
  }
  return [...hosts]
}
