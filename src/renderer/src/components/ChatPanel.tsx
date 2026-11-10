import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import type { AssistantBlock } from '@shared/types'
import { useAppStore, type ChatMessage, type ChatTab } from '../store'
import { Markdown } from './Markdown'
import { formatClock, permissionModeLabel, statusLabel } from '../lib/format'

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']

export function ChatPanel(): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
  const createTab = useAppStore((state) => state.createTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const setActiveTab = useAppStore((state) => state.setActiveTab)

  return (
    <section className="center">
      <div className="tabstrip" role="tablist" aria-label="Sessions">
        <div className="tabstrip__scroll">
          {tabs.map((tab) => (
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
              title={tab.title}
            >
              <span className={`tab__dot tab__dot--${tab.status}`} />
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
          ))}
          <button
            type="button"
            className="tab tab--new"
            onClick={() => void createTab({ activate: true })}
            title="New session"
            aria-label="New session"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="tabstrip__meta">
          <span className="mono">{tabs.length} {tabs.length === 1 ? 'session' : 'sessions'}</span>
        </div>
      </div>

      {activeTab ? <ChatView tab={activeTab} /> : <NoSession />}
    </section>
  )
}

function NoSession(): React.JSX.Element {
  const createTab = useAppStore((state) => state.createTab)
  const goal = useAppStore((state) => state.goalDetail)
  const setDesignGoal = useAppStore((state) => state.setDesignGoal)

  return (
    <div className="session-empty">
      <div className="session-empty__index">00</div>
      <p className="eyebrow">No session open</p>
      <h1>
        One desk.
        <br />
        Every agent.
      </h1>
      <p className="session-empty__copy">
        Open a Claude session, point it at a goal, and keep the plan, the diff, and the shell in one
        frame.
      </p>
      <div className="session-empty__actions">
        <button type="button" className="btn btn--accent" onClick={() => void createTab({ activate: true })}>
          <Plus size={15} /> New session
        </button>
        {goal ? (
          <button type="button" className="btn btn--ghost" onClick={() => setDesignGoal(goal.id)}>
            <FileText size={14} /> Read the goal
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ChatView({ tab }: { tab: ChatTab }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    if (atBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [tab.messages, tab.status])

  return (
    <div className="chat">
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
            <MessageRow key={message.id} message={message} tab={tab} />
          ))}
          {tab.status === 'thinking' && !tab.messages.some((message) => message.streaming) ? (
            <div className="thinking-line">
              <span className="thinking-line__orb" />
              <span>Claude is working the desk…</span>
            </div>
          ) : null}
        </div>
      </div>
      <Composer tab={tab} />
    </div>
  )
}

function SessionBlank({ tab }: { tab: ChatTab }): React.JSX.Element {
  const goal = useAppStore((state) => state.goalDetail)
  const setDraft = useAppStore((state) => state.setDraft)
  const setDesignGoal = useAppStore((state) => state.setDesignGoal)
  const sendMessage = useAppStore((state) => state.sendMessage)
  const nextTask = goal?.phases.flatMap((phase) => phase.tasks).find((task) => !task.checked)

  const suggestions = goal
    ? [
        nextTask
          ? `Implement task ${nextTask.id} — ${nextTask.title}`
          : 'Read the completed plan and propose the next goal',
        `Read goals/${goal.id}/DESIGN.md and summarize the architecture`,
        'Review the current working tree and point out risky changes'
      ]
    : [
        'Map this repository and explain its architecture',
        'Review the current working tree for risky changes',
        'What should we build next?'
      ]

  return (
    <div className="session-blank">
      <div className="session-blank__head">
        <div className="session-blank__glyph">
          <Terminal size={22} />
        </div>
        <div>
          <p className="eyebrow">Session · {statusLabel(tab.status)}</p>
          <h1>Point the harness at something.</h1>
        </div>
      </div>
      <p className="session-blank__copy">
        {goal ? (
          <>
            Working goal: <strong>{goal.title}</strong> · {goal.progress}% built.
            {nextTask ? (
              <span className="session-blank__next">
                {' '}
                Next up: <button type="button" onClick={() => setDraft(suggestions[0])}>{nextTask.id}</button>{' '}
                {nextTask.title}
              </span>
            ) : (
              <span className="session-blank__next"> All tasks are checked off.</span>
            )}
          </>
        ) : (
          'Pick a goal in the plan rail to give the session a target.'
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
              window.dispatchEvent(new CustomEvent('proharness:focus-composer'))
            }}
          >
            <span className={`prompt-card__icon prompt-card__icon--${index}`}>
              {index === 0 ? <Sparkles size={14} /> : index === 1 ? <FileText size={14} /> : <ShieldCheck size={14} />}
            </span>
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
      <div className="session-blank__hints">
        <span>
          <Zap size={12} /> {tab.model}
        </span>
        <span>
          <ShieldCheck size={12} /> {permissionModeLabel(tab.permissionMode)}
        </span>
        <span>
          <Clock size={12} /> new session
        </span>
      </div>
    </div>
  )
}

function MessageRow({ message, tab }: { message: ChatMessage; tab: ChatTab }): React.JSX.Element {
  if (message.role === 'system') {
    return (
      <div className={`system-row system-row--${message.level || 'info'}`}>
        <span className="system-row__line" />
        <div className="system-row__body">
          <span className="system-row__label">{message.level === 'error' ? 'Error' : message.level === 'warn' ? 'Notice' : 'System'}</span>
          <Markdown compact>{message.blocks.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')).join('\n')}</Markdown>
        </div>
      </div>
    )
  }

  const isUser = message.role === 'user'
  return (
    <article className={`message message--${message.role}`}>
      <div className="message__gutter">
        <span className={`message__avatar ${isUser ? 'message__avatar--user' : ''}`}>
          {isUser ? 'Y' : <Bot size={15} />}
        </span>
        <span className="message__thread" />
      </div>
      <div className="message__content">
        <div className="message__meta">
          <span className="message__author">{isUser ? 'You' : 'Claude'}</span>
          <span>{formatClock(message.createdAt)}</span>
          {!isUser && message.streaming ? <span className="live-tag">streaming</span> : null}
          {!isUser && tab.model ? <span className="message__model">{tab.model}</span> : null}
        </div>
        <div className="message__blocks">
          {message.blocks.map((block, index) => (
            <Block key={block.type === 'tool_use' ? block.id : `${message.id}-${index}`} block={block} streaming={message.streaming} />
          ))}
          {message.streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
        </div>
      </div>
    </article>
  )
}

function Block({ block, streaming }: { block: AssistantBlock; streaming?: boolean }): React.JSX.Element | null {
  if (block.type === 'text') {
    if (!block.text.trim()) return null
    return <Markdown>{block.text}</Markdown>
  }
  if (block.type === 'thinking') {
    return (
      <details className="thinking-block">
        <summary>
          <Sparkles size={12} /> Reasoning
          <span>{streaming ? 'live' : 'trace'}</span>
        </summary>
        <pre>{block.text}</pre>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const done = block.result !== undefined
    return (
      <details className={`tool-call ${block.isError ? 'tool-call--error' : ''} ${done ? 'is-done' : 'is-running'}`}>
        <summary>
          <span className="tool-call__icon">{done ? block.isError ? <X size={12} /> : <CheckCircle2 size={12} /> : <Wrench size={12} />}</span>
          <span className="tool-call__name">{block.name}</span>
          <span className="tool-call__hint">{toolHint(block)}</span>
          <span className="tool-call__state">{done ? (block.isError ? 'failed' : 'done') : 'running'}</span>
        </summary>
        <div className="tool-call__body">
          <div className="tool-call__label">Input</div>
          <pre>{truncate(JSON.stringify(block.input, null, 2), 6000)}</pre>
          {block.result !== undefined ? (
            <>
              <div className="tool-call__label">Output</div>
              <pre>{truncate(block.result, 8000)}</pre>
            </>
          ) : null}
        </div>
      </details>
    )
  }
  return null
}

function toolHint(block: Extract<AssistantBlock, { type: 'tool_use' }>): string {
  const input = block.input as Record<string, unknown>
  const value =
    input.file_path || input.path || input.command || input.pattern || input.url || input.description || ''
  return typeof value === 'string' ? truncate(value, 90) : ''
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… truncated` : value
}

function Composer({ tab }: { tab: ChatTab }): React.JSX.Element {
  const draft = useAppStore((state) => state.drafts[tab.id] || '')
  const setDraft = useAppStore((state) => state.setDraft)
  const sendMessage = useAppStore((state) => state.sendMessage)
  const stopActive = useAppStore((state) => state.stopActive)
  const setTabMode = useAppStore((state) => state.setTabMode)
  const goal = useAppStore((state) => state.goalDetail)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [modeOpen, setModeOpen] = useState(false)
  const busy = ['thinking', 'streaming', 'starting', 'stopping'].includes(tab.status)
  const nextTask = goal?.phases.flatMap((phase) => phase.tasks).find((task) => !task.checked)

  useEffect(() => {
    const focus = (): void => textareaRef.current?.focus()
    window.addEventListener('proharness:focus-composer', focus)
    return () => window.removeEventListener('proharness:focus-composer', focus)
  }, [])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(220, Math.max(52, textarea.scrollHeight))}px`
  }, [draft])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [tab.id])

  const insertNextTask = (): void => {
    if (!goal) return
    if (nextTask) {
      setDraft(
        `Implement task ${nextTask.id} — ${nextTask.title}. Read goals/${goal.id}/DESIGN.md and goals/${goal.id}/PLAN.md first, then make the change and verify it.`
      )
    } else {
      setDraft(`Review goals/${goal.id}/PLAN.md and tell me what remains before this goal is complete.`)
    }
    textareaRef.current?.focus()
  }

  return (
    <div className="composer-wrap">
      <div className="composer-context">
        {goal ? (
          <>
            <span className="context-goal">
              <FileText size={12} /> {goal.title}
            </span>
            {nextTask ? (
              <button type="button" className="context-next" onClick={insertNextTask}>
                <Circle size={9} /> next {nextTask.id} · {nextTask.title}
              </button>
            ) : (
              <span className="context-next context-next--done">
                <CheckCircle2 size={11} /> plan complete
              </span>
            )}
          </>
        ) : (
          <span className="context-next">No goal selected</span>
        )}
        <span className="composer-context__spacer" />
        <span className="composer-context__hint">shift + return for a new line</span>
      </div>
      <div className={`composer ${busy ? 'is-busy' : ''}`}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!busy && draft.trim()) void sendMessage(draft)
            }
          }}
          placeholder="Ask Claude to read the plan, make a change, or run a review…"
          aria-label="Message Claude"
          rows={1}
        />
        <div className="composer__bar">
          <div className="composer__left">
            <div className="mode-select">
              <button
                type="button"
                className="mode-select__button"
                onClick={() => setModeOpen((open) => !open)}
                aria-expanded={modeOpen}
              >
                <ShieldCheck size={13} />
                {permissionModeLabel(tab.permissionMode)}
                <ChevronRight size={11} className={modeOpen ? 'rotated' : ''} />
              </button>
              {modeOpen ? (
                <div className="mode-menu" role="menu">
                  {PERMISSION_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitem"
                      className={mode === tab.permissionMode ? 'is-active' : ''}
                      onClick={() => {
                        setModeOpen(false)
                        void setTabMode(tab.id, mode)
                      }}
                    >
                      <span>{permissionModeLabel(mode)}</span>
                      <small>{mode}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="composer__model">{tab.model}</span>
          </div>
          <div className="composer__right">
            {busy ? (
              <button type="button" className="composer__stop" onClick={() => void stopActive()}>
                <Square size={12} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                type="button"
                className="composer__send"
                onClick={() => void sendMessage(draft)}
                disabled={!draft.trim()}
                aria-label="Send message"
                title="Send (Return)"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-foot">
        <span>ProHarness does not sandbox the shell. Review permission dialogs.</span>
        <span className="mono">{busy ? 'streaming' : 'ready'}</span>
      </div>
    </div>
  )
}
