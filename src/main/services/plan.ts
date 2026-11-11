import { basename } from 'node:path'
import { DESIGN_FILE, PLAN_DIR, PLAN_FILE } from '@shared/defaults'
import type {
  GoalDetail,
  GoalSummary,
  PlanPhase,
  TaskRef
} from '@shared/types'
import type { WorkspaceHost } from '../host/host'
import { PollingWatcher } from './polling-watcher'

interface Frontmatter {
  data: Record<string, string>
  body: string
}

const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

function parseFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return { data: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: raw }
  const header = raw.slice(3, end).trim()
  const data: Record<string, string> = {}
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (match) data[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return { data, body: raw.slice(end + 4).replace(/^\r?\n/, '') }
}

function firstHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m)
  return match ? stripInline(match[1]) : null
}

function stripInline(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function firstParagraph(body: string): string {
  const lines = body
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  let collecting = false
  const out: string[] = []
  for (const line of lines) {
    if (!collecting) {
      if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('|')) continue
      collecting = true
    }
    if (!line) break
    if (line.startsWith('#')) break
    out.push(line)
    if (out.join(' ').length > 240) break
  }
  return stripInline(out.join(' ')).slice(0, 240)
}

function taskIdentity(rest: string): { id: string | null; title: string } {
  const patterns: Array<[RegExp, number, number]> = [
    [/^\*\*([^*]+)\*\*\s*(.*)$/, 1, 2],
    [/^`([^`]+)`\s*[—:-]?\s*(.*)$/, 1, 2],
    [/^\[([^\]]+)\]\s*[—:-]?\s*(.*)$/, 1, 2],
    [/^([A-Za-z][A-Za-z0-9._-]*\d[A-Za-z0-9._-]*)\s*[—:-]\s*(.*)$/, 1, 2],
    [/^(\d+(?:\.\d+)+)[.)]?\s+(.*)$/, 1, 2]
  ]
  for (const [regex, idIndex, titleIndex] of patterns) {
    const match = rest.match(regex)
    if (match) {
      const id = match[idIndex].trim()
      const title = stripInline(match[titleIndex] || rest)
      if (id && title) return { id, title }
    }
  }
  return { id: null, title: stripInline(rest) }
}

function parsePhases(plan: string): PlanPhase[] {
  const lines = plan.split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    for (let i = 0; i <= end; i += 1) lines[i] = ''
  }
  const phases: PlanPhase[] = []
  let current: PlanPhase | null = null
  const seenIds = new Set<string>()
  let inFence = false

  const pushPhase = (title: string): PlanPhase => {
    const index = phases.length + 1
    const phase: PlanPhase = {
      id: `phase-${index}`,
      title: title || `Phase ${index}`,
      index,
      tasks: [],
      done: 0,
      total: 0
    }
    phases.push(phase)
    return phase
  }

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      const rawTitle = stripInline(heading[1]).replace(/^Phase\s+\d+\s*[—:-]?\s*/i, '')
      current = pushPhase(rawTitle)
      return
    }

    const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (!task) return
    if (!current) current = pushPhase('Tasks')
    const identity = taskIdentity(task[3])
    let id = identity.id || `p${current.index}-t${current.tasks.length + 1}`
    if (seenIds.has(id)) {
      let n = 2
      while (seenIds.has(`${id}-${n}`)) n += 1
      id = `${id}-${n}`
    }
    seenIds.add(id)
    const noteLines: string[] = []
    for (let j = index + 1; j < lines.length; j += 1) {
      const cursor = lines[j]
      if (/^\s*[-*]\s+\[[ xX]\]/.test(cursor) || /^#{1,2}\s+/.test(cursor) || /^\s*$/.test(cursor)) {
        break
      }
      if (/^\s{2,}[-*]\s+/.test(cursor)) {
        noteLines.push(stripInline(cursor.replace(/^\s{2,}[-*]\s+/, '')))
        continue
      }
      break
    }
    current.tasks.push({
      id,
      title: identity.title,
      checked: task[2].toLowerCase() === 'x',
      phaseId: current.id,
      phaseTitle: current.title,
      line: index + 1,
      note: noteLines.length ? noteLines.join('\n') : null
    })
  })

  if (phases.length === 0) pushPhase('Tasks')

  for (const phase of phases) {
    phase.total = phase.tasks.length
    phase.done = phase.tasks.filter((task) => task.checked).length
  }

  return phases
}

function summarizeGoal(
  id: string,
  design: string,
  plan: string,
  designPath: string,
  planPath: string,
  updatedAt: number
): GoalSummary {
  const front = parseFrontmatter(design)
  const planFront = parseFrontmatter(plan)
  const phases = parsePhases(plan)
  const tasks = phases.flatMap((phase) => phase.tasks)
  const done = tasks.filter((task) => task.checked).length
  const title =
    front.data.title ||
    planFront.data.title ||
    firstHeading(front.body) ||
    firstHeading(planFront.body) ||
    basename(designPath, '.md')
  const summary = front.data.summary || planFront.data.summary || firstParagraph(front.body)
  const taskCount = tasks.length
  const openCount = taskCount - done
  const status =
    front.data.status ||
    planFront.data.status ||
    (taskCount > 0 && openCount === 0 ? 'complete' : 'active')

  return {
    id,
    title,
    summary,
    status,
    designPath,
    planPath,
    phaseCount: phases.length,
    taskCount,
    openCount,
    progress: taskCount === 0 ? 0 : Math.round((done / taskCount) * 100),
    updatedAt
  }
}

export class PlanService {
  private readonly watcher = new PollingWatcher<GoalSummary[]>({
    load: () => this.listGoals(),
    signature: (goals) => JSON.stringify(goals.map((goal) => [goal.id, goal.updatedAt, goal.openCount])),
    interval: () => this.host().pollMs.plan,
    debounceMs: 120,
    forceNotify: true
  })

  constructor(
    private readonly host: () => WorkspaceHost,
    private readonly workspace: () => string
  ) {}

  get goalsRoot(): string {
    return this.host().path.join(this.workspace(), PLAN_DIR)
  }

  async ensureRoot(): Promise<void> {
    const host = this.host()
    await host.mkdirp(this.goalsRoot)
    const readme = host.path.join(this.goalsRoot, 'README.md')
    if (!(await host.stat(readme))) {
      await host.writeText(
        readme,
        [
          '# Goals',
          '',
          'Each goal is a folder with a `DESIGN.md` and a `PLAN.md` split into phases and task checklists.',
          '',
          '```',
          'goals/',
          '  my-goal/',
          '    DESIGN.md',
          '    PLAN.md',
          '```',
          '',
          'Tasks use `- [ ]` checkboxes. Give each task a stable id with bold text:',
          '',
          '```md',
          '## Phase 1 — Foundation',
          '- [ ] **1.1** Build the first thing',
          '- [ ] **1.2** Build the second thing',
          '```',
          ''
        ].join('\n')
      )
    }
  }

  /** Scaffolds goals/<slug>/ with a DESIGN.md and an empty phase in PLAN.md. */
  async createGoal(title: string): Promise<GoalSummary> {
    const clean = title.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('Give the goal a title.')
    const base =
      clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'goal'
    const host = this.host()
    await this.ensureRoot()
    let id = base
    for (let n = 2; await host.stat(host.path.join(this.goalsRoot, id)); n += 1) id = `${base}-${n}`
    const dir = host.path.join(this.goalsRoot, id)
    await host.mkdirp(dir)
    await host.writeText(
      host.path.join(dir, DESIGN_FILE),
      [
        '---',
        'status: draft',
        '---',
        `# ${clean}`,
        '',
        'One paragraph on what this goal delivers and why.',
        '',
        '## Scope',
        '',
        '- In: ',
        '- Out: ',
        '',
        '## Approach',
        '',
        'Key decisions, interfaces, and risks.',
        ''
      ].join('\n')
    )
    await host.writeText(
      host.path.join(dir, PLAN_FILE),
      [`# ${clean} — plan`, '', '## Phase 1 — Foundation', '', '- [ ] **1.1** First task', ''].join('\n')
    )
    this.resetWatching()
    this.emitChanged()
    const summary = (await this.listGoals()).find((goal) => goal.id === id)
    if (!summary) throw new Error('The goal was created but could not be read back.')
    return summary
  }

  private async ensureGoal(goalId: string): Promise<string> {
    if (!GOAL_ID_RE.test(goalId)) throw new Error('Invalid goal id.')
    const host = this.host()
    const dir = host.path.resolve(this.goalsRoot, goalId)
    if (!dir.startsWith(host.path.resolve(this.goalsRoot) + host.path.sep)) throw new Error('Invalid goal path.')
    const info = await host.stat(dir)
    if (!info || !info.isDirectory) {
      throw new Error(`Goal "${goalId}" was not found under goals/.`)
    }
    return dir
  }

  async listGoals(): Promise<GoalSummary[]> {
    const host = this.host()
    if (!(await host.stat(this.goalsRoot))) return []
    const entries = await host.readdir(this.goalsRoot)

    const goals: GoalSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue
      const id = entry.name
      if (!GOAL_ID_RE.test(id)) continue
      const dir = host.path.join(this.goalsRoot, id)
      const designPath = host.path.join(dir, DESIGN_FILE)
      const planPath = host.path.join(dir, PLAN_FILE)
      const designInfo = await host.stat(designPath)
      if (!designInfo) continue
      try {
        const design = await host.readText(designPath)
        const planInfo = await host.stat(planPath)
        const plan = planInfo ? await host.readText(planPath) : ''
        const updatedAt = Math.max(designInfo.mtimeMs, planInfo?.mtimeMs ?? 0)
        goals.push(summarizeGoal(id, design, plan, designPath, planPath, updatedAt))
      } catch {
        // A malformed goal should not hide the rest of the plan.
      }
    }
    return goals.sort((a, b) => a.title.localeCompare(b.title))
  }

  async readGoal(goalId: string): Promise<GoalDetail> {
    const host = this.host()
    const dir = await this.ensureGoal(goalId)
    const designPath = host.path.join(dir, DESIGN_FILE)
    const planPath = host.path.join(dir, PLAN_FILE)
    const designInfo = await host.stat(designPath)
    if (!designInfo) throw new Error(`Goal "${goalId}" has no DESIGN.md.`)
    const design = await host.readText(designPath)
    const planInfo = await host.stat(planPath)
    const plan = planInfo ? await host.readText(planPath) : ''
    const phases = parsePhases(plan)
    const summary = summarizeGoal(
      goalId,
      design,
      plan,
      designPath,
      planPath,
      Math.max(designInfo.mtimeMs, planInfo?.mtimeMs ?? 0)
    )
    return { ...summary, design, plan, phases }
  }

  async nextTask(goalId: string): Promise<TaskRef | null> {
    const detail = await this.readGoal(goalId)
    for (const phase of detail.phases) {
      const task = phase.tasks.find((candidate) => !candidate.checked)
      if (task) {
        return {
          goalId,
          taskId: task.id,
          taskTitle: task.title,
          phaseTitle: phase.title
        }
      }
    }
    return null
  }

  private async writePlan(goalId: string, content: string): Promise<void> {
    const dir = await this.ensureGoal(goalId)
    const target = this.host().path.join(dir, PLAN_FILE)
    await this.host().writeText(target, content)
    this.emitChanged()
  }

  async setTaskChecked(goalId: string, taskId: string, checked: boolean, note?: string): Promise<GoalDetail> {
    const detail = await this.readGoal(goalId)
    const task = detail.phases.flatMap((phase) => phase.tasks).find((item) => item.id === taskId)
    if (!task) throw new Error(`Task "${taskId}" was not found in ${goalId}.`)
    const eol = detail.plan.includes('\r\n') ? '\r\n' : '\n'
    const lines = detail.plan.split(/\r?\n/)
    const line = lines[task.line - 1]
    if (line === undefined) throw new Error('Task line moved while updating the plan.')
    lines[task.line - 1] = line.replace(/\[([ xX])\]/, checked ? '[x]' : '[ ]')
    if (checked && note) {
      const completion = `  - ${new Date().toISOString().slice(0, 10)} — ${note.replace(/\s+/g, ' ').trim()}`
      const next = lines[task.line]
      if (next !== completion) lines.splice(task.line, 0, completion)
    }
    await this.writePlan(goalId, lines.join(eol))
    return this.readGoal(goalId)
  }

  async addTaskNote(goalId: string, taskId: string, note: string): Promise<GoalDetail> {
    if (!note.trim()) throw new Error('A note is required.')
    const detail = await this.readGoal(goalId)
    const task = detail.phases.flatMap((phase) => phase.tasks).find((item) => item.id === taskId)
    if (!task) throw new Error(`Task "${taskId}" was not found in ${goalId}.`)
    const eol = detail.plan.includes('\r\n') ? '\r\n' : '\n'
    const lines = detail.plan.split(/\r?\n/)
    const entry = `  - ${note.replace(/\s+/g, ' ').trim()}`
    let insertAt = task.line
    while (
      insertAt < lines.length &&
      /^\s{2,}[-*]\s+/.test(lines[insertAt]) &&
      !/^\s*[-*]\s+\[[ xX]\]/.test(lines[insertAt])
    ) {
      insertAt += 1
    }
    lines.splice(insertAt, 0, entry)
    await this.writePlan(goalId, lines.join(eol))
    return this.readGoal(goalId)
  }

  onChange(listener: (goals: GoalSummary[]) => void): () => void {
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
