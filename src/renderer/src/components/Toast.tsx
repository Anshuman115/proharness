import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useAppStore } from '../store'

export function Toast(): React.JSX.Element | null {
  const toast = useAppStore((state) => state.toast)
  const clearToast = useAppStore((state) => state.clearToast)
  if (!toast) return null

  const Icon =
    toast.kind === 'success'
      ? CheckCircle2
      : toast.kind === 'error'
        ? XCircle
        : toast.kind === 'warning'
          ? AlertTriangle
          : Info

  return (
    <div className={`toast toast--${toast.kind}`} role="status">
      <Icon size={16} />
      <span>{toast.message}</span>
      <button type="button" className="toast__close" onClick={clearToast} aria-label="Dismiss">
        <X size={13} />
      </button>
    </div>
  )
}
