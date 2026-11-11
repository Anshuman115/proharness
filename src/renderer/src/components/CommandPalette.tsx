import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useAppStore } from '../store'
import { basename } from '../lib/format'

interface Action {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** ⌘K: app actions plus switching models, tabs and goals. */
export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((state) => state.paletteOpen)
  const setOpen = useAppStore((state) => state.setPaletteOpen)
  const tabs = useAppStore((state) => state.tabs)
  const goals = useAppStore((state) => state.goals)
  const omp = useAppStore((state) => state.omp)
  const pinned = useAppStore((state) => state.settings?.pinnedModels || [])
  const recentWorkspaces = useAppStore((state) => state.settings?.recentWorkspaces || [])
  const activeTabId = useAppStore((state) => state.activeTabId)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const actions = useMemo<Action[]>(() => {
    const store = useAppStore.getState
    const list: Action[] = [
      { id: 'new-tab', label: 'New session', hint: '⌘T', run: () => void store().createTab({ activate: true }) },
      { id: 'resume', label: 'Resume an omp session…', run: () => void store().openRecent(true) },
      { id: 'new-goal', label: 'New goal…', run: () => store().setNewGoalOpen(true) },
      { id: 'loop', label: 'Open autonomous loop', run: () => store().setWorkbenchTab('loop') },
      { id: 'consult', label: 'Ask another model', run: () => store().setWorkbenchTab('consult') },
      { id: 'changes', label: 'Review changes', run: () => store().setWorkbenchTab('changes') },
      { id: 'shell', label: 'Open shell', hint: '⌘J', run: () => store().setWorkbenchTab('terminal') },
      { id: 'workspace', label: 'Change workspace…', run: () => store().setWorkspaceOpen(true) },
      { id: 'settings', label: 'Settings', hint: '⌘,', run: () => store().setSettingsOpen(true) },
      { id: 'refresh-omp', label: 'Recheck omp and reload models', run: () => void store().refreshOmp() }
    ]
    if (activeTabId) {
      list.push(
        { id: 'compact', label: 'Compact this session', run: () => void store().compactTab(activeTabId) },
        { id: 'fresh', label: 'Fresh conversation in this tab', run: () => void store().newConversation(activeTabId) }
      )
      const models = omp?.models || []
      const ordered = [...pinned.map((key) => models.find((model) => model.key === key)).filter(Boolean), ...models.filter((model) => !pinned.includes(model.key))]
      for (const model of ordered) {
        if (!model) continue
        list.push({ id: `model-${model.key}`, label: `Switch model: ${model.name}`, hint: model.key, run: () => void store().setTabModel(activeTabId, model.key) })
      }
    }
    tabs.forEach((tab, index) => list.push({ id: `tab-${tab.id}`, label: `Go to tab: ${tab.title}`, hint: index < 7 ? `⌘${index + 3}` : undefined, run: () => store().setActiveTab(tab.id) }))
    for (const goal of goals) list.push({ id: `goal-${goal.id}`, label: `Goal: ${goal.title}`, hint: `${goal.progress}%`, run: () => void store().selectGoal(goal.id) })
    for (const item of recentWorkspaces) {
      list.push({
        id: `workspace-${item.host}-${item.path}`,
        label: `Open workspace: ${basename(item.path)} ${item.host === 'local' ? '(This Mac)' : `@ ${item.host}`}`,
        hint: item.host === 'local' ? undefined : item.path,
        run: () => void store().openWorkspace(item)
      })
    }
    return list
  }, [tabs, goals, omp, pinned, activeTabId, recentWorkspaces])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions.filter((action) => !action.id.startsWith('model-')).slice(0, 40)
    const words = q.split(/\s+/)
    return actions.filter((action) => words.every((word) => `${action.label} ${action.hint || ''}`.toLowerCase().includes(word))).slice(0, 60)
  }, [actions, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null
  const run = (action: Action | undefined): void => {
    if (!action) return
    setOpen(false)
    action.run()
  }

  return (
    <div className="modal-backdrop modal-backdrop--palette" role="presentation" onMouseDown={() => setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette__search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Type a command, model, tab or goal"
            onChange={(event) => {
              setQuery(event.target.value)
              setCursor(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((index) => Math.min(filtered.length - 1, index + 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((index) => Math.max(0, index - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(filtered[cursor])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              }
            }}
          />
        </div>
        <div className="palette__list" ref={listRef} role="listbox">
          {filtered.length === 0 ? <p className="palette__empty">Nothing matches.</p> : null}
          {filtered.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="option"
              data-index={index}
              aria-selected={index === cursor}
              className={`palette__item ${index === cursor ? 'is-cursor' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => run(action)}
            >
              <span>{action.label}</span>
              {action.hint ? <span className="palette__hint">{action.hint}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
