type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta'

interface DiffLine {
  kind: DiffLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

export function parseDiff(diff: string, limit = 3000): { lines: DiffLine[]; truncated: boolean } {
  const raw = diff.split(/\r?\n/)
  const lines: DiffLine[] = []
  let oldNo: number | null = null
  let newNo: number | null = null
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

  for (const text of raw) {
    if (lines.length >= limit) return { lines, truncated: true }
    const hunk = text.match(hunkRe)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ kind: 'hunk', text, oldNo: null, newNo: null })
      continue
    }
    if (
      text.startsWith('diff --git') ||
      text.startsWith('index ') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file') ||
      text.startsWith('similarity ') ||
      text.startsWith('rename ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ')
    ) {
      lines.push({ kind: 'meta', text, oldNo: null, newNo: null })
      continue
    }
    if (text.startsWith('+')) {
      lines.push({ kind: 'add', text, oldNo: null, newNo })
      if (newNo !== null) newNo += 1
      continue
    }
    if (text.startsWith('-')) {
      lines.push({ kind: 'del', text, oldNo, newNo: null })
      if (oldNo !== null) oldNo += 1
      continue
    }
    if (text.startsWith(' ')) {
      lines.push({ kind: 'context', text, oldNo, newNo })
      if (oldNo !== null) oldNo += 1
      if (newNo !== null) newNo += 1
      continue
    }
    lines.push({ kind: 'meta', text, oldNo: null, newNo: null })
  }
  return { lines, truncated: false }
}
