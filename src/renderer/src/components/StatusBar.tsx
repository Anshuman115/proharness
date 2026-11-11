import { AlertTriangle, CircleCheck, GitBranch, Server, Terminal } from 'lucide-react'
import { shortModel } from '@shared/models'
import { useAppStore } from '../store'
import { formatCost } from '../lib/format'
import { isLocalHost, LOCAL_HOST } from '../lib/host'

export function StatusBar(): React.JSX.Element {
  const git = useAppStore((state) => state.git)
  const omp = useAppStore((state) => state.omp)
  const tabs = useAppStore((state) => state.tabs)
  const requests = useAppStore((state) => state.requests)
  const workspaceHost = useAppStore((state) => state.settings?.workspaceHost || LOCAL_HOST)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const working = tabs.filter((tab) => tab.status === 'working').length
  const spend = tabs.reduce((sum, tab) => sum + (tab.snapshot?.costUsd || 0), 0)

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        {!isLocalHost(workspaceHost) ? (
          <span className="statusbar__item" title={workspaceHost}>
            <Server size={12} />
            <span className="mono">{workspaceHost}</span>
          </span>
        ) : null}
        <button type="button" className="statusbar__item" onClick={() => setWorkbenchTab('changes')}>
          <GitBranch size={12} />
          <span>{git?.branch || (git?.isRepo ? 'detached' : 'no git')}</span>
          {git && !git.clean ? <span className="statusbar__badge">{git.files.length}</span> : null}
        </button>
        <button type="button" className="statusbar__item" onClick={() => setWorkbenchTab('terminal')}>
          <Terminal size={12} />
          <span>shell</span>
        </button>
        {requests.length ? <span className="statusbar__item statusbar__alert">{requests.length} waiting for you</span> : null}
      </div>
      <div className="statusbar__group statusbar__group--right">
        {working ? <span className="statusbar__item">{working} working</span> : null}
        {spend ? <span className="statusbar__item mono">{formatCost(spend)} this run</span> : null}
        <button type="button" className="statusbar__item" onClick={() => setSettingsOpen(true)}>
          {omp?.ok ? <CircleCheck size={12} /> : <AlertTriangle size={12} className="statusbar__warn" />}
          <span>{omp?.ok ? `omp ${omp.version || ''} · ${shortModel(omp.defaultModel)}` : 'omp not ready'}</span>
        </button>
      </div>
    </footer>
  )
}
