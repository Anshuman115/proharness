import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanService } from '../src/main/services/plan'

let root = ''
let service: PlanService

const design = `---
title: Demo Goal
summary: A demo goal for parser tests.
status: active
---

# Demo Goal

Demo intent.
`

const plan = `# Demo plan

## Phase 1 — Foundation

- [x] **1.1** Already done
- [ ] **1.2** Next thing
  - existing note

## Phase 2 — Delivery

- [ ] **2.1** Ship it
- [ ] No stable id task
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proharness-plan-'))
  mkdirSync(join(root, 'goals', 'demo'), { recursive: true })
  writeFileSync(join(root, 'goals', 'demo', 'DESIGN.md'), design)
  writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), plan)
  service = new PlanService(() => root)
})

afterEach(() => {
  service.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('PlanService', () => {
  it('lists and parses phases, tasks, progress and next task', () => {
    const goals = service.listGoals()
    expect(goals).toHaveLength(1)
    expect(goals[0]).toMatchObject({
      id: 'demo',
      title: 'Demo Goal',
      taskCount: 4,
      openCount: 3,
      phaseCount: 2,
      progress: 25
    })

    const detail = service.readGoal('demo')
    expect(detail.phases[0].tasks[1]).toMatchObject({
      id: '1.2',
      title: 'Next thing',
      checked: false,
      note: 'existing note'
    })

    expect(service.nextTask('demo')).toMatchObject({
      taskId: '1.2',
      taskTitle: 'Next thing',
      phaseTitle: 'Foundation'
    })
  })

  it('checks a task off atomically and preserves the rest of the plan', () => {
    const detail = service.setTaskChecked('demo', '1.2', true)
    expect(detail.openCount).toBe(2)
    const raw = readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
    expect(raw).toContain('- [x] **1.2** Next thing')
    expect(raw).toContain('- [ ] **2.1** Ship it')
    expect(raw).toContain('  - existing note')
  })

  it('appends a note under the selected task', () => {
    service.addTaskNote('demo', '1.2', 'Verified with unit tests.')
    const raw = readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
    expect(raw).toContain('Verified with unit tests.')
  })

  it('rejects unknown goals and path traversal', () => {
    expect(() => service.readGoal('../etc')).toThrow(/Invalid goal id/)
    expect(() => service.readGoal('missing')).toThrow(/not found/)
  })
})

describe('PlanService edge cases', () => {
  it('ignores checklist examples inside code fences and keeps CRLF line endings', () => {
    const crlf = ['## Phase 1 — Docs', '- [ ] **1.1** Real task', '```md', '- [ ] **9.9** Example only', '```', ''].join('\r\n')
    writeFileSync(join(root, 'goals', 'demo', 'PLAN.md'), crlf)
    const detail = service.readGoal('demo')
    expect(detail.taskCount).toBe(1)
    service.setTaskChecked('demo', '1.1', true)
    const raw = readFileSync(join(root, 'goals', 'demo', 'PLAN.md'), 'utf8')
    expect(raw).toContain('- [x] **1.1** Real task\r\n')
    expect(raw).toContain('- [ ] **9.9** Example only')
  })

  it('does not create goals/ just by listing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'proharness-empty-'))
    const other = new PlanService(() => empty)
    expect(other.listGoals()).toEqual([])
    expect(existsSync(join(empty, 'goals'))).toBe(false)
    rmSync(empty, { recursive: true, force: true })
  })
})
