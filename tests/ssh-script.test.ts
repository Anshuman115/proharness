import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { shq } from '../src/main/host/host'
import { SshHost } from '../src/main/host/ssh'
import { brokerEnvScript, REMOTE_TOKEN_PATH } from '../src/main/services/login-share'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function runSh(script: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('sh', ['-c', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('SshHost.remoteScript', () => {
  it('round-trips a cwd with a space and a quote plus an env value full of metacharacters', () => {
    const host = new SshHost('example', async () => process.env)
    const cwd = realpathSync(tempDir("proharness ssh 'q "))
    const env = { FOO: `a 'b' $c "d"` }
    const script = host.remoteScript(`printf '%s\\n' "$PWD" "$FOO"`, cwd, env)

    const stdout = runSh(script, { ...process.env, SHELL: '/bin/sh' })
    const lines = stdout.replace(/\n$/, '').split('\n')
    expect(lines[0]).toBe(cwd)
    expect(lines[1]).toBe(env.FOO)
  })

  it('runs in the shell environment without leaking the exported values into the script text', () => {
    const host = new SshHost('example', async () => process.env)
    const script = host.remoteScript('printf %s "$BAR"', undefined, { BAR: 'plain' })
    expect(runSh(script, { ...process.env, SHELL: '/bin/sh' })).toBe('plain')
    expect(script).toContain('export BAR=plain;')
  })
})

describe('shq round trip', () => {
  const values = ['', 'a b', "it's", '$HOME', '`x`', 'a\nb', '*']

  for (const value of values) {
    it(`preserves ${JSON.stringify(value)} through sh -c`, () => {
      expect(runSh(`printf %s ${shq(value)}`)).toBe(value)
    })
  }
})

describe('brokerEnvScript', () => {
  it('reads the broker token from the host file and keeps it out of the script text', () => {
    const home = tempDir('proharness-broker-home-')
    const token = 'tok-abc-123'
    const tokenPath = join(home, REMOTE_TOKEN_PATH)
    mkdirSync(dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })

    const port = 51234
    const script = brokerEnvScript(port)
    const stdout = runSh(
      `${script} printf '%s|%s|%s' "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN" "$OMP_AUTH_BROKER_SNAPSHOT_CACHE"`,
      { ...process.env, HOME: home }
    )
    const [url, readToken, cache] = stdout.split('|')

    expect(url).toBe(`http://127.0.0.1:${port}`)
    expect(readToken).toBe(token)
    expect(cache.startsWith(`${home}/`)).toBe(true)
    expect(cache).toContain('proharness')
    expect(script).not.toContain(token)
  })

  it('leaves the token empty when the host has no token file', () => {
    const home = tempDir('proharness-broker-empty-')
    const stdout = runSh(
      `${brokerEnvScript(5000)} printf '[%s]' "$OMP_AUTH_BROKER_TOKEN"`,
      { ...process.env, HOME: home }
    )
    expect(stdout).toBe('[]')
  })
})
