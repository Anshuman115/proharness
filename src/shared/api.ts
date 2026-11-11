import type {
  AppInfo,
  Bootstrap,
  DelegateEvent,
  DelegateRequest,
  GitFileDiff,
  GitSummary,
  GoalDetail,
  GoalSummary,
  LoopConfig,
  LoopEvent,
  LoopState,
  PermissionDecision,
  PermissionRequest,
  ProviderId,
  ProviderTestOverrides,
  ProviderTestResult,
  PublicSettings,
  SessionCreateInput,
  SessionEvent,
  SessionRuntime,
  SettingsPatch,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent
} from './types'

type Unsubscribe = () => void

export interface ProHarnessApi {
  bootstrap(): Promise<Bootstrap>
  appInfo(): Promise<AppInfo>

  settings: {
    update(patch: SettingsPatch): Promise<PublicSettings>
    chooseWorkspace(): Promise<PublicSettings | null>
    chooseClaudeExecutable(): Promise<string | null>
  }

  goals: {
    list(): Promise<GoalSummary[]>
    init(): Promise<string>
    read(goalId: string): Promise<GoalDetail>
    toggleTask(goalId: string, taskId: string, checked: boolean): Promise<GoalDetail>
    onChanged(listener: (goals: GoalSummary[]) => void): Unsubscribe
  }

  git: {
    summary(): Promise<GitSummary>
    fileDiff(path: string): Promise<GitFileDiff>
    restore(path: string): Promise<GitSummary>
    reveal(path: string): Promise<void>
    onChanged(listener: (summary: GitSummary) => void): Unsubscribe
  }

  sessions: {
    create(input: SessionCreateInput): Promise<SessionRuntime>
    send(tabId: string, text: string): Promise<void>
    stop(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
    setMode(tabId: string, mode: SessionCreateInput['permissionMode']): Promise<void>
    onEvent(listener: (tabId: string, event: SessionEvent) => void): Unsubscribe
  }

  permissions: {
    respond(decision: PermissionDecision): Promise<void>
    onRequest(listener: (request: PermissionRequest) => void): Unsubscribe
    onResolved(listener: (requestId: string, allow: boolean) => void): Unsubscribe
  }

  terminal: {
    create(input: TerminalCreateInput): Promise<TerminalCreateResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe
  }

  providers: {
    delegate(request: DelegateRequest): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    test(provider: ProviderId, overrides?: ProviderTestOverrides): Promise<ProviderTestResult>
    onEvent(listener: (event: DelegateEvent) => void): Unsubscribe
  }

  loop: {
    start(config: LoopConfig): Promise<LoopState>
    pause(): Promise<LoopState>
    resume(): Promise<LoopState>
    stop(): Promise<LoopState>
    state(): Promise<LoopState>
    onEvent(listener: (event: LoopEvent) => void): Unsubscribe
  }

  shell: {
    openPath(path: string): Promise<string>
    showItem(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
}
