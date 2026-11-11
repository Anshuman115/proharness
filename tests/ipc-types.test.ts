import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ProHarnessApi, Unsubscribe } from '../src/shared/api'
import { BOOTSTRAP_CHANNEL, channelFor, IPC_METHODS, type ExpectedKind } from '../src/shared/ipc'
import { createApi } from '../src/preload/api'
import type { Bootstrap, SessionEvent } from '../src/shared/types'

interface Fixture {
  ns: {
    go(a: string): Promise<number>
    fire(a: string): void
    onPing(listener: (n: number) => void): Unsubscribe
  }
}

interface NumericFixture extends Fixture {
  ns: Fixture['ns'] & { numeric(): number }
}

type Kinds<A> = { [N in keyof A]: { [M in keyof A[N]]: ExpectedKind<M, A[N][M]> } }

const good = { ns: { go: 'invoke', fire: 'send', onPing: 'subscribe' } } as const satisfies Kinds<Fixture>
// @ts-expect-error a missing descriptor method is rejected
const missing = { ns: { go: 'invoke', fire: 'send' } } as const satisfies Kinds<Fixture>
// @ts-expect-error an extra descriptor method is rejected
const extra = { ns: { go: 'invoke', fire: 'send', onPing: 'subscribe', nope: 'invoke' } } as const satisfies Kinds<Fixture>
// @ts-expect-error an on* method cannot be classified invoke
const wrongOn = { ns: { go: 'invoke', fire: 'send', onPing: 'invoke' } } as const satisfies Kinds<Fixture>
// @ts-expect-error a void method cannot be classified invoke
const wrongSend = { ns: { go: 'invoke', fire: 'invoke', onPing: 'subscribe' } } as const satisfies Kinds<Fixture>
// @ts-expect-error a numeric return has no valid kind
const numeric = { ns: { go: 'invoke', fire: 'send', onPing: 'subscribe', numeric: 'invoke' } } as const satisfies Kinds<NumericFixture>

// @ts-expect-error numeric-returning methods have no valid descriptor kind
const badNumeric: ExpectedKind<'numeric', () => number> = 'send'
// @ts-expect-error an on* method must return Unsubscribe
const badOn: ExpectedKind<'onPing', (listener: (n: number) => void) => string> = 'subscribe'

describe('ipc types', () => {
  it('keeps the descriptor exact and the factory contract intact', () => {
    expectTypeOf<typeof IPC_METHODS['terminal']['write']>().toEqualTypeOf<'send'>()
    expectTypeOf<typeof IPC_METHODS['terminal']['resize']>().toEqualTypeOf<'send'>()
    expectTypeOf<typeof IPC_METHODS['sessions']['onEvent']>().toEqualTypeOf<'subscribe'>()
    expectTypeOf<typeof IPC_METHODS['sessions']['create']>().toEqualTypeOf<'invoke'>()
    expectTypeOf<typeof BOOTSTRAP_CHANNEL>().toEqualTypeOf<'app:bootstrap'>()
    expectTypeOf<ReturnType<typeof channelFor>>().toEqualTypeOf<string>()

    expectTypeOf<ReturnType<typeof createApi>>().toEqualTypeOf<ProHarnessApi>()
    expectTypeOf<ProHarnessApi['bootstrap']>().returns.toEqualTypeOf<Promise<Bootstrap>>()
    expectTypeOf<ProHarnessApi['terminal']['write']>().returns.toEqualTypeOf<void>()
    expectTypeOf<ProHarnessApi['sessions']['create']>().returns.toEqualTypeOf<Promise<void>>()
    expectTypeOf<Parameters<Parameters<ProHarnessApi['sessions']['onEvent']>[0]>>().toEqualTypeOf<
      [tabId: string, event: SessionEvent]
    >()

    void [good, missing, extra, wrongOn, wrongSend, numeric, badNumeric, badOn]
    expect(true).toBe(true)
  })
})
