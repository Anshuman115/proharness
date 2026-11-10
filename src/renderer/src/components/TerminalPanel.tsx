import { useEffect, useRef, useState } from 'react'
import { Eraser, RotateCw, Terminal as TerminalIcon } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalCreateResult } from '@shared/types'
import { useAppStore } from '../store'

const TERMINAL_ID = 'primary'

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

export function TerminalPanel({ active }: { active: boolean }): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const workspacePath = settings?.workspacePath
  const terminalShell = settings?.terminalShell
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [terminal, setTerminal] = useState<TerminalCreateResult | null>(null)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hostRef.current || !workspacePath) return
    let disposed = false
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

    const dataDisposable = term.onData((data) => window.proharness.terminal.write(TERMINAL_ID, data))
    const resizeDisposable = term.onResize(({ cols, rows }) =>
      window.proharness.terminal.resize(TERMINAL_ID, cols, rows)
    )
    const offData = window.proharness.terminal.onData((event) => {
      if (event.id === TERMINAL_ID) term.write(event.data)
    })
    const offExit = window.proharness.terminal.onExit((event) => {
      if (event.id !== TERMINAL_ID) return
      term.write(`\r\n\x1b[38;2;107;98;85m[process exited ${event.exitCode ?? event.signal ?? ''}]\x1b[0m\r\n`)
    })

    const resize = (): void => {
      try {
        fit.fit()
      } catch {
        // The host may be hidden during a resize.
      }
    }
    const observer = new ResizeObserver(() => window.requestAnimationFrame(resize))
    observer.observe(hostRef.current)

    const start = async (): Promise<void> => {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, 30))
        resize()
        const created = await window.proharness.terminal.create({
          id: TERMINAL_ID,
          cwd: workspacePath,
          cols: term.cols,
          rows: term.rows,
          shell: terminalShell
        })
        if (disposed) {
          void window.proharness.terminal.kill(TERMINAL_ID)
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
      observer.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      offData()
      offExit()
      void window.proharness.terminal.kill(TERMINAL_ID)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [workspacePath, terminalShell, generation])

  useEffect(() => {
    if (!active) return
    const timer = window.setTimeout(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.focus()
      } catch {
        // Ignore fit failures while the panel is animating.
      }
    }, 80)
    return () => window.clearTimeout(timer)
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
          <button
            type="button"
            className="icon-button"
            title="Clear scrollback"
            onClick={() => termRef.current?.clear()}
          >
            <Eraser size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Restart shell"
            onClick={() => setGeneration((value) => value + 1)}
          >
            <RotateCw size={13} />
          </button>
        </div>
      </div>
      {error ? <div className="terminal-warning">{error}</div> : null}
      <div
        className="terminal-host"
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        onKeyDown={() => termRef.current?.focus()}
      />
      <div className="terminal-foot">
        <span>{terminal?.cwd || settings?.workspacePath}</span>
        <span className="mono">{terminal ? `${terminal.mode} · ${terminal.shell}` : 'connecting'}</span>
      </div>
    </div>
  )
}
