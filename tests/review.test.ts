import { describe, expect, it } from 'vitest'
import { buildReviewPrompt, parseReview } from '../src/main/services/review'

describe('review parsing', () => {
  it('parses an approval', () => {
    const review = parseReview('VERDICT: APPROVE\nSUMMARY: Looks good.\nFINDINGS:\n- none')
    expect(review.verdict).toBe('APPROVE')
    expect(review.summary).toBe('Looks good.')
    expect(review.notes).toContain('none')
    expect(review.parseWarning).toBeNull()
  })

  it('parses requested changes', () => {
    const review = parseReview('VERDICT: REQUEST_CHANGES\nSUMMARY: Missing guard.\nFINDINGS:\n- src/a.ts: handle null')
    expect(review.verdict).toBe('REQUEST_CHANGES')
    expect(review.notes).toContain('handle null')
  })

  it('fails closed when the verdict is missing', () => {
    const review = parseReview('I think this is probably fine.')
    expect(review.verdict).toBe('REQUEST_CHANGES')
    expect(review.parseWarning).toBeTruthy()
  })

  it('uses the last verdict when the reviewer quotes the format first', () => {
    const text = 'The format is VERDICT: APPROVE or VERDICT: REQUEST_CHANGES.\n\nVERDICT: REQUEST_CHANGES\nSUMMARY: no\nFINDINGS:\n- x'
    expect(parseReview(text).verdict).toBe('REQUEST_CHANGES')
  })

  it('gives the reviewer the task, design, diff and required verdict format', () => {
    const prompt = buildReviewPrompt({
      goal: { id: 'demo', title: 'Demo' },
      task: { goalId: 'demo', taskId: '1.1', taskTitle: 'Build it', phaseTitle: 'One' },
      design: '# Design\nUse the queue.',
      diff: '+ hello',
      diffTruncated: false
    })
    expect(prompt).toContain('Task id: 1.1')
    expect(prompt).toContain('Task: Build it')
    expect(prompt).toContain('Phase: One')
    expect(prompt).toContain('# Design\nUse the queue.')
    expect(prompt).toContain('+ hello')
    expect(prompt).toContain('VERDICT: APPROVE')
    expect(prompt).toContain('REQUEST_CHANGES')
    expect(prompt).not.toContain('diff truncated before review')
  })

  it('marks a truncated diff and handles a missing task or goal', () => {
    const prompt = buildReviewPrompt({
      goal: null,
      task: null,
      design: '',
      diff: '',
      diffTruncated: true
    })
    expect(prompt).toContain('Goal: unknown')
    expect(prompt).toContain('No specific task was supplied')
    expect(prompt).toContain('(no design document)')
    expect(prompt).toContain('(no diff produced)')
    expect(prompt).toContain('diff truncated before review')
  })
})
