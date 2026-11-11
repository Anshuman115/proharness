import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Pin, Search } from 'lucide-react'
import { providerOf, shortModel } from '@shared/models'
import type { ModelInfo } from '@shared/types'
import { useAppStore } from '../store'
import { formatTokens, providerLabel } from '../lib/format'

interface Props {
  value: string
  onChange: (model: string) => void
  /** Label for the empty value, e.g. "omp default". Omit to require a model. */
  emptyLabel?: string
  disabled?: boolean
  compact?: boolean
  align?: 'left' | 'right'
  ariaLabel?: string
}

/** Searchable picker over the models omp reports; pinned models first. */
export function ModelPicker({
  value,
  onChange,
  emptyLabel,
  disabled,
  compact,
  align = 'left',
  ariaLabel = 'Model'
}: Props): React.JSX.Element {
  const omp = useAppStore((state) => state.omp)
  const pinned = useAppStore((state) => state.settings?.pinnedModels || [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const models = omp?.models || []
  const current = models.find((model) => model.key === value)

  const options = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (model: ModelInfo): boolean =>
      !q || model.key.toLowerCase().includes(q) || model.name.toLowerCase().includes(q)
    const pinnedModels = pinned
      .map((key) => models.find((model) => model.key === key))
      .filter((model): model is ModelInfo => Boolean(model) && match(model!))
    const rest = models.filter((model) => !pinned.includes(model.key) && match(model))
    const list: Array<{ model: ModelInfo | null; pinned: boolean; group: string }> = []
    if (emptyLabel !== undefined && (!q || emptyLabel.toLowerCase().includes(q))) list.push({ model: null, pinned: false, group: '' })
    for (const model of pinnedModels) list.push({ model, pinned: true, group: 'Pinned' })
    for (const model of rest) list.push({ model, pinned: false, group: providerLabel(model.provider) })
    // Typed provider/id that omp did not list (e.g. catalog still loading).
    if (q.includes('/') && !models.some((model) => model.key === query.trim())) {
      list.push({
        model: {
          key: query.trim(),
          provider: providerOf(query.trim()),
          id: query.trim().split('/').slice(1).join('/'),
          name: `Use "${query.trim()}"`,
          contextWindow: null,
          reasoning: false,
          efforts: [],
          costIn: null,
          costOut: null
        },
        pinned: false,
        group: 'Custom'
      })
    }
    return list
  }, [models, pinned, query, emptyLabel])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = (model: ModelInfo | null): void => {
    onChange(model ? model.key : '')
    setOpen(false)
  }

  const label = value ? current?.name || shortModel(value) : emptyLabel || 'Choose a model'

  return (
    <div className={`model-picker ${compact ? 'model-picker--compact' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="model-picker__button"
        onClick={() => setOpen((state) => !state)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={value || emptyLabel}
      >
        {value ? <span className={`provider-mark provider-mark--${current?.provider || providerOf(value)}`} /> : null}
        <span className="model-picker__label">{label}</span>
        {!compact && value ? <span className="model-picker__provider">{providerLabel(providerOf(value))}</span> : null}
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className={`model-menu model-menu--${align} model-menu--down`} role="dialog" aria-label="Choose model">
          <div className="model-menu__search">
            <Search size={13} />
            <input
              ref={inputRef}
              value={query}
              placeholder={`Search ${models.length} models or type provider/id`}
              onChange={(event) => {
                setQuery(event.target.value)
                setCursor(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setCursor((index) => Math.min(options.length - 1, index + 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setCursor((index) => Math.max(0, index - 1))
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  const option = options[cursor]
                  if (option) choose(option.model)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setOpen(false)
                }
              }}
            />
          </div>
          <div className="model-menu__list" role="listbox" ref={listRef}>
            {options.length === 0 ? (
              <p className="model-menu__empty">
                {models.length ? 'No match.' : 'omp has not reported models yet. Refresh from Settings.'}
              </p>
            ) : null}
            {options.map((option, index) => {
              const showGroup = index === 0 || options[index - 1].group !== option.group
              const key = option.model?.key || ''
              return (
                <div key={`${option.group}-${key || 'empty'}`}>
                  {showGroup && option.group ? <div className="model-menu__group">{option.group}</div> : null}
                  <button
                    type="button"
                    role="option"
                    data-index={index}
                    aria-selected={key === value}
                    className={`model-option ${index === cursor ? 'is-cursor' : ''} ${key === value ? 'is-selected' : ''}`}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => choose(option.model)}
                  >
                    {option.model ? (
                      <>
                        <span className={`provider-mark provider-mark--${option.model.provider}`} />
                        <span className="model-option__name">{option.model.name}</span>
                        <span className="model-option__key">{option.model.key}</span>
                        <span className="model-option__meta">
                          {option.pinned ? <Pin size={10} /> : null}
                          {option.model.contextWindow ? formatTokens(option.model.contextWindow) : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="provider-mark provider-mark--default" />
                        <span className="model-option__name">{emptyLabel}</span>
                        <span className="model-option__key">{omp?.defaultModel ? `currently ${omp.defaultModel}` : 'from omp config'}</span>
                        <span className="model-option__meta" />
                      </>
                    )}
                    {key === value ? <Check size={12} className="model-option__check" /> : null}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Explains which saved models were swapped because the active host does not have them. */
export function ModelNotes(): React.JSX.Element | null {
  const notes = useAppStore((state) => state.settings?.modelNotes || [])
  if (!notes.length) return null
  return (
    <div className="loop-warning">
      <AlertTriangle size={13} />
      <span>{notes.join(' ')}</span>
    </div>
  )
}
