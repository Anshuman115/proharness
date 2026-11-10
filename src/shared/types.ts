export const PROVIDER_IDS = ['openai', 'deepseek', 'kimi'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  kimi: 'Kimi'
}

export const DEFAULT_PROVIDER_BASE_URLS: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.ai/v1'
}

export const DEFAULT_PROVIDER_MODELS: Record<ProviderId, string> = {
  openai: 'gpt-5.1',
  deepseek: 'deepseek-chat',
  kimi: 'kimi-k2-0905-preview'
}

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

export type SessionStatus =
  | 'starting'
  | 'thinking'
  | 'streaming'
  | 'waiting_permission'
  | 'idle'
  | 'stopping'
  | 'error'

export type SessionKind = 'chat' | 'loop'

export interface ProviderPublic {
  id: ProviderId
  label: string
  baseUrl: string
  model: string
  hasKey: boolean
  keyHint: string
  envKey: boolean
}

export interface ClaudePublic {
  model: string
  permissionMode: PermissionMode
  hasApiKey: boolean
  apiKeyHint: string
  envKey: boolean
  executablePath: string
  claudeCodeVersion: string | null
}

export interface PublicSettings {
  workspacePath: string
  workspaceName: string
  goalsPath: string
  claude: ClaudePublic
  providers: ProviderPublic[]
  terminalShell: string
  defaultReviewer: ProviderId
  defaultReviewerModel: string
  reduceMotion: boolean
}

export interface SettingsPatch {
  workspacePath?: string
  claude?: {
    model?: string
    permissionMode?: PermissionMode
    apiKey?: string
    clearApiKey?: boolean
    executablePath?: string
  }
  providers?: Partial<
    Record<
      ProviderId,
      {
        baseUrl?: string
        model?: string
        apiKey?: string
        clearApiKey?: boolean
      }
    >
  >
  terminalShell?: string
  defaultReviewer?: ProviderId
  defaultReviewerModel?: string
  reduceMotion?: boolean
}

export interface Bootstrap {
  settings: PublicSettings
  goals: GoalSummary[]
  git: GitSummary
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
}

export interface GitFileDiff {
  path: string
  diff: string
  binary: boolean
  untracked: boolean
  truncated: boolean
}

// ── Chat sessions ────────────────────────────────────────────────────────────

export interface AssistantTextBlock {
  type: 'text'
  text: string
}

export interface AssistantThinkingBlock {
  type: 'thinking'
  text: string
}

export interface AssistantToolBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export type AssistantBlock = AssistantTextBlock | AssistantThinkingBlock | AssistantToolBlock

export interface SessionCreateInput {
  tabId: string
  cwd?: string
  title: string
  model?: string
  permissionMode?: PermissionMode
  kind?: SessionKind
}

export interface SessionRuntime {
  tabId: string
  sdkSessionId: string | null
  cwd: string
  model: string
  permissionMode: PermissionMode
  kind: SessionKind
  createdAt: number
}

export interface SessionResultMeta {
  costUsd: number
  durationMs: number
  numTurns: number
  isError: boolean
  resultText: string
}

export type SessionEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | {
      type: 'init'
      sdkSessionId: string
      model: string
      cwd: string
      tools: string[]
      mcpServers: string[]
      apiKeySource: string
    }
  | { type: 'message_start'; messageId: string }
  | { type: 'delta'; messageId: string; block: 'text' | 'thinking'; text: string }
  | { type: 'message'; messageId: string; blocks: AssistantBlock[] }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; meta: SessionResultMeta }
  | { type: 'error'; message: string }

// ── Permissions ──────────────────────────────────────────────────────────────

export type PermissionRisk = 'low' | 'medium' | 'high'

export interface PermissionRequest {
  id: string
  origin: 'session' | 'loop'
  originId: string
  originLabel: string
  toolName: string
  toolUseId: string
  title: string
  displayName: string
  description: string
  decisionReason: string | null
  blockedPath: string | null
  input: Record<string, unknown>
  risk: PermissionRisk
  canRemember: boolean
  defaultToNo: boolean
  createdAt: number
}

export interface PermissionDecision {
  requestId: string
  allow: boolean
  remember: boolean
  message?: string
}

export type PermissionOutcome =
  | { allow: true; remember: boolean }
  | { allow: false; message: string }

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

// ── Delegation ───────────────────────────────────────────────────────────────

export interface DelegateRequest {
  provider: ProviderId
  model?: string
  system?: string
  prompt: string
  temperature?: number
  maxTokens?: number
}

export interface DelegateUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

export type DelegateEvent =
  | { type: 'delta'; requestId: string; text: string; reasoning?: string }
  | { type: 'done'; requestId: string; text: string; model: string; usage: DelegateUsage | null }
  | { type: 'error'; requestId: string; message: string }

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs: number
  model: string
}

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
  reviewerProvider: ProviderId
  reviewerModel: string
  autoApproveTools: boolean
  maxTasks: number
  maxReviewRounds: number
  pauseBetweenMs: number
  commit: boolean
  permissionMode: PermissionMode
}

export interface LoopTaskRecord {
  taskId: string
  taskTitle: string
  phaseTitle: string
  status: 'pending' | 'running' | 'reviewing' | 'revising' | 'committed' | 'failed'
  attempts: number
  reviewVerdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  reviewNotes: string | null
  commitHash: string | null
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
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  review: { verdict: 'APPROVE' | 'REQUEST_CHANGES'; notes: string; provider: string; model: string } | null
}

export type LoopEvent =
  | { type: 'state'; state: LoopState }
  | { type: 'log'; entry: LoopLogEntry }
  | { type: 'delta'; text: string }
  | { type: 'step'; step: LoopStep; task: TaskRef | null }

// ── IPC plumbing ─────────────────────────────────────────────────────────────

export interface AppInfo {
  version: string
  platform: string
  electron: string
  chrome: string
  node: string
  claudeCodeVersion: string | null
  nodePtyAvailable: boolean
}
