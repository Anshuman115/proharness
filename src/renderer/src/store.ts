import { create } from 'zustand'
import { DEFAULT_SESSION_TITLE, emptyLoopState, titleFromText } from '@shared/defaults'
import type {
  ApprovalMode,
  ConsultEvent,
  ContentBlock,
  GitFileDiff,
  GitSummary,
  GoalDetail,
  GoalSummary,
  LoopConfig,
  LoopEvent,
  LoopLogEntry,
  LoopState,
  OmpStatus,
  PublicSettings,
  RecentSession,
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  SettingsPatch,
  SlashCommand,
  ThinkingLevel,
  UiRequest,
  WorkspaceRef
} from '@shared/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: ContentBlock[]
  createdAt: number
  model?: string | null
  streaming?: boolean
  costUsd?: number
  level?: 'info' | 'warn' | 'error'
}

export interface ChatTab {
  id: string
  title: string
  status: SessionStatus
  approval: ApprovalMode
  messages: ChatMessage[]
  snapshot: SessionSnapshot | null
  commands: SlashCommand[]
  error: string | null
}

export type WorkbenchTab = 'changes' | 'terminal' | 'consult' | 'loop'

interface ConsultState {
  requestId: string
  model: string
  prompt: string
  text: string
  thinking: string
  tools: string[]
  done: boolean
  error: string | null
  costUsd: number
  startedAt: number
}

interface Toast {
  kind: 'success' | 'error' | 'info'
  message: string
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function systemMessage(text: string, level: 'info' | 'warn' | 'error' = 'info'): ChatMessage {
  return { id: makeId('sys'), role: 'system', blocks: [{ type: 'text', text }], createdAt: Date.now(), level }
}

function setBlock(blocks: ContentBlock[], index: number, block: ContentBlock): ContentBlock[] {
  const next = [...blocks]
  while (next.length < index) next.push({ type: 'text', text: '' })
  const previous = next[index]
  if (block.type === 'tool' && previous?.type === 'tool' && previous.id === block.id) {
    // Keep runtime status/output that arrived through tool events.
    next[index] = { ...block, status: previous.status, output: previous.output }
  } else {
    next[index] = block
  }
  return next
}

function appendToBlock(blocks: ContentBlock[], index: number, text: string): ContentBlock[] {
  const next = [...blocks]
  const block = next[index]
  if (block && (block.type === 'text' || block.type === 'thinking')) next[index] = { ...block, text: block.text + text }
  else next[index] = { type: 'text', text }
  return next
}

function updateMessage(tab: ChatTab, messageId: string, updater: (message: ChatMessage) => ChatMessage): ChatTab {
  const index = tab.messages.findIndex((message) => message.id === messageId)
  const messages = [...tab.messages]
  if (index >= 0) messages[index] = updater(messages[index])
  else messages.push(updater({ id: messageId, role: 'assistant', blocks: [], createdAt: Date.now(), streaming: true }))
  return { ...tab, messages: messages.slice(-600) }
}

function updateTool(tab: ChatTab, toolId: string, status: string, output?: string): ChatTab {
  for (let i = tab.messages.length - 1; i >= 0; i -= 1) {
    const message = tab.messages[i]
    const blockIndex = message.blocks.findIndex((block) => block.type === 'tool' && block.id === toolId)
    if (blockIndex < 0) continue
    const blocks = [...message.blocks]
    const block = blocks[blockIndex]
    if (block.type !== 'tool') return tab
    blocks[blockIndex] = { ...block, status: status as typeof block.status, output: output ?? block.output }
    const messages = [...tab.messages]
    messages[i] = { ...message, blocks }
    return { ...tab, messages }
  }
  return tab
}

function settle(tab: ChatTab): ChatTab {
  if (!tab.messages.some((message) => message.streaming)) return tab
  return { ...tab, messages: tab.messages.map((message) => (message.streaming ? { ...message, streaming: false } : message)) }
}

interface AppStore {
  loading: boolean
  bootError: string | null
  settings: PublicSettings | null
  omp: OmpStatus | null
  goals: GoalSummary[]
  git: GitSummary | null
  appVersion: string

