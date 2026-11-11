import { useEffect, useRef, useState } from 'react'
import { Check, MessageSquareText, ShieldAlert, X } from 'lucide-react'
import type { UiRequest } from '@shared/types'
import { useAppStore } from '../store'

/** Answers omp dialogs: tool approvals, the ask tool, and extension prompts. */
export function RequestDialog(): React.JSX.Element | null {
  const requests = useAppStore((state) => state.requests)
  const answerRequest = useAppStore((state) => state.answerRequest)
  const setActiveTab = useAppStore((state) => state.setActiveTab)
  const request = requests[0]

  useEffect(() => {
    if (request?.origin === 'session') setActiveTab(request.originId)
  }, [request?.id, request?.origin, request?.originId, setActiveTab])

  if (!request) return null
  const cancel = (): void => void answerRequest(request, { cancelled: true })
  const more = requests.length > 1 ? ` · ${requests.length - 1} more waiting` : ''

  return (
    <div className="modal-backdrop modal-backdrop--request" role="presentation">
      <div
        className={`request-card ${request.approval ? 'request-card--approval' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-title"
      >
        {request.approval ? (
          <Approval request={request} more={more} />
        ) : request.method === 'select' ? (
          <Select request={request} more={more} cancel={cancel} />
        ) : request.method === 'confirm' ? (
          <Confirm request={request} more={more} />
        ) : (
          <TextInput request={request} more={more} cancel={cancel} />
        )}
      </div>
    </div>
  )
}

function Head({ request, more, icon, eyebrow }: { request: UiRequest; more: string; icon: React.ReactNode; eyebrow: string }): React.JSX.Element {
  return (
    <div className="request-card__top">
      <div className="request-card__glyph">{icon}</div>
      <div>
        <p className="eyebrow">
          {eyebrow} · {request.originLabel}
          {more}
        </p>
        <h2 id="request-title">{request.approval ? request.approval.tool : request.title.split('\n')[0]}</h2>
      </div>
    </div>
  )
}

function useKeys(handlers: Record<string, () => void>, deps: unknown[]): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName) && event.key !== 'Escape') return
      const handler = handlers[event.key]
      if (handler) {
        event.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function Approval({ request, more }: { request: UiRequest; more: string }): React.JSX.Element {
  const answerRequest = useAppStore((state) => state.answerRequest)
  const denyRef = useRef<HTMLButtonElement>(null)
  const [armed, setArmed] = useState(false)
  const approve = request.options.find((option) => /^approve$/i.test(option)) || request.options.find((option) => /^approve/i.test(option))
  const deny = request.options.find((option) => /^deny/i.test(option))
  const others = request.options.filter((option) => option !== approve && option !== deny)
  const pick = (value: string | undefined): void => {
    if (value) void answerRequest(request, { value })
  }

  // Ignore keys for a moment so a key meant for the composer cannot answer the prompt.
  useEffect(() => {
    setArmed(false)
    const timer = window.setTimeout(() => setArmed(true), 450)
    denyRef.current?.focus()
    return () => window.clearTimeout(timer)
  }, [request.id])

  useKeys(
    {
      Escape: () => pick(deny),
      Enter: () => armed && pick(approve)
    },
    [request.id, armed]
  )

  return (
    <>
      <Head request={request} more={more} icon={<ShieldAlert size={20} />} eyebrow="Approval needed" />
      {request.approval?.details.length ? (
        <pre className="request-card__details">{request.approval.details.join('\n')}</pre>
      ) : null}
      <div className="request-card__footer">
        <p>Return approves once. Esc denies.</p>
        <div className="request-card__buttons">
          <button ref={denyRef} type="button" className="btn btn--ghost" onClick={() => pick(deny)}>
            <X size={14} /> {deny || 'Deny'}
          </button>
          {others.map((option) => (
            <button key={option} type="button" className="btn btn--quiet" onClick={() => pick(option)}>
              {option}
            </button>
          ))}
          <button type="button" className="btn btn--accent" onClick={() => pick(approve)} disabled={!armed}>
            <Check size={14} /> {approve || 'Approve'}
          </button>
        </div>
      </div>
    </>
  )
}

function Select({ request, more, cancel }: { request: UiRequest; more: string; cancel: () => void }): React.JSX.Element {
  const answerRequest = useAppStore((state) => state.answerRequest)
  const [cursor, setCursor] = useState(0)
  const body = request.title.split('\n').slice(1).join('\n') || request.message
  useKeys(
    {
      Escape: cancel,
      ArrowDown: () => setCursor((index) => Math.min(request.options.length - 1, index + 1)),
      ArrowUp: () => setCursor((index) => Math.max(0, index - 1)),
      Enter: () => request.options[cursor] && void answerRequest(request, { value: request.options[cursor] })
    },
    [request.id, cursor]
  )
  return (
    <>
      <Head request={request} more={more} icon={<MessageSquareText size={20} />} eyebrow="omp asks" />
      {body ? <p className="request-card__message">{body}</p> : null}
      <div className="request-options" role="listbox">
        {request.options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="option"
            aria-selected={index === cursor}
            className={`request-option ${index === cursor ? 'is-cursor' : ''}`}
            onMouseEnter={() => setCursor(index)}
            onClick={() => void answerRequest(request, { value: option })}
          >
            <span>{option}</span>
            {request.optionDetails[index] ? <small>{request.optionDetails[index]}</small> : null}
          </button>
        ))}
      </div>
      <div className="request-card__footer">
        <p>↑↓ to move, Return to choose.</p>
        <button type="button" className="btn btn--ghost" onClick={cancel}>
          Skip
        </button>
      </div>
    </>
  )
}

function Confirm({ request, more }: { request: UiRequest; more: string }): React.JSX.Element {
  const answerRequest = useAppStore((state) => state.answerRequest)
  const answer = (confirmed: boolean): void => void answerRequest(request, { confirmed })
  useKeys({ Escape: () => answer(false), Enter: () => answer(true) }, [request.id])
  return (
    <>
      <Head request={request} more={more} icon={<MessageSquareText size={20} />} eyebrow="Confirm" />
      {request.message ? <p className="request-card__message">{request.message}</p> : null}
      <div className="request-card__footer">
        <p />
        <div className="request-card__buttons">
          <button type="button" className="btn btn--ghost" onClick={() => answer(false)}>
            No
          </button>
          <button type="button" className="btn btn--accent" onClick={() => answer(true)}>
            Yes
          </button>
        </div>
      </div>
    </>
  )
}

function TextInput({ request, more, cancel }: { request: UiRequest; more: string; cancel: () => void }): React.JSX.Element {
  const answerRequest = useAppStore((state) => state.answerRequest)
  const [value, setValue] = useState('')
  const multiline = request.method === 'editor'
  const submit = (): void => void answerRequest(request, { value })
  return (
    <>
      <Head request={request} more={more} icon={<MessageSquareText size={20} />} eyebrow="omp asks" />
      {request.message ? <p className="request-card__message">{request.message}</p> : null}
      {multiline ? (
        <textarea
          className="request-card__input"
          rows={6}
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
            if (event.key === 'Escape') cancel()
          }}
        />
      ) : (
        <input
          className="request-card__input"
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') cancel()
          }}
        />
      )}
      <div className="request-card__footer">
        <p>{multiline ? '⌘Return to send.' : 'Return to send.'}</p>
        <div className="request-card__buttons">
          <button type="button" className="btn btn--ghost" onClick={cancel}>
            Skip
          </button>
          <button type="button" className="btn btn--accent" onClick={submit}>
            Send
          </button>
        </div>
      </div>
    </>
  )
}
