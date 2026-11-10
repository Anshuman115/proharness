import type { ProHarnessApi } from '@shared/api'

declare global {
  interface Window {
    proharness: ProHarnessApi
  }
}

export {}
