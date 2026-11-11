import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmpRpc } from '../src/main/omp/rpc'

type FakeChild = ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new EventEmitter() as never
  child.stderr = new EventEmitter() as never
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() }) as never
  child.kill = vi.fn() as never
  return child
}

afterEach(() => {
  vi.useRealTimers()
})

describe('OmpRpc start', () => {
  it('spawns once for concurrent starts', async () => {
    const child = fakeChild()
    const spawnChild = vi.fn(async () => child)
    const rpc = new OmpRpc({ spawnChild })
    const first = rpc.start(1_000)
    const second = rpc.start(1_000)
    expect(second).toBe(first)
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(child.stdout as unknown as EventEmitter).emit('data', Buffer.from(`${JSON.stringify({ type: 'ready' })}\n`))
    await expect(first).resolves.toBeUndefined()
    expect(spawnChild).toHaveBeenCalledTimes(1)
    const closing = rpc.close(50)
    child.emit('exit', 0, null)
    await closing
  })

  it('rejects start and emits exit when the async spawn rejects', async () => {
    const rpc = new OmpRpc({
      spawnChild: async () => {
        throw new Error('boom')
      }
    })
    const exits: Array<{ code: number | null; signal: string | null; error: string | null }> = []
    rpc.on('exit', (info: { code: number | null; signal: string | null; error: string | null }) => exits.push(info))
    await expect(rpc.start(1_000)).rejects.toThrow('boom')
    expect(rpc.alive).toBe(false)
    expect(exits).toEqual([{ code: null, signal: null, error: 'boom' }])
    await expect(rpc.close(10)).resolves.toBeUndefined()
  })

  it('kills the child when closed during an async start', async () => {
    const child = fakeChild()
    let release!: (value: ChildProcessWithoutNullStreams) => void
    const spawnChild = vi.fn(
      () =>
        new Promise<ChildProcessWithoutNullStreams>((resolve) => {
          release = resolve
        })
    )
    const rpc = new OmpRpc({ spawnChild })
    const started = rpc.start(1_000)
    const expectation = expect(started).rejects.toThrow(/cancelled/)
    const closing = rpc.close(50)
    release(child)
    await expectation
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', null, 'SIGTERM')
    await closing
  })

  it('rejects a pending start as soon as close runs, without waiting for the ready timer', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    let release!: (value: ChildProcessWithoutNullStreams) => void
    const rpc = new OmpRpc({
      spawnChild: () =>
        new Promise<ChildProcessWithoutNullStreams>((resolve) => {
          release = resolve
        })
    })
    const started = rpc.start(90_000)
    const rejection = expect(started).rejects.toThrow(/cancelled/)
    const closing = rpc.close(100)
    release(child)
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', null, 'SIGTERM')
    await closing
  })

  it('rejects a start that is waiting for ready as soon as close runs', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const started = rpc.start(90_000)
    await vi.advanceTimersByTimeAsync(0)
    const closing = rpc.close(100)
    await expect(started).rejects.toThrow(/cancelled/)
    child.emit('exit', 0, null)
    await closing
  })
})

describe('OmpRpc close during start', () => {
  it('rejects a start that begins after close without spawning', async () => {
    const spawnChild = vi.fn(async () => fakeChild())
    const rpc = new OmpRpc({ spawnChild })
    await rpc.close(10)
    await expect(rpc.start(100)).rejects.toThrow(/cancelled/)
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('returns the same close promise for concurrent close calls', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    child.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') child.emit('exit', null, 'SIGTERM')
    }) as never
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const first = rpc.close(50)
    const second = rpc.close(50)
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(0)
    await first
  })

  it('stays pending until the late child actually exits after SIGKILL', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    child.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') child.emit('exit', null, 'SIGKILL')
    }) as never
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const started = rpc.start(1_000)
    const rejection = expect(started).rejects.toThrow(/cancelled/)
    const closing = rpc.close(100)
    let closed = false
    void closing.then(() => {
      closed = true
    })
    await rejection
    await vi.advanceTimersByTimeAsync(100)
    expect(closed).toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await closing
    expect(closed).toBe(true)
  })

  it('rejects close with a bounded error when the child never dies', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const started = rpc.start(1_000)
    const rejection = expect(started).rejects.toThrow(/cancelled/)
    const closing = rpc.close(100)
    const closeExpectation = expect(closing).rejects.toThrow(/did not exit after SIGKILL/)
    await rejection
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await closeExpectation
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('fails pending requests when the child exits during close', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const started = rpc.start(1_000)
    started.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    const request = rpc.request({ type: 'ping' })
    const requestExpectation = expect(request).rejects.toThrow(/omp exited/)
    const closing = rpc.close(1_000)
    child.emit('exit', 1, null)
    await requestExpectation
    await closing
  })
})
