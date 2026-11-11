import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collect, shq } from '../src/main/host/host'
import { LocalHost } from '../src/main/host/local'
import { parseSshConfigHosts } from '../src/main/host/ssh'

describe('shq', () => {
  it('quotes arguments containing spaces', () => {
    expect(shq('a b')).toBe("'a b'")
    expect(shq('/Users/me/My Projects')).toBe("'/Users/me/My Projects'")
  })

  it('escapes single quotes', () => {
    expect(shq("it's")).toBe("'it'\\''s'")
  })

  it('quotes the empty string', () => {
    expect(shq('')).toBe("''")
  })

  it('leaves safe tokens unquoted', () => {
    expect(shq('/usr/local/bin/omp')).toBe('/usr/local/bin/omp')
    expect(shq('user@host:/srv/app')).toBe('user@host:/srv/app')
  })
})

describe('parseSshConfigHosts', () => {
  it('reads every alias from Host lines and skips wildcards', () => {
    const config = [
      'Host devbox',
      '  HostName 203.0.113.10',
      '',
      'Host build-*.internal !jump ?single',
      '  User ci',
      '',
      'host alpha beta',
      '  Port 2222'
    ].join('\n')
    expect(parseSshConfigHosts(config)).toEqual(['devbox', 'alpha', 'beta'])
  })

  it('returns no hosts for an empty config', () => {
    expect(parseSshConfigHosts('')).toEqual([])
  })

  it('ignores Match and comments', () => {
    const config = '# Host commented-out\nMatch host example.com\n  User me\n'
    expect(parseSshConfigHosts(config)).toEqual([])
  })
})

describe('login sharing env', () => {
  it('reads the token from a file on the host instead of inlining it', async () => {
    const { brokerEnvScript, REMOTE_TOKEN_PATH } = await import('../src/main/services/login-share')
    const script = brokerEnvScript(51234)
    expect(script).toContain('OMP_AUTH_BROKER_URL=http://127.0.0.1:51234')
    expect(script).toContain(`$(cat "$HOME/${REMOTE_TOKEN_PATH}")`)
    expect(script.trim().endsWith(';')).toBe(true)
  })
})

describe('LocalHost', () => {
  it('reports the local home and watcher intervals', async () => {
    const host = new LocalHost()
    expect(await host.home()).toBe(homedir())
    expect(host.pollMs.plan).toBeGreaterThan(0)
    expect(host.pollMs.git).toBeGreaterThan(0)
  })

  it('reads at most maxBytes and propagates a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ph-host-'))
    try {
      const file = join(dir, 'note.txt')
      await writeFile(file, 'abcdefghij')
      const host = new LocalHost()
      expect((await host.readFile(file, 4)).toString()).toBe('abcd')
      expect((await host.readFile(file)).toString()).toBe('abcdefghij')
      await expect(host.readFile(file, -1)).rejects.toThrow(/maxBytes/)
      await expect(host.readFile(file, 1.5)).rejects.toThrow(/maxBytes/)
      await expect(host.readFile(join(dir, 'missing.txt'))).rejects.toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null only for a missing path and propagates access errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ph-host-'))
    const locked = join(dir, 'locked')
    try {
      await writeFile(join(dir, 'file.txt'), 'x')
      await mkdir(locked)
      await chmod(locked, 0o000)
      const host = new LocalHost()
      expect(await host.stat(join(dir, 'missing'))).toBeNull()
      expect(await host.stat(join(dir, 'file.txt'))).toMatchObject({ isFile: true, isDirectory: false })
      expect(await host.stat(locked)).toMatchObject({ isDirectory: true })
      await expect(host.stat(join(locked, 'inside'))).rejects.toBeTruthy()
    } finally {
      await chmod(locked, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('spawns with the login env plus the spec overlay', async () => {
    const host = new LocalHost()
    const child = await host.spawn({
      command: 'sh',
      args: ['-c', 'printf "%s|%s" "$PH_TEST" "${PATH:+set}"'],
      cwd: process.cwd(),
      env: { PH_TEST: 'ok' },
      prelude: 'ignored-by-local;'
    })
    const result = await collect(child)
    expect(result.stdout).toBe('ok|set')
  })

  it('builds a local terminal launch and rejects a missing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ph-host-'))
    try {
      const host = new LocalHost()
      const launch = await host.terminal(dir, '/bin/zsh')
      expect(launch.command).toBe('/bin/zsh')
      expect(launch.ptyArgs).toEqual(['-l'])
      expect(launch.pipeArgs).toEqual(['-i'])
      expect(launch.cwd).toBe(dir)
      expect(launch.shell).toBe('/bin/zsh')
      expect(launch.env.PROHARNESS_TERMINAL).toBe('1')
      await expect(host.terminal(join(dir, 'missing'), '/bin/zsh')).rejects.toThrow(/does not exist/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('discovers nested .git entries with spaces in the path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ph-host-'))
    const repo = join(dir, 'my repo')
    try {
      await mkdir(repo)
      await writeFile(join(repo, '.git'), 'gitdir: elsewhere\n')
      const host = new LocalHost()
      const found = await host.exec('find', [dir, '-mindepth', '2', '-maxdepth', '2', '-name', '.git'])
      const repos = found.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((path) => basename(dirname(path)))
      expect(repos).toContain('my repo')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
