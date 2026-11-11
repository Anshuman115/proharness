import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalHost } from '../src/main/host/local'
import { GitService } from '../src/main/services/git'

let root = ''
let service: GitService
const host = new LocalHost()

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proharness-git-'))
  git('init', '-q')
  git('config', 'user.email', 'test@proharness.local')
  git('config', 'user.name', 'ProHarness Test')
  writeFileSync(join(root, 'hello.txt'), 'one\ntwo\n')
  git('add', '-A')
  git('commit', '-qm', 'initial')
  service = new GitService(() => host, () => root)
})

afterEach(() => {
  service.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('GitService', () => {
  it('reports a clean tree and branch', async () => {
    const summary = await service.summary()
    expect(summary.isRepo).toBe(true)
    expect(summary.clean).toBe(true)
    expect(summary.files).toHaveLength(0)
  })

  it('detects a tracked modification and produces a diff', async () => {
    writeFileSync(join(root, 'hello.txt'), 'one\nTWO\nthree\n')
    const summary = await service.summary()
    expect(summary.clean).toBe(false)
    expect(summary.files[0]).toMatchObject({ path: 'hello.txt', status: 'modified', additions: 2 })
    const diff = await service.fileDiff('hello.txt')
    expect(diff.diff).toContain('-two')
    expect(diff.diff).toContain('+TWO')
  })

  it('restores a tracked file and rejects path escapes', async () => {
    writeFileSync(join(root, 'hello.txt'), 'changed\n')
    await service.restoreFile('hello.txt')
    const summary = await service.summary()
    expect(summary.clean).toBe(true)
    await expect(service.fileDiff('../escape.txt')).rejects.toThrow(/relative|escapes/)
  })

  it('commits all changes and reports the hash', async () => {
    writeFileSync(join(root, 'new.txt'), 'new\n')
    const result = await service.commitAll('test commit')
    expect(result.hash).toMatch(/^[0-9a-f]{7,}$/)
    expect((await service.summary()).clean).toBe(true)
  })
})

describe('GitService untracked files', () => {
  it('counts untracked lines and includes them in the review diff', async () => {
    writeFileSync(join(root, 'new.txt'), 'a\nb\nc\n')
    const summary = await service.summary()
    expect(summary.files.find((file) => file.path === 'new.txt')).toMatchObject({ status: 'untracked', additions: 3 })
    const review = await service.reviewDiff()
    expect(review.diff).toContain('+++ b/new.txt')
    expect(review.diff).toContain('+c')
  })
})

describe('GitService before the first commit', () => {
  it('diffs staged files against the empty tree', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'proharness-git-empty-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh })
      writeFileSync(join(fresh, 'a.txt'), 'one\ntwo\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: fresh })
      const empty = new GitService(() => new LocalHost(), () => fresh)
      const summary = await empty.summary()
      expect(summary.files[0]).toMatchObject({ path: 'a.txt', additions: 2 })
      expect((await empty.fileDiff('a.txt')).diff).toContain('+two')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe('GitService.excludeGoals', () => {
  function excludeLines(): string[] {
    return readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  it('writes the goals pattern once even when called twice', async () => {
    expect(await service.excludeGoals()).toEqual({ excluded: true, tracked: false })
    expect(await service.excludeGoals()).toEqual({ excluded: true, tracked: false })
    expect(excludeLines().filter((line) => line === '/goals/')).toHaveLength(1)
  })

  it('scopes the pattern to the workspace when it is a subfolder of the repo', async () => {
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    const nested = new GitService(() => host, () => app)
    try {
      expect(await nested.excludeGoals()).toEqual({ excluded: true, tracked: false })
      expect(excludeLines()).toContain('/app/goals/')
      expect(excludeLines()).not.toContain('/goals/')
    } finally {
      nested.dispose()
    }
  })

  it('reports goals/ as untracked when it was never committed', async () => {
    expect(await service.excludeGoals()).toEqual({ excluded: true, tracked: false })
  })

  it('reports goals/ as tracked when it was committed before', async () => {
    mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
    writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), '# Plan\n')
    git('add', '-A')
    git('commit', '-qm', 'plan')
    expect(await service.excludeGoals()).toEqual({ excluded: true, tracked: true })
  })

  it('does nothing outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'proharness-git-plain-'))
    const outside = new GitService(() => host, () => plain)
    try {
      expect(await outside.excludeGoals()).toEqual({ excluded: false, tracked: false })
    } finally {
      outside.dispose()
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
