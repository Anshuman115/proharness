import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  CornerDownRight,
  FileText,
  History,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  XCircle
} from 'lucide-react'
import { providerOf, shortModel } from '@shared/models'
import { THINKING_LEVELS, type ContentBlock, type ThinkingLevel, type ToolBlock } from '@shared/types'
import { useAppStore, type ChatMessage, type ChatTab } from '../store'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { approvalLabel, formatClock, formatCost, formatRelative, formatTokens, statusLabel } from '../lib/format'

export function ChatPanel(): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  const createTab = useAppStore((state) => state.createTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const openRecent = useAppStore((state) => state.openRecent)
  const requests = useAppStore((state) => state.requests)

  return (
    <section className="center">
      <div className="tabstrip" role="tablist" aria-label="Sessions">
        <div className="tabstrip__scroll">
          {tabs.map((tab) => {
            const waiting = requests.some((request) => request.originId === tab.id)
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={tab.id === activeTabId}
                className={`tab ${tab.id === activeTabId ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveTab(tab.id)
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) void closeTab(tab.id)
                }}
                title={tab.title}
              >
                <span className={`tab__dot tab__dot--${waiting ? 'waiting' : tab.status}`} />
                <span className="tab__title">{tab.title}</span>
                <button
                  type="button"
                  className="tab__close"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void closeTab(tab.id)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="tab tab--new"
            onClick={() => void createTab({ activate: true })}
            title="New session (⌘T)"
            aria-label="New session"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="tabstrip__meta">
          <button type="button" className="text-button" onClick={() => void openRecent(true)} title="Resume an omp session">
            <History size={13} /> Resume
          </button>
        </div>
      </div>

      {activeTab ? <ChatView key={activeTab.id} tab={activeTab} /> : <NoSession />}
      <RecentSessions />
    </section>
  )
}

function NoSession(): React.JSX.Element {
  const createTab = useAppStore((state) => state.createTab)
  return (
    <div className="session-empty">
      <p className="eyebrow">No session open</p>
      <h1>Open a session to start.</h1>
      <p className="session-empty__copy">Each tab is its own omp process with your models, skills and extensions.</p>
      <div className="session-empty__actions">
        <button type="button" className="btn btn--accent" onClick={() => void createTab({ activate: true })}>
          <Plus size={15} /> New session
        </button>
      </div>
    </div>
  )
}

function RecentSessions(): React.JSX.Element | null {
  const open = useAppStore((state) => state.recentOpen)
  const recent = useAppStore((state) => state.recent)
  const openRecent = useAppStore((state) => state.openRecent)
  const resumeRecent = useAppStore((state) => state.resumeRecent)
  const workspace = useAppStore((state) => state.settings?.workspaceName)
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => void openRecent(false)}>
      <div className="recent-dialog" role="dialog" aria-modal="true" aria-label="Resume a session" onMouseDown={(event) => event.stopPropagation()}>
        <div className="recent-dialog__head">
          <div>
            <p className="eyebrow">omp sessions · {workspace}</p>
            <h2>Resume a conversation</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => void openRecent(false)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="recent-dialog__list">
          {recent.length === 0 ? <p className="muted small">No saved omp sessions for this folder yet.</p> : null}
          {recent.map((item) => (
            <button key={item.file} type="button" className="recent-row" onClick={() => void resumeRecent(item.file, item.title)}>
              <span className="recent-row__title">{item.title}</span>
              <span className="recent-row__meta">
                {item.model ? <span className="mono">{shortModel(item.model)}</span> : null}
                <span>{formatRelative(item.updatedAt)}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="recent-dialog__foot">Sessions started in the omp terminal app appear here too.</p>
      </div>
    </div>
  )
}

function ChatView({ tab }: { tab: ChatTab }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    if (atBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [tab.messages, tab.status])

  const working = tab.status === 'working'
  const streaming = tab.messages.some((message) => message.streaming)

  return (
    <div className="chat">
      <SessionHeader tab={tab} />
      <div
        className="chat__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90
        }}
      >
        <div className="chat__inner">
          {tab.messages.length === 0 ? <SessionBlank tab={tab} /> : null}
          {tab.messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
          {working && !streaming ? (
            <div className="thinking-line">
              <span className="thinking-line__orb" />
              <span>{shortModel(tab.snapshot?.model)} is working…</span>
            </div>
          ) : null}
        </div>
      </div>
      <TodoStrip tab={tab} />
      <Composer tab={tab} />
    </div>
  )
}

function SessionHeader({ tab }: { tab: ChatTab }): React.JSX.Element {
  const setTabModel = useAppStore((state) => state.setTabModel)
  const setTabThinking = useAppStore((state) => state.setTabThinking)
  const newConversation = useAppStore((state) => state.newConversation)
  const compactTab = useAppStore((state) => state.compactTab)
  const omp = useAppStore((state) => state.omp)
  const snapshot = tab.snapshot
  const model = omp?.models.find((item) => item.key === snapshot?.model)
  const efforts = model?.efforts.length ? ['off', ...model.efforts] : [...THINKING_LEVELS]
  const percent = snapshot?.contextPercent ?? null
  const busy = tab.status !== 'idle'

  return (
    <div className="session-head">
      <ModelPicker
        value={snapshot?.model || ''}
        onChange={(key) => key && void setTabModel(tab.id, key)}
        disabled={tab.status === 'starting' || tab.status === 'closed'}
        ariaLabel="Session model"
      />
      <label className="effort-select" title="Reasoning effort">
        <Brain size={13} />
        <select
          value={snapshot?.thinking || ''}
          onChange={(event) => void setTabThinking(tab.id, event.target.value as ThinkingLevel)}
          disabled={tab.status === 'starting'}
          aria-label="Reasoning effort"
        >
          {snapshot?.thinking && !efforts.includes(snapshot.thinking) ? <option value={snapshot.thinking}>{snapshot.thinking}</option> : null}
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <span className="session-head__chip" title="omp approval mode for this tab">
        {approvalLabel(tab.approval)}
      </span>
      <span className="session-head__spacer" />
      {percent !== null ? (
        <span
          className={`context-meter ${percent > 80 ? 'is-hot' : percent > 60 ? 'is-warm' : ''}`}
          title={`${formatTokens(snapshot?.contextTokens)} of ${formatTokens(snapshot?.contextWindow)} tokens`}
        >
          <span className="context-meter__bar">
            <span style={{ width: `${Math.min(100, percent)}%` }} />
          </span>
          {Math.round(percent)}%
        </span>
      ) : null}
      {snapshot?.costUsd ? <span className="session-head__cost mono">{formatCost(snapshot.costUsd)}</span> : null}
      <button type="button" className="icon-button" onClick={() => void compactTab(tab.id)} disabled={busy} title="Compact context">
        <CircleDashed size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => void newConversation(tab.id)}
        disabled={busy}
        title="Start a fresh conversation in this tab"
      >
        <RotateCcw size={14} />
      </button>
    </div>
  )
}

function SessionBlank({ tab }: { tab: ChatTab }): React.JSX.Element {
  const goal = useAppStore((state) => state.goalDetail)
  const setDraft = useAppStore((state) => state.setDraft)
  const focusComposer = useAppStore((state) => state.focusComposer)
  const setDesignGoal = useAppStore((state) => state.setDesignGoal)
  const omp = useAppStore((state) => state.omp)
  const nextTask = goal?.phases.flatMap((phase) => phase.tasks).find((task) => !task.checked)

  if (tab.status === 'error' || (omp && !omp.ok && omp.error)) {
    return (
      <div className="session-blank session-blank--error">
        <p className="eyebrow">omp unavailable</p>
        <h1>This tab could not start omp.</h1>
        <p className="session-blank__copy">{tab.error || omp?.error}</p>
        <p className="session-blank__copy muted">Check the omp path in Settings, then open a new tab.</p>
      </div>
    )
  }

  const suggestions = goal
    ? [
        nextTask ? `Implement task ${nextTask.id} of goal ${goal.id}: ${nextTask.title}` : `Read goal ${goal.id} and propose the next phase`,
        `Summarize the design in goals/${goal.id}/DESIGN.md and flag open questions`,
        'Review the working tree for risky or unrelated changes'
      ]
    : ['Map this repository and explain its architecture', 'Review the working tree for risky changes', 'Draft a goal and phased plan for the next feature']

  return (
    <div className="session-blank">
      <p className="eyebrow">
        {statusLabel(tab.status)} · {shortModel(tab.snapshot?.model)}
      </p>
      <h1>What should we work on?</h1>
      <p className="session-blank__copy">
        {goal ? (
          <>
            Goal <strong>{goal.title}</strong> is {goal.progress}% done.
            {nextTask ? (
              <>
                {' '}
                Next: <span className="mono">{nextTask.id}</span> {nextTask.title}.
              </>
            ) : (
              ' Every task is checked off.'
            )}
          </>
        ) : (
          'No goal selected. Plans live in goals/ and stay out of git.'
        )}
      </p>
      <div className="prompt-grid">
        {suggestions.map((suggestion, index) => (
          <button
            key={suggestion}
            type="button"
            className="prompt-card"
            onClick={() => {
              setDraft(suggestion)
              focusComposer()
            }}
          >
            <span className="prompt-card__icon">{index === 0 ? <Sparkles size={14} /> : index === 1 ? <FileText size={14} /> : <ListChecks size={14} />}</span>
            <span>{suggestion}</span>
            <ArrowUp size={13} className="prompt-card__arrow" />
          </button>
        ))}
      </div>
      {goal ? (
        <button type="button" className="text-link" onClick={() => setDesignGoal(goal.id)}>
          Open DESIGN.md <ChevronRight size={12} />
        </button>
      ) : null}
    </div>
  )
}

function MessageRow({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (message.role === 'system') {
    const text = message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    return (
      <div className={`system-row system-row--${message.level || 'info'}`}>
        <span className="system-row__label">{message.level === 'error' ? 'Error' : message.level === 'warn' ? 'Notice' : 'omp'}</span>
        <div className="system-row__body">
          <Markdown compact>{text}</Markdown>
        </div>
      </div>
    )
  }

  if (message.role === 'user') {
    const text = message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    return (
      <article className="message message--user">
        <div className="message__bubble">
          <Markdown compact>{text}</Markdown>
        </div>
      </article>
    )
  }

  const visible = message.blocks.filter((block) => block.type !== 'text' || block.text.trim())
  if (!visible.length && !message.streaming) return null
  return (
    <article className="message message--assistant">
      <div className="message__meta">
        <span className={`provider-mark provider-mark--${providerOf(message.model || '') || 'default'}`} />
        <span className="message__author">{shortModel(message.model)}</span>
        <span>{formatClock(message.createdAt)}</span>
        {message.costUsd ? <span className="mono">{formatCost(message.costUsd)}</span> : null}
        {message.streaming ? <span className="live-tag">live</span> : null}
      </div>
      <div className="message__blocks">
        {message.blocks.map((block, index) => (
          <Block key={block.type === 'tool' ? block.id : `${message.id}-${index}`} block={block} streaming={message.streaming} />
        ))}
        {message.streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
      </div>
    </article>
  )
}

function Block({ block, streaming }: { block: ContentBlock; streaming?: boolean }): React.JSX.Element | null {
  if (block.type === 'text') return block.text.trim() ? <Markdown>{block.text}</Markdown> : null
  if (block.type === 'thinking') {
    if (!block.text.trim()) return null
    return (
      <details className="thinking-block">
        <summary>
          <Brain size={12} /> Reasoning
          <span>{streaming ? 'live' : `${block.text.length} chars`}</span>
        </summary>
        <pre>{block.text}</pre>
      </details>
    )
  }
  return <ToolCard block={block} />
}

function ToolCard({ block }: { block: ToolBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const icon =
    block.status === 'done' ? (
      <CheckCircle2 size={12} />
    ) : block.status === 'error' ? (
      <XCircle size={12} />
    ) : block.status === 'running' ? (
      <Loader2 size={12} className="spin" />
    ) : (
      <Wrench size={12} />
    )
  const hint = block.intent || toolHint(block)
  const argsText = useMemo(() => truncate(JSON.stringify(block.args, null, 2), 6000), [block.args])
  return (
    <div className={`tool-call tool-call--${block.status} ${open ? 'is-open' : ''}`}>
      <button type="button" className="tool-call__summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-call__icon">{icon}</span>
        <span className="tool-call__name">{block.name}</span>
        <span className="tool-call__hint">{hint}</span>
        <ChevronRight size={12} className={`tool-call__chevron ${open ? 'rotated' : ''}`} />
      </button>
      {open ? (
        <div className="tool-call__body">
          {block.name === 'bash' && typeof block.args.command === 'string' ? (
            <pre className="tool-call__command">
              <Terminal size={11} /> {block.args.command}
            </pre>
          ) : (
            <pre>{argsText}</pre>
          )}
          {block.output ? <pre className="tool-call__output">{truncate(block.output, 12000)}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

function toolHint(block: ToolBlock): string {
  const args = block.args
  const value = args.path || args.file_path || args.command || args.pattern || args.query || args.url || args.goal || args.description || ''
  return typeof value === 'string' ? truncate(value.replace(/\s+/g, ' '), 110) : ''
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… truncated` : value
}

function TodoStrip({ tab }: { tab: ChatTab }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const tasks = (tab.snapshot?.todos || []).flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })))
  if (!tasks.length) return null
  const done = tasks.filter((task) => task.status === 'completed').length
  const active = tasks.find((task) => task.status === 'in_progress')
  return (
    <div className={`todo-strip ${open ? 'is-open' : ''}`}>
      <button type="button" className="todo-strip__head" onClick={() => setOpen((value) => !value)}>
        <ListChecks size={13} />
        <span>
          Agent todos {done}/{tasks.length}
        </span>
        {active ? <span className="todo-strip__active">{active.content}</span> : null}
        <ChevronRight size={12} className={open ? 'rotated-up' : ''} />
      </button>
      {open ? (
        <ul className="todo-strip__list">
          {tasks.map((task, index) => (
            <li key={`${task.phase}-${index}`} className={`todo todo--${task.status}`}>
              {task.status === 'completed' ? <CheckCircle2 size={12} /> : task.status === 'in_progress' ? <Loader2 size={12} className="spin" /> : <Circle size={12} />}
              <span>{task.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Composer({ tab }: { tab: ChatTab }): React.JSX.Element {
  const draft = useAppStore((state) => state.drafts[tab.id] || '')
  const setDraft = useAppStore((state) => state.setDraft)
  const sendMessage = useAppStore((state) => state.sendMessage)
  const stopActive = useAppStore((state) => state.stopActive)
  const removeQueued = useAppStore((state) => state.removeQueued)
  const composerFocus = useAppStore((state) => state.composerFocus)
  const goal = useAppStore((state) => state.goalDetail)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const working = tab.status === 'working' || tab.status === 'stopping'
  const disabled = tab.status === 'starting' || tab.status === 'closed' || tab.status === 'error'
  const nextTask = goal?.phases.flatMap((phase) => phase.tasks).find((task) => !task.checked)
  const queue = tab.snapshot?.queue || { steering: [], followUp: [] }
  const focusComposer = useAppStore((state) => state.focusComposer)

  const slashQuery = /^\/[\w:-]*$/.test(draft) ? draft.slice(1).toLowerCase() : null
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : tab.commands.filter((command) => command.name.toLowerCase().startsWith(slashQuery)).slice(0, 8)),
    [slashQuery, tab.commands]
  )

  useEffect(() => {
    if (composerFocus > 0) textareaRef.current?.focus()
  }, [composerFocus])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(240, Math.max(48, textarea.scrollHeight))}px`
  }, [draft])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [tab.id])

  useEffect(() => setSlashIndex(0), [slashQuery])

  const submit = (behavior: 'steer' | 'followUp' = 'followUp'): void => {
    if (!draft.trim() || disabled) return
    void sendMessage(draft, behavior)
  }

  return (
    <div className="composer-wrap">
      {queue.steering.length || queue.followUp.length ? (
        <div className="queue-chips">
          {[...queue.steering.map((text) => ({ text, queue: 'steering' as const })), ...queue.followUp.map((text) => ({ text, queue: 'followUp' as const }))].map(
            (item, index) => (
              <span key={`${item.queue}-${index}`} className={`queue-chip queue-chip--${item.queue}`}>
                <CornerDownRight size={11} />
                <span className="queue-chip__label">{item.queue === 'steering' ? 'steer' : 'next'}</span>
                <span className="queue-chip__text">{item.text}</span>
                <button type="button" onClick={() => void removeQueued(tab.id, item.text, item.queue)} aria-label="Remove queued message">
                  <X size={11} />
                </button>
              </span>
            )
          )}
        </div>
      ) : null}
      {slashMatches.length ? (
        <div className="slash-menu" role="listbox">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={index === slashIndex ? 'is-cursor' : ''}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => {
                setDraft(`/${command.name} `)
                textareaRef.current?.focus()
              }}
            >
              <span className="mono">/{command.name}</span>
              {command.hint ? <span className="slash-menu__hint">{command.hint}</span> : null}
              <span className="slash-menu__desc">{command.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={`composer ${working ? 'is-busy' : ''}`}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (slashMatches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setSlashIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : slashMatches.length - 1)) % slashMatches.length)
              return
            }
            if (slashMatches.length && event.key === 'Tab') {
              event.preventDefault()
              setDraft(`/${slashMatches[slashIndex].name} `)
              return
            }
            if (event.key === 'Escape' && working) {
              event.preventDefault()
              void stopActive()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (slashMatches.length && draft.trim() !== `/${slashMatches[slashIndex].name}`) {
                setDraft(`/${slashMatches[slashIndex].name} `)
                return
              }
              submit(working && (event.metaKey || event.ctrlKey) ? 'steer' : 'followUp')
            }
          }}
          placeholder={
            disabled
              ? tab.status === 'starting'
                ? 'Starting omp…'
                : 'omp is not running in this tab'
              : working
                ? 'Queue a follow-up (Return) or steer now (⌘Return)…'
                : 'Message omp. Type / for commands.'
          }
          aria-label="Message"
          rows={1}
          disabled={disabled}
        />
        <div className="composer__bar">
          <div className="composer__left">
            {goal && nextTask ? (
              <button
                type="button"
                className="context-next"
                onClick={() => {
                  setDraft(`Implement task ${nextTask.id} of goal ${goal.id}: ${nextTask.title}. Read goals/${goal.id}/DESIGN.md first, then verify the change.`)
                  focusComposer()
                }}
              >
                <Circle size={9} /> next {nextTask.id} · {nextTask.title}
              </button>
            ) : (
              <span className="composer__hint">⇧↵ new line · / commands</span>
            )}
          </div>
          <div className="composer__right">
            {working ? (
              <button type="button" className="composer__stop" onClick={() => void stopActive()} title="Stop (Esc)">
                <Square size={11} fill="currentColor" /> Stop
              </button>
            ) : null}
            <button
              type="button"
              className="composer__send"
              onClick={() => submit()}
              disabled={!draft.trim() || disabled}
              aria-label={working ? 'Queue message' : 'Send message'}
              title={working ? 'Queue (Return)' : 'Send (Return)'}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
