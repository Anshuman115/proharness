import { create } from 'zustand'
import type {
  AssistantBlock,
  DelegateEvent,
  GitFileDiff,
  GitSummary,
  GoalDetail,
  GoalSummary,
  LoopConfig,
  LoopEvent,
  LoopLogEntry,
  LoopState,
  PermissionRequest,
  ProviderId,
  PublicSettings,
  SessionEvent,
  SessionStatus,
  SettingsPatch,
  TaskRef
} from '@shared/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: AssistantBlock[]
  createdAt: number
  streaming?: boolean
  level?: 'info' | 'warn' | 'error'
}

export interface ChatTab {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  model: string
  permissionMode: string
  messages: ChatMessage[]
  createdAt: number
  sdkSessionId: string | null
  lastCost: number
  kind: 'chat' | 'loop'
}

export type WorkbenchTab = 'changes' | 'terminal' | 'delegate' | 'loop'

export interface DelegateState {
  requestId: string
  provider: ProviderId
  model: string
  text: string
  reasoning: string
  done: boolean
  error: string | null
  startedAt: number
}

interface Toast {
  id: number
  kind: 'success' | 'error' | 'info' | 'warning'
  message: string
}

function blankLoop(): LoopState {
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
    startedAt: null,
    finishedAt: null,
    error: null,
    review: null
  }
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function systemMessage(text: string, level: 'info' | 'warn' | 'error' = 'info'): ChatMessage {
  return {
    id: makeId('sys'),
    role: 'system',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
    level
  }
}

function mergeIncoming(existing: AssistantBlock[], incoming: AssistantBlock[]): AssistantBlock[] {
  if (!incoming.length) return existing
  const previousTools = new Map(
    existing.filter((block): block is Extract<AssistantBlock, { type: 'tool_use' }> => block.type === 'tool_use').map((block) => [block.id, block])
  )
  const merged = incoming.map((block) => {
    if (block.type !== 'tool_use') return block
    const old = previousTools.get(block.id)
    return old ? { ...block, result: old.result, isError: old.isError } : block
  })
  for (const block of existing) {
    if (block.type === 'tool_use' && !merged.some((item) => item.type === 'tool_use' && item.id === block.id)) {
      merged.push(block)
    }
  }
  return merged
}

function upsertAssistantMessage(
  tab: ChatTab,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatTab {
  const messages = [...tab.messages]
  const index = messages.findIndex((message) => message.id === messageId)
  if (index >= 0) {
    messages[index] = updater(messages[index])
  } else {
    const base: ChatMessage = {
      id: messageId,
      role: 'assistant',
      blocks: [],
      createdAt: Date.now(),
      streaming: true
    }
    messages.push(updater(base))
  }
  return { ...tab, messages: messages.slice(-500) }
}

function appendDelta(message: ChatMessage, block: 'text' | 'thinking', text: string): ChatMessage {
  const blocks = [...message.blocks]
  const type = block === 'text' ? 'text' : 'thinking'
  const last = blocks[blocks.length - 1]
  if (last && last.type === type) {
    blocks[blocks.length - 1] = { type, text: last.text + text } as AssistantBlock
  } else {
    blocks.push({ type, text } as AssistantBlock)
  }
  return { ...message, blocks, streaming: true }
}

function applyToolResult(tab: ChatTab, toolUseId: string, content: string, isError: boolean): ChatTab {
  const messages = tab.messages.map((message) => {
    if (!message.blocks.some((block) => block.type === 'tool_use' && block.id === toolUseId)) return message
    return {
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'tool_use' && block.id === toolUseId ? { ...block, result: content, isError } : block
      )
    }
  })
  return { ...tab, messages }
}

export interface AppStore {
  loading: boolean
  bootError: string | null
  settings: PublicSettings | null
  goals: GoalSummary[]
  git: GitSummary | null
  appVersion: string
  platform: string

