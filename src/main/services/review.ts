import type { GoalDetail, TaskRef, Verdict } from '@shared/types'

export interface ReviewVerdict {
  verdict: Verdict
  summary: string
  notes: string
  parseWarning: string | null
}

export const REVIEWER_SYSTEM = [
  'You are an independent, skeptical senior code reviewer. You did not write this code.',
  'You may read files in the repository for context, but never modify anything.',
  'Always end your answer with the exact VERDICT/SUMMARY/FINDINGS format you are given.'
].join(' ')

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
    'Decide whether the working-tree diff below correctly and safely completes the task, without scope creep or regressions.',
    'Read surrounding files with your read-only tools when the diff alone is not enough. Do not edit files or run commands that change state.',
    '',
    `Goal: ${options.goal ? `${options.goal.title} (${options.goal.id})` : 'unknown'}`,
    taskBlock,
    '',
    'Design context (truncated):',
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
    '- APPROVE only when the diff is a plausible, complete implementation of the task with no obvious security, data-loss, or unrelated destructive changes.',
    '- REQUEST_CHANGES for missing behavior, broken builds, weak error handling, unsafe shell/file operations, or changes unrelated to the task.',
    '- Be concrete. Point to files and behaviors. Do not invent issues that are not visible in the code.',
    '- If the diff is empty, return REQUEST_CHANGES.',
    '',
    'End your answer in exactly this format:',
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

/** Parses the reviewer reply. Anything without a clear verdict fails closed. */
export function parseReview(text: string): ReviewVerdict {
  const trimmed = text.trim()
  const matches = [...trimmed.matchAll(/VERDICT\s*:\s*\**\s*(APPROVE|REQUEST[_\s-]*CHANGES)/gi)]
  const verdictMatch = matches[matches.length - 1]
  if (!verdictMatch) {
    return {
      verdict: 'REQUEST_CHANGES',
      summary: 'The reviewer did not return a machine-readable verdict.',
      notes: trimmed.slice(0, 12_000),
      parseWarning: 'Missing VERDICT line; treating the review as changes requested.'
    }
  }
  const verdict: Verdict = verdictMatch[1].toUpperCase().startsWith('APPROVE') ? 'APPROVE' : 'REQUEST_CHANGES'
  const tail = trimmed.slice(verdictMatch.index ?? 0)
  const summaryMatch = tail.match(/SUMMARY\s*:\s*([\s\S]*?)(?:\n\s*FINDINGS\s*:|$)/i)
  const findingsIndex = tail.search(/\n\s*FINDINGS\s*:/i)
  const findings = findingsIndex >= 0 ? tail.slice(findingsIndex).replace(/^\s*FINDINGS\s*:\s*/i, '') : tail
  return {
    verdict,
    summary: (summaryMatch?.[1] || '').trim().slice(0, 1_200),
    notes: `VERDICT: ${verdict}\n\n${findings.trim()}`.slice(0, 12_000),
    parseWarning: null
  }
}

/** True when two `provider/id` model keys refer to the same underlying model family. */
export function sameModel(a: string, b: string): boolean {
  const strip = (value: string): string =>
    value
      .toLowerCase()
      .replace(/:[a-z]+$/, '')
      .split('/')
      .slice(1)
      .join('/')
      .replace(/^.*\//, '')
      .replace(/-(fast|ultrafast|\d{8})$/, '')
  return Boolean(a && b) && strip(a) === strip(b)
}
