import type {
  Bootstrap,
  ConsultEvent,
  ConsultRequest,
  GitFileDiff,
  GitSummary,
  GoalDetail,
  GoalSummary,
  LoopConfig,
  LoopEvent,
  LoginShareStatus,
  LoopState,
  OmpStatus,
  PublicSettings,
  RecentSession,
  SessionCreateInput,
  SessionEvent,
  SettingsPatch,
  TerminalCreateInput,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  ThinkingLevel,
  UiRequest,
  UiResponse,
  WorkspaceListing,
  WorkspaceRef
} from './types'

type Unsubscribe = () => void

export interface ProHarnessApi {
  bootstrap(): Promise<Bootstrap>

  settings: {
    update(patch: SettingsPatch): Promise<PublicSettings>
    chooseWorkspace(): Promise<PublicSettings | null>
    chooseOmp(): Promise<string | null>
    onChanged(listener: (settings: PublicSettings) => void): Unsubscribe
  }

  workspace: {
    open(ref: WorkspaceRef): Promise<PublicSettings>
    sshHosts(): Promise<string[]>
    listDir(host: string, path: string): Promise<WorkspaceListing>
  }

  loginShare: {
    status(): Promise<LoginShareStatus>
    set(enabled: boolean): Promise<{ settings: PublicSettings; status: LoginShareStatus }>
  }

  omp: {
    refresh(): Promise<OmpStatus>
    onChanged(listener: (status: OmpStatus) => void): Unsubscribe
  }

  goals: {
    list(): Promise<GoalSummary[]>
    init(): Promise<{ root: string; tracked: boolean }>
    create(title: string): Promise<GoalSummary>
    read(goalId: string): Promise<GoalDetail>
    toggleTask(goalId: string, taskId: string, checked: boolean): Promise<GoalDetail>
    onChanged(listener: (goals: GoalSummary[]) => void): Unsubscribe
  }

  git: {
    summary(): Promise<GitSummary>
    fileDiff(path: string): Promise<GitFileDiff>
    restore(path: string): Promise<GitSummary>
    onChanged(listener: (summary: GitSummary) => void): Unsubscribe
  }

  sessions: {
    create(input: SessionCreateInput): Promise<void>
    send(tabId: string, text: string, behavior?: 'steer' | 'followUp'): Promise<void>
    stop(tabId: string): Promise<void>
    close(tabId: string): Promise<void>
    setModel(tabId: string, model: string): Promise<void>
    setThinking(tabId: string, level: ThinkingLevel): Promise<void>
    newConversation(tabId: string): Promise<void>
    resume(tabId: string, file: string): Promise<void>
    compact(tabId: string): Promise<void>
    removeQueued(tabId: string, message: string, queue: 'steering' | 'followUp'): Promise<void>
    recent(): Promise<RecentSession[]>
    onEvent(listener: (tabId: string, event: SessionEvent) => void): Unsubscribe
  }

  ui: {
    respond(response: UiResponse): Promise<void>
    onRequest(listener: (request: UiRequest) => void): Unsubscribe
    onResolved(listener: (requestId: string) => void): Unsubscribe
  }

  terminal: {
    create(input: TerminalCreateInput): Promise<TerminalCreateResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe
  }

  consult: {
    start(request: ConsultRequest): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    onEvent(listener: (event: ConsultEvent) => void): Unsubscribe
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
