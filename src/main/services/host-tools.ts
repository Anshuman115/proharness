import type { GoalDetail, TaskRef } from '@shared/types'
import type { HostTool } from '../omp/agent'
import type { GitService } from './git'
import type { PlanService } from './plan'

/** Plan tools are read/plan-only and never touch the code, so omp may run them without a prompt. */
export const PLAN_TOOL_NAMES = ['plan_list', 'plan_read', 'plan_next_task', 'plan_complete_task', 'plan_add_note', 'git_status'] as const

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
      const tasks = phase.tasks.map((task) => `- [${task.checked ? 'x' : ' '}] ${task.id} — ${task.title}`).join('\n')
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

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function required(args: Record<string, unknown>, key: string): string {
  const value = str(args[key])
  if (!value) throw new Error(`Missing required argument "${key}".`)
  return value
}

const obj = (properties: Record<string, unknown>, requiredKeys: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required: requiredKeys,
  additionalProperties: false
})

export function createPlanTools(options: {
  plan: PlanService
  git: GitService
  /** The autonomous loop owns check-off; its implementer does not get this tool. */
  allowComplete: boolean
}): HostTool[] {
  const { plan, git } = options
  const goalArg = { type: 'string', description: 'Goal folder id under goals/, e.g. checkout-redesign' }

  const tools: HostTool[] = [
    {
      name: 'plan_list',
      label: 'Plan: list goals',
      description: 'List the project goals under goals/ with progress and open-task counts.',
      parameters: obj({}),
      run: async () => {
        const goals = await plan.listGoals()
        if (!goals.length) return 'No goals found under goals/. A goal is a folder with DESIGN.md and PLAN.md.'
        return goals
          .map((goal) => `- ${goal.id}: ${goal.title} — ${goal.progress}% (${goal.openCount} open / ${goal.taskCount} tasks) — ${goal.status}`)
          .join('\n')
      }
    },
    {
      name: 'plan_read',
      label: 'Plan: read goal',
      description: 'Read a goal DESIGN.md and its PLAN.md checklist, or every goal when no id is given.',
      parameters: obj({ goal: goalArg }),
      run: async (args) => {
        const goal = str(args.goal)
        if (goal) return formatGoal(await plan.readGoal(goal))
        const goals = await plan.listGoals()
        if (!goals.length) return 'No goals found under goals/.'
        const formatted = await Promise.all(
          goals.map(async (summary) => {
            try {
              return formatGoal(await plan.readGoal(summary.id)).slice(0, 40_000)
            } catch (error) {
              return `${summary.id}: ${(error as Error).message}`
            }
          })
        )
        return formatted.join('\n\n---\n\n').slice(0, 160_000)
      }
    },
    {
      name: 'plan_next_task',
      label: 'Plan: next task',
      description: 'Return the next unchecked task in a goal, in phase order, with its design and plan paths.',
      parameters: obj({ goal: goalArg }, ['goal']),
      run: async (args) => {
        const goal = required(args, 'goal')
        return formatTask(await plan.readGoal(goal), await plan.nextTask(goal))
      }
    },
    {
      name: 'plan_add_note',
      label: 'Plan: add note',
      description: 'Append a short progress or review note beneath a task in a goal PLAN.md.',
      parameters: obj(
        { goal: goalArg, task_id: { type: 'string', description: 'Task id such as 1.2' }, note: { type: 'string' } },
        ['goal', 'task_id', 'note']
      ),
      run: async (args) => {
        const goal = required(args, 'goal')
        const taskId = required(args, 'task_id')
        await plan.addTaskNote(goal, taskId, required(args, 'note'))
        return `Added a note under ${goal}/${taskId}.`
      }
    },
    {
      name: 'git_status',
      label: 'Git status',
      description: 'Show the working tree: branch, changed files, and line counts.',
      parameters: obj({}),
      run: async () => {
        const summary = await git.summary()
        if (!summary.isRepo) return 'The workspace is not a git repository.'
        if (summary.clean) return `Branch ${summary.branch || '(detached)'} is clean.`
        return [
          `Branch: ${summary.branch || '(detached)'}`,
          `${summary.files.length} changed file(s):`,
          ...summary.files.map((file) => `- ${file.status.toUpperCase()} ${file.path} (+${file.additions} −${file.deletions})`)
        ].join('\n')
      }
    }
  ]

  if (options.allowComplete) {
    tools.splice(3, 0, {
      name: 'plan_complete_task',
      label: 'Plan: check off task',
      description: 'Check off a task in a goal PLAN.md. Use only after the work is implemented and verified.',
      parameters: obj(
        {
          goal: goalArg,
          task_id: { type: 'string', description: 'Task id such as 1.2' },
          note: { type: 'string', description: 'Optional short completion note' }
        },
        ['goal', 'task_id']
      ),
      run: async (args) => {
        const goal = required(args, 'goal')
        const taskId = required(args, 'task_id')
        const detail = await plan.setTaskChecked(goal, taskId, true, str(args.note) || undefined)
        return `Checked off ${taskId} in ${goal}. Progress ${detail.progress}% (${detail.openCount} open). Next: ${
          (await plan.nextTask(goal))?.taskTitle || 'none, goal complete'
        }`
      }
    })
  }
  return tools
}

export const PLAN_SYSTEM_PROMPT = [
  'This workspace is driven by ProHarness. Project plans live in goals/<goal>/DESIGN.md (design) and goals/<goal>/PLAN.md (phases with `- [ ]` task checklists).',
  'Use the plan_list, plan_read and plan_next_task tools to understand the plan before broad changes.',
  'Only check off a task with plan_complete_task after the work is implemented and verified.',
  'The goals/ folder is local planning state and is never committed; do not git add it.'
].join(' ')
