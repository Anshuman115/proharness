import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  PROVIDER_IDS,
  type GoalDetail,
  type ProviderId,
  type TaskRef
} from '@shared/types'
import type { GitService } from './git'
import type { PlanService } from './plan'
import type { ProviderService } from './providers'
import { buildReviewPrompt, parseReview } from './review'

function text(value: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: value }] }
}

function failure(value: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text: value }], isError: true }
}

function formatTask(goal: GoalDetail, task: TaskRef | null): string {
  if (!task) return `Goal ${goal.id} has no open tasks.`
  return [
    `Goal: ${goal.title} (${goal.id})`,
    `Phase: ${task.phaseTitle}`,
    `Task: ${task.taskTitle}`,
    `Task id: ${task.taskId}`,
    `Progress: ${goal.progress}% (${goal.taskCount - goal.openCount}/${goal.taskCount} tasks)`,
    `Design: ${goal.designPath}`,
    `Plan: ${goal.planPath}`
  ].join('\n')
}

function formatGoal(goal: GoalDetail): string {
  const phases = goal.phases
    .map((phase) => {
      const tasks = phase.tasks
        .map((task) => `- [${task.checked ? 'x' : ' '}] ${task.id} — ${task.title}`)
        .join('\n')
      return `## ${phase.title}\n${tasks || '(no tasks)'}`
    })
    .join('\n\n')
  return [
    `# Goal: ${goal.title} (${goal.id})`,
    `Status: ${goal.status}`,
    `Progress: ${goal.progress}% — ${goal.taskCount - goal.openCount}/${goal.taskCount} tasks complete`,
    `Design: ${goal.designPath}`,
    `Plan: ${goal.planPath}`,
    '',
    '## DESIGN.md',
    goal.design.slice(0, 80_000),
    '',
    '## PLAN.md',
    phases.slice(0, 80_000)
  ].join('\n')
}

function providerGuess(prompt: string): ProviderId {
  const match = prompt.match(/\b(openai|deepseek|kimi)\b/i)
  return match ? (match[1].toLowerCase() as ProviderId) : 'deepseek'
}