  tabs: ChatTab[]
  activeTabId: string | null
  drafts: Record<string, string>
  leftOpen: boolean
  rightOpen: boolean
  workbenchTab: WorkbenchTab

  activeGoalId: string | null
  goalDetail: GoalDetail | null
  goalLoading: boolean
  designGoalId: string | null

  permissions: PermissionRequest[]
  diffPath: string | null
  diff: GitFileDiff | null
  diffLoading: boolean

  delegateRequests: Record<string, DelegateState>
  activeDelegateId: string | null

  loop: LoopState
  settingsOpen: boolean
  toast: Toast | null

  init: () => Promise<void>
  refreshGoals: () => Promise<void>
  refreshGit: () => Promise<void>
  refreshLoop: () => Promise<void>
  selectGoal: (goalId: string) => Promise<void>
  toggleTask: (goalId: string, taskId: string, checked: boolean) => Promise<void>
  setDesignGoal: (goalId: string | null) => void
  createTab: (options?: { activate?: boolean; kind?: 'chat' | 'loop' }) => Promise<string | null>
  closeTab: (tabId: string) => Promise<void>
  setActiveTab: (tabId: string) => void
  sendMessage: (text: string) => Promise<void>
  stopActive: () => Promise<void>
  setDraft: (text: string) => void
  setTabMode: (tabId: string, mode: string) => Promise<void>
  handleSessionEvent: (tabId: string, event: SessionEvent) => void
  handleGoalsChanged: (goals: GoalSummary[]) => void
  handleGitChanged: (summary: GitSummary) => void
  addPermission: (request: PermissionRequest) => void
  resolvePermission: (request: PermissionRequest, allow: boolean, remember: boolean) => Promise<void>
  clearPermission: (requestId: string) => void
  loadDiff: (path: string | null) => Promise<void>
  restoreDiff: (path: string) => Promise<void>
  setWorkbenchTab: (tab: WorkbenchTab) => void
  toggleLeft: () => void
  toggleRight: () => void
  updateSettings: (patch: SettingsPatch) => Promise<void>
  chooseWorkspace: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  pushToast: (kind: Toast['kind'], message: string) => void
  clearToast: () => void
  startDelegate: (provider: ProviderId, model: string, prompt: string) => Promise<void>
  cancelDelegate: () => Promise<void>
  handleDelegateEvent: (event: DelegateEvent) => void
  startLoop: (config: LoopConfig) => Promise<void>
  pauseLoop: () => Promise<void>
  resumeLoop: () => Promise<void>
  stopLoop: () => Promise<void>
  handleLoopEvent: (event: LoopEvent) => void
  insertDelegateResult: () => void
}

let toastTimer: number | null = null