  tabs: ChatTab[]
  activeTabId: string | null
  drafts: Record<string, string>
  leftOpen: boolean
  rightOpen: boolean
  workbenchTab: WorkbenchTab
  paletteOpen: boolean
  recentOpen: boolean
  recent: RecentSession[]

  activeGoalId: string | null
  goalDetail: GoalDetail | null
  goalLoading: boolean
  designGoalId: string | null
  newGoalOpen: boolean

  requests: UiRequest[]
  diffPath: string | null
  diff: GitFileDiff | null
  diffLoading: boolean

  consults: ConsultState[]
  loop: LoopState
  settingsOpen: boolean
  workspaceOpen: boolean
  toast: Toast | null

  init: () => Promise<void>
  refreshGoals: () => Promise<void>
  refreshGit: () => Promise<void>
  refreshOmp: () => Promise<void>
  selectGoal: (goalId: string) => Promise<void>
  toggleTask: (goalId: string, taskId: string, checked: boolean) => Promise<void>
  createGoal: (title: string) => Promise<void>
  setDesignGoal: (goalId: string | null) => void
  setNewGoalOpen: (open: boolean) => void
  createTab: (options?: { activate?: boolean; model?: string; resumeFile?: string; title?: string }) => Promise<string | null>
  closeTab: (tabId: string) => Promise<void>
  setActiveTab: (tabId: string) => void
  sendMessage: (text: string, behavior?: 'steer' | 'followUp') => Promise<void>
  stopActive: () => Promise<void>
  setDraft: (text: string) => void
  setTabModel: (tabId: string, model: string) => Promise<void>
  setTabThinking: (tabId: string, level: ThinkingLevel) => Promise<void>
  newConversation: (tabId: string) => Promise<void>
  compactTab: (tabId: string) => Promise<void>
  removeQueued: (tabId: string, message: string, queue: 'steering' | 'followUp') => Promise<void>
  openRecent: (open: boolean) => Promise<void>
  resumeRecent: (file: string, title: string) => Promise<void>
  handleSessionEvent: (tabId: string, event: SessionEvent) => void
  handleGoalsChanged: (goals: GoalSummary[]) => void
  handleGitChanged: (summary: GitSummary) => void
  addRequest: (request: UiRequest) => void
  answerRequest: (request: UiRequest, answer: { value: string } | { confirmed: boolean } | { cancelled: true }) => Promise<void>
  clearRequest: (requestId: string) => void
  loadDiff: (path: string | null) => Promise<void>
  restoreDiff: (path: string) => Promise<void>
  setWorkbenchTab: (tab: WorkbenchTab) => void
  toggleLeft: () => void
  toggleRight: () => void
  setPaletteOpen: (open: boolean) => void
  updateSettings: (patch: SettingsPatch) => Promise<void>
  chooseWorkspace: () => Promise<void>
  setWorkspaceOpen: (open: boolean) => void
  openWorkspace: (ref: WorkspaceRef) => Promise<void>
  /** Clears tabs and reloads after the host's omp processes were restarted. */
  resetWorkspace: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  pushToast: (kind: Toast['kind'], message: string) => void
  clearToast: () => void
  startConsult: (model: string, prompt: string, includeDiff: boolean) => Promise<void>
  cancelConsult: (requestId: string) => Promise<void>
  handleConsultEvent: (event: ConsultEvent) => void
  startLoop: (config: LoopConfig) => Promise<void>
  pauseLoop: () => Promise<void>
  resumeLoop: () => Promise<void>
  stopLoop: () => Promise<void>
  handleLoopEvent: (event: LoopEvent) => void
}

let toastTimer: number | null = null

export const useAppStore = create<AppStore>((set, get) => {
  const patchTab = (tabId: string, updater: (tab: ChatTab) => ChatTab): void => {
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)) }))
  }

  const resetWorkspaceState = async (): Promise<void> => {
    set({ tabs: [], activeTabId: null, drafts: {}, activeGoalId: null, goalDetail: null, diffPath: null, diff: null, requests: [] })
    await get().refreshGoals()
    await get().refreshGit()
    await get().createTab({ activate: true })
  }

  return {
    loading: true,
    bootError: null,
    settings: null,
    omp: null,
    goals: [],
    git: null,
    appVersion: '',
    tabs: [],
    activeTabId: null,
    drafts: {},
    leftOpen: true,
    rightOpen: true,
    workbenchTab: 'changes',
    paletteOpen: false,
    recentOpen: false,
    recent: [],
    activeGoalId: null,
    goalDetail: null,
    goalLoading: false,
    designGoalId: null,
    newGoalOpen: false,
    requests: [],
    diffPath: null,
    diff: null,
    diffLoading: false,
    consults: [],
    loop: emptyLoopState(),
    settingsOpen: false,
    workspaceOpen: false,
    toast: null,

    init: async () => {
      try {
        const boot = await window.proharness.bootstrap()
        set({
          settings: boot.settings,
          goals: boot.goals,
          git: boot.git,
          omp: boot.omp,
          appVersion: boot.appVersion,
          loading: false
        })
        set({ loop: await window.proharness.loop.state() })
        if (boot.goals[0]) void get().selectGoal(boot.goals[0].id)
        if (!get().tabs.length) await get().createTab({ activate: true })
      } catch (error) {
        set({ loading: false, bootError: (error as Error).message })
      }
    },

    refreshGoals: async () => {
      try {
        get().handleGoalsChanged(await window.proharness.goals.list())
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    refreshGit: async () => {
      try {
        set({ git: await window.proharness.git.summary() })
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    refreshOmp: async () => {
      try {
        set({ omp: await window.proharness.omp.refresh() })
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    selectGoal: async (goalId) => {
      set({ activeGoalId: goalId, goalLoading: true })
      try {
        const detail = await window.proharness.goals.read(goalId)
        if (get().activeGoalId === goalId) set({ goalDetail: detail, goalLoading: false })
      } catch (error) {
        set({ goalLoading: false })
        get().pushToast('error', (error as Error).message)
      }
    },

    toggleTask: async (goalId, taskId, checked) => {
      try {
        const detail = await window.proharness.goals.toggleTask(goalId, taskId, checked)
        if (get().activeGoalId === goalId) set({ goalDetail: detail })
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    createGoal: async (title) => {
      const summary = await window.proharness.goals.create(title)
      set({ newGoalOpen: false })
      await get().refreshGoals()
      await get().selectGoal(summary.id)
      get().pushToast('success', `Created goals/${summary.id}. It stays out of git.`)
    },

    setDesignGoal: (goalId) => set({ designGoalId: goalId }),
    setNewGoalOpen: (open) => set({ newGoalOpen: open }),

    createTab: async (options) => {
      const settings = get().settings
      if (!settings) return null
      const id = makeId('tab')
      const tab: ChatTab = {
        id,
        title: options?.title || DEFAULT_SESSION_TITLE,
        status: 'starting',
        approval: settings.chatApproval,
        messages: [],
        snapshot: null,
        commands: [],
        error: null
      }
      set((state) => ({ tabs: [...state.tabs, tab], activeTabId: options?.activate === false ? state.activeTabId : id }))
      try {
        await window.proharness.sessions.create({
          tabId: id,
          title: tab.title,
          model: options?.model,
          resumeFile: options?.resumeFile
        })
        return id
      } catch (error) {
        patchTab(id, (item) => ({
          ...item,
          status: 'error',
          error: (error as Error).message,
          messages: [...item.messages, systemMessage((error as Error).message, 'error')]
        }))
        return null
      }
    },

    closeTab: async (tabId) => {
      for (const request of get().requests.filter((item) => item.originId === tabId)) get().clearRequest(request.id)
      set((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === tabId)
        const tabs = state.tabs.filter((tab) => tab.id !== tabId)
        let activeTabId = state.activeTabId
        if (activeTabId === tabId) activeTabId = tabs[Math.max(0, index - 1)]?.id || tabs[0]?.id || null
        const drafts = { ...state.drafts }
        delete drafts[tabId]
        return { tabs, activeTabId, drafts }
      })
      await window.proharness.sessions.close(tabId).catch(() => undefined)
    },

    setActiveTab: (tabId) => set({ activeTabId: tabId }),

    sendMessage: async (rawText, behavior = 'followUp') => {
      const text = rawText.trim()
      if (!text) return
      let tabId = get().activeTabId
      if (!tabId) tabId = await get().createTab({ activate: true })
      if (!tabId) return
      const tab = get().tabs.find((item) => item.id === tabId)
      if (!tab) return
      set((state) => ({ drafts: { ...state.drafts, [tabId]: '' } }))
      if (tab.title === DEFAULT_SESSION_TITLE && !text.startsWith('/')) {
        patchTab(tabId, (item) => ({ ...item, title: titleFromText(text) }))
      }
      try {
        await window.proharness.sessions.send(tabId, text, behavior)
      } catch (error) {
        set((state) => ({ drafts: { ...state.drafts, [tabId]: text } }))
        patchTab(tabId, (item) => ({ ...item, messages: [...item.messages, systemMessage((error as Error).message, 'error')] }))
      }
    },

    stopActive: async () => {
      const id = get().activeTabId
      if (id) await window.proharness.sessions.stop(id).catch((error: Error) => get().pushToast('error', error.message))
    },

    setDraft: (text) => {
      const id = get().activeTabId
      if (id) set((state) => ({ drafts: { ...state.drafts, [id]: text } }))
    },

    setTabModel: async (tabId, model) => {
      try {
        await window.proharness.sessions.setModel(tabId, model)
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    setTabThinking: async (tabId, level) => {
      try {
        await window.proharness.sessions.setThinking(tabId, level)
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    newConversation: async (tabId) => {
      try {
        await window.proharness.sessions.newConversation(tabId)
        patchTab(tabId, (tab) => ({ ...tab, title: DEFAULT_SESSION_TITLE, messages: [] }))
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    compactTab: async (tabId) => {
      try {
        await window.proharness.sessions.compact(tabId)
        get().pushToast('success', 'Context compacted.')
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    removeQueued: async (tabId, message, queue) => {
      await window.proharness.sessions.removeQueued(tabId, message, queue).catch((error: Error) => get().pushToast('error', error.message))
    },

    openRecent: async (open) => {
      set({ recentOpen: open })
      if (open) set({ recent: await window.proharness.sessions.recent().catch(() => []) })
    },

    resumeRecent: async (file, title) => {
      set({ recentOpen: false })
      const active = get().tabs.find((tab) => tab.id === get().activeTabId)
      if (active && active.messages.length === 0 && active.status === 'idle') {
        patchTab(active.id, (tab) => ({ ...tab, title }))
        try {
          await window.proharness.sessions.resume(active.id, file)
        } catch (error) {
          get().pushToast('error', (error as Error).message)
        }
        return
      }
      await get().createTab({ activate: true, resumeFile: file, title })
    },

    handleSessionEvent: (tabId, event) => {
      set((state) => {
        const tab = state.tabs.find((item) => item.id === tabId)
        if (!tab) return state
        let next = tab
        switch (event.type) {
          case 'status':
            next = { ...next, status: event.status, error: event.status === 'error' ? event.detail || next.error : null }
            if (event.status !== 'working') next = settle(next)
            break
          case 'snapshot':
            next = { ...next, snapshot: event.snapshot }
            break
          case 'commands':
            next = { ...next, commands: event.commands }
            break
          case 'user':
            next = {
              ...next,
              messages: [...next.messages, { id: makeId('user'), role: 'user', blocks: [{ type: 'text', text: event.text }], createdAt: Date.now() }]
            }
            break
          case 'message_start':
            next = updateMessage(next, event.messageId, (message) => ({ ...message, model: event.model, streaming: true }))
            break
          case 'block':
            next = updateMessage(next, event.messageId, (message) => ({ ...message, blocks: setBlock(message.blocks, event.index, event.block) }))
            break
          case 'delta':
            next = updateMessage(next, event.messageId, (message) => ({ ...message, blocks: appendToBlock(message.blocks, event.index, event.text) }))
            break
          case 'message_end':
            next = updateMessage(next, event.messageId, (message) => {
              const blocks = event.blocks.map((block) => {
                if (block.type !== 'tool') return block
                const live = message.blocks.find((item) => item.type === 'tool' && item.id === block.id)
                return live && live.type === 'tool' ? { ...block, status: live.status, output: live.output } : block
              })
              return { ...message, blocks: blocks.length ? blocks : message.blocks, streaming: false, costUsd: event.costUsd }
            })
            if (event.error) next = { ...next, messages: [...next.messages, systemMessage(event.error, 'error')] }
            break
          case 'tool':
            next = updateTool(next, event.toolId, event.status, event.output)
            break
          case 'history':
            next = {
              ...next,
              messages: event.messages.map((message) => ({
                id: makeId(message.role),
                role: message.role,
                blocks: message.blocks,
                model: message.model,
                createdAt: Date.now()
              }))
            }
            break
          case 'notice':
            next = { ...next, messages: [...next.messages, systemMessage(event.message, event.level)] }
            break
          case 'turn_end':
            next = settle(next)
            if (event.status === 'error' && event.error) next = { ...next, messages: [...next.messages, systemMessage(event.error, 'error')] }
            if (event.status === 'aborted') next = { ...next, messages: [...next.messages, systemMessage('Stopped.', 'warn')] }
            break
        }
        return { tabs: state.tabs.map((item) => (item.id === tabId ? next : item)) }
      })
      if (event.type === 'turn_end') void get().refreshGit()
    },

    handleGoalsChanged: (goals) => {
      set({ goals })
      const active = get().activeGoalId
      if (!active || !goals.some((goal) => goal.id === active)) {
        const first = goals[0]?.id || null
        set({ activeGoalId: first, goalDetail: null })
        if (first) void get().selectGoal(first)
      } else {
        void get().selectGoal(active)
      }
    },

    handleGitChanged: (summary) => {
      set({ git: summary })
      const path = get().diffPath
      if (path && !summary.files.some((file) => file.path === path)) set({ diffPath: null, diff: null })
      else if (path) void get().loadDiff(path)
    },

    addRequest: (request) => {
      set((state) => (state.requests.some((item) => item.id === request.id) ? state : { requests: [...state.requests, request] }))
    },

    answerRequest: async (request, answer) => {
      set((state) => ({ requests: state.requests.filter((item) => item.id !== request.id) }))
      try {
        await window.proharness.ui.respond({ requestId: request.id, ...answer })
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    clearRequest: (requestId) => set((state) => ({ requests: state.requests.filter((item) => item.id !== requestId) })),

    loadDiff: async (path) => {
      if (!path) {
        set({ diffPath: null, diff: null, diffLoading: false })
        return
      }
      set({ diffPath: path, diffLoading: true })
      try {
        const diff = await window.proharness.git.fileDiff(path)
        if (get().diffPath === path) set({ diff, diffLoading: false })
      } catch (error) {
        if (get().diffPath === path) set({ diffLoading: false })
        get().pushToast('error', (error as Error).message)
      }
    },

    restoreDiff: async (path) => {
      try {
        const summary = await window.proharness.git.restore(path)
        set({ git: summary, diffPath: null, diff: null })
        get().pushToast('success', `Restored ${path}`)
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    setWorkbenchTab: (tab) => set({ workbenchTab: tab, rightOpen: true }),
    toggleLeft: () => set((state) => ({ leftOpen: !state.leftOpen })),
    toggleRight: () => set((state) => ({ rightOpen: !state.rightOpen })),
    setPaletteOpen: (open) => set({ paletteOpen: open }),

    updateSettings: async (patch) => {
      const previousWorkspace = get().settings?.workspacePath
      try {
        const next = await window.proharness.settings.update(patch)
        set({ settings: next })
        if (previousWorkspace && previousWorkspace !== next.workspacePath) await resetWorkspaceState()
        get().pushToast('success', 'Settings saved.')
      } catch (error) {
        get().pushToast('error', (error as Error).message)
        throw error
      }
    },

    chooseWorkspace: async () => {
      try {
        const next = await window.proharness.settings.chooseWorkspace()
        if (!next) return
        set({ settings: next })
        await resetWorkspaceState()
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    setWorkspaceOpen: (open) => set({ workspaceOpen: open }),

    openWorkspace: async (ref) => {
      try {
        const next = await window.proharness.workspace.open(ref)
        set({ settings: next, workspaceOpen: false })
        await resetWorkspaceState()
      } catch (error) {
        get().pushToast('error', (error as Error).message)
        throw error
      }
    },

    resetWorkspace: resetWorkspaceState,

    setSettingsOpen: (open) => set({ settingsOpen: open }),

    pushToast: (kind, message) => {
      if (toastTimer) window.clearTimeout(toastTimer)
      set({ toast: { kind, message } })
      toastTimer = window.setTimeout(() => set({ toast: null }), 5200)
    },

    clearToast: () => set({ toast: null }),

    startConsult: async (model, prompt, includeDiff) => {
      try {
        const { requestId } = await window.proharness.consult.start({ model, prompt, includeDiff })
        const entry: ConsultState = {
          requestId,
          model,
          prompt,
          text: '',
          thinking: '',
          tools: [],
          done: false,
          error: null,
          costUsd: 0,
          startedAt: Date.now()
        }
        set((state) => ({ consults: [entry, ...state.consults].slice(0, 12) }))
      } catch (error) {
        get().pushToast('error', (error as Error).message)
      }
    },

    cancelConsult: async (requestId) => {
      await window.proharness.consult.cancel(requestId).catch(() => undefined)
    },

    handleConsultEvent: (event) => {
      set((state) => ({
        consults: state.consults.map((item) => {
          if (item.requestId !== event.requestId) return item
          switch (event.type) {
            case 'delta':
              return { ...item, text: item.text + event.text }
            case 'thinking':
              return { ...item, thinking: event.text }
            case 'tool':
              return { ...item, tools: [...item.tools, event.label].slice(-8) }
            case 'done':
              return { ...item, text: event.text || item.text, done: true, costUsd: event.costUsd }
            case 'error':
              return { ...item, done: true, error: event.message }
          }
          return item
        })
      }))
    },

    startLoop: async (config) => {
      try {
        set({ loop: await window.proharness.loop.start(config), workbenchTab: 'loop', rightOpen: true })
      } catch (error) {
        get().pushToast('error', (error as Error).message)
        throw error
      }
    },

    pauseLoop: async () => set({ loop: await window.proharness.loop.pause() }),
    resumeLoop: async () => set({ loop: await window.proharness.loop.resume() }),
    stopLoop: async () => set({ loop: await window.proharness.loop.stop() }),

    handleLoopEvent: (event) => {
      if (event.type === 'state') {
        set({ loop: event.state })
        return
      }
      if (event.type === 'delta') {
        set((state) => ({ loop: { ...state.loop, liveOutput: `${state.loop.liveOutput}${event.text}`.slice(-80_000) } }))
        return
      }
      if (event.type === 'tool') {
        set((state) => ({ loop: { ...state.loop, liveTool: event.label } }))
        return
      }
      if (event.type === 'log') {
        set((state) => {
          if (state.loop.log.some((entry) => entry.ts === event.entry.ts && entry.message === event.entry.message)) return state
          const log: LoopLogEntry[] = [...state.loop.log, event.entry].slice(-400)
          return { loop: { ...state.loop, log } }
        })
      }
    }
  }
})

