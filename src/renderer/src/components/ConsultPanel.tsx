import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Brain, Copy, GitCompare, Loader2, Send, Square, Wrench } from 'lucide-react'
import { useAppStore } from '../store'
import { formatCost, shortModel } from '../lib/format'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'

/** Ask any omp model for a read-only second opinion, optionally on the current diff. */
export function ConsultPanel(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const consults = useAppStore((state) => state.consults)
  const startConsult = useAppStore((state) => state.startConsult)
  const cancelConsult = useAppStore((state) => state.cancelConsult)
  const setDraft = useAppStore((state) => state.setDraft)
  const git = useAppStore((state) => state.git)
  const [model, setModel] = useState(settings?.reviewerModel || '')
  const [prompt, setPrompt] = useState('')
  const [includeDiff, setIncludeDiff] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)
  const current = consults[0]
  const running = Boolean(current && !current.done)

  // Reset to the host's reviewer when the workspace host or its catalog changes.
  useEffect(() => {
    setModel(settings?.reviewerModel || '')
  }, [settings?.workspaceHost, settings?.reviewerModel])

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [current?.text])

  return (
    <div className="consult-panel">
      <div className="panel-intro">
        <p className="eyebrow">Second opinion</p>
        <h3>Ask another model.</h3>
        <p>It runs in a separate read-only omp process. It can read the repo but cannot change it.</p>
      </div>

      <div className="field">
        <label>Model</label>
        <ModelPicker value={model} onChange={setModel} ariaLabel="Consult model" />
      </div>

      <div className="field">
        <label htmlFor="consult-prompt">Question</label>
        <textarea
          id="consult-prompt"
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && prompt.trim() && model && !running) {
              void startConsult(model, prompt, includeDiff)
            }
          }}
          placeholder="Is this migration safe to run twice? What breaks if the queue is empty?"
          disabled={running}
        />
      </div>

      <div className="consult-actions">
        <button
          type="button"
          className={`switch ${includeDiff ? 'is-on' : ''}`}
          role="switch"
          aria-checked={includeDiff}
          onClick={() => setIncludeDiff((value) => !value)}
          disabled={running}
        >
          <span />
          <GitCompare size={12} /> attach diff{git && !git.clean ? ` (${git.files.length} files)` : ''}
        </button>
        <span className="consult-actions__spacer" />
        {running && current ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void cancelConsult(current.requestId)}>
            <Square size={11} /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--accent btn--sm"
            disabled={!prompt.trim() || !model}
            onClick={() => void startConsult(model, prompt, includeDiff)}
          >
            <Send size={13} /> Ask
          </button>
        )}
      </div>

      {current ? (
        <div className="consult-output">
          <div className="consult-output__head">
            <span className="eyebrow">
              <span className={`provider-mark provider-mark--${current.model.split('/')[0]}`} /> {shortModel(current.model)}
              {current.costUsd ? ` · ${formatCost(current.costUsd)}` : ''}
            </span>
            {current.done && current.text ? (
              <span className="consult-output__actions">
                <button type="button" className="icon-button" title="Copy" onClick={() => void navigator.clipboard.writeText(current.text)}>
                  <Copy size={13} />
                </button>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    setDraft(`A second opinion from ${current.model}:\n\n${current.text}\n\nWhat do you make of this?`)
                    window.dispatchEvent(new CustomEvent('proharness:focus-composer'))
                  }}
                >
                  send to chat <ArrowUpRight size={12} />
                </button>
              </span>
            ) : null}
          </div>
          {current.tools.length && !current.done ? (
            <div className="consult-tools">
              <Wrench size={11} /> {current.tools[current.tools.length - 1]}
            </div>
          ) : null}
          {current.thinking && !current.text ? (
            <details className="thinking-block">
              <summary>
                <Brain size={12} /> Reasoning
              </summary>
              <pre>{current.thinking}</pre>
            </details>
          ) : null}
          <div className="consult-output__body" ref={outputRef}>
            {current.error ? (
              <div className="inline-error">{current.error}</div>
            ) : current.text ? (
              <Markdown compact>{current.text}</Markdown>
            ) : (
              <div className="consult-waiting">
                <Loader2 size={13} className="spin" /> starting {shortModel(current.model)}…
              </div>
            )}
          </div>
        </div>
      ) : null}

      {consults.length > 1 ? (
        <div className="consult-history">
          <p className="eyebrow">Earlier</p>
          {consults.slice(1, 6).map((item) => (
            <details key={item.requestId} className="consult-history__item">
              <summary>
                <span className="mono">{shortModel(item.model)}</span> {item.prompt.slice(0, 80)}
              </summary>
              {item.error ? <div className="inline-error">{item.error}</div> : <Markdown compact>{item.text}</Markdown>}
            </details>
          ))}
        </div>
      ) : null}
    </div>
  )
}
