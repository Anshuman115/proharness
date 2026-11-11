import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceHost } from '../src/main/host/host'
import { GitService } from '../src/main/services/git'
import { PlanService } from '../src/main/services/plan'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

function statInfo(isDirectory = true): { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number } {
  return { isFile: !isDirectory, isDirectory, size: 0, mtimeMs: 1 }
}

describe('workspace snapshots', () => {
  it('git summary keeps the host path captured at call entry', async () => {
    const gate = deferred<void>()
    const cwds: string[] = []
    const host = {
      path: posix,
      stat: vi.fn(async () => statInfo()),
      exec: vi.fn(async (_command: string, args: string[], options?: { cwd?: string }) => {
        cwds.push(options?.cwd || '')
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          await gate.promise
          return { stdout: '/work\n', stderr: '', code: 0 }
        }
        if (args[0] === 'status') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'rev-list') return { stdout: '', stderr: '', code: 1 }
        if (args[0] === 'diff') return { stdout: '', stderr: '', code: 0 }
        if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      })
    } as unknown as WorkspaceHost
    let current = '/work'
    const service = new GitService(
      () => host,
      () => current
    )
    const summarizing = service.summary()
    await tick()
    current = '/other'
    gate.resolve()
    const summary = await summarizing
    expect(summary.isRepo).toBe(true)
    expect(cwds.length).toBeGreaterThan(0)
    expect(new Set(cwds)).toEqual(new Set(['/work']))
  })


  it('propagates git transport failures and treats only a non-repository as notRepo', async () => {
    const transport = {
      path: posix,
      stat: vi.fn(async () => statInfo()),
      exec: vi.fn(async () => {
        throw new Error('ssh connection dropped')
      })
    } as unknown as WorkspaceHost
    await expect(
      new GitService(
        () => transport,
        () => '/work'
      ).summary()
    ).rejects.toThrow(/ssh connection dropped/)

    const nonRepo = {
      path: posix,
      stat: vi.fn(async () => statInfo()),
      exec: vi.fn(async () => ({
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
        code: 128
      }))
    } as unknown as WorkspaceHost
    const summary = await new GitService(
      () => nonRepo,
      () => '/work'
    ).summary()
    expect(summary.isRepo).toBe(false)
  })

  it('plan readGoal keeps the host path captured at call entry', async () => {
    const designRead = deferred<void>()
    const paths: string[] = []
    const host = {
      path: posix,
      stat: vi.fn(async (path: string) => {
        paths.push(path)
        if (path.endsWith('DESIGN.md')) await designRead.promise
        return statInfo(!path.endsWith('.md'))
      }),
      readText: vi.fn(async (path: string) => {
        paths.push(path)
        return '# Demo\n'
      })
    } as unknown as WorkspaceHost
    let current = '/work'
    const service = new PlanService(
      () => host,
      () => current
    )
    const reading = service.readGoal('demo')
    await tick()
    current = '/other'
    designRead.resolve()
    await reading
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every((path) => path.startsWith('/work/'))).toBe(true)
  })
})
