import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../src/shared/types'
import { resolveModel } from '../src/shared/models'

const model = (key: string): ModelInfo => {
  const slash = key.indexOf('/')
  return { key, provider: key.slice(0, slash), id: key.slice(slash + 1), name: key, contextWindow: null, reasoning: true, efforts: [], costIn: null, costOut: null }
}
const mac = ['anthropic/claude-sonnet-5-5', 'openai-codex/gpt-6.1-sol', 'commandcode/claude-sonnet-5-5', 'commandcode/deepseek/deepseek-v4.1-flash'].map(model)
const devbox = ['commandcode/claude-sonnet-5-5', 'commandcode/gpt-6.1-sol', 'commandcode/deepseek/deepseek-v4.1-flash'].map(model)

describe('resolveModel', () => {
  it('keeps a saved model the host has', () => {
    expect(resolveModel('reviewer', 'anthropic/claude-sonnet-5-5', mac, null)).toEqual({ model: 'anthropic/claude-sonnet-5-5', note: null })
  })

  it('switches to the same model through another provider', () => {
    const result = resolveModel('reviewer', 'anthropic/claude-sonnet-5-5', devbox, null)
    expect(result.model).toBe('commandcode/claude-sonnet-5-5')
    expect(result.note).toMatch(/not available/)
  })

  it('falls back to omp default for chat and implementer, never for an explicit reviewer', () => {
    expect(resolveModel('implementer', 'openai-codex/gpt-6-luna', devbox, null).model).toBe('')
    expect(resolveModel('reviewer', 'openai-codex/gpt-6-luna', [model('commandcode/deepseek/deepseek-v4.1-flash')], null)).toMatchObject({ model: '' })
  })

  it('fills an empty reviewer from the preference list', () => {
    expect(resolveModel('reviewer', '', devbox, null).model).toBe('commandcode/claude-sonnet-5-5')
  })

  it('handles saved efforts and an empty catalog', () => {
    expect(resolveModel('chat', 'commandcode/deepseek/deepseek-v4.1-flash:high', devbox, null).model).toBe('commandcode/deepseek/deepseek-v4.1-flash:high')
    expect(resolveModel('reviewer', 'anthropic/claude-sonnet-5-5', [], null).model).toBe('anthropic/claude-sonnet-5-5')
  })
})
