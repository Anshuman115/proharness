import { useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, Check, Cpu, ShieldAlert, X } from 'lucide-react'
import { useAppStore } from '../store'
import { riskTone } from '../lib/format'

export function PermissionDialog(): React.JSX.Element | null {
  const permissions = useAppStore((state) => state.permissions)
  const resolvePermission = useAppStore((state) => state.resolvePermission)
  const request = permissions[0]
  const denyRef = useRef<HTMLButtonElement>(null)
  const allowRef = useRef<HTMLButtonElement>(null)

  const inputText = useMemo(() => {
    if (!request) return ''
    try {
      const text = JSON.stringify(request.input, null, 2)
      return text.length > 9000 ? `${text.slice(0, 9000)}\n… input truncated` : text
    } catch {
      return String(request.input)
    }
  }, [request])

  useEffect(() => {
    if (!request) return
    const target = request.defaultToNo || request.risk === 'high' ? denyRef.current : allowRef.current
    target?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void resolvePermission(request, false, false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolvePermission])

  if (!request) return null

  return (
    <div className="modal-backdrop modal-backdrop--permission" role="presentation">
      <div className="permission-card" role="dialog" aria-modal="true" aria-labelledby="permission-title">
        <div className="permission-card__top">
          <div className="permission-card__glyph">
            <ShieldAlert size={22} />
          </div>
          <div>
            <p className="eyebrow">
              <AlertTriangle size={11} /> Permission required
              {permissions.length > 1 ? ` · ${permissions.length - 1} more waiting` : ''}
            </p>
            <h2 id="permission-title">{request.displayName || request.toolName}</h2>
            <p className="permission-card__title">{request.title}</p>
          </div>
          <span className={`risk-chip risk-chip--${riskTone(request.risk)}`}>{request.risk} risk</span>
        </div>

        {request.description ? <p className="permission-card__description">{request.description}</p> : null}
        {request.decisionReason ? (
          <p className="permission-card__reason">{request.decisionReason}</p>
        ) : null}
        {request.blockedPath ? (
          <p className="permission-card__blocked">
            Path involved in this request: <code>{request.blockedPath}</code>
          </p>
        ) : null}

        <div className="permission-meta">
          <span>
            <Cpu size={12} /> {request.originLabel}
          </span>
          <span className="mono">{request.toolName}</span>
        </div>

        <details className="permission-input" open={request.risk !== 'low'}>
          <summary>Tool input</summary>
          <pre>{inputText || '{}'}</pre>
        </details>

        <div className="permission-card__footer">
          <p>
            {request.canRemember
              ? 'Always allow stores a session rule for this exact tool call pattern.'
              : 'This action cannot be remembered for the session.'}
          </p>
          <div className="permission-card__buttons">
            <button
              ref={denyRef}
              type="button"
              className="btn btn--ghost"
              onClick={() => void resolvePermission(request, false, false)}
            >
              <X size={14} /> Deny
            </button>
            {request.canRemember ? (
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => void resolvePermission(request, true, true)}
              >
                Always allow
              </button>
            ) : null}
            <button
              ref={allowRef}
              type="button"
              className="btn btn--accent"
              onClick={() => void resolvePermission(request, true, false)}
            >
              <Check size={14} /> Allow once
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
