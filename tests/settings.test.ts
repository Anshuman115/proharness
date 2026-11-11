import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { DEFAULT_PINNED } from '../src/shared/models'
import { SettingsService } from '../src/main/services/settings'

vi.mock('electron', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proharness-electron-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return {
    app: {
      getPath: (name: string) => (name === 'home' ? home : path.join(root, name)),
      getAppPath: () => path.join(root, 'app'),
      isPackaged: true
    }
  }
})

let root = ''
let file = ''

const electronRoot = dirname(app.getPath('home'))

function service(): SettingsService {
  return new SettingsService(file)
}

function writeStored(value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proharness-settings-'))
  file = join(root, 'settings.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(electronRoot, { recursive: true, force: true })
})

describe('SettingsService defaults and migration', () => {
  it('falls back to defaults when the file is missing', () => {
    const settings = service()
    expect(settings.workspaceHost).toBe('local')
    expect(settings.publicSettings()).toMatchObject({
      workspaceHost: 'local',
      chatApproval: 'write',
      loopApproval: 'yolo',
      reviewerModel: 'anthropic/claude-sonnet-5-5',
      pinnedModels: DEFAULT_PINNED
    })
    expect(settings.prefsFor('local')).toEqual({
      chatModel: '',
      implementerModel: '',
      reviewerModel: 'anthropic/claude-sonnet-5-5'
    })
  })

  it('falls back to defaults for corrupt JSON instead of throwing', () => {
    writeFileSync(file, '{ this is not json')
    const settings = service()
    const pub = settings.publicSettings()
    expect(pub.workspaceHost).toBe('local')
    expect(pub.chatApproval).toBe('write')
    expect(pub.loopApproval).toBe('yolo')
    expect(pub.pinnedModels).toEqual(DEFAULT_PINNED)
  })

  it('keeps an unparseable settings file as .corrupt before saving defaults', () => {
    const original = '{ this is not json'
    writeFileSync(file, original)
    service()
    expect(existsSync(`${file}.corrupt`)).toBe(true)
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(original)
    expect(existsSync(file)).toBe(false)
  })

  it('turns flat pre-v3 model fields into the local prefs', () => {
    writeStored({
      chatModel: 'anthropic/claude-opus-5-5',
      implementerModel: 'openai-codex/gpt-6.1-sol',
      reviewerModel: 'commandcode/claude-sonnet-5-5'
    })
    expect(service().prefsFor('local')).toEqual({
      chatModel: 'anthropic/claude-opus-5-5',
      implementerModel: 'openai-codex/gpt-6.1-sol',
      reviewerModel: 'commandcode/claude-sonnet-5-5'
    })
  })

  it('uses the default reviewer when the legacy reviewer is empty', () => {
    writeStored({ chatModel: 'anthropic/claude-opus-5-5', implementerModel: 'openai-codex/gpt-6.1-sol', reviewerModel: '   ' })
    expect(service().prefsFor('local')).toEqual({
      chatModel: 'anthropic/claude-opus-5-5',
      implementerModel: 'openai-codex/gpt-6.1-sol',
      reviewerModel: 'anthropic/claude-sonnet-5-5'
    })
  })

  it('replaces the untouched v2 pin list but keeps a customised one', () => {
    const v2DefaultPins = [
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
      'openai-codex/gpt-6.1-sol',
      'openai-codex/gpt-6.1-terra',
      'openai-codex/gpt-6-luna',
      'commandcode/deepseek/deepseek-v4.1-flash'
    ]
    writeStored({ pinnedModels: v2DefaultPins })
    expect(service().publicSettings().pinnedModels).toEqual(DEFAULT_PINNED)

    writeStored({ pinnedModels: ['vendor/one', 'vendor/two'] })
    expect(service().publicSettings().pinnedModels).toEqual(['vendor/one', 'vendor/two'])
  })

  it('drops invalid approvals and cleans the shared login hosts', () => {
    writeStored({ chatApproval: 'sometimes', loopApproval: 7, shareLoginHosts: ['devbox', 'local', '', '  ', 'devbox', 'build'] })
    const pub = service().publicSettings()
    expect(pub.chatApproval).toBe('write')
    expect(pub.loopApproval).toBe('yolo')
    expect(service().sharesLogins('devbox')).toBe(true)
    expect(service().sharesLogins('build')).toBe(true)
    expect(service().sharesLogins('local')).toBe(false)
  })

  it('checks a local workspace path but keeps a remote one that does not exist here', () => {
    const missing = join(root, 'gone')
    writeStored({ workspacePath: missing, workspaceHost: 'local' })
    const local = service()
    expect(local.workspacePath).not.toBe(missing)
    expect(existsSync(local.workspacePath)).toBe(true)

    writeStored({ workspacePath: '/srv/x', workspaceHost: 'devbox' })
    const remote = service()
    expect(remote.workspaceHost).toBe('devbox')
    expect(remote.workspacePath).toBe('/srv/x')
  })
})

describe('SettingsService writes', () => {
  it('saves a model choice per active host and reloads it from disk', () => {
    const settings = service()
    const localDir = join(root, 'work')
    mkdirSync(localDir)
    settings.setWorkspace({ host: 'local', path: localDir })
    expect(settings.prefsFor('local').chatModel).toBe('')

    settings.setWorkspace({ host: 'devbox', path: '/srv/x' })
    settings.update({ chatModel: 'vendor/remote-model' })
    expect(settings.prefsFor('devbox').chatModel).toBe('vendor/remote-model')

    settings.setWorkspace({ host: 'local', path: localDir })
    expect(settings.prefsFor('local').chatModel).toBe('')
    expect(settings.prefsFor('devbox').chatModel).toBe('vendor/remote-model')

    const reloaded = service()
    expect(reloaded.workspaceHost).toBe('local')
    expect(reloaded.workspacePath).toBe(localDir)
    expect(reloaded.prefsFor('local').chatModel).toBe('')
    expect(reloaded.prefsFor('devbox').chatModel).toBe('vendor/remote-model')
  })

  it('names the workspace after the folder and the host', () => {
    const settings = service()
    const localDir = join(root, 'my-project')
    mkdirSync(localDir)
    settings.setWorkspace({ host: 'local', path: localDir })
    expect(settings.publicSettings().workspaceName).toBe('my-project')

    settings.setWorkspace({ host: 'devbox', path: '/srv/app' })
    expect(settings.publicSettings().workspaceName).toBe('app @ devbox')
  })

  it('toggles shared logins for remote hosts only', () => {
    const settings = service()
    expect(() => settings.setShareLogins('local', true)).toThrow()
    expect(settings.sharesLogins('devbox')).toBe(false)

    settings.setShareLogins('devbox', true)
    expect(settings.sharesLogins('devbox')).toBe(true)
    expect(service().sharesLogins('devbox')).toBe(true)

    settings.setShareLogins('devbox', false)
    expect(settings.sharesLogins('devbox')).toBe(false)
  })

  it('writes the settings file with mode 0600', () => {
    service().update({ chatModel: 'vendor/x' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