export const useAppStore = create<AppStore>((set, get) => ({
  loading: true,
  bootError: null,
  settings: null,
  goals: [],
  git: null,
  appVersion: '0.1.0',
  platform: '',
  tabs: [],
  activeTabId: null,
  drafts: {},
  leftOpen: true,
  rightOpen: true,
  workbenchTab: 'changes',
  activeGoalId: null,
  goalDetail: null,
  goalLoading: false,
  designGoalId: null,
  permissions: [],
  diffPath: null,
  diff: null,
  diffLoading: false,
  delegateRequests: {},
  activeDelegateId: null,
  loop: blankLoop(),
  settingsOpen: false,
  toast: null,

  init: async () => {
    try {
      const boot = await window.proharness.bootstrap()
      set({
        settings: boot.settings,
        goals: boot.goals,
        git: boot.git,
        appVersion: boot.appVersion,
        platform: boot.platform,
        loading: false
      })
      const loopState = await window.proharness.loop.state()
      set({ loop: loopState })
      if (boot.goals[0]) void get().selectGoal(boot.goals[0].id)
      if (!get().tabs.length) await get().createTab({ activate: true })
      void get().refreshGit()
    } catch (error) {
      set({ loading: false, bootError: (error as Error).message })
    }
  },

  refreshGoals: async () => {
    try {
      const goals = await window.proharness.goals.list()
      get().handleGoalsChanged(goals)
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

  refreshLoop: async () => {
    try {
      set({ loop: await window.proharness.loop.state() })
    } catch {
      // The loop service may not be initialized yet during boot.
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
      set({ goals: await window.proharness.goals.list() })
    } catch (error) {
      get().pushToast('error', (error as Error).message)
    }
  },

  setDesignGoal: (goalId) => set({ designGoalId: goalId }),

  createTab: async (options) => {
    const settings = get().settings
    if (!settings) return null
    const id = makeId('tab')
    const tab: ChatTab = {
      id,
      title: 'New session',
      cwd: settings.workspacePath,
      status: 'starting',
      model: settings.claude.model,
      permissionMode: settings.claude.permissionMode,
      messages: [],
      createdAt: Date.now(),
      sdkSessionId: null,
      lastCost: 0,
      kind: options?.kind || 'chat'
    }
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: options?.activate === false ? state.activeTabId : id
    }))
    try {
      await window.proharness.sessions.create({
        tabId: id,
        cwd: settings.workspacePath,
        title: tab.title,
        model: tab.model,
        permissionMode: settings.claude.permissionMode,
        kind: tab.kind
      })
      return id
    } catch (error) {
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === id ? { ...item, status: 'error', messages: [systemMessage((error as Error).message, 'error')] } : item
        )
      }))
      get().pushToast('error', (error as Error).message)
      return null
    }
  },

  closeTab: async (tabId) => {
    await window.proharness.sessions.close(tabId).catch(() => undefined)
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      let activeTabId = state.activeTabId
      if (activeTabId === tabId) {
        activeTabId = tabs[Math.max(0, index - 1)]?.id || tabs[0]?.id || null
      }
      const drafts = { ...state.drafts }
      delete drafts[tabId]
      return { tabs, activeTabId, drafts }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  sendMessage: async (rawText) => {
    const text = rawText.trim()
    if (!text) return
    let tabId = get().activeTabId
    if (!tabId) tabId = await get().createTab({ activate: true })
    if (!tabId) return
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    set((state) => ({
      drafts: { ...state.drafts, [tabId]: '' },
      tabs: state.tabs.map((item) => {
        if (item.id !== tabId) return item
        const title =
          item.title === 'New session'
            ? text.replace(/\s+/g, ' ').slice(0, 48) || 'New session'
            : item.title
        return {
          ...item,
          title,
          status: 'thinking',
          messages: [
            ...item.messages,
            {
              id: makeId('user'),
              role: 'user' as const,
              blocks: [{ type: 'text' as const, text }],
              createdAt: Date.now()
            }
          ]
        }
      })
    }))
    try {
      await window.proharness.sessions.send(tabId, text)
    } catch (error) {
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId
            ? { ...item, status: 'error', messages: [...item.messages, systemMessage((error as Error).message, 'error')] }
            : item
        )
      }))
    }
  },

  stopActive: async () => {
    const id = get().activeTabId
    if (!id) return
    await window.proharness.sessions.stop(id)
  },

  setDraft: (text) => {
    const id = get().activeTabId
    if (!id) return
    set((state) => ({ drafts: { ...state.drafts, [id]: text } }))
  },

  setTabMode: async (tabId, mode) => {
    await window.proharness.sessions.setMode(tabId, mode as never).catch((error: Error) =>
      get().pushToast('error', error.message)
    )
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, permissionMode: mode } : tab
      )
    }))
  },

  handleSessionEvent: (tabId, event) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId)
      if (!tab) return state
      let next = tab
      switch (event.type) {
        case 'status':
          next = { ...next, status: event.status }
          break
        case 'init':
          next = { ...next, model: event.model, sdkSessionId: event.sdkSessionId }
          break
        case 'message_start':
          next = upsertAssistantMessage(next, event.messageId, (message) => ({ ...message, streaming: true }))
          next = { ...next, status: 'streaming' }
          break
        case 'delta':
          next = upsertAssistantMessage(next, event.messageId, (message) =>
            appendDelta(message, event.block, event.text)
          )
          next = { ...next, status: 'streaming' }
          break
        case 'message':
          next = upsertAssistantMessage(next, event.messageId, (message) => ({
            ...message,
            blocks: mergeIncoming(message.blocks, event.blocks),
            streaming: false
          }))
          break
        case 'tool_result':
          next = applyToolResult(next, event.toolUseId, event.content, event.isError)
          break
        case 'notice':
          next = {
            ...next,
            messages: [...next.messages, systemMessage(event.message, event.level)]
          }
          break
        case 'result':
          next = {
            ...next,
            status: 'idle',
            lastCost: event.meta.costUsd || next.lastCost
          }
          break
        case 'error':
          next = {
            ...next,
            status: 'error',
            messages: [...next.messages, systemMessage(event.message, 'error')]
          }
          break
      }
      return {
        ...state,
        tabs: state.tabs.map((item) => (item.id === tabId ? next : item))
      }
    })
    if (event.type === 'result' || event.type === 'error') {
      void get().refreshGit()
    }
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
    if (path && !summary.files.some((file) => file.path === path)) {
      set({ diffPath: null, diff: null })
    } else if (path) {
      void get().loadDiff(path)
    }
  },

  addPermission: (request) => {
    set((state) =>
      state.permissions.some((item) => item.id === request.id)
        ? state
        : { permissions: [...state.permissions, request] }
    )
  },

  resolvePermission: async (request, allow, remember) => {
    set((state) => ({ permissions: state.permissions.filter((item) => item.id !== request.id) }))
    try {
      await window.proharness.permissions.respond({
        requestId: request.id,
        allow,
        remember,
        message: allow ? undefined : 'The user denied this action.'
      })
    } catch (error) {
      get().pushToast('error', (error as Error).message)
    }
  },

  clearPermission: (requestId) => {
    set((state) => ({ permissions: state.permissions.filter((item) => item.id !== requestId) }))
  },

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

  updateSettings: async (patch) => {
    const previousWorkspace = get().settings?.workspacePath
    try {
      const next = await window.proharness.settings.update(patch)
      set({ settings: next })
      if (previousWorkspace && previousWorkspace !== next.workspacePath) {
        set({
          tabs: [],
          activeTabId: null,
          drafts: {},
          activeGoalId: null,
          goalDetail: null,
          diffPath: null,
          diff: null
        })
        await get().refreshGoals()
        await get().refreshGit()
        await get().createTab({ activate: true })
      }
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
      set({
        settings: next,
        tabs: [],
        activeTabId: null,
        drafts: {},
        activeGoalId: null,
        goalDetail: null,
        diffPath: null,
        diff: null
      })
      await get().refreshGoals()
      await get().refreshGit()
      await get().createTab({ activate: true })
    } catch (error) {
      get().pushToast('error', (error as Error).message)
    }
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  pushToast: (kind, message) => {
    if (toastTimer) window.clearTimeout(toastTimer)
    set({ toast: { id: Date.now(), kind, message } })
    toastTimer = window.setTimeout(() => set({ toast: null }), 4800)
  },

  clearToast: () => set({ toast: null }),

  startDelegate: async (provider, model, prompt) => {
    const activeId = get().activeDelegateId
    if (activeId && !get().delegateRequests[activeId]?.done) {
      await get().cancelDelegate()
    }
    try {
      const { requestId } = await window.proharness.providers.delegate({
        provider,
        model: model || undefined,
        prompt,
        system:
          'You are a senior software engineer consulting for a Claude Code desktop workspace. Be concrete and concise. Do not claim to have edited files.'
      })
      set((state) => ({
        activeDelegateId: requestId,
        delegateRequests: {
          ...state.delegateRequests,
          [requestId]: {
            requestId,
            provider,
            model,
            text: '',
            reasoning: '',
            done: false,
            error: null,
            startedAt: Date.now()
          }
        }
      }))
    } catch (error) {
      get().pushToast('error', (error as Error).message)
    }
  },

  cancelDelegate: async () => {
    const id = get().activeDelegateId
    if (!id) return
    await window.proharness.providers.cancel(id).catch(() => undefined)
    set((state) => {
      const current = state.delegateRequests[id]
      if (!current) return state
      return {
        delegateRequests: {
          ...state.delegateRequests,
          [id]: { ...current, done: true, error: 'Cancelled.' }
        }
      }
    })
  },

  handleDelegateEvent: (event) => {
    set((state) => {
      const current = state.delegateRequests[event.requestId]
      if (!current) return state
      if (event.type === 'delta') {
        return {
          delegateRequests: {
            ...state.delegateRequests,
            [event.requestId]: {
              ...current,
              text: current.text + event.text,
              reasoning: current.reasoning + (event.reasoning || '')
            }
          }
        }
      }
      if (event.type === 'done') {
        return {
          delegateRequests: {
            ...state.delegateRequests,
            [event.requestId]: {
              ...current,
              text: event.text || current.text,
              done: true,
              model: event.model
            }
          }
        }
      }
      return {
        delegateRequests: {
          ...state.delegateRequests,
          [event.requestId]: { ...current, done: true, error: event.message }
        }
      }
    })
  },

  insertDelegateResult: () => {
    const id = get().activeDelegateId
    const result = id ? get().delegateRequests[id] : null
    const tabId = get().activeTabId
    if (!result?.text || !tabId) return
    const current = get().drafts[tabId] || ''
    set((state) => ({
      drafts: {
        ...state.drafts,
        [tabId]: `${current.trim() ? `${current.trim()}\n\n` : ''}Consider this ${result.provider} review:\n\n${result.text}`
      }
    }))
    window.dispatchEvent(new CustomEvent('proharness:focus-composer'))
  },

  startLoop: async (config) => {
    try {
      const state = await window.proharness.loop.start(config)
      set({ loop: state, workbenchTab: 'loop', rightOpen: true })
    } catch (error) {
      get().pushToast('error', (error as Error).message)
      throw error
    }
  },

  pauseLoop: async () => {
    set({ loop: await window.proharness.loop.pause() })
  },

  resumeLoop: async () => {
    set({ loop: await window.proharness.loop.resume() })
  },

  stopLoop: async () => {
    set({ loop: await window.proharness.loop.stop() })
  },

  handleLoopEvent: (event) => {
    if (event.type === 'state') {
      set((state) => {
        const previous = state.loop
        const taskChanged =
          previous.runId !== event.state.runId ||
          previous.currentTask?.taskId !== event.state.currentTask?.taskId ||
          previous.currentStep !== event.state.currentStep ||
          previous.status !== event.state.status
        return {
          loop: {
            ...event.state,
            liveOutput: taskChanged ? event.state.liveOutput : state.loop.liveOutput
          }
        }
      })
      return
    }
    if (event.type === 'delta') {
      set((state) => ({
        loop: {
          ...state.loop,
          liveOutput: `${state.loop.liveOutput}${event.text}`.slice(-80_000)
        }
      }))
      return
    }
    if (event.type === 'log') {
      set((state) => {
        if (state.loop.log.some((entry) => entry.ts === event.entry.ts && entry.message === event.entry.message)) {
          return state
        }
        const log: LoopLogEntry[] = [...state.loop.log, event.entry].slice(-350)
        return { loop: { ...state.loop, log } }
      })
      return
    }
    if (event.type === 'step') {
      set((state) => ({
        loop: { ...state.loop, currentStep: event.step, currentTask: event.task || state.loop.currentTask }
      }))
    }
  }
}))
