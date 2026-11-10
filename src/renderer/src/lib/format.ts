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

export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'acceptEdits':
      return 'Accept edits'
    case 'plan':
      return 'Plan only'
    case 'auto':
      return 'Auto'
    case 'dontAsk':
      return 'Don’t ask'
    case 'bypassPermissions':
      return 'Bypass'
    default:
      return 'Ask'
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'starting':
      return 'Starting'
    case 'thinking':
      return 'Thinking'
    case 'streaming':
      return 'Streaming'
    case 'waiting_permission':
      return 'Waiting'
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
  if (['thinking', 'streaming', 'starting', 'stopping', 'waiting_permission'].includes(status)) return 'accent'
  if (status === 'idle') return 'success'
  if (status === 'error') return 'danger'
  return 'muted'
}

export function riskTone(risk: string): 'danger' | 'warning' | 'muted' {
  if (risk === 'high') return 'danger'
  if (risk === 'medium') return 'warning'
  return 'muted'
}

export function encodePathForUi(path: string): string {
  return path.replace(/\\/g, '/')
}
