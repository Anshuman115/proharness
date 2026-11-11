export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export function shortPath(path: string, max = 52): string {
  if (path.length <= max) return path
  const parts = path.split(/[\\/]/)
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

export function formatRelative(ts: number | null): string {
  if (!ts) return '—'
  const delta = Date.now() - ts
  if (delta < 30_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function formatCost(value: number): string {
  if (!value) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function approvalLabel(mode: string): string {
  switch (mode) {
    case 'always-ask':
      return 'Ask every time'
    case 'always-ask-cached':
      return 'Ask and remember'
    case 'write':
      return 'Ask for commands'
    case 'yolo':
      return 'Never ask'
    default:
      return mode
  }
}

export function approvalHint(mode: string): string {
  switch (mode) {
    case 'always-ask':
      return 'Prompts for every edit and command'
    case 'always-ask-cached':
      return 'Prompts once per file or folder'
    case 'write':
      return 'Edits run freely; shell and subagents ask'
    case 'yolo':
      return 'Nothing asks; omp critical-command guards still apply'
    default:
      return ''
  }
}

/** "anthropic/claude-opus-5-5" -> { provider: "anthropic", id: "claude-opus-5-5" } */
export function splitModel(key: string | null | undefined): { provider: string; id: string } {
  if (!key) return { provider: '', id: '' }
  const index = key.indexOf('/')
  return index > 0 ? { provider: key.slice(0, index), id: key.slice(index + 1) } : { provider: '', id: key }
}

export function shortModel(key: string | null | undefined): string {
  const { id } = splitModel(key)
  return id.split('/').pop() || id || 'default'
}

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai-codex':
      return 'OpenAI Codex'
    case 'openai':
      return 'OpenAI'
    case 'commandcode':
      return 'Command Code'
    case 'opencode-zen':
      return 'OpenCode Zen'
    case 'apple':
      return 'Apple'
    default:
      return provider
  }
}

export function formatTokens(value: number | null | undefined): string {
  if (!value) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'working':
      return 'Working'
    case 'closed':
      return 'Closed'
    case 'stopping':
      return 'Stopping'
    case 'idle':
      return 'Ready'
    case 'error':
      return 'Error'
    default:
      return status
  }
}

export function stepLabel(step: string): string {
  switch (step) {
    case 'preflight':
      return 'Preflight'
    case 'implementing':
      return 'Implementing'
    case 'reviewing':
      return 'Reviewing'
    case 'revising':
      return 'Revising'
    case 'committing':
      return 'Committing'
    case 'marking':
      return 'Checking off'
    case 'waiting':
      return 'Between tasks'
    case 'complete':
      return 'Complete'
    case 'error':
      return 'Halted'
    default:
      return 'Idle'
  }
}

export function statusTone(status: string): 'accent' | 'success' | 'danger' | 'muted' {
  if (['working', 'starting', 'stopping'].includes(status)) return 'accent'
  if (status === 'idle') return 'success'
  if (status === 'error') return 'danger'
  return 'muted'
}

export function encodePathForUi(path: string): string {
  return path.replace(/\\/g, '/')
}
