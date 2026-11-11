import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { shellEnv } from '../omp/env'
import {
  assertMaxBytes,
  collect,
  shellLine,
  shq,
  spawnPiped,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type SpawnSpec,
  type StatInfo,
  type TerminalLaunch,
  type WorkspaceHost
} from './host'

/**
 * Env for the local ssh client. macOS ssh forwards LANG/LC_* (SendEnv), and
 * servers without that locale print setlocale warnings, so drop them.
 */
function sshClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  readonly pollMs = { plan: 4_000, git: 5_000 }
  private readonly controlPath: string

  constructor(
    /** An ~/.ssh/config alias or user@host. */
    readonly id: string
  ) {
    // macOS caps unix socket paths at 104 bytes and $TMPDIR is long, so use
    // ~/.ssh (short, already private) for the control sockets.
    const dir = join(homedir(), '.ssh', 'ph')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.controlPath = join(dir, '%C')
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
    return sshClientEnv(await shellEnv())
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

  async readFile(path: string, maxBytes?: number): Promise<Buffer> {
    assertMaxBytes(maxBytes)
    const line =
      maxBytes === undefined
        ? `base64 < ${shq(path)}`
        : `t=$(mktemp "\${TMPDIR:-/tmp}/ph-read.XXXXXX") || exit 1; trap 'rm -f "$t"' EXIT; head -c ${maxBytes} ${shq(path)} > "$t" && base64 < "$t"`
    const result = await this.must(line, `Reading ${path}`, { maxBuffer: 64 * 1024 * 1024 })
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
    const result = await this.run(`stat -L -c '%F|%s|%Y' -- ${shq(path)}`)
    if (result.code !== 0) {
      if (/no such file|not found|not a directory/i.test(result.stderr)) return null
      throw new Error(`Could not read ${path} on ${this.id}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`)
    }
    const [type, size, mtime] = result.stdout.trim().split('|')
    if (!type) throw new Error(`Could not read ${path} on ${this.id}.`)
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

  async spawn(spec: SpawnSpec): Promise<ChildProcessWithoutNullStreams> {
    const line = `${spec.prelude ?? ''}exec ${shellLine(spec.command, spec.args)}`
    return spawnPiped('ssh', [...this.sshArgs(['-T']), this.remoteScript(line, spec.cwd, spec.env)], {
      env: await this.local()
    })
  }

  async terminal(cwd: string, _shell: string): Promise<TerminalLaunch> {
    const args = [...this.sshArgs(['-tt']), this.remoteScript('exec "${SHELL:-/bin/bash}" -l', cwd)]
    return {
      command: 'ssh',
      ptyArgs: args,
      pipeArgs: args,
      cwd: process.cwd(),
      env: {
        ...(await this.local()),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PROHARNESS_TERMINAL: '1'
      },
      shell: `ssh ${this.id}`
    }
  }

  private async control(args: string[]): Promise<void> {
    const child = spawnPiped('ssh', ['-o', `ControlPath=${this.controlPath}`, ...args, this.id], {
      env: sshClientEnv(await shellEnv())
    })
    const result = await collect(child, { timeoutMs: 15_000 })
    if (result.code !== 0) throw new Error(`ssh ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }

  /** Forwards remotePort on the host to localPort on this Mac over the control connection. */
  async forwardRemote(remotePort: number, localPort: number): Promise<void> {
    await this.connect()
    await this.control(['-O', 'forward', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`])
  }

  async cancelRemote(remotePort: number, localPort: number): Promise<void> {
    await this.control(['-O', 'cancel', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`])
  }

  /** Opens (or reuses) the control connection. */
  async connect(): Promise<void> {
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
