import type { LoopState, LoopStatus } from './types'

/** Title given to a session before its first message. */
export const DEFAULT_SESSION_TITLE = 'New session'

/** Local planning state; never shown as a change and never committed. */
export const PLAN_DIR = 'goals'
export const DESIGN_FILE = 'DESIGN.md'
export const PLAN_FILE = 'PLAN.md'

export const DEFAULT_REVIEWER = 'anthropic/claude-sonnet-5-5'

/** Accepted bounds for the loop's numeric settings. */
export const LOOP_LIMITS = {
  maxTasks: [1, 50],
  maxReviewRounds: [1, 5],
  pauseBetweenMs: [0, 60_000]
} as const

export function emptyLoopState(): LoopState {
  return {
    runId: null,
    status: 'idle',
    goalId: null,
    goalTitle: null,
    config: null,
    currentTask: null,
    currentStep: 'idle',
    queue: [],
    completed: [],
    log: [],
    liveOutput: '',
    liveTool: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    review: null,
    costUsd: 0
  }
}

export function isLoopLive(status: LoopStatus): boolean {
  return status === 'running' || status === 'paused' || status === 'stopping'
}

export function titleFromText(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 48)
}

export function toolLabel(name: string, intent?: string): string {
  return `${name}${intent ? ` · ${intent}` : ''}`
}
