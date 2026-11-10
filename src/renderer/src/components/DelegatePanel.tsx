import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Bot,
  Copy,
  KeyRound,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Square
} from 'lucide-react'
import { PROVIDER_IDS, type ProviderId } from '@shared/types'
import { useAppStore } from '../store'
import { Markdown } from './Markdown'

export function DelegatePanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const activeId = useAppStore((state) => state.activeDelegateId)
  const requests = useAppStore((state) => state.delegateRequests)
  const startDelegate = useAppStore((state) => state.startDelegate)
  const cancelDelegate = useAppStore((state) => state.cancelDelegate)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)
  const setDraft = useAppStore((state) => state.setDraft)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const drafts = useAppStore((state) => state.drafts)
  const [provider, setProvider] = useState<ProviderId>(settings?.defaultReviewer || 'deepseek')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const outputRef = useRef<HTMLDivElement>(null)

  const request = activeId ? requests[activeId] : null
  const providerInfo = settings?.providers.find((item) => item.id === provider)
  const running = Boolean(request && !request.done)

  useEffect(() => {
    if (!settings) return
    setProvider(settings.defaultReviewer)
    setModel(settings.defaultReviewerModel)
    // Only seed the form once per settings identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.defaultReviewer])

  useEffect(() => {
    if (!request) return
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [request?.text, request?.reasoning])

  const switchProvider = (next: ProviderId): void => {
    setProvider(next)
    const info = settings?.providers.find((item) => item.id === next)
    setModel(info?.model || '')
  }

  const insert = (): void => {
    if (!request?.text) return
    const current = drafts[activeTabId || ''] || ''
    const prefix = current.trim() ? `${current.trim()}\n\n` : ''
    setDraft(`${prefix}Consider this ${request.provider} review:\n\n${request.text}`)
    window.dispatchEvent(new CustomEvent('proharness:focus-composer'))
  }

  return (
    <div className="delegate-panel">
      <div className="panel-intro">
        <p className="eyebrow">
          <Sparkles size={11} /> Second opinion
        </p>
        <h3>Ask another model.</h3>
        <p>
          Delegate a review, a design critique, or a bounded drafting task to OpenAI, DeepSeek, or
          Kimi. This runs without tools or filesystem access.
        </p>
      </div>

      <div className="field">
        <label>Provider</label>
        <div className="provider-switch">
          {PROVIDER_IDS.map((id) => {
            const info = settings?.providers.find((item) => item.id === id)
            return (
              <button
                key={id}
                type="button"
                className={`provider-pill ${provider === id ? 'is-active' : ''} ${info?.hasKey ? '' : 'is-unconfigured'}`}
                onClick={() => switchProvider(id)}
                disabled={running}
              >
                <span className={`provider-dot provider-dot--${id}`} />
                {info?.label || id}
                {!info?.hasKey ? <KeyRound size={10} /> : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="delegate-model">Model</label>
          <input
            id="delegate-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={providerInfo?.model}
            disabled={running}
          />
        </div>
        <div className="field field--grow">
          <label>Key</label>
          <div className={`key-readout ${providerInfo?.hasKey ? 'is-ok' : 'is-missing'}`}>
            <KeyRound size={12} />
            {providerInfo?.hasKey ? providerInfo.keyHint || 'configured' : 'not configured'}
            {!providerInfo?.hasKey ? (
              <button type="button" onClick={() => setSettingsOpen(true)}>
                <Settings size={11} /> add
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="delegate-prompt">Prompt</label>
        <textarea
          id="delegate-prompt"
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Review this architecture decision. Be specific about failure modes…"
          disabled={running}
        />
      </div>

      <div className="delegate-actions">
        {running ? (
          <button type="button" className="btn btn--ghost" onClick={() => void cancelDelegate()}>
            <Square size={12} /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--accent"
            disabled={!prompt.trim() || !providerInfo?.hasKey}
            onClick={() => {
              void startDelegate(provider, model, prompt)
            }}
          >
            <Send size={13} /> Delegate
          </button>
        )}
        {running ? (
          <span className="inline-progress">
            <Loader2 size={13} className="spin" /> waiting for {providerInfo?.label || provider}
          </span>
        ) : null}
      </div>

      {request ? (
        <div className="delegate-output">
          <div className="delegate-output__head">
            <span className="eyebrow">
              <Bot size={11} /> {request.provider} · {request.model || providerInfo?.model}
            </span>
            <div>
              {request.text ? (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    title="Copy response"
                    onClick={() => void navigator.clipboard.writeText(request.text)}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    className="text-link"
                    onClick={insert}
                    title="Insert into the active chat composer"
                  >
                    send to chat <ArrowUpRight size={12} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {request.reasoning ? (
            <details className="thinking-block delegate-thinking">
              <summary>
                <Sparkles size={12} /> Model reasoning
              </summary>
              <pre>{request.reasoning}</pre>
            </details>
          ) : null}
          <div className="delegate-output__body" ref={outputRef}>
            {request.error ? (
              <div className="inline-error">{request.error}</div>
            ) : request.text ? (
              <Markdown compact>{request.text}</Markdown>
            ) : (
              <div className="delegate-waiting">
                <span className="stream-caret" />
                streaming…
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="delegate-empty">
          <Bot size={20} />
          <p>No delegation yet. The response stays local until you send it to the chat.</p>
        </div>
      )}
    </div>
  )
}
