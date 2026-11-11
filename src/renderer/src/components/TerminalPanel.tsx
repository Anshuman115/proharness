import { useEffect, useRef, useState } from 'react'
import { Eraser, RotateCw, Terminal as TerminalIcon } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalCreateResult } from '@shared/types'
import { useAppStore } from '../store'

const THEME = {
  background: '#100f0c',
  foreground: '#e9e2d3',
  cursor: '#e0a35c',
  cursorAccent: '#100f0c',
  selectionBackground: '#3b3223',
  black: '#1b1814',
  red: '#d97a6c',
  green: '#93b87c',
  yellow: '#d8b56a',
  blue: '#85a8ba',
  magenta: '#bd95ad',
  cyan: '#87b8ae',
  white: '#e9e2d3',
  brightBlack: '#6b6255',
  brightRed: '#e78e7e',
  brightGreen: '#a6ca8e',
  brightYellow: '#ecc87e',
  brightBlue: '#9abed0',
  brightMagenta: '#d0a7c2',
  brightCyan: '#9acac0',
  brightWhite: '#f4eddf'
}

/** One animation frame, resolvable as false when cleanup cancels it. */
function nextFrame(): { promise: Promise<boolean>; cancel: () => void } {
  let frame = 0
  let settled = false
  let finish: (value: boolean) => void = () => undefined
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve
    frame = window.requestAnimationFrame(() => {
      settled = true
      resolve(true)
    })
  })
  return {
    promise,
    cancel: () => {
      if (settled) return
      settled = true
      window.cancelAnimationFrame(frame)
      finish(false)
    }
  }
}

export function TerminalPanel({ active }: { active: boolean }): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const workspacePath = settings?.workspacePath
  const workspaceHost = settings?.workspaceHost
  const terminalShell = settings?.terminalShell
  const workspaceRevision = useAppStore((state) => state.workspaceRevision)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [terminal, setTerminal] = useState<TerminalCreateResult | null>(null)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hostRef.current || !workspacePath) return
    let disposed = false
    setTerminal(null)
    const id = `term-${crypto.randomUUID()}`
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SFMono-Regular", "Cascadia Code", "Roboto Mono", monospace',
      fontSize: 12,
      lineHeight: 1.32,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit
    setError(null)

    const dataDisposable = term.onData((data) => window.proharness.terminal.write(id, data))
    const resizeDisposable = term.onResize(({ cols, rows }) => window.proharness.terminal.resize(id, cols, rows))
    const offData = window.proharness.terminal.onData((event) => {
      if (event.id === id) term.write(event.data)
    })
    const offExit = window.proharness.terminal.onExit((event) => {
      if (event.id !== id) return
      term.write(`\r\n\x1b[38;2;107;98;85m[process exited ${event.exitCode ?? event.signal ?? ''}]\x1b[0m\r\n`)
    })

    const resize = (): void => {
      try {
        fit.fit()
      } catch {
        // The host may be hidden during a resize.
      }
    }
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(resize)
    })
    observer.observe(hostRef.current)

    let startFrame: { promise: Promise<boolean>; cancel: () => void } | null = null
    const start = async (): Promise<void> => {
      try {
        startFrame = nextFrame()
        if (!(await startFrame.promise) || disposed) return
        resize()
        const created = await window.proharness.terminal.create({
          id,
          cwd: workspacePath,
          cols: term.cols,
          rows: term.rows,
          shell: terminalShell
        })
        if (disposed) {
          void window.proharness.terminal.kill(id)
          return
        }
        setTerminal(created)
        if (created.mode === 'pipe') setError(created.warning)
        term.write(
          `\x1b[38;2;224;163;92mProHarness shell\x1b[0m \x1b[38;2;107;98;85m· ${created.shell} · ${created.mode}\x1b[0m\r\n`
        )
        term.focus()
        resize()
      } catch (err) {
        if (!disposed) setError((err as Error).message)
      }
    }
    void start()

    return () => {
      disposed = true
      startFrame?.cancel()
      window.cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      offData()
      offExit()
      void window.proharness.terminal.kill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [workspacePath, workspaceHost, terminalShell, generation, workspaceRevision])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.focus()
      } catch {
        // Ignore fit failures while the panel is animating.
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  return (
    <div className={`terminal-panel ${active ? '' : 'is-hidden'}`} aria-hidden={!active}>
      <div className="terminal-head">
        <div className="terminal-head__title">
          <TerminalIcon size={13} />
          <strong>Shell</strong>
          <span className="mono">{terminal?.shell || settings?.terminalShell || 'bash'}</span>
          <span className={`mode-chip ${terminal?.mode === 'pty' ? 'mode-chip--ok' : 'mode-chip--warn'}`}>
            {terminal?.mode || 'starting'}
          </span>
        </div>
        <div className="terminal-head__actions">
          <button type="button" className="icon-button" title="Clear scrollback" onClick={() => termRef.current?.clear()}>
            <Eraser size={13} />
          </button>
          <button type="button" className="icon-button" title="Restart shell" onClick={() => setGeneration((value) => value + 1)}>
            <RotateCw size={13} />
          </button>
        </div>
      </div>
      {error ? <div className="terminal-warning">{error}</div> : null}
      <div className="terminal-host" ref={hostRef} onClick={() => termRef.current?.focus()} onKeyDown={() => termRef.current?.focus()} />
      <div className="terminal-foot">
        <span>{terminal?.cwd || settings?.workspacePath}</span>
        <span className="mono">{terminal ? `${terminal.mode} · ${terminal.shell}` : 'connecting'}</span>
      </div>
    </div>
  )
}
