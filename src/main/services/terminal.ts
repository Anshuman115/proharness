import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch'
import type {
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent
} from '@shared/types'

const require = createRequire(__filename)

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string | undefined>
    }
  ) => IPty
}

interface TerminalSession {
  id: string
  mode: 'pty' | 'pipe'
  shell: string
  pty?: IPty
  child?: ChildProcessWithoutNullStreams
  disposed: boolean
}

export class TerminalService {
  private sessions = new Map<string, TerminalSession>()
  private emitData: (event: TerminalDataEvent) => void = () => undefined
  private emitExit: (event: TerminalExitEvent) => void = () => undefined
  private ptyModule: PtyModule | null = null
  private ptyLoadError: string | null = null

  constructor(
    private readonly workspace: () => string,
    private readonly defaultShell: () => string
  ) {
    const candidates = ['@homebridge/node-pty-prebuilt-multiarch', 'node-pty']
    for (const candidate of candidates) {
      try {
        this.ptyModule = require(candidate) as PtyModule
        this.ptyLoadError = null
        break
      } catch (error) {
        this.ptyLoadError = `${candidate}: ${(error as Error).message}`
      }
    }
  }

  setEmitter(
    onData: (event: TerminalDataEvent) => void,
    onExit: (event: TerminalExitEvent) => void
  ): void {
    this.emitData = onData
    this.emitExit = onExit
  }

  get available(): boolean {
    return Boolean(this.ptyModule)
  }

  get loadError(): string | null {
    return this.ptyLoadError
  }

  create(input: TerminalCreateInput): TerminalCreateResult {
    if (this.sessions.has(input.id)) this.kill(input.id)
    const workspace = resolve(this.workspace())
    const requested = resolve(workspace, input.cwd || '.')
    if (requested !== workspace && !requested.startsWith(`${workspace}${sep}`)) {
      throw new Error('The terminal must run inside the current workspace.')
    }
    const cwd = requested
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error('Terminal working directory does not exist.')
    }
    const shell = input.shell || this.defaultShell() || '/bin/bash'
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROHARNESS_TERMINAL: '1'
    }

    if (this.ptyModule) {
      try {
        const pty = this.ptyModule.spawn(shell, [], {
          name: 'xterm-256color',
          cols: Math.max(20, input.cols || 100),
          rows: Math.max(5, input.rows || 30),
          cwd,
          env
        })
        const session: TerminalSession = {
          id: input.id,
          mode: 'pty',
          shell,
          pty,
          disposed: false
        }
        this.sessions.set(input.id, session)
        pty.onData((data) => {
          if (!session.disposed) this.emitData({ id: input.id, data })
        })
        pty.onExit(({ exitCode, signal }) => {
          if (session.disposed) return
          session.disposed = true
          this.sessions.delete(input.id)
          this.emitExit({ id: input.id, exitCode, signal: signal ? String(signal) : null })
        })
        return { id: input.id, shell, cwd, mode: 'pty', warning: null }
      } catch (error) {
        this.ptyLoadError = (error as Error).message
      }
    }

    const child = spawn(shell, ['-i'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const session: TerminalSession = {
      id: input.id,
      mode: 'pipe',
      shell,
      child,
      disposed: false
    }
    this.sessions.set(input.id, session)
    child.stdout.on('data', (data: Buffer) => {
      if (!session.disposed) this.emitData({ id: input.id, data: data.toString('utf8') })
    })
    child.stderr.on('data', (data: Buffer) => {
      if (!session.disposed) this.emitData({ id: input.id, data: data.toString('utf8') })
    })
    child.on('exit', (code, signal) => {
      if (session.disposed) return
      session.disposed = true
      this.sessions.delete(input.id)
      this.emitExit({ id: input.id, exitCode: code, signal })
    })
    child.on('error', (error) => {
      if (!session.disposed) {
        this.emitData({ id: input.id, data: `\r\n[terminal error] ${error.message}\r\n` })
      }
    })

    return {
      id: input.id,
      shell,
      cwd,
      mode: 'pipe',
      warning: `PTY unavailable (${this.ptyLoadError || 'native module not loaded'}). Running in pipe mode; interactive full-screen programs will not work.`
    }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.pty) session.pty.write(data)
    else session.child?.stdin.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session?.pty) return
    try {
      session.pty.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    } catch {
      // The process may have exited between the event and the resize.
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.disposed = true
    this.sessions.delete(id)
    if (session.pty) {
      try {
        session.pty.kill()
      } catch {
        // Already gone.
      }
      return
    }
    if (session.child) {
      try {
        session.child.kill('SIGTERM')
        setTimeout(() => {
          if (!session.child?.killed) session.child?.kill('SIGKILL')
        }, 800).unref()
      } catch {
        // Already gone.
      }
    }
  }

  dispose(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
  }
}
