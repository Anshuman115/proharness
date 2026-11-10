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

  it('builds a prompt that names the task and requires a verdict', () => {
    const prompt = buildReviewPrompt({
      goal: { id: 'demo', title: 'Demo' },
      task: { goalId: 'demo', taskId: '1.1', taskTitle: 'Build it', phaseTitle: 'One' },
      design: '# Design',
      diff: '+ hello',
      diffTruncated: false
    })
    expect(prompt).toContain('Task: Build it')
    expect(prompt).toContain('VERDICT: APPROVE')
    expect(prompt).toContain('REQUEST_CHANGES')
  })
})
