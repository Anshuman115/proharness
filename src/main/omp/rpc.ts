import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * Minimal client for `omp --mode rpc`: newline-delimited JSON over stdio.
 * Protocol reference: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
 */

export type Frame = Record<string, unknown> & { type: string }

/** Rejects `request()` calls that receive no response within this window. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

interface RpcSpawnOptions {
  /** Spawns the child; may resolve asynchronously. */
  spawnChild: () => ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams>
}

interface Pending {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  command: string
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string
  ) {
    super(message)
  }
}

interface ChunkState {
  chunkId: string
  count: number
  byteLength: number
  parts: Buffer[]
}

/** Reassembles protocol v2 `rpc_chunk` sequences into one logical frame. */
export class FrameDecoder {
  private chunk: ChunkState | null = null

  push(frame: Frame): Frame | null {
    if (frame.type !== 'rpc_chunk') {
      if (this.chunk) this.chunk = null
      return frame
    }
    const chunkId = String(frame.chunkId)
    const index = Number(frame.index)
    const count = Number(frame.count)
    const byteLength = Number(frame.byteLength)
    if (index === 0) this.chunk = { chunkId, count, byteLength, parts: [] }
    const state = this.chunk
    if (!state || state.chunkId !== chunkId || state.parts.length !== index || count !== state.count) {
      this.chunk = null
      throw new Error('Interrupted rpc_chunk sequence')
    }
    state.parts.push(Buffer.from(String(frame.data), 'base64'))
    if (state.parts.length < state.count) return null
    this.chunk = null
    const bytes = Buffer.concat(state.parts)
    if (bytes.length !== state.byteLength) throw new Error('rpc_chunk length mismatch')
    return JSON.parse(bytes.toString('utf8')) as Frame
  }
}

/** Splits a byte stream into complete lines without breaking UTF-8 sequences. */
export class LineSplitter {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const lines: string[] = []
    let start = 0
    for (let i = 0; i < this.buffer.length; i += 1) {
      if (this.buffer[i] === 0x0a) {
        const line = this.buffer.subarray(start, i).toString('utf8').trim()
        if (line) lines.push(line)
        start = i + 1
      }
    }
    this.buffer = start ? this.buffer.subarray(start) : this.buffer
    return lines
  }
}

let requestCounter = 0
const liveChildren = new Set<ChildProcessWithoutNullStreams>()
let exitHookInstalled = false

/** Kills every omp child when this process exits, even on an unclean quit. */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  })
}

