// ── omp runtime ──────────────────────────────────────────────────────────────

/** omp tool approval modes, see `tools.approvalMode` in omp docs. */
export const APPROVAL_MODES = ['always-ask', 'always-ask-cached', 'write', 'yolo'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface ModelInfo {
  /** `provider/id`, the form omp accepts for `--model`. */
  key: string
  provider: string
  id: string
  name: string
  contextWindow: number | null
  reasoning: boolean
  efforts: string[]
  costIn: number | null
  costOut: number | null
}

export interface OmpStatus {
  ok: boolean
  path: string | null
  version: string | null
  error: string | null
  defaultModel: string | null
  models: ModelInfo[]
  checkedAt: number
}

export interface SlashCommand {
  name: string
  description: string
  hint: string
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PublicSettings {
  workspacePath: string
  workspaceName: string
  goalsPath: string
  ompPath: string
  chatModel: string
  chatApproval: ApprovalMode
  implementerModel: string
  reviewerModel: string
  loopApproval: ApprovalMode
  pinnedModels: string[]
  terminalShell: string
  reduceMotion: boolean
}

export type SettingsPatch = Partial<Omit<PublicSettings, 'workspaceName' | 'goalsPath'>>

export interface Bootstrap {
  settings: PublicSettings
  goals: GoalSummary[]
  git: GitSummary
  omp: OmpStatus
  appVersion: string
  platform: string
}

// ── Goals / plans ────────────────────────────────────────────────────────────

export interface PlanTask {
  id: string
  title: string
  checked: boolean
  phaseId: string
  phaseTitle: string
  line: number
  note: string | null
}

export interface PlanPhase {
  id: string
  title: string
  index: number
  tasks: PlanTask[]
  done: number
  total: number
}

export interface GoalSummary {
  id: string
  title: string
  summary: string
  status: string
  designPath: string
  planPath: string
  phaseCount: number
  taskCount: number
  openCount: number
  progress: number
  updatedAt: number
}

export interface GoalDetail extends GoalSummary {
  design: string
  plan: string
  phases: PlanPhase[]
}

export interface TaskRef {
  goalId: string
  taskId: string
  taskTitle: string
  phaseTitle: string
}

// ── Git ──────────────────────────────────────────────────────────────────────

export type GitChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'copied'

export interface GitFileChange {
  path: string
  oldPath?: string
  status: GitChangeStatus
  additions: number
  deletions: number
  staged: boolean
}

export interface GitSummary {
  isRepo: boolean
  root: string | null
  branch: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
  clean: boolean
  head: string | null
}

export interface GitFileDiff {
  path: string
  diff: string
  binary: boolean
  untracked: boolean
  truncated: boolean
}

export interface GitCommitInfo {
  hash: string
  subject: string
  author: string
  ts: number
}

// ── Chat sessions ────────────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
}

export interface ToolBlock {
  type: 'tool'
  id: string
  name: string
  intent: string
  args: Record<string, unknown>
  /** Streaming or final output text. */
  output?: string
  status: 'pending' | 'running' | 'done' | 'error'
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolBlock

export type SessionStatus = 'starting' | 'idle' | 'working' | 'stopping' | 'error' | 'closed'

export interface TodoItem {
  content: string
  status: string
}

export interface TodoPhase {
  name: string
  tasks: TodoItem[]
}

export interface SessionSnapshot {
  model: string | null
  thinking: string | null
  sessionId: string | null
  sessionFile: string | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  todos: TodoPhase[]
  queue: { steering: string[]; followUp: string[] }
  costUsd: number
}

export interface SessionCreateInput {
  tabId: string
  title: string
  model?: string
  thinking?: ThinkingLevel
  approval?: ApprovalMode
  /** Resume an existing omp session file. */
  resumeFile?: string
}

export interface RecentSession {
  file: string
  title: string
  updatedAt: number
  model: string | null
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'commands'; commands: SlashCommand[] }
  | { type: 'message_start'; messageId: string; model: string | null }
  | { type: 'block'; messageId: string; index: number; block: ContentBlock }
  | { type: 'delta'; messageId: string; index: number; text: string }
  | { type: 'message_end'; messageId: string; blocks: ContentBlock[]; costUsd: number; error: string | null }
  | { type: 'tool'; toolId: string; status: ToolBlock['status']; output?: string }
  | { type: 'user'; text: string }
  | { type: 'history'; messages: HistoryMessage[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'turn_end'; status: 'completed' | 'aborted' | 'error'; error?: string }

export interface HistoryMessage {
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  model: string | null
}

// ── Interactive requests from omp (approvals, ask tool, extension dialogs) ───

export interface UiRequest {
  /** ProHarness id, unique across all omp processes. */
  id: string
  origin: 'session' | 'loop'
  originId: string
  originLabel: string
  method: 'select' | 'confirm' | 'input' | 'editor'
  title: string
  message: string
  options: string[]
  optionDetails: string[]
  placeholder: string
  /** True when this select is an omp tool approval prompt. */
  approval: { tool: string; details: string[] } | null
  createdAt: number
}

export type UiResponse =
  | { requestId: string; value: string }
  | { requestId: string; confirmed: boolean }
  | { requestId: string; cancelled: true }

// ── Terminal ─────────────────────────────────────────────────────────────────

export interface TerminalCreateInput {
  id: string
  cwd: string
  cols: number
  rows: number
  shell?: string
}

export interface TerminalCreateResult {
  id: string
  shell: string
  cwd: string
  mode: 'pty' | 'pipe'
  warning: string | null
}

export interface TerminalDataEvent {
  id: string
  data: string
}

export interface TerminalExitEvent {
  id: string
  exitCode: number | null
  signal: string | null
}

// ── Consult (one-shot second opinion) ────────────────────────────────────────

export interface ConsultRequest {
  model: string
  prompt: string
  /** Attach the current working-tree diff to the prompt. */
  includeDiff: boolean
}

export type ConsultEvent =
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'thinking'; requestId: string; text: string }
  | { type: 'tool'; requestId: string; label: string }
  | { type: 'done'; requestId: string; text: string; costUsd: number }
  | { type: 'error'; requestId: string; message: string }

// ── Task loop ────────────────────────────────────────────────────────────────

export type LoopStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'stopped' | 'complete' | 'error'

export type LoopStep =
  | 'idle'
  | 'preflight'
  | 'implementing'
  | 'reviewing'
  | 'revising'
  | 'committing'
  | 'marking'
  | 'waiting'
  | 'complete'
  | 'error'

export interface LoopConfig {
  goalId: string
  implementerModel: string
  reviewerModel: string
  approval: ApprovalMode
  maxTasks: number
  maxReviewRounds: number
  pauseBetweenMs: number
}

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES'

export interface LoopTaskRecord {
  taskId: string
  taskTitle: string
  phaseTitle: string
  status: 'running' | 'reviewing' | 'revising' | 'committed' | 'failed'
  attempts: number
  reviewVerdict: Verdict | null
  reviewNotes: string | null
  commitHash: string | null
  costUsd: number
  startedAt: number
  finishedAt: number | null
  error: string | null
}

export interface LoopLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

export interface LoopState {
  runId: string | null
  status: LoopStatus
  goalId: string | null
  goalTitle: string | null
  config: LoopConfig | null
  currentTask: TaskRef | null
  currentStep: LoopStep
  queue: TaskRef[]
  completed: LoopTaskRecord[]
  log: LoopLogEntry[]
  liveOutput: string
  liveTool: string | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  review: { verdict: Verdict; summary: string; notes: string; model: string } | null
  costUsd: number
}

export type LoopEvent =
  | { type: 'state'; state: LoopState }
  | { type: 'log'; entry: LoopLogEntry }
  | { type: 'delta'; text: string }
  | { type: 'tool'; label: string | null }
