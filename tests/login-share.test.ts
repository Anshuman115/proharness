import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshHost } from '../src/main/host/ssh'
import { LoginShare, REMOTE_TOKEN_PATH } from '../src/main/services/login-share'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as unknown as Record<string, unknown>
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.kill = vi.fn()
    return child
  }),
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) =>
    callback(null, '')
  )
}))

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'super-secret-token\n') }))

type FakeHostFields = {
  id: string
  kind: 'ssh'
  run: ReturnType<typeof vi.fn>
  forwardRemote: ReturnType<typeof vi.fn>
  cancelRemote: ReturnType<typeof vi.fn>
}

function fakeHost(id: string): {
  host: SshHost
  raw: FakeHostFields
  setFailing: (value: boolean) => void
  cancelRemote: ReturnType<typeof vi.fn>
} {
  let failing = false
  const cancelRemote = vi.fn(async () => undefined)
  const host: FakeHostFields = {
    id,
    kind: 'ssh',
    run: vi.fn(async () =>
      failing
        ? { code: 1, stdout: '', stderr: 'token install failed' }
        : { code: 0, stdout: '', stderr: '' }
    ),
    forwardRemote: vi.fn(async () => undefined),
    cancelRemote
  }
  return {
    host: host as unknown as SshHost,
    raw: host,
    setFailing: (value) => (failing = value),
    cancelRemote
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginShare', () => {
  it('keeps per-host errors and falls back to the host logins', async () => {
    const share = new LoginShare(async () => '/opt/homebrew/bin/omp', (hostId) => hostId !== 'disabled')
    const good = fakeHost('good')
    const bad = fakeHost('bad')
    const disabled = fakeHost('disabled')
    bad.setFailing(true)
    try {
      const script = await share.prelude(good.host)
      expect(script).toContain('OMP_AUTH_BROKER_URL=http://127.0.0.1:')
      expect(script).toContain(`$(cat "$HOME/${REMOTE_TOKEN_PATH}")`)
      expect(script).not.toContain('super-secret-token')

      expect(await share.prelude(bad.host)).toBe('')
      expect(await share.prelude(disabled.host)).toBe('')

      expect(share.status('good')).toMatchObject({ hostId: 'good', enabled: true, active: true, error: null })
      expect(share.status('bad')).toMatchObject({ hostId: 'bad', enabled: true, active: false })
      expect(share.status('bad').error).toMatch(/token install failed/)
      expect(share.status('good').error).toBeNull()
      expect(share.status('disabled')).toMatchObject({ enabled: false, active: false, error: null })

      const calls = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(JSON.stringify(calls)).not.toContain('super-secret-token')
    } finally {
      share.dispose()
    }
  })

  it('clears the recorded error on success and on disable, and detaches', async () => {
    const share = new LoginShare(async () => '/opt/homebrew/bin/omp', () => true)
    const host = fakeHost('devbox')
    host.setFailing(true)
    try {
      expect(await share.prelude(host.host)).toBe('')
      expect(share.status('devbox').error).toMatch(/token install failed/)

      host.setFailing(false)
      expect(await share.prelude(host.host)).toContain('OMP_AUTH_BROKER_URL')
      expect(share.status('devbox')).toMatchObject({ active: true, error: null })

      await share.detach(host.host)
      expect(host.cancelRemote).toHaveBeenCalledTimes(1)
      expect(share.status('devbox')).toMatchObject({ active: false, error: null })
    } finally {
      share.dispose()
    }
  })
})


describe('LoginShare broker and attach races', () => {
  it('reports a broker spawn failure instead of crashing or waiting for the timeout', async () => {
    const failing = new EventEmitter() as unknown as Record<string, unknown>
    failing.stdout = new EventEmitter()
    failing.stderr = new EventEmitter()
    failing.exitCode = null
    failing.kill = vi.fn()
    setTimeout(() => (failing as unknown as EventEmitter).emit('error', new Error('spawn omp ENOENT')), 0)
    ;(spawn as unknown as { mockReturnValueOnce: (value: unknown) => void }).mockReturnValueOnce(failing)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))
    const share = new LoginShare(async () => '/missing/omp', () => true)
    const host = fakeHost('bad')
    const startedAt = Date.now()
    try {
      expect(await share.prelude(host.host)).toBe('')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(share.status('bad').error).toMatch(/did not start|ENOENT/)
    } finally {
      share.dispose()
    }
  })

  it('attaches a host once for concurrent preludes', async () => {
    const share = new LoginShare(async () => '/opt/homebrew/bin/omp', () => true)
    const host = fakeHost('devbox')
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => (releaseInstall = resolve))
    host.raw.run.mockImplementation(async (line: string) => {
      if (line.includes('umask')) await installGate
      return { code: 0, stdout: '', stderr: '' }
    })
    try {
      const first = share.prelude(host.host)
      const second = share.prelude(host.host)
      await new Promise((resolve) => setTimeout(resolve, 0))
      releaseInstall()
      const [firstScript, secondScript] = await Promise.all([first, second])
      expect(firstScript).toBe(secondScript)
      expect(firstScript).toContain('OMP_AUTH_BROKER_URL')
      expect(host.raw.forwardRemote).toHaveBeenCalledTimes(1)
    } finally {
      share.dispose()
    }
  })
})
