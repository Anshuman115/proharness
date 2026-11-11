import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshHost } from '../host/ssh'

/** Where the broker bearer token lives on the remote host (mode 0600). */
export const REMOTE_TOKEN_PATH = '.omp/agent/secrets/proharness-broker.token'
/** omp's encrypted snapshot cache on the remote host, separate from any other broker use. */
export const REMOTE_SNAPSHOT_CACHE = '.cache/proharness/broker-snapshot.enc'

/**
 * Shell prefix that points a remote omp at the tunnelled broker. The token is
 * read from its file inside the remote shell so it never appears in argv.
 */
export function brokerEnvScript(port: number): string {
  return [
    `export OMP_AUTH_BROKER_URL=http://127.0.0.1:${port}`,
    `OMP_AUTH_BROKER_TOKEN="$(cat "$HOME/${REMOTE_TOKEN_PATH}")"`,
    `OMP_AUTH_BROKER_SNAPSHOT_CACHE="$HOME/${REMOTE_SNAPSHOT_CACHE}"`
  ].join(' ') + ';'
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('No free port.'))))
    })
  })
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/healthz`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Shares this Mac's omp logins with SSH hosts. Runs `omp auth-broker serve`
 * on loopback and forwards it into each host over the existing SSH control
 * connection. Model requests go straight from the host to the provider; the
 * broker only hands out short-lived access tokens and refreshes them.
 */
export class LoginShare {
  private broker: ChildProcess | null = null
  private port = 0
  private starting: Promise<number> | null = null
  private forwarded = new Map<string, number>()
  private log = ''

  constructor(
    private readonly ompPath: () => Promise<string>,
    private readonly env: () => Promise<NodeJS.ProcessEnv>
  ) {}

  get brokerPort(): number {
    return this.port
  }

  /** Starts the broker once and resolves with its port. */
  ensureBroker(): Promise<number> {
    if (this.port && this.broker && this.broker.exitCode === null) return Promise.resolve(this.port)
    if (this.starting) return this.starting
    this.starting = this.startBroker().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startBroker(): Promise<number> {
    const port = await freePort()
    const child = spawn(await this.ompPath(), ['auth-broker', 'serve', `--bind=127.0.0.1:${port}`], {
      env: await this.env(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const capture = (chunk: Buffer): void => {
      this.log = `${this.log}${chunk.toString('utf8')}`.slice(-4000)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('exit', () => {
      if (this.broker === child) {
        this.broker = null
        this.port = 0
        this.forwarded.clear()
      }
    })
    this.broker = child
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break
      if (await healthy(port)) {
        this.port = port
        return port
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    child.kill()
    throw new Error(`The omp auth broker did not start. ${this.log.trim().split('\n').pop() || ''}`.trim())
  }

  /**
   * Makes the broker reachable on the host at 127.0.0.1:<port> and installs
   * the bearer token there. Resolves with the remote port.
   */
  async attach(host: SshHost): Promise<number> {
    const port = await this.ensureBroker()
    // A reconnected control master drops its forwards, so re-check every time (one fast round trip).
    if (this.forwarded.get(host.id) === port && (await this.remoteHealthy(host, port))) return port
    this.forwarded.delete(host.id)
    const token = (await readFile(join(homedir(), '.omp', 'auth-broker.token'), 'utf8')).trim()
    if (!token) throw new Error('The omp auth broker has no token.')
    const install = await host.run(
      `umask 077; mkdir -p "$HOME/$(dirname ${REMOTE_TOKEN_PATH})" "$HOME/$(dirname ${REMOTE_SNAPSHOT_CACHE})" && cat > "$HOME/${REMOTE_TOKEN_PATH}"`,
      { input: token }
    )
    if (install.code !== 0) throw new Error(`Could not install the login token on ${host.id}: ${install.stderr.trim()}`)
    await host.forwardRemote(port, port)
    if (!(await this.remoteHealthy(host, port))) throw new Error(`The login tunnel to ${host.id} is not reachable.`)
    this.forwarded.set(host.id, port)
    return port
  }

  private async remoteHealthy(host: SshHost, port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}/v1/healthz`
    const check = await host
      .run(`curl -fsS -m 3 ${url} >/dev/null 2>&1 || wget -q -T 3 -O /dev/null ${url}`)
      .catch(() => null)
    return check?.code === 0
  }

  /** Drops the tunnel and the token from a host that no longer shares logins. */
  async detach(host: SshHost): Promise<void> {
    const port = this.forwarded.get(host.id)
    this.forwarded.delete(host.id)
    if (port) await host.cancelRemote(port, port).catch(() => undefined)
    await host.run(`rm -f "$HOME/${REMOTE_TOKEN_PATH}" "$HOME/${REMOTE_SNAPSHOT_CACHE}"`).catch(() => undefined)
  }

  isAttached(hostId: string): boolean {
    return this.forwarded.has(hostId) && this.forwarded.get(hostId) === this.port
  }

  dispose(): void {
    this.forwarded.clear()
    this.broker?.kill()
    this.broker = null
    this.port = 0
  }
}
