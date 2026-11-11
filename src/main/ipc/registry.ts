import type { IpcMain } from 'electron'
import type { ProHarnessApi, Unsubscribe } from '@shared/api'
import { BOOTSTRAP_CHANNEL, channelFor, IPC_METHODS, type IpcKind } from '@shared/ipc'
import type { Bootstrap } from '@shared/types'

type Namespace = Exclude<keyof ProHarnessApi, 'bootstrap'>

type HandlerFor<F> = F extends (...args: infer P) => infer R
  ? (...args: P) => Awaited<R> | Promise<Awaited<R>>
  : never
type SendFor<F> = F extends (...args: infer P) => unknown ? (...args: P) => void : never
type EventArgs<F> = F extends (listener: (...args: infer A) => void) => Unsubscribe ? A : never

/** Per-namespace helpers keep `NS` concrete, so keyed access stays provable. */
type InvokeFor<NS, KM> = {
  [M in keyof KM as KM[M] extends 'invoke' ? M & keyof NS : never]: HandlerFor<NS[M & keyof NS]>
}
type SendForNs<NS, KM> = {
  [M in keyof KM as KM[M] extends 'send' ? M & keyof NS : never]: SendFor<NS[M & keyof NS]>
}
type EventsFor<NS, KM> = {
  [M in keyof KM as KM[M] extends 'subscribe' ? M & keyof NS : never]: (...args: EventArgs<NS[M & keyof NS]>) => void
}

export type InvokeHandlers = { [N in Namespace]: InvokeFor<ProHarnessApi[N], (typeof IPC_METHODS)[N]> }
export type SendHandlers = { [N in Namespace]: SendForNs<ProHarnessApi[N], (typeof IPC_METHODS)[N]> }
export type EventSenders = { [N in Namespace]: EventsFor<ProHarnessApi[N], (typeof IPC_METHODS)[N]> }
export interface RootHandlers {
  bootstrap(): Promise<Bootstrap>
}

type AnyHandler = (...args: unknown[]) => unknown

/**
 * Registers every invoke/send leaf from the shared descriptor against `ipcMain`.
 * Subscribe leaves are push-only and are handled by `createEventSenders`.
 * The Electron event is dropped; arguments and resolved values are passed through.
 */
export function bindIpc(
  ipc: Pick<IpcMain, 'handle' | 'on'>,
  invoke: InvokeHandlers,
  send: SendHandlers,
  root: RootHandlers
): void {
  const invokes = invoke as unknown as Record<string, Record<string, AnyHandler>>
  const sends = send as unknown as Record<string, Record<string, AnyHandler>>
  ipc.handle(BOOTSTRAP_CHANNEL, () => root.bootstrap())
  for (const [namespace, methods] of Object.entries(IPC_METHODS)) {
    for (const [method, kind] of Object.entries(methods as Record<string, IpcKind>)) {
      const channel = channelFor(namespace, method)
      if (kind === 'invoke') {
        ipc.handle(channel, (_event: unknown, ...args: unknown[]) => invokes[namespace][method](...args))
      } else if (kind === 'send') {
        ipc.on(channel, (_event: unknown, ...args: unknown[]) => {
          sends[namespace][method](...args)
        })
      }
    }
  }
}

/** Typed push helpers for the 11 subscribe leaves, keyed by their `on*` method names. */
export function createEventSenders(send: (channel: string, ...args: unknown[]) => void): EventSenders {
  const events: Record<string, Record<string, (...args: unknown[]) => void>> = {}
  for (const [namespace, methods] of Object.entries(IPC_METHODS)) {
    const group: Record<string, (...args: unknown[]) => void> = {}
    for (const [method, kind] of Object.entries(methods as Record<string, IpcKind>)) {
      if (kind === 'subscribe') {
        group[method] = (...args: unknown[]): void => send(channelFor(namespace, method), ...args)
      }
    }
    events[namespace] = group
  }
  return events as unknown as EventSenders
}
