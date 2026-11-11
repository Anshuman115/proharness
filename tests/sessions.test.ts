import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/host/local'
import type { GitService } from '../src/main/services/git'
import type { OmpSpawn } from '../src/main/omp/agent'
import type { OmpService } from '../src/main/services/omp'
import type { PlanService } from '../src/main/services/plan'
import { SessionManager } from '../src/main/services/sessions'
import type { SettingsService } from '../src/main/services/settings'
import type { UiBroker } from '../src/main/services/ui-broker'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

function fakeSpawn(): OmpSpawn {
  return () => Promise.reject(new Error('no spawn in this test'))
}

function build(omp: Partial<OmpService>, dataDir: string): SessionManager {
  const settings = {
    chatApproval: 'write',
    chatModel: '',
    workspacePath: dataDir
  } as unknown as SettingsService
  return new SessionManager(
    settings,
    omp as OmpService,
    {} as PlanService,
    {} as GitService,
    {} as UiBroker,
    dataDir,
    () => new LocalHost()
  )
}

describe('SessionManager pending creates', () => {
  it('cancels a create waiting on the spawner when the tab is closed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ph-sessions-'))
    const pendingSpawn = deferred<OmpSpawn>()
    const spawner = vi.fn(() => pendingSpawn.promise)
    const sessions = build({ spawner } as unknown as Partial<OmpService>, dataDir)
    try {
      const creating = sessions.create({ tabId: 'tab-1', title: 'New session' })
      const expectation = expect(creating).rejects.toThrow(/cancelled/)
      await sessions.close('tab-1')
      pendingSpawn.resolve(fakeSpawn())
      await expectation
      expect(spawner).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('lets the latest pending create for a tab win', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ph-sessions-'))
    const firstSpawn = deferred<OmpSpawn>()
    const secondSpawn = deferred<OmpSpawn>()
    const spawner = vi.fn().mockImplementationOnce(() => firstSpawn.promise).mockImplementationOnce(() => secondSpawn.promise)
    const sessions = build({ spawner } as unknown as Partial<OmpService>, dataDir)
    try {
      const first = sessions.create({ tabId: 'tab-2', title: 'First' })
      const firstExpectation = expect(first).rejects.toThrow(/cancelled/)
      const second = sessions.create({ tabId: 'tab-2', title: 'Second' })
      firstSpawn.resolve(fakeSpawn())
      await firstExpectation
      secondSpawn.resolve(fakeSpawn())
      await expect(second).rejects.toThrow(/no spawn/)
      expect(spawner).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
