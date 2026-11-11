import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecResult, WorkspaceHost } from '../src/main/host/host'
import { OmpService } from '../src/main/services/omp'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ph-omp-service-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(host: WorkspaceHost, cwd = '/work'): OmpService {
  return new OmpService(() => '', () => cwd, join(dir, 'omp-status.json'), () => host)
}

function fakeHost(overrides: Partial<WorkspaceHost>): WorkspaceHost {
  return {
    kind: 'local',
    id: 'local',
    home: async () => '/home/me',
    writeText: async () => undefined,
    ...overrides
  } as unknown as WorkspaceHost
}

describe('OmpService overlays', () => {
  it('writes the local overlay next to the model cache and reuses it', async () => {
    const writes: Array<{ path: string; content: string }> = []
    const host = fakeHost({
      writeText: async (path, content) => {
        writes.push({ path, content })
      }
    })
    const omp = service(host)
    const file = await omp.overlayFor(host)
    expect(file).toBe(join(dir, 'omp-overlay.yml'))
    expect(writes).toHaveLength(1)
    expect(writes[0].content).toContain('plan_list: allow')
    expect(writes[0].content).toContain('git_status: allow')
    await expect(omp.overlayFor(host)).resolves.toBe(file)
    expect(writes).toHaveLength(1)
  })

  it('writes the remote overlay under ~/.cache/proharness', async () => {
    const writes: string[] = []
    const host = fakeHost({
      kind: 'ssh',
      id: 'devbox',
      home: async () => '/home/me',
      writeText: async (path) => {
        writes.push(path)
      }
    })
    const omp = service(host)
    await expect(omp.overlayFor(host)).resolves.toBe('/home/me/.cache/proharness/omp-overlay.yml')
    expect(writes).toEqual(['/home/me/.cache/proharness/omp-overlay.yml'])
  })

  it('single-flights concurrent writes for the same host', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const writeText = vi.fn(async () => {
      await gate
    })
    const host = fakeHost({ writeText })
    const omp = service(host)
    const first = omp.overlayFor(host)
    const second = omp.overlayFor(host)
    expect(second).toBe(first)
    release()
    await expect(first).resolves.toBe(join(dir, 'omp-overlay.yml'))
    await expect(second).resolves.toBe(join(dir, 'omp-overlay.yml'))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('evicts a rejected write so a later call retries', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce(undefined)
    const host = fakeHost({ writeText })
    const omp = service(host)
    await expect(omp.overlayFor(host)).rejects.toThrow('write failed')
    await expect(omp.overlayFor(host)).resolves.toBe(join(dir, 'omp-overlay.yml'))
    expect(writeText).toHaveBeenCalledTimes(2)
  })
})

describe('OmpService probe cwd', () => {
  it('reports a missing workspace and does not spawn the probe', async () => {
    const spawn = vi.fn()
    const exec = vi.fn(async (command: string): Promise<ExecResult> => {
      if (command === 'sh') return { code: 0, stdout: '/opt/homebrew/bin/omp\n', stderr: '' }
      if (command === '/opt/homebrew/bin/omp') return { code: 0, stdout: 'omp/18.18.8\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const host = fakeHost({
      exec,
      stat: async () => null,
      spawn
    })
    const omp = service(host, '/missing')
    const status = await omp.refresh()
    expect(status.ok).toBe(false)
    expect(status.error).toMatch(/Workspace folder "\/missing"/)
    expect(status.error).toMatch(/Choose another workspace in Settings/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps the host and cwd snapshot when the active target changes during refresh', async () => {
    let resolveVersion!: (value: ExecResult) => void
    const version = new Promise<ExecResult>((resolve) => (resolveVersion = resolve))
    const dirInfo = { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }
    const hostA = fakeHost({
      id: 'a',
      exec: vi.fn(async (command: string) =>
        command === 'sh' ? { code: 0, stdout: '/opt/omp\n', stderr: '' } : version
      ),
      stat: vi.fn(async (path: string) => (path === '/a' ? dirInfo : null)),
      spawn: vi.fn(async () => {
        throw new Error('probe failed')
      })
    })
    const hostB = fakeHost({
      id: 'b',
      exec: vi.fn(async (command: string) =>
        command === 'sh'
          ? { code: 0, stdout: '/opt/omp\n', stderr: '' }
          : { code: 0, stdout: 'omp/18.18.8\n', stderr: '' }
      ),
      stat: vi.fn(async (path: string) => (path === '/b' ? dirInfo : null)),
      spawn: vi.fn(async () => {
        throw new Error('probe failed')
      })
    })
    let active = hostA
    let cwd = '/a'
    const omp = new OmpService(() => '', () => cwd, join(dir, 'omp-status.json'), () => active)
    const hosts: string[] = []
    omp.onChange((status) => hosts.push(status.hostId))

    const first = omp.refresh()
    active = hostB
    cwd = '/b'
    const second = omp.refresh()
    resolveVersion({ code: 0, stdout: 'omp/18.18.8\n', stderr: '' })

    const [a, b] = await Promise.all([first, second])
    expect(a.hostId).toBe('a')
    expect(b.hostId).toBe('b')
    expect(hostA.stat).toHaveBeenCalledWith('/a')
    expect(hostB.stat).toHaveBeenCalledWith('/b')
    expect(hostA.spawn).toHaveBeenCalled()
    expect(hostB.spawn).toHaveBeenCalled()
    expect(hosts.every((host) => host === 'b')).toBe(true)
    expect(omp.current().hostId).toBe('b')
  })
})
