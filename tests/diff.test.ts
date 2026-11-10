import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/renderer/src/lib/diff'

describe('diff parser', () => {
  it('tracks line numbers and line kinds', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' four'
    ].join('\n')
    const { lines, truncated } = parseDiff(diff)
    expect(truncated).toBe(false)
    expect(lines.find((line) => line.text === '-two')).toMatchObject({ kind: 'del', oldNo: 2 })
    expect(lines.find((line) => line.text === '+TWO')).toMatchObject({ kind: 'add', newNo: 2 })
    expect(lines.find((line) => line.text === '+three')).toMatchObject({ kind: 'add', newNo: 3 })
    expect(lines.find((line) => line.text === ' four')).toMatchObject({ kind: 'context', oldNo: 3, newNo: 4 })
  })

  it('caps very large diffs', () => {
    const diff = ['@@ -1,1 +1,1 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join('\n')
    const parsed = parseDiff(diff, 10)
    expect(parsed.truncated).toBe(true)
    expect(parsed.lines).toHaveLength(10)
  })
})
