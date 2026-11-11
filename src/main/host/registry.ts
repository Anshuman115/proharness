import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceHost } from './host'
import { LocalHost } from './local'
import { parseSshConfigHosts, SshHost } from './ssh'

/** One host per workspace, created on first use and reused afterwards. */
export class HostRegistry {
  readonly local: LocalHost
  private readonly ssh = new Map<string, SshHost>()

  constructor(private readonly localEnv: () => Promise<NodeJS.ProcessEnv>) {
    this.local = new LocalHost()
  }

  get(id: string): WorkspaceHost {
    const name = id.trim() || 'local'
    if (name === 'local') return this.local
    let host = this.ssh.get(name)
    if (!host) {
      host = new SshHost(name, this.localEnv)
      this.ssh.set(name, host)
    }
    return host
  }

  async connect(id: string): Promise<WorkspaceHost> {
    const host = this.get(id)
    if (host.kind === 'ssh') await (host as SshHost).connect()
    return host
  }

  /** Host aliases from ~/.ssh/config, without wildcards. */
  sshHosts(): string[] {
    let config: string
    try {
      config = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8')
    } catch {
      return []
    }
    return parseSshConfigHosts(config)
  }

  dispose(): void {
    for (const host of this.ssh.values()) host.dispose()
    this.ssh.clear()
    this.local.dispose()
  }
}
