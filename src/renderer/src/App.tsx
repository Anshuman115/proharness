import { useEffect, useRef } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useAppStore } from './store'
import { AppBar } from './components/AppBar'
import { PlanRail } from './components/PlanRail'
import { ChatPanel } from './components/ChatPanel'
import { Workbench } from './components/Workbench'
import { StatusBar } from './components/StatusBar'
import { PermissionDialog } from './components/PermissionDialog'
import { GoalDesignDialog } from './components/GoalDesignDialog'
import { SettingsDialog } from './components/SettingsDialog'
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
    const store = useAppStore.getState()
    const offGoals = window.proharness.goals.onChanged((goals) => store.handleGoalsChanged(goals))
    const offGit = window.proharness.git.onChanged((summary) => store.handleGitChanged(summary))
    const offSessions = window.proharness.sessions.onEvent((tabId, event) =>
      useAppStore.getState().handleSessionEvent(tabId, event)
    )
    const offPermission = window.proharness.permissions.onRequest((request) =>
      useAppStore.getState().addPermission(request)
    )
    const offResolved = window.proharness.permissions.onResolved((requestId) =>
      useAppStore.getState().clearPermission(requestId)
    )
    const offLoop = window.proharness.loop.onEvent((event) => useAppStore.getState().handleLoopEvent(event))
    const offDelegate = window.proharness.providers.onEvent((event) =>
      useAppStore.getState().handleDelegateEvent(event)
    )

    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      if (event.key === 't') {
        event.preventDefault()
        void useAppStore.getState().createTab({ activate: true })
      } else if (event.key === 'w') {
        event.preventDefault()
        const id = useAppStore.getState().activeTabId
        if (id) void useAppStore.getState().closeTab(id)
      } else if (event.key === ',') {
        event.preventDefault()
        useAppStore.getState().setSettingsOpen(true)
      } else if (event.key === 'j') {
        event.preventDefault()
        useAppStore.getState().toggleLeft()
      } else if (event.key === 'b') {
        event.preventDefault()
        useAppStore.getState().toggleRight()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      offGoals()
      offGit()
      offSessions()
      offPermission()
      offResolved()
      offLoop()
      offDelegate()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
  }, [settings])

  if (loading) {
    return (
      <div className="boot">
        <div className="boot__mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <p className="eyebrow">ProHarness</p>
        <h1>Warming the desk.</h1>
        <p className="boot__status">
          <Loader2 size={13} className="spin" /> Reading the workspace and plan
        </p>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="boot boot--error">
        <AlertTriangle size={28} />
        <p className="eyebrow">Could not open the harness</p>
        <h1>{bootError}</h1>
        <p className="boot__status">Check the workspace path and restart the app.</p>
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
      <PermissionDialog />
      <GoalDesignDialog />
      <SettingsDialog />
      <Toast />
    </div>
  )
}
