import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PollingWatcher, type PollingWatcherOptions } from '../src/main/services/polling-watcher'

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

function makeWatcher(overrides: Partial<PollingWatcherOptions<string>> = {}): PollingWatcher<string> {
  return new PollingWatcher<string>({
    load: async () => 'value',
    signature: (value) => value,
    interval: () => 1_000,
    debounceMs: 1,
    forceNotify: false,
    ...overrides
  })
}

describe('PollingWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds silently without notifying', async () => {
    const load = vi.fn(async () => 'a')
    const watcher = makeWatcher({ load })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      expect(load).toHaveBeenCalledTimes(1)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('polls and notifies only when the signature changes', async () => {
    let value = 'a'
    const load = vi.fn(async () => value)
    const watcher = makeWatcher({ load })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      value = 'b'
      await flush(1_000)
      expect(listener).toHaveBeenCalledWith('b')
      const count = listener.mock.calls.length
      await flush(2_000)
      expect(listener.mock.calls.length).toBe(count)
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('forces a notify even when the signature is unchanged, and dedupes when it is not forced', async () => {
    const forced = makeWatcher({ load: async () => 'a', forceNotify: true, debounceMs: 5 })
    const deduped = makeWatcher({ load: async () => 'a', forceNotify: false, debounceMs: 5 })
    const forcedListener = vi.fn()
    const dedupedListener = vi.fn()
    const unsubscribeForced = forced.subscribe(forcedListener)
    const unsubscribeDeduped = deduped.subscribe(dedupedListener)
    try {
      await flush()
      forced.notify()
      deduped.notify()
      await flush(5)
      expect(forcedListener).toHaveBeenCalledWith('a')
      expect(dedupedListener).not.toHaveBeenCalled()
    } finally {
      unsubscribeForced()
      forced.dispose()
      unsubscribeDeduped()
      deduped.dispose()
    }
  })

  it('lets a notify survive a silent seed without overwriting the newer signature', async () => {
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const watcher = makeWatcher({ load, debounceMs: 5 })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      watcher.notify()
      await flush(5)
      resolvers.shift()!('old')
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
      resolvers.shift()!('new')
      await flush()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('new')
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('discards an in-flight load after reset and seeds again', async () => {
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const watcher = makeWatcher({ load })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      watcher.reset()
      resolvers.shift()!('old')
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
      resolvers.shift()!('new')
      await flush()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('discards an in-flight load after dispose', async () => {
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const watcher = makeWatcher({ load, forceNotify: true })
    const listener = vi.fn()
    watcher.subscribe(listener)
    await flush()
    watcher.dispose()
    resolvers.shift()!('late')
    await flush()
    expect(listener).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps one load in flight and coalesces poll ticks', async () => {
    const resolvers: Array<(value: string) => void> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const watcher = makeWatcher({ load, interval: () => 1 })
    const unsubscribe = watcher.subscribe(() => undefined)
    try {
      await flush()
      await flush(100)
      expect(load).toHaveBeenCalledTimes(1)
      resolvers.shift()!('a')
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('retries after a failed load and emits the next successful change', async () => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('offline')
      return attempt === 2 ? 'a' : 'b'
    })
    const watcher = makeWatcher({ load })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      expect(listener).not.toHaveBeenCalled()
      await flush(1_000)
      expect(listener).toHaveBeenLastCalledWith('a')
      await flush(1_000)
      expect(listener).toHaveBeenLastCalledWith('b')
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('stops emitting to later listeners when one resets the watcher', async () => {
    const watcher = makeWatcher({ load: async () => 'value', debounceMs: 5, forceNotify: true })
    const second = vi.fn()
    const unsubscribeFirst = watcher.subscribe(() => watcher.reset())
    const unsubscribeSecond = watcher.subscribe(second)
    try {
      await flush()
      watcher.notify()
      await flush(5)
      expect(second).not.toHaveBeenCalled()
    } finally {
      unsubscribeFirst()
      unsubscribeSecond()
      watcher.dispose()
    }
  })

  it.each(['EACCES', 'EPERM'])('stops polling on a direct %s error until reset', async (code) => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw Object.assign(new Error('denied'), { code })
      return 'a'
    })
    const watcher = makeWatcher({ load, debounceMs: 5 })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    const second = vi.fn()
    let unsubscribeSecond = (): void => undefined
    try {
      await flush()
      expect(load).toHaveBeenCalledTimes(1)
      await flush(10_000)
      expect(load).toHaveBeenCalledTimes(1)

      watcher.notify()
      await flush(10)
      expect(load).toHaveBeenCalledTimes(1)

      unsubscribeSecond = watcher.subscribe(second)
      await flush(10_000)
      expect(load).toHaveBeenCalledTimes(1)
      expect(listener).not.toHaveBeenCalled()
      expect(second).not.toHaveBeenCalled()

      watcher.reset()
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      unsubscribeSecond()
      watcher.dispose()
    }
  })

  it('keeps retrying when EACCES is only the cause', async () => {
    let attempt = 0
    const load = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw Object.assign(new Error('offline'), { cause: { code: 'EACCES' } })
      return 'a'
    })
    const watcher = makeWatcher({ load })
    const listener = vi.fn()
    const unsubscribe = watcher.subscribe(listener)
    try {
      await flush()
      await flush(1_000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenCalledWith('a')
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })

  it('does not load when notify has no subscribers', async () => {
    const load = vi.fn(async () => 'a')
    const watcher = makeWatcher({ load, debounceMs: 1 })
    try {
      watcher.notify()
      await flush(10)
      expect(load).not.toHaveBeenCalled()
    } finally {
      watcher.dispose()
    }
  })

  it('does not load from notify after the last unsubscribe', async () => {
    const load = vi.fn(async () => 'a')
    const watcher = makeWatcher({ load, interval: () => 60_000 })
    const unsubscribe = watcher.subscribe(() => undefined)
    try {
      await flush()
      expect(load).toHaveBeenCalledTimes(1)
      unsubscribe()
      watcher.notify()
      await flush(10)
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      watcher.dispose()
    }
  })

  it('ignores a stale permission failure after reset', async () => {
    const attempts: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = []
    const load = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          attempts.push({ resolve, reject })
        })
    )
    const watcher = makeWatcher({ load })
    const unsubscribe = watcher.subscribe(() => undefined)
    try {
      await flush()
      expect(load).toHaveBeenCalledTimes(1)
      watcher.reset()
      attempts[0].reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
      attempts[1].resolve('a')
      await flush(1_000)
      expect(load).toHaveBeenCalledTimes(3)
    } finally {
      unsubscribe()
      watcher.dispose()
    }
  })
})
