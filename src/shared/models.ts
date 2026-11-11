import { DEFAULT_REVIEWER } from './defaults'
import type { HostModelPrefs, ModelInfo } from './types'

/** Default choices per role, tried in order until one exists on the host. */
const ROLE_PREFERENCES = {
  chat: [] as string[],
  implementer: [] as string[],
  reviewer: [
    DEFAULT_REVIEWER,
    'commandcode/claude-sonnet-5-5',
    'openai-codex/gpt-6.1-sol',
    'commandcode/gpt-6.1-sol',
    'anthropic/claude-opus-5-5',
    'commandcode/claude-opus-5-5'
  ]
}

export const DEFAULT_PINNED = [
  'anthropic/claude-opus-5-5',
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-haiku-5-5',
  'openai-codex/gpt-6.1-sol',
  'openai-codex/gpt-6.1-terra',
  'openai-codex/gpt-6-luna',
  'commandcode/claude-opus-5-5',
  'commandcode/claude-sonnet-5-5',
  'commandcode/gpt-6.1-sol',
  'commandcode/deepseek/deepseek-v4.1-flash'
]

type ModelRole = 'chat' | 'implementer' | 'reviewer'

/** `provider/id:effort` → `provider/id` */
function stripEffort(key: string): string {
  return key.replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/i, '')
}

/** The model id without its provider, used to find the same model elsewhere. */
function modelTail(key: string): string {
  const bare = stripEffort(key)
  const slash = bare.indexOf('/')
  return slash >= 0 ? bare.slice(slash + 1) : bare
}

export function providerOf(key: string): string {
  return key.split('/')[0]
}

/** True when two `provider/id` model keys refer to the same underlying model family. */
export function sameModel(a: string, b: string): boolean {
  const strip = (value: string): string =>
    value
      .toLowerCase()
      .replace(/:[a-z]+$/, '')
      .split('/')
      .slice(1)
      .join('/')
      .replace(/^.*\//, '')
      .replace(/-(fast|ultrafast|\d{8})$/, '')
  return Boolean(a && b) && strip(a) === strip(b)
}

interface Resolution {
  /** Model to use; '' means "omp default" (only allowed for chat and implementer). */
  model: string
  /** Set when the saved choice was unavailable and something else was picked. */
  note: string | null
}

/**
 * Picks the model for a role on a host. Keeps the saved choice when the host
 * has it; otherwise prefers the same model through another provider, then the
 * role's preference list, then the host's default.
 */
export function resolveModel(
  role: ModelRole,
  saved: string,
  models: ModelInfo[],
  hostDefault: string | null
): Resolution {
  const keys = new Set(models.map((model) => model.key))
  // An empty catalog means discovery has not finished; do not second-guess the user.
  if (!keys.size) return { model: saved, note: null }
  const has = (key: string): boolean => keys.has(stripEffort(key))
  if (saved && has(saved)) return { model: saved, note: null }
  if (!saved && role !== 'reviewer') return { model: '', note: null }

  const tail = saved ? modelTail(saved) : ''
  const sameTail = tail ? models.find((model) => model.id === tail || model.id.endsWith(`/${tail}`)) : undefined
  const fallback =
    sameTail?.key ||
    ROLE_PREFERENCES[role].find((key) => has(key)) ||
    (role === 'reviewer' && hostDefault && has(hostDefault) ? stripEffort(hostDefault) : '')
  if (!saved) return { model: fallback, note: null }
  if (!fallback) {
    return role === 'reviewer'
      ? { model: '', note: `${saved} is not available on this host. Choose a reviewer.` }
      : { model: '', note: `${saved} is not available on this host; using omp's default.` }
  }
  return { model: fallback, note: `${saved} is not available on this host; using ${fallback}.` }
}

export function emptyPrefs(): HostModelPrefs {
  return { chatModel: '', implementerModel: '', reviewerModel: '' }
}
