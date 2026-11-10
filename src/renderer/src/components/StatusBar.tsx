import { GitBranch, ShieldCheck, Cpu, Terminal, Layers } from 'lucide-react'
import { useAppStore } from '../store'
import { permissionModeLabel } from '../lib/format'

export function StatusBar(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const git = useAppStore((state) => state.git)
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const appVersion = useAppStore((state) => state.appVersion)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const tab = tabs.find((item) => item.id === activeTabId)

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        <button type="button" className="statusbar__item" onClick={() => setWorkbenchTab('changes')}>
          <GitBranch size={12} />
          <span>{git?.branch || (git?.isRepo ? 'detached' : 'no git')}</span>
          {git && !git.clean ? <span className="statusbar__badge">{git.files.length} changed</span> : null}
        </button>
        {tab ? (
          <>
            <span className="statusbar__sep" />
            <span className="statusbar__item">
              <Cpu size={12} />
              {tab.model}
            </span>
            <span className="statusbar__item">
              <ShieldCheck size={12} />
              {permissionModeLabel(tab.permissionMode)}
            </span>
          </>
        ) : null}
      </div>
      <div className="statusbar__group statusbar__group--right">
        <button type="button" className="statusbar__item" onClick={() => setWorkbenchTab('terminal')}>
          <Terminal size={12} />
          <span>shell</span>
        </button>
        <span className="statusbar__item">
          <Layers size={12} />
          MCP · plan tools
        </span>
        <span className="statusbar__sep" />
        <span className="statusbar__item statusbar__muted">v{appVersion}</span>
        <span className="statusbar__item statusbar__muted">{settings?.claude.model}</span>
      </div>
    </footer>
  )
}
