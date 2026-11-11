import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type {
  GoalDetail,
  GoalSummary,
  PlanPhase,
  TaskRef
} from '@shared/types'

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

  if (phases.length === 0) phases.push(pushPhase('Tasks'))

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
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null
  private listeners = new Set<(goals: GoalSummary[]) => void>()

  constructor(
    private readonly workspace: () => string
  ) {}

  get goalsRoot(): string {
    return join(this.workspace(), 'goals')
  }

  ensureRoot(): void {
    mkdirSync(this.goalsRoot, { recursive: true })
    const readme = join(this.goalsRoot, 'README.md')
    if (!existsSync(readme)) {
      writeFileSync(
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
        ].join('\n'),
        'utf8'
      )
    }
  }

  ensureGoal(goalId: string): string {
    if (!GOAL_ID_RE.test(goalId)) throw new Error('Invalid goal id.')
    const dir = resolve(this.goalsRoot, goalId)
    if (!dir.startsWith(resolve(this.goalsRoot) + sep)) throw new Error('Invalid goal path.')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`Goal "${goalId}" was not found under goals/.`)
    }
    return dir
  }

  listGoals(): GoalSummary[] {
    if (!existsSync(this.goalsRoot)) return []
    let entries
    try {
      entries = readdirSync(this.goalsRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const goals: GoalSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const id = entry.name
      if (!GOAL_ID_RE.test(id)) continue
      const dir = join(this.goalsRoot, id)
      const designPath = join(dir, 'DESIGN.md')
      const planPath = join(dir, 'PLAN.md')
      if (!existsSync(designPath)) continue
      try {
        const design = readFileSync(designPath, 'utf8')
        const plan = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''
        const updatedAt = Math.max(
          statSync(designPath).mtimeMs,
          existsSync(planPath) ? statSync(planPath).mtimeMs : 0
        )
        goals.push(summarizeGoal(id, design, plan, designPath, planPath, updatedAt))
      } catch {
        // A malformed goal should not hide the rest of the plan.
      }
    }
    return goals.sort((a, b) => a.title.localeCompare(b.title))
  }

  readGoal(goalId: string): GoalDetail {
    const dir = this.ensureGoal(goalId)
    const designPath = join(dir, 'DESIGN.md')
    const planPath = join(dir, 'PLAN.md')
    if (!existsSync(designPath)) throw new Error(`Goal "${goalId}" has no DESIGN.md.`)
    const design = readFileSync(designPath, 'utf8')
    const plan = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''
    const phases = parsePhases(plan)
    const summary = summarizeGoal(
      goalId,
      design,
      plan,
      designPath,
      planPath,
      Math.max(statSync(designPath).mtimeMs, existsSync(planPath) ? statSync(planPath).mtimeMs : 0)
    )
    return { ...summary, design, plan, phases }
  }

  nextTask(goalId: string): TaskRef | null {
    const detail = this.readGoal(goalId)
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

  private writePlan(goalId: string, content: string): void {
    const dir = this.ensureGoal(goalId)
    const target = join(dir, 'PLAN.md')
    const tmp = `${target}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, target)
    this.emitChanged()
  }

  setTaskChecked(goalId: string, taskId: string, checked: boolean, note?: string): GoalDetail {
    const detail = this.readGoal(goalId)
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
    this.writePlan(goalId, lines.join(eol))
    return this.readGoal(goalId)
  }

  addTaskNote(goalId: string, taskId: string, note: string): GoalDetail {
    if (!note.trim()) throw new Error('A note is required.')
    const detail = this.readGoal(goalId)
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
    this.writePlan(goalId, lines.join(eol))
    return this.readGoal(goalId)
  }

  onChange(listener: (goals: GoalSummary[]) => void): () => void {
    this.listeners.add(listener)
    this.startWatching()
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      const goals = this.listGoals()
      for (const listener of this.listeners) listener(goals)
    }, 120)
  }

  private startWatching(): void {
    if (this.watcher) return
    if (!existsSync(this.goalsRoot)) return
    try {
      this.watcher = watch(this.goalsRoot, { recursive: true }, () => this.emitChanged())
    } catch {
      // Some filesystems do not support recursive watches. Mutations still
      // notify listeners directly.
      this.watcher = null
    }
  }

  resetWatching(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    if (this.listeners.size) this.startWatching()
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
  }
}
