export interface PollingWatcherOptions<T> {
  load: () => Promise<T>
  signature: (value: T) => string
  interval: () => number
  debounceMs: number
  /** plan: every notify emits; git: only when the signature changed. */
  forceNotify: boolean
}

/**
 * Polls a value and notifies listeners when its signature changes. One load
 * runs at a time; poll ticks and notify requests are coalesced behind it, and
 * a reset or dispose makes every in-flight result stale.
 */
export class PollingWatcher<T> {
  private readonly listeners = new Set<(value: T) => void>()
  private poller: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private signature = ''
  private generation = 0
  private loading: Promise<void> | null = null
  private pendingSeed = false
  private pendingPoll = false
  private pendingNotify = false

  constructor(private readonly options: PollingWatcherOptions<T>) {}

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    this.startPolling()
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      this.pendingNotify = true
      this.pump()
    }, this.options.debounceMs)
  }

  reset(): void {
    this.generation += 1
    this.pendingSeed = false
    this.pendingPoll = false
    this.pendingNotify = false
    this.stopPolling()
    clearTimeout(this.debounce ?? undefined)
    this.debounce = null
    this.signature = ''
    if (this.listeners.size) this.startPolling()
  }

  dispose(): void {
    this.generation += 1
    this.pendingSeed = false
    this.pendingPoll = false
    this.pendingNotify = false
    this.stopPolling()
    clearTimeout(this.debounce ?? undefined)
    this.debounce = null
  }

  private startPolling(): void {
    if (this.poller) return
    this.pendingSeed = true
    this.pump()
    this.poller = setInterval(() => {
      this.pendingPoll = true
      this.pump()
    }, this.options.interval())
    this.poller.unref?.()
  }

  private stopPolling(): void {
    clearInterval(this.poller ?? undefined)
    this.poller = null
  }

  private pump(): void {
    if (this.loading) return
    const generation = this.generation
    const kind = this.pendingSeed ? 'seed' : this.pendingNotify ? 'notify' : this.pendingPoll ? 'poll' : null
    if (!kind) return
    if (kind === 'seed') this.pendingSeed = false
    else if (kind === 'notify') this.pendingNotify = false
    else this.pendingPoll = false
    this.loading = (async () => {
      try {
        const value = await this.options.load()
        if (generation !== this.generation) return
        const signature = this.options.signature(value)
        const changed = signature !== this.signature
        this.signature = signature
        if (kind === 'seed') return
        if (kind === 'poll' && !changed) return
        if (kind === 'notify' && !this.options.forceNotify && !changed) return
        for (const listener of this.listeners) {
          if (generation !== this.generation) return
          listener(value)
        }
      } catch {
        // Keep the previous signature; the next poll or notify retries.
      }
    })().finally(() => {
      this.loading = null
      this.pump()
    })
  }
}
