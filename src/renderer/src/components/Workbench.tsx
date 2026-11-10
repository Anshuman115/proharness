import { Bot, GitCompare, PanelRightClose, Terminal, Zap } from 'lucide-react'
import { useAppStore, type WorkbenchTab } from '../store'
import { ChangesPanel } from './ChangesPanel'
import { TerminalPanel } from './TerminalPanel'
import { DelegatePanel } from './DelegatePanel'
import { LoopPanel } from './LoopPanel'

const TABS: Array<{ id: WorkbenchTab; label: string; icon: typeof Terminal }> = [
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'terminal', label: 'Shell', icon: Terminal },
  { id: 'delegate', label: 'Delegate', icon: Bot },
  { id: 'loop', label: 'Loop', icon: Zap }
]

export function Workbench(): React.JSX.Element {
  const rightOpen = useAppStore((state) => state.rightOpen)
  const workbenchTab = useAppStore((state) => state.workbenchTab)
  const setWorkbenchTab = useAppStore((state) => state.setWorkbenchTab)
  const toggleRight = useAppStore((state) => state.toggleRight)
  const git = useAppStore((state) => state.git)
  const loop = useAppStore((state) => state.loop)

  return (
    <aside className={`workbench ${rightOpen ? '' : 'is-collapsed'}`} aria-label="Workbench">
      <div className="workbench__head">
        <div>
          <p className="eyebrow">Workbench</p>
          <div className="workbench__tabs" role="tablist" aria-label="Workbench panels">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const count =
                tab.id === 'changes' ? git?.files.length || 0 : tab.id === 'loop' && loop.status !== 'idle' ? 1 : 0
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
                  {count ? <span className="workbench__count">{count}</span> : null}
                </button>
              )
            })}
          </div>
        </div>
        <button type="button" className="icon-button" onClick={toggleRight} title="Collapse workbench">
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="workbench__body">
        {workbenchTab === 'changes' ? <ChangesPanel /> : null}
        {workbenchTab === 'delegate' ? <DelegatePanel /> : null}
        {workbenchTab === 'loop' ? <LoopPanel /> : null}
        <div className={`workbench__terminal-slot ${workbenchTab === 'terminal' ? 'is-active' : ''}`}>
          <TerminalPanel active={workbenchTab === 'terminal' && rightOpen} />
        </div>
      </div>
    </aside>
  )
}