export class OmpRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private splitter = new LineSplitter()
  private decoder = new FrameDecoder()
  private stderrTail = ''
  private starting: Promise<void> | null = null
  private closing = false
  private readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private exited = false

  constructor(private readonly options: RpcSpawnOptions) {
    super()
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Avoid unhandled rejections when nobody awaits start().
    this.readyPromise.catch(() => undefined)
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.exited
  }

  start(readyTimeoutMs = 60_000): Promise<void> {
    if (this.starting) return this.starting
    if (this.closing) {
      this.starting = Promise.reject(new Error('omp start was cancelled.'))
      this.starting.catch(() => undefined)
      return this.starting
    }
    this.starting = this.begin(readyTimeoutMs)
    return this.starting
  }

  private async begin(readyTimeoutMs: number): Promise<void> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = await this.options.spawnChild()
    } catch (error) {
      this.exited = true
      const message = (error as Error).message
      this.rejectReady(new Error(message))
      this.emit('exit', { code: null, signal: null, error: message })
      throw error
    }
    if (this.closing) {
      installExitHook()
      this.child = child
      liveChildren.add(child)
      child.once('exit', () => {
        liveChildren.delete(child)
        this.exited = true
      })
      // A spawn error here means the late child will never run; drop it from
      // the exit hook without emitting 'exit' (the caller asked to close).
      child.on('error', () => {
        liveChildren.delete(child)
        this.exited = true
      })
      const error = new Error('omp start was cancelled.')
      this.rejectReady(error)
      this.kill()
      throw error
    }
    this.child = child
    installExitHook()
    liveChildren.add(child)
    child.once('exit', () => liveChildren.delete(child))
    const readyTimer = setTimeout(() => {
      this.rejectReady(new Error(`omp did not become ready within ${Math.round(readyTimeoutMs / 1000)}s.${this.stderrHint()}`))
      this.kill()
    }, readyTimeoutMs)
    readyTimer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.splitter.push(chunk)) this.handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-6_000)
    })
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => {
      clearTimeout(readyTimer)
      this.exited = true
      liveChildren.delete(child)
      this.rejectReady(new Error(error.message))
      this.failAll(new Error(error.message))
      this.emit('exit', { code: null, signal: null, error: error.message })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer)
      this.exited = true
      const reason = `omp exited (${signal || `code ${code}`}).${this.stderrHint()}`
      this.rejectReady(new Error(reason))
      this.failAll(new Error(reason))
      this.emit('exit', { code, signal, error: code === 0 ? null : reason })
    })
    this.once('ready', () => clearTimeout(readyTimer))
    return this.readyPromise
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim().split('\n').slice(-4).join(' ').trim()
    return tail ? ` ${tail.slice(0, 600)}` : ''
  }

  private handleLine(line: string): void {
    let raw: Frame
    try {
      raw = JSON.parse(line) as Frame
    } catch {
      return
    }
    let frame: Frame | null
    try {
      frame = this.decoder.push(raw)
    } catch (error) {
      this.emit('frame', { type: 'notice', level: 'error', message: (error as Error).message })
      return
    }
    if (!frame) return

    if (frame.type === 'ready') {
      const versions = frame.supportedProtocolVersions as number[] | undefined
      if (Array.isArray(versions) && versions.includes(2)) {
        this.write({ id: this.nextId(), type: 'negotiate_protocol', protocolVersion: 2 })
      }
      this.emit('ready', frame)
      this.resolveReady()
      return
    }

    if (frame.type === 'response' && typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (frame.success) pending.resolve(frame.data)
      else
        pending.reject(
          new RpcError(String(frame.error || `${pending.command} failed`), pending.command, frame.code as string | undefined)
        )
      // Prompt responses are also interesting to listeners (late failures).
      if (pending.command !== 'prompt') return
    }

    this.emit('frame', frame)
  }

  private nextId(): string {
    requestCounter += 1
    return `ph-${process.pid}-${requestCounter}`
  }

  write(frame: Record<string, unknown>): void {
    if (!this.child || this.exited) return
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  /** Sends a command and resolves with its `data` payload. */
  request<T = unknown>(
    command: Record<string, unknown> & { type: string },
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> & { id: string } {
    const id = typeof command.id === 'string' ? command.id : this.nextId()
    let pendingRef: Pending | null = null
    const promise = new Promise<T>((resolve, reject) => {
      if (!this.child || this.exited) {
        reject(new RpcError('omp is not running.', command.type))
        return
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new RpcError(`omp did not answer "${command.type}" in time.`, command.type))
            }, timeoutMs)
          : null
      timer?.unref()
      pendingRef = { resolve: resolve as (data: unknown) => void, reject, timer, command: command.type }
      this.pending.set(id, pendingRef)
      this.write({ ...command, id })
    }) as Promise<T> & { id: string }
    promise.id = id
    return promise
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new RpcError(error.message, pending.command))
    }
    this.pending.clear()
  }

  /** Closes stdin so omp drains and exits; kills it if it lingers. */
  async close(graceMs = 4_000): Promise<void> {
    this.closing = true
    if (!this.child) {
      // A start may still be spawning; let it see the closing flag and kill the child.
      if (this.starting) await this.starting.catch(() => undefined)
      return
    }
    const child = this.child
    if (this.exited) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.kill()
        resolve()
      }, graceMs)
      timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.stdin.end()
      } catch {
        this.kill()
      }
    })
  }

  kill(): void {
    if (!this.child || this.exited) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // Already gone.
    }
    const child = this.child
    setTimeout(() => {
      if (!this.exited) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }, 2_000).unref()
  }
}
