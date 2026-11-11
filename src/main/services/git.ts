import { PLAN_DIR } from '@shared/defaults'
import type { GitChangeStatus, GitFileChange, GitFileDiff, GitSummary } from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import { PollingWatcher } from './polling-watcher'

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

const MAX_DIFF_CHARS = 700_000
const MAX_DIFF_LINES = 9_000
const MAX_REVIEW_DIFF_CHARS = 180_000
const PLAN_EXCLUDE = `:(exclude)${PLAN_DIR}`
/** git's well-known empty tree; diffs against it before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function statusFromPorcelain(x: string, y: string): GitChangeStatus {
  if (x === '?' || y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflicted'
  }
  const code = x !== ' ' ? x : y
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

interface GitTarget {
  host: WorkspaceHost
  path: string
}

export class GitService {
  private readonly watcher = new PollingWatcher<GitSummary>({
    load: () => this.summary(),
    signature: (summary) => JSON.stringify(summary),
    interval: () => this.host().pollMs.git,
    debounceMs: 350,
    forceNotify: false
  })

  constructor(
    private readonly host: () => WorkspaceHost,
    private readonly workspace: () => string
  ) {}

  private target(): GitTarget {
    return { host: this.host(), path: this.workspace() }
  }

  private async gitOn(target: GitTarget, args: string[], allowCodes: number[] = [0]): Promise<GitResult> {
    const result = await target.host.exec('git', args, {
      cwd: target.path,
      timeoutMs: 30_000,
      maxBuffer: 20 * 1024 * 1024
    })
    if (allowCodes.includes(result.code)) return result
    throw new Error((result.stderr || 'git command failed').trim())
  }

  /** HEAD, or the empty tree in a repository without commits. */
  private async baseOf(target: GitTarget): Promise<string> {
    const result = await this.gitOn(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1, 128])
    return result.code === 0 ? 'HEAD' : EMPTY_TREE
  }

  private async rootOf(target: GitTarget): Promise<string | null> {
    if (!(await target.host.stat(target.path))) return null
    const result = await this.gitOn(target, ['rev-parse', '--show-toplevel'], [0, 128])
    if (result.code === 0) return result.stdout.trim() || null
    if (/not a git repository/i.test(result.stderr)) return null
    throw new Error((result.stderr || 'git rev-parse failed').trim())
  }

  async summary(): Promise<GitSummary> {
    return this.summaryOf(this.target())
  }

  private async summaryOf(target: GitTarget): Promise<GitSummary> {
    const root = await this.rootOf(target)
    if (!root) {
      return { isRepo: false, root: null, branch: null, ahead: 0, behind: 0, files: [], clean: true, head: null }
    }

    const branchResult = await this.gitOn(target, ['branch', '--show-current'], [0, 1])
    const branch = branchResult.stdout.trim() || null
    let ahead = 0
    let behind = 0
    try {
      const counts = await this.gitOn(target, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
      const [behindText, aheadText] = counts.stdout.trim().split(/\s+/)
      behind = Number(behindText) || 0
      ahead = Number(aheadText) || 0
    } catch {
      // No upstream configured.
    }

    const statusResult = await this.gitOn(target, [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
      PLAN_EXCLUDE
    ])
    const records = statusResult.stdout.split('\0')
    const files: GitFileChange[] = []
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]
      if (!record || record.length < 4) continue
      const x = record[0]
      const y = record[1]
      const path = record.slice(3)
      if (!path) continue
      let oldPath: string | undefined
      if ((x === 'R' || x === 'C') && records[i + 1]) {
        oldPath = records[i + 1]
        i += 1
      }
      files.push({
        path,
        oldPath,
        status: statusFromPorcelain(x, y),
        additions: 0,
        deletions: 0,
        staged: x !== ' ' && x !== '?'
      })
    }

    try {
      const numstat = await this.gitOn(target, ['diff', await this.baseOf(target), '--numstat', '--', '.', PLAN_EXCLUDE], [0, 128])
      const byPath = new Map<string, { additions: number; deletions: number }>()
      for (const line of numstat.stdout.split(/\r?\n/)) {
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const [added, deleted, ...pathParts] = parts
        const path = pathParts.join('\t')
        byPath.set(path, {
          additions: added === '-' ? 0 : Number(added) || 0,
          deletions: deleted === '-' ? 0 : Number(deleted) || 0
        })
      }
      for (const file of files) {
        const stats = byPath.get(file.path) || byPath.get(file.oldPath || '')
        if (stats) {
          file.additions = stats.additions
          file.deletions = stats.deletions
        }
      }
    } catch {
      // `git diff HEAD` fails before the first commit; status is still useful.
    }
    for (const file of files) {
      if (file.status !== 'untracked') continue
      try {
        const absolute = target.host.path.resolve(root, file.path)
        const info = await target.host.stat(absolute)
        if (!info || info.size > 3 * 1024 * 1024) continue
        const content = await target.host.readFile(absolute)
        if (content.subarray(0, 8_000).includes(0)) continue
        const textContent = content.toString('utf8')
        file.additions = textContent ? textContent.replace(/\r?\n$/, '').split(/\r?\n/).length : 0
      } catch {
        // Inaccessible file.
      }
    }

    return {
      isRepo: true,
      root,
      branch,
      ahead,
      behind,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      clean: files.length === 0,
      head: await this.headOf(target)
    }
  }

  private safePathFor(target: GitTarget, path: string, root: string): string {
    const { isAbsolute, resolve, sep } = target.host.path
    if (!path || isAbsolute(path)) throw new Error('Diff paths must be relative to the repository.')
    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error('Path escapes the repository.')
    }
    return absolute
  }

  async fileDiff(path: string): Promise<GitFileDiff> {
    return this.fileDiffOf(this.target(), path)
  }

  private async fileDiffOf(target: GitTarget, path: string): Promise<GitFileDiff> {
    const root = await this.rootOf(target)
    if (!root) throw new Error('The workspace is not a git repository.')
    const absolute = this.safePathFor(target, path, root)
    const status = await this.gitOn(target, ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--', path])
    const untracked = status.stdout.startsWith('??')
    let diff = ''
    if (!untracked) {
      const result = await this.gitOn(target, ['diff', await this.baseOf(target), '--no-ext-diff', '--unified=5', '--', path], [0, 1])
      diff = result.stdout
    }

    if (untracked) {
      const info = await target.host.stat(absolute)
      if (!info) {
        return { path, diff: '', binary: false, untracked: true, truncated: false }
      }
      const size = info.size
      if (size > 3 * 1024 * 1024) {
        return {
          path,
          diff: `New file ${path} (${Math.round(size / 1024)} KB) is too large to preview.`,
          binary: false,
          untracked: true,
          truncated: true
        }
      }
      const buffer = await target.host.readFile(absolute)
      const probe = buffer.subarray(0, 8_000)
      if (probe.includes(0)) {
        return { path, diff: `Binary file: ${path}`, binary: true, untracked: true, truncated: false }
      }
      const lines = buffer.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/)
      const capped = lines.slice(0, MAX_DIFF_LINES)
      diff = [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        `@@ -0,0 +1,${capped.length} @@`,
        ...capped.map((line) => `+${line}`)
      ].join('\n')
      if (capped.length < lines.length) diff += '\n… preview truncated'
    }

    const truncated = diff.length > MAX_DIFF_CHARS
    return {
      path,
      diff: truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated` : diff,
      binary: /^Binary files /m.test(diff),
      untracked,
      truncated
    }
  }

  async reviewDiff(maxChars = MAX_REVIEW_DIFF_CHARS): Promise<{ summary: GitSummary; diff: string; truncated: boolean }> {
    const target = this.target()
    const summary = await this.summaryOf(target)
    if (!summary.isRepo) throw new Error('The workspace is not a git repository.')
    const sections: string[] = []
    let size = 0
    for (const file of summary.files) {
      const detail = await this.fileDiffOf(target, file.path)
      const section = detail.diff || `--- ${file.status}: ${file.path}`
      sections.push(section)
      size += section.length + 2
      if (size > maxChars) break
    }
    const full = sections.join('\n\n')
    const truncated = full.length > maxChars
    return {
      summary,
      diff: truncated
        ? `${full.slice(0, maxChars)}\n\n… diff truncated at ${maxChars} characters`
        : full,
      truncated
    }
  }

  async restoreFile(path: string): Promise<GitSummary> {
    const target = this.target()
    const root = await this.rootOf(target)
    if (!root) throw new Error('The workspace is not a git repository.')
    this.safePathFor(target, path, root)
    const status = await this.gitOn(target, ['--no-optional-locks', 'status', '--porcelain=v1', '--', path])
    if (!status.stdout) throw new Error('File has no changes to restore.')
    const code = `${status.stdout[0]}${status.stdout[1]}`
    if (code.includes('?') || code === 'A ' || code === 'AM' || code.startsWith('R') || code.startsWith('C')) {
      throw new Error('Only tracked changes can be restored. Untracked or newly added files are left alone.')
    }
    await this.gitOn(target, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
    this.emitChanged()
    return this.summaryOf(target)
  }

  async commitAll(message: string): Promise<{ hash: string; summary: GitSummary }> {
    const target = this.target()
    const summary = await this.summaryOf(target)
    if (!summary.isRepo) throw new Error('The workspace is not a git repository.')
    if (summary.clean) throw new Error('There are no changes to commit.')
    const trimmed = message.trim()
    if (!trimmed) throw new Error('A commit message is required.')
    await this.excludeGoalsAt(target)
    await this.gitOn(target, ['add', '-A'])
    // goals/ is ignored once excluded; if it was tracked before, keep its edits out anyway.
    await this.gitOn(target, ['reset', '-q', '--', PLAN_DIR], [0, 1, 128])
    const staged = await this.gitOn(target, ['diff', '--cached', '--name-only'], [0, 1])
    if (!staged.stdout.trim()) throw new Error('Nothing was staged for commit.')
    await this.gitOn(target, ['commit', '-m', trimmed])
    const head = await this.gitOn(target, ['rev-parse', '--short', 'HEAD'])
    this.emitChanged()
    return { hash: head.stdout.trim(), summary: await this.summaryOf(target) }
  }

  /**
   * Keeps goals/ out of git without touching the shared .gitignore: adds it to
   * .git/info/exclude. Returns true when goals/ was already tracked, which
   * needs `git rm --cached` by the user.
   */
  async excludeGoals(): Promise<{ excluded: boolean; tracked: boolean }> {
    return this.excludeGoalsAt(this.target())
  }

  private async excludeGoalsAt(target: GitTarget): Promise<{ excluded: boolean; tracked: boolean }> {
    const host = target.host
    const root = await this.rootOf(target)
    if (!root) return { excluded: false, tracked: false }
    const rel = host.path
      .relative(await host.realpath(root), host.path.resolve(await host.realpath(target.path), PLAN_DIR))
      .split(host.path.sep)
      .join('/')
    if (rel.startsWith('..')) return { excluded: false, tracked: false }
    const pattern = `/${rel}/`
    const pathResult = await this.gitOn(target, ['rev-parse', '--git-path', 'info/exclude'])
    const excludeFile = host.path.resolve(target.path, pathResult.stdout.trim())
    const current = (await host.stat(excludeFile)) ? await host.readText(excludeFile) : ''
    if (!current.split(/\r?\n/).some((line) => line.trim() === pattern)) {
      await host.mkdirp(host.path.dirname(excludeFile))
      const prefix = current && !current.endsWith('\n') ? '\n' : ''
      await host.appendText(excludeFile, `${prefix}# ProHarness planning state (local only)\n${pattern}\n`)
    }
    const tracked = await this.gitOn(target, ['ls-files', '--', PLAN_DIR], [0])
    return { excluded: true, tracked: Boolean(tracked.stdout.trim()) }
  }

  private async headOf(target: GitTarget): Promise<string | null> {
    try {
      const result = await this.gitOn(target, ['rev-parse', '--short', 'HEAD'])
      return result.stdout.trim() || null
    } catch {
      return null
    }
  }

  onChanged(listener: (summary: GitSummary) => void): () => void {
    return this.watcher.subscribe(listener)
  }

  private emitChanged(): void {
    this.watcher.notify()
  }

  resetWatching(): void {
    this.watcher.reset()
  }

  dispose(): void {
    this.watcher.dispose()
  }
}
