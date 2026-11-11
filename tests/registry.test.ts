import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostRegistry } from '../src/main/host/registry'

const testHome = vi.hoisted(() => ({ value: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => testHome.value }
})

let root = ''
let configFile = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ph-registry-'))
  testHome.value = root
  mkdirSync(join(root, '.ssh'), { recursive: true })
  configFile = join(root, '.ssh', 'config')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('HostRegistry.sshHosts', () => {
  it('reports no hosts when ~/.ssh/config does not exist', () => {
    expect(new HostRegistry().sshHosts()).toEqual([])
  })

  it('parses aliases and ignores wildcard patterns', () => {
    writeFileSync(
      configFile,
      ['Host alpha', '  HostName 192.0.2.10', 'Host beta gamma', 'Host * !legacy', '  User git', ''].join('\n')
    )
    expect(new HostRegistry().sshHosts()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('propagates an unreadable config instead of reporting no hosts', () => {
    writeFileSync(configFile, 'Host alpha\n')
    chmodSync(configFile, 0o000)
    let caught: NodeJS.ErrnoException | undefined
    try {
      new HostRegistry().sshHosts()
    } catch (error) {
      caught = error as NodeJS.ErrnoException
    }
    expect(caught?.code).toBe('EACCES')
  })
})
