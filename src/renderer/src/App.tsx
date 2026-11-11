import { useEffect, useRef } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useAppStore } from './store'
import { AppBar } from './components/AppBar'
import { PlanRail } from './components/PlanRail'
import { ChatPanel } from './components/ChatPanel'
import { Workbench } from './components/Workbench'
import { StatusBar } from './components/StatusBar'
import { RequestDialog } from './components/RequestDialog'
import { GoalDesignDialog } from './components/GoalDesignDialog'
import { NewGoalDialog } from './components/NewGoalDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { WorkspaceDialog } from './components/WorkspaceDialog'
import { CommandPalette } from './components/CommandPalette'
import { Toast } from './components/Toast'

export default function App(): React.JSX.Element {
  const loading = useAppStore((state) => state.loading)
  const bootError = useAppStore((state) => state.bootError)
  const settings = useAppStore((state) => state.settings)
  const leftOpen = useAppStore((state) => state.leftOpen)
  const rightOpen = useAppStore((state) => state.rightOpen)
  const bootStarted = useRef(false)

  useEffect(() => {
    if (bootStarted.current) return
    bootStarted.current = true
    void useAppStore.getState().init()
  }, [])

  useEffect(() => {
    const api = window.proharness
    const store = useAppStore.getState
    const offs = [
      api.goals.onChanged((goals) => store().handleGoalsChanged(goals)),
      api.git.onChanged((summary) => store().handleGitChanged(summary)),
      api.omp.onChanged((status) => useAppStore.setState({ omp: status })),
      api.settings.onChanged((settings) => useAppStore.setState({ settings })),
      api.sessions.onEvent((tabId, event) => store().handleSessionEvent(tabId, event)),
      api.ui.onRequest((request) => store().addRequest(request)),
      api.ui.onResolved((requestId) => store().clearRequest(requestId)),
      api.loop.onEvent((event) => store().handleLoopEvent(event)),
      api.consult.onEvent((event) => store().handleConsultEvent(event))
    ]

    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target instanceof Element && target.closest('.terminal-host')) return
      if (!event.metaKey || event.altKey || event.ctrlKey) return
      const state = store()
      const key = event.key.toLowerCase()
      if (key === 't') {
        event.preventDefault()
        void state.createTab({ activate: true })
      } else if (key === 'w') {
        event.preventDefault()
        if (state.activeTabId) void state.closeTab(state.activeTabId)
      } else if (key === ',') {
        event.preventDefault()
        state.setSettingsOpen(true)
      } else if (key === 'k') {
        event.preventDefault()
        state.setPaletteOpen(!state.paletteOpen)
      } else if (key === '1') {
        event.preventDefault()
        state.toggleLeft()
      } else if (key === '2') {
        event.preventDefault()
        state.toggleRight()
      } else if (key === 'j') {
        event.preventDefault()
        state.setWorkbenchTab('terminal')
      } else if (/^[3-9]$/.test(key) && !event.shiftKey) {
        const tab = state.tabs[Number(key) - 3]
        if (tab) {
          event.preventDefault()
          state.setActiveTab(tab.id)
        }
      } else if ((key === '[' || key === ']') && event.shiftKey) {
        event.preventDefault()
        const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
        const next = state.tabs[(index + (key === ']' ? 1 : state.tabs.length - 1)) % Math.max(1, state.tabs.length)]
        if (next) state.setActiveTab(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      for (const off of offs) off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (settings) document.documentElement.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
  }, [settings])

  if (loading) {
    return (
      <div className="boot">
        <p className="boot__status">
          <Loader2 size={14} className="spin" /> Opening workspace
        </p>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="boot boot--error">
        <AlertTriangle size={26} />
        <h1>ProHarness could not start.</h1>
        <p className="boot__status">{bootError}</p>
        <button type="button" className="btn btn--accent" onClick={() => window.location.reload()}>
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className={`app ${leftOpen ? '' : 'rail-closed'} ${rightOpen ? '' : 'workbench-closed'}`}>
      <AppBar />
      <main className="workspace">
        <PlanRail />
        <ChatPanel />
        <Workbench />
      </main>
      <StatusBar />
      <RequestDialog />
      <GoalDesignDialog />
      <NewGoalDialog />
      <SettingsDialog />
      <WorkspaceDialog />
      <CommandPalette />
      <Toast />
    </div>
  )
}
