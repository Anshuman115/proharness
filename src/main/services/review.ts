import type { GoalDetail, TaskRef } from '@shared/types'

export interface ReviewVerdict {
  verdict: 'APPROVE' | 'REQUEST_CHANGES'
  summary: string
  notes: string
  parseWarning: string | null
}

export function buildReviewPrompt(options: {
  goal: Pick<GoalDetail, 'id' | 'title'> | null
  task: TaskRef | null
  design: string
  diff: string
  diffTruncated: boolean
  extraInstructions?: string
}): string {
  const design = options.design.slice(0, 12_000)
  const taskBlock = options.task
    ? [
        `Task id: ${options.task.taskId}`,
        `Task: ${options.task.taskTitle}`,
        `Phase: ${options.task.phaseTitle}`
      ].join('\n')
    : 'No specific task was supplied. Review the entire working-tree change set.'
  return [
    'You are an independent senior code reviewer. You did not write this code.',
    'Your job is to decide whether the working-tree diff correctly and safely completes the task, without scope creep or regressions.',
    '',
    `Repository goal: ${options.goal ? `${options.goal.title} (${options.goal.id})` : 'unknown'}`,
    taskBlock,
    '',
    'Relevant design context (truncated):',
    '```markdown',
    design || '(no design document)',
    '```',
    '',
    'Working-tree diff:',
    '```diff',
    options.diff || '(no diff produced)',
    options.diffTruncated ? '\n… diff truncated before review' : '',
    '```',
    '',
    options.extraInstructions?.trim() || '',
    '',
    'Review rules:',
    '- APPROVE only when the diff is a plausible, complete implementation of the task and does not contain obvious security, data-loss, or unrelated destructive changes.',
    '- REQUEST_CHANGES for missing behavior, broken builds, weak error handling, unsafe shell/file operations, or changes unrelated to the task.',
    '- Be concrete. Point to files and behaviors. Do not invent issues that are not visible in the diff.',
    '- If the diff is empty, return REQUEST_CHANGES.',
    '',
    'Respond in exactly this format:',
    'VERDICT: APPROVE',
    'SUMMARY: one or two sentences',
    'FINDINGS:',
    '- concrete finding, or "- none"',
    '',
    'or:',
    'VERDICT: REQUEST_CHANGES',
    'SUMMARY: one or two sentences',
    'FINDINGS:',
    '- file or behavior: what must change'
  ]
    .filter((line, index, array) => line !== '' || array[index - 1] !== '')
    .join('\n')
}

export function parseReview(text: string): ReviewVerdict {
  const trimmed = text.trim()
  const verdictMatch = trimmed.match(/VERDICT\s*:\s*(APPROVE|REQUEST[_\s-]*CHANGES)/i)
  if (!verdictMatch) {
    return {
      verdict: 'REQUEST_CHANGES',
      summary: 'The reviewer did not return a machine-readable verdict.',
      notes: trimmed.slice(0, 12_000),
      parseWarning: 'Missing VERDICT line; treating the review as changes requested.'
    }
  }
  const verdict = verdictMatch[1].toUpperCase().startsWith('APPROVE')
    ? 'APPROVE'
    : 'REQUEST_CHANGES'
  const summaryMatch = trimmed.match(/SUMMARY\s*:\s*([\s\S]*?)(?:\n\s*FINDINGS\s*:|$)/i)
  const findingsIndex = trimmed.search(/\n\s*FINDINGS\s*:/i)
  const findings = findingsIndex >= 0 ? trimmed.slice(findingsIndex).replace(/^\s*FINDINGS\s*:\s*/i, '') : trimmed
  return {
    verdict,
    summary: (summaryMatch?.[1] || '').trim().slice(0, 1_200),
    notes: `VERDICT: ${verdict}\n\n${findings.trim()}`.slice(0, 12_000),
    parseWarning: null
  }
}
