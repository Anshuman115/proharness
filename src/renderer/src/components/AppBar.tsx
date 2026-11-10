import {
  FolderOpen,
  PanelLeft,
  PanelRight,
  Settings,
  Sparkles
} from 'lucide-react'
import { useAppStore } from '../store'
import { basename } from '../lib/format'

export function AppBar(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const platform = useAppStore((state) => state.platform)
  const leftOpen = useAppStore((state) => state.leftOpen)
  const rightOpen = useAppStore((state) => state.rightOpen)
  const loop = useAppStore((state) => state.loop)
  const toggleLeft = useAppStore((state) => state.toggleLeft)
  const toggleRight = useAppStore((state) => state.toggleRight)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)

  const loopLive = loop.status === 'running' || loop.status === 'paused' || loop.status === 'stopping'

  return (
    <header className="appbar" data-mac={platform === 'darwin' ? 'true' : 'false'}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="brand-name">ProHarness</span>
        <span className="brand-sub">operations desk</span>
      </div>

      <div className="appbar-center">
        <button
          type="button"
          className="workspace-chip"
          onClick={() => setSettingsOpen(true)}
          title={settings?.workspacePath || 'Workspace'}
        >
          <FolderOpen size={13} />
          <span>{settings ? basename(settings.workspacePath) : 'workspace'}</span>
          <span className="workspace-chip__path">{settings?.workspacePath}</span>
        </button>
        <div className="appbar-divider" />
        <button
          type="button"
          className={`icon-button ${leftOpen ? 'is-active' : ''}`}
          onClick={toggleLeft}
          aria-label={leftOpen ? 'Hide plan' : 'Show plan'}
          title="Toggle plan rail"
        >
          <PanelLeft size={15} />
        </button>
        <button
          type="button"
          className={`icon-button ${rightOpen ? 'is-active' : ''}`}
          onClick={toggleRight}
          aria-label={rightOpen ? 'Hide workbench' : 'Show workbench'}
          title="Toggle workbench"
        >
          <PanelRight size={15} />
        </button>
      </div>

      <div className="appbar-actions">
        <button
          type="button"
          className={`loop-pill loop-pill--${loop.status}`}
          onClick={() => {
            setWorkbenchTab('loop')
          }}
          title="Open autonomous task loop"
        >
          <span className="status-dot" />
          <span>{loopLive ? loop.status : 'Loop ready'}</span>
          {loopLive && loop.currentTask ? (
            <span className="loop-pill__task">{loop.currentTask.taskId}</span>
          ) : (
            <Sparkles size={12} />
          )}
        </button>
        <button
          type="button"
          className="icon-button icon-button--lg"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  )
}
