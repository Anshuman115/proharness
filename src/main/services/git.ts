import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { GitChangeStatus, GitFileChange, GitFileDiff, GitSummary } from '@shared/types'

const execFileAsync = promisify(execFile)

interface GitResult {
  stdout: string
  stderr: string
  code: number
}

const MAX_DIFF_CHARS = 700_000
const MAX_DIFF_LINES = 9_000
const MAX_REVIEW_DIFF_CHARS = 180_000

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

export class GitService {
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private poller: NodeJS.Timeout | null = null
  private lastSignature = ''
  private listeners = new Set<(summary: GitSummary) => void>()

  constructor(
    private readonly workspace: () => string
  ) {}

  private async git(args: string[], allowCodes: number[] = [0]): Promise<GitResult> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.workspace(),
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30_000,
        encoding: 'utf8'
      })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string }
      const code = typeof err.code === 'number' ? err.code : 1
      if (allowCodes.includes(code)) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', code }
      }
      throw new Error((err.stderr || err.message || 'git command failed').trim())
    }
  }

  private async root(): Promise<string | null> {
    if (!existsSync(this.workspace())) return null
    try {
      const result = await this.git(['rev-parse', '--show-toplevel'])
      return result.stdout.trim() || null
    } catch {
      return null
    }
  }

  async summary(): Promise<GitSummary> {
    const root = await this.root()
    if (!root) {
      return { isRepo: false, root: null, branch: null, ahead: 0, behind: 0, files: [], clean: true }
    }

    const branchResult = await this.git(['branch', '--show-current'], [0, 1])
    const branch = branchResult.stdout.trim() || null
    let ahead = 0
    let behind = 0
    try {
      const counts = await this.git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
      const [behindText, aheadText] = counts.stdout.trim().split(/\s+/)
      behind = Number(behindText) || 0
      ahead = Number(aheadText) || 0
    } catch {
      // No upstream configured.
    }

    const statusResult = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
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
      const numstat = await this.git(['diff', 'HEAD', '--numstat'], [0, 128])
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
        const absolute = resolve(root, file.path)
        if (statSync(absolute).size > 3 * 1024 * 1024) continue
        const content = readFileSync(absolute)
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
      clean: files.length === 0
    }
  }

  private safePath(path: string, root: string): string {
    if (!path || isAbsolute(path)) throw new Error('Diff paths must be relative to the repository.')
    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error('Path escapes the repository.')
    }
    return absolute
  }

  async fileDiff(path: string): Promise<GitFileDiff> {
    const root = await this.root()
    if (!root) throw new Error('The workspace is not a git repository.')
    const absolute = this.safePath(path, root)
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all', '--', path])
    const untracked = status.stdout.startsWith('??')
    let diff = ''
    if (!untracked) {
      const result = await this.git(['diff', 'HEAD', '--no-ext-diff', '--unified=5', '--', path], [0, 1])
      diff = result.stdout
    }

    if (untracked) {
      if (!existsSync(absolute)) {
        return { path, diff: '', binary: false, untracked: true, truncated: false }
      }
      const size = statSync(absolute).size
      if (size > 3 * 1024 * 1024) {
        return {
          path,
          diff: `New file ${path} (${Math.round(size / 1024)} KB) is too large to preview.`,
          binary: false,
          untracked: true,
          truncated: true
        }
      }
      const buffer = readFileSync(absolute)
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
    const summary = await this.summary()
    if (!summary.isRepo) throw new Error('The workspace is not a git repository.')
    const sections: string[] = []
    let size = 0
    for (const file of summary.files) {
      const detail = await this.fileDiff(file.path)
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
    const root = await this.root()
    if (!root) throw new Error('The workspace is not a git repository.')
    this.safePath(path, root)
    const status = await this.git(['status', '--porcelain=v1', '--', path])
    if (!status.stdout) throw new Error('File has no changes to restore.')
    const code = `${status.stdout[0]}${status.stdout[1]}`
    if (code.includes('?') || code === 'A ' || code === 'AM' || code.startsWith('R') || code.startsWith('C')) {
      throw new Error('Only tracked changes can be restored. Untracked or newly added files are left alone.')
    }
    await this.git(['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
    this.emitChanged()
    return this.summary()
  }

  async commitAll(message: string): Promise<{ hash: string; summary: GitSummary }> {
    const summary = await this.summary()
    if (!summary.isRepo) throw new Error('The workspace is not a git repository.')
    if (summary.clean) throw new Error('There are no changes to commit.')
    const trimmed = message.trim()
    if (!trimmed) throw new Error('A commit message is required.')
    await this.git(['add', '-A'])
    const staged = await this.git(['diff', '--cached', '--name-only'], [0, 1])
    if (!staged.stdout.trim()) throw new Error('Nothing was staged for commit.')
    await this.git(['commit', '-m', trimmed])
    const head = await this.git(['rev-parse', '--short', 'HEAD'])
    this.emitChanged()
    return { hash: head.stdout.trim(), summary: await this.summary() }
  }

  async head(): Promise<string | null> {
    try {
      const result = await this.git(['rev-parse', '--short', 'HEAD'])
      return result.stdout.trim() || null
    } catch {
      return null
    }
  }

  onChanged(listener: (summary: GitSummary) => void): () => void {
    this.listeners.add(listener)
    this.startWatching()
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      void this.summary()
        .then((summary) => {
          const signature = JSON.stringify(summary)
          if (signature === this.lastSignature) return
          this.lastSignature = signature
          for (const listener of this.listeners) listener(summary)
        })
        .catch(() => undefined)
    }, 350)
  }

  private startWatching(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.workspace(), { recursive: true }, (_event, filename) => {
        if (!filename) return
        const value = String(filename).replace(/\\/g, '/')
        if (value === '.git/index' || value === '.git/HEAD') {
          this.emitChanged()
          return
        }
        if (
          value.startsWith('.git') ||
          value.includes('node_modules') ||
          value.startsWith('out/') ||
          value.startsWith('.cache/') ||
          value.startsWith('release/') ||
          value.startsWith('dist/')
        ) {
          return
        }
        this.emitChanged()
      })
    } catch {
      // Recursive watching is unavailable on some Linux filesystems/Node builds.
      this.watcher = null
    }
    if (!this.watcher && !this.poller) {
      this.poller = setInterval(() => this.emitChanged(), 4_000)
      this.poller.unref()
    }
  }

  resetWatching(): void {
    this.dispose()
    this.lastSignature = ''
    if (this.listeners.size) this.startWatching()
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
  }
}
