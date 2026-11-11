import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { OmpRpc } from '../src/main/omp/rpc'

type FakeChild = ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new EventEmitter() as never
  child.stderr = new EventEmitter() as never
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() }) as never
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
    await closing
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', null, 'SIGTERM')
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

  it('escalates to SIGKILL when a late child ignores SIGTERM', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const rpc = new OmpRpc({ spawnChild: async () => child })
    const started = rpc.start(1_000)
    const expectation = expect(started).rejects.toThrow(/cancelled/)
    const closing = rpc.close(50)
    await expectation
    await closing
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    child.emit('exit', null, 'SIGKILL')
  })
})
