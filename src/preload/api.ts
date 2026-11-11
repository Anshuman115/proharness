import type { ProHarnessApi } from '@shared/api'
import { BOOTSTRAP_CHANNEL, channelFor, IPC_METHODS, type IpcKind } from '@shared/ipc'

/** The slice of `ipcRenderer` the bridge needs; tests provide a fake. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

/**
 * Builds the `window.proharness` object from the shared descriptor. Invoke leaves
 * resolve through `ipcRenderer.invoke`, send leaves stay fire-and-forget, and
 * subscribe leaves strip the Electron event before calling the renderer listener.
 */
export function createApi(ipc: IpcRendererLike): ProHarnessApi {
  const api: Record<string, unknown> = {
    bootstrap: () => ipc.invoke(BOOTSTRAP_CHANNEL)
  }
  for (const [namespace, methods] of Object.entries(IPC_METHODS)) {
    const group: Record<string, unknown> = {}
    for (const [method, kind] of Object.entries(methods as Record<string, IpcKind>)) {
      const channel = channelFor(namespace, method)
      if (kind === 'invoke') {
        group[method] = (...args: unknown[]): Promise<unknown> => ipc.invoke(channel, ...args)
      } else if (kind === 'send') {
        group[method] = (...args: unknown[]): void => {
          ipc.send(channel, ...args)
        }
      } else {
        group[method] = (listener: (...args: unknown[]) => void): (() => void) => {
          const wrapped = (_event: unknown, ...args: unknown[]): void => listener(...args)
          ipc.on(channel, wrapped)
          return () => ipc.removeListener(channel, wrapped)
        }
      }
    }
    api[namespace] = group
  }
  return api as unknown as ProHarnessApi
}
