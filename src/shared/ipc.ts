import type { ProHarnessApi, Unsubscribe } from './api'

/** How a `ProHarnessApi` leaf reaches the main process. */
export type IpcKind = 'invoke' | 'send' | 'subscribe'

type Fn = (...args: never[]) => unknown

/** Classifies one API method by its exact return type, not by `(...) => void` assignability. */
type KindOf<F> =
  F extends Fn
    ? ReturnType<F> extends Unsubscribe
      ? Parameters<F> extends [infer L, ...unknown[]]
        ? L extends Fn
          ? 'subscribe'
          : never
        : never
      : ReturnType<F> extends Promise<unknown>
        ? 'invoke'
        : ReturnType<F> extends void
          ? 'send'
          : never
    : never

/** True only when `A` and `B` are mutually assignable (so `never` does not match). */
type Is<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Collapses a union or `never` classification to a single kind, or `never`. */
type ExactKind<F> =
  Is<KindOf<F>, 'invoke'> extends true
    ? 'invoke'
    : Is<KindOf<F>, 'send'> extends true
      ? 'send'
      : Is<KindOf<F>, 'subscribe'> extends true
        ? 'subscribe'
        : never

/** The only allowed descriptor value for method `M`: `on*` must subscribe, others must not. */
export type ExpectedKind<M extends PropertyKey, F> =
  M extends `on${string}`
    ? Is<ExactKind<F>, 'subscribe'> extends true
      ? 'subscribe'
      : never
    : Is<ExactKind<F>, 'subscribe'> extends true
      ? never
      : ExactKind<F>

type Namespace = Exclude<keyof ProHarnessApi, 'bootstrap'>

/** Exhaustive kind map for every namespace method; missing, extra or wrong entries fail `satisfies`. */
type ExpectedKinds = {
  [N in Namespace]: { [M in keyof ProHarnessApi[N]]: ExpectedKind<M, ProHarnessApi[N][M]> }
}

/** The single root method is special-cased on its own channel. */
export const BOOTSTRAP_CHANNEL = 'app:bootstrap'

/** Wire names are exactly `namespace:method`; both sides derive them from the descriptor. */
export function channelFor(namespace: string, method: string): string {
  return `${namespace}:${method}`
}

export const IPC_METHODS = {
  settings: {
    update: 'invoke',
    chooseWorkspace: 'invoke',
    chooseOmp: 'invoke',
    onChanged: 'subscribe'
  },
  workspace: {
    open: 'invoke',
    sshHosts: 'invoke',
    listDir: 'invoke'
  },
  loginShare: {
    status: 'invoke',
    set: 'invoke'
  },
  omp: {
    refresh: 'invoke',
    onChanged: 'subscribe'
  },
  goals: {
    list: 'invoke',
    create: 'invoke',
    read: 'invoke',
    toggleTask: 'invoke',
    onChanged: 'subscribe'
  },
  git: {
    summary: 'invoke',
    fileDiff: 'invoke',
    restore: 'invoke',
    onChanged: 'subscribe'
  },
  sessions: {
    create: 'invoke',
    send: 'invoke',
    stop: 'invoke',
    close: 'invoke',
    setModel: 'invoke',
    setThinking: 'invoke',
    newConversation: 'invoke',
    resume: 'invoke',
    compact: 'invoke',
    removeQueued: 'invoke',
    recent: 'invoke',
    onEvent: 'subscribe'
  },
  ui: {
    respond: 'invoke',
    onRequest: 'subscribe',
    onResolved: 'subscribe'
  },
  terminal: {
    create: 'invoke',
    write: 'send',
    resize: 'send',
    kill: 'invoke',
    onData: 'subscribe',
    onExit: 'subscribe'
  },
  consult: {
    start: 'invoke',
    cancel: 'invoke',
    onEvent: 'subscribe'
  },
  loop: {
    start: 'invoke',
    pause: 'invoke',
    resume: 'invoke',
    stop: 'invoke',
    state: 'invoke',
    onEvent: 'subscribe'
  },
  shell: {
    openPath: 'invoke',
    showItem: 'invoke',
    openExternal: 'invoke'
  }
} as const satisfies ExpectedKinds