export function createProHarnessMcpServer(options: {
  planService: PlanService
  gitService: GitService
  providerService: ProviderService
  defaultProvider: () => ProviderId
  defaultReviewerModel: () => string
}) {
  const { planService, gitService, providerService } = options

  const tools = [
    tool(
      'plan_list',
      'List all project goals under goals/ with progress and open-task counts.',
      {},
      async () => {
        const goals = planService.listGoals()
        if (!goals.length) return text('No goals found under goals/. Add a goal folder with DESIGN.md and PLAN.md.')
        return text(
          goals
            .map(
              (goal) =>
                `- ${goal.id}: ${goal.title} — ${goal.progress}% (${goal.openCount} open / ${goal.taskCount} tasks) — ${goal.status}`
            )
            .join('\n')
        )
      }
    ),

    tool(
      'plan_read',
      'Read one goal DESIGN.md and PLAN.md, or all goals when no goal id is given.',
      { goal: z.string().optional().describe('Goal folder id under goals/, e.g. proharness-desktop') },
      async ({ goal }) => {
        try {
          if (goal) return text(formatGoal(planService.readGoal(goal)))
          const goals = planService.listGoals()
          if (!goals.length) return text('No goals found under goals/.')
          const sections = goals.map((summary) => {
            try {
              return formatGoal(planService.readGoal(summary.id)).slice(0, 40_000)
            } catch (error) {
              return `${summary.id}: ${(error as Error).message}`
            }
          })
          return text(sections.join('\n\n---\n\n').slice(0, 160_000))
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'plan_next_task',
      'Return the next unchecked task in a goal, in phase order, with its design and plan paths.',
      { goal: z.string().describe('Goal folder id under goals/') },
      async ({ goal }) => {
        try {
          const detail = planService.readGoal(goal)
          return text(formatTask(detail, planService.nextTask(goal)))
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'plan_complete_task',
      'Check off a task in a goal PLAN.md. Use only after the work is implemented and verified.',
      {
        goal: z.string().describe('Goal folder id under goals/'),
        task_id: z.string().describe('Stable task id such as 1.1 or phase-1.2'),
        note: z.string().optional().describe('Optional short completion note')
      },
      async ({ goal, task_id, note }) => {
        try {
          const detail = planService.setTaskChecked(goal, task_id, true, note)
          return text(
            `Checked off ${task_id} in ${goal}. Progress is now ${detail.progress}% (${detail.openCount} open).\nNext task: ${
              planService.nextTask(goal)?.taskTitle || 'none — goal complete'
            }`
          )
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'plan_add_note',
      'Append a short progress or review note beneath a task in a goal PLAN.md.',
      {
        goal: z.string().describe('Goal folder id under goals/'),
        task_id: z.string().describe('Stable task id'),
        note: z.string().describe('Short note to record')
      },
      async ({ goal, task_id, note }) => {
        try {
          planService.addTaskNote(goal, task_id, note)
          return text(`Added note under ${goal}/${task_id}.`)
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'git_status',
      'Show the working tree status: branch, changed files, and line counts.',
      {},
      async () => {
        try {
          const summary = await gitService.summary()
          if (!summary.isRepo) return text('The workspace is not a git repository.')
          if (summary.clean) return text(`Branch ${summary.branch || '(detached)'} is clean.`)
          return text(
            [
              `Branch: ${summary.branch || '(detached)'}`,
              `${summary.files.length} changed file(s):`,
              ...summary.files.map(
                (file) =>
                  `- ${file.status.toUpperCase()} ${file.path} (+${file.additions} −${file.deletions})`
              )
            ].join('\n')
          )
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'delegate_model',
      'Send a task to another model (OpenAI, DeepSeek, or Kimi) and return its answer. Use for independent review, a second opinion, or non-Claude drafting.',
      {
        provider: z.enum(PROVIDER_IDS).optional().describe('Provider to call'),
        model: z.string().optional().describe('Provider model id'),
        system: z.string().optional().describe('Optional system prompt'),
        prompt: z.string().describe('Complete prompt for the other model')
      },
      async ({ provider, model, system, prompt }) => {
        const chosen = provider || options.defaultProvider() || providerGuess(prompt)
        try {
          const result = await providerService.complete({
            provider: chosen,
            model: model || (chosen === options.defaultProvider() ? options.defaultReviewerModel() : undefined),
            system,
            prompt,
            maxTokens: 8_000
          })
          return text(`${chosen} reply:\n\n${result.text.slice(0, 100_000)}`)
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    ),

    tool(
      'review_changes',
      'Ask another model to review the current git working-tree diff, optionally against a specific goal task.',
      {
        provider: z.enum(PROVIDER_IDS).optional().describe('Reviewer provider'),
        model: z.string().optional().describe('Reviewer model'),
        goal: z.string().optional().describe('Goal id for design context'),
        task_id: z.string().optional().describe('Task id for review scope'),
        instructions: z.string().optional().describe('Extra review focus')
      },
      async ({ provider, model, goal, task_id, instructions }) => {
        const chosen = provider || options.defaultProvider()
        try {
          const { summary, diff, truncated } = await gitService.reviewDiff()
          if (!summary.files.length) return text('No changes to review.')
          let detail: GoalDetail | null = null
          let task: TaskRef | null = null
          if (goal) {
            detail = planService.readGoal(goal)
            if (task_id) {
              const found = detail.phases.flatMap((phase) => phase.tasks).find((item) => item.id === task_id)
              if (found) {
                task = {
                  goalId: goal,
                  taskId: found.id,
                  taskTitle: found.title,
                  phaseTitle: found.phaseTitle
                }
              }
            }
          }
          const prompt = buildReviewPrompt({
            goal: detail ? { id: detail.id, title: detail.title } : null,
            task,
            design: detail?.design || '',
            diff,
            diffTruncated: truncated,
            extraInstructions: instructions
          })
          const result = await providerService.complete({
            provider: chosen,
            model: model || (chosen === options.defaultProvider() ? options.defaultReviewerModel() : undefined),
            system: 'You are a precise, skeptical senior code reviewer. Follow the required output format exactly.',
            prompt,
            maxTokens: 8_000
          })
          const review = parseReview(result.text)
          return text(
            [
              `Reviewer: ${chosen} / ${model || options.defaultReviewerModel()}`,
              `Verdict: ${review.verdict}`,
              review.summary ? `Summary: ${review.summary}` : '',
              '',
              review.notes,
              review.parseWarning ? `\nWarning: ${review.parseWarning}` : ''
            ]
              .filter(Boolean)
              .join('\n')
          )
        } catch (error) {
          return failure((error as Error).message)
        }
      }
    )
  ]

  return createSdkMcpServer({
    name: 'proharness',
    version: '0.1.0',
    instructions: [
      'ProHarness is a desktop control room for Claude Code.',
      'Project plans live under goals/<goal>/DESIGN.md with phases and checklists in goals/<goal>/PLAN.md.',
      'Use plan_list/plan_read to understand the plan, plan_next_task to choose work, and plan_complete_task only after implementation and verification.',
      'Use delegate_model and review_changes to ask OpenAI, DeepSeek, or Kimi for a second opinion.',
      'Never check off a task unless the work is complete. Do not commit unless the user or the automatic loop explicitly asks you to.'
    ].join(' '),
    tools,
    alwaysLoad: true,
    timeout: 300_000
  })
}
