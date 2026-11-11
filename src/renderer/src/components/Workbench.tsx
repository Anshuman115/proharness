import { GitCompare, MessagesSquare, Repeat, Terminal } from 'lucide-react'
import { useAppStore, type WorkbenchTab } from '../store'
import { ChangesPanel } from './ChangesPanel'
import { ConsultPanel } from './ConsultPanel'
import { LoopPanel } from './LoopPanel'
import { TerminalPanel } from './TerminalPanel'

const TABS: Array<{ id: WorkbenchTab; label: string; icon: typeof Terminal }> = [
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'loop', label: 'Loop', icon: Repeat },
  { id: 'consult', label: 'Consult', icon: MessagesSquare },
  { id: 'terminal', label: 'Shell', icon: Terminal }
]

export function Workbench(): React.JSX.Element {
  const rightOpen = useAppStore((state) => state.rightOpen)
  const workbenchTab = useAppStore((state) => state.workbenchTab)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const git = useAppStore((state) => state.git)
  const loop = useAppStore((state) => state.loop)
  const loopLive = ['running', 'paused', 'stopping'].includes(loop.status)

  return (
    <aside className={`workbench ${rightOpen ? '' : 'is-collapsed'}`} aria-label="Workbench">
      <div className="workbench__tabs" role="tablist" aria-label="Workbench panels">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const badge = tab.id === 'changes' ? git?.files.length || 0 : 0
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={workbenchTab === tab.id}
              className={workbenchTab === tab.id ? 'is-active' : ''}
              onClick={() => setWorkbenchTab(tab.id)}
            >
              <Icon size={13} />
              <span>{tab.label}</span>
              {badge ? <span className="workbench__count">{badge}</span> : null}
              {tab.id === 'loop' && loopLive ? <span className="workbench__live" /> : null}
            </button>
          )
        })}
      </div>
      <div className="workbench__body">
        {workbenchTab === 'changes' ? <ChangesPanel /> : null}
        {workbenchTab === 'consult' ? <ConsultPanel /> : null}
        {workbenchTab === 'loop' ? <LoopPanel /> : null}
        <div className={`workbench__terminal-slot ${workbenchTab === 'terminal' ? 'is-active' : ''}`}>
          <TerminalPanel active={workbenchTab === 'terminal' && rightOpen} />
        </div>
      </div>
    </aside>
  )
}
