import { FolderOpen, PanelLeft, PanelRight, Settings } from 'lucide-react'
import { useAppStore } from '../store'
import { basename, stepLabel } from '../lib/format'

export function AppBar(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const leftOpen = useAppStore((state) => state.leftOpen)
  const rightOpen = useAppStore((state) => state.rightOpen)
  const loop = useAppStore((state) => state.loop)
  const toggleLeft = useAppStore((state) => state.toggleLeft)
  const toggleRight = useAppStore((state) => state.toggleRight)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const chooseWorkspace = useAppStore((state) => state.chooseWorkspace)
  const loopLive = ['running', 'paused', 'stopping'].includes(loop.status)

  return (
    <header className="appbar">
      <div className="appbar__left">
        <button
          type="button"
          className={`icon-button ${leftOpen ? 'is-active' : ''}`}
          onClick={toggleLeft}
          aria-label={leftOpen ? 'Hide plan' : 'Show plan'}
          title="Plan (⌘1)"
        >
          <PanelLeft size={15} />
        </button>
        <button type="button" className="workspace-chip" onClick={() => void chooseWorkspace()} title={settings?.workspacePath}>
          <FolderOpen size={13} />
          <span>{settings ? basename(settings.workspacePath) : 'workspace'}</span>
        </button>
      </div>

      <div className="appbar__title">ProHarness</div>

      <div className="appbar__right">
        <button type="button" className={`loop-pill loop-pill--${loop.status}`} onClick={() => setWorkbenchTab('loop')} title="Autonomous loop">
          <span className="status-dot" />
          {loopLive ? (
            <>
              <span>{stepLabel(loop.currentStep)}</span>
              {loop.currentTask ? <span className="loop-pill__task mono">{loop.currentTask.taskId}</span> : null}
            </>
          ) : (
            <span>Loop</span>
          )}
        </button>
        <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings (⌘,)">
          <Settings size={15} />
        </button>
        <button
          type="button"
          className={`icon-button ${rightOpen ? 'is-active' : ''}`}
          onClick={toggleRight}
          aria-label={rightOpen ? 'Hide workbench' : 'Show workbench'}
          title="Workbench (⌘2)"
        >
          <PanelRight size={15} />
        </button>
      </div>
    </header>
  )
}
