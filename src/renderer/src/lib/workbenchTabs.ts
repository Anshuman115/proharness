import { GitCompare, MessagesSquare, Repeat, Terminal, type LucideIcon } from 'lucide-react'
import type { WorkbenchTab } from '../store'

interface WorkbenchTabMeta {
  id: WorkbenchTab
  label: string
  actionLabel: string
  shortcut?: string
  icon: LucideIcon
}

export const WORKBENCH_TABS: readonly WorkbenchTabMeta[] = [
  { id: 'changes', label: 'Changes', actionLabel: 'Review changes', icon: GitCompare },
  { id: 'loop', label: 'Loop', actionLabel: 'Open autonomous loop', icon: Repeat },
  { id: 'consult', label: 'Consult', actionLabel: 'Ask another model', icon: MessagesSquare },
  { id: 'terminal', label: 'Shell', actionLabel: 'Open shell', shortcut: '⌘J', icon: Terminal }
]

export function workbenchTab(id: WorkbenchTab): WorkbenchTabMeta {
  const meta = WORKBENCH_TABS.find((item) => item.id === id)
  if (!meta) throw new Error(`Unknown workbench tab: ${id}`)
  return meta
}

export function workbenchTabByShortcut(shortcut: string): WorkbenchTabMeta | undefined {
  return WORKBENCH_TABS.find((item) => item.shortcut === shortcut)
}
