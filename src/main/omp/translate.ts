import type { ContentBlock, HistoryMessage, SessionSnapshot, SlashCommand, TodoPhase, ToolBlock } from '@shared/types'

/** Pure helpers that map omp RPC payloads onto ProHarness view models. */

type Json = Record<string, unknown>

const MAX_TOOL_OUTPUT = 60_000

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const item = part as Json
      if (item.type === 'text' && typeof item.text === 'string') return item.text
      if (item.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function clampOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… output truncated` : text
}

function toolArgs(raw: unknown): { args: Record<string, unknown>; intent: string } {
  const args = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
  const intent = typeof args.i === 'string' ? args.i : ''
  delete args.i
  return { args, intent }
}

/** Converts one assistant content part into a block, or null for parts the UI skips. */
export function toBlock(part: unknown): ContentBlock | null {
  const item = (part || {}) as Json
  switch (item.type) {
    case 'text':
      return { type: 'text', text: String(item.text ?? '') }
    case 'thinking':
      return { type: 'thinking', text: String(item.thinking ?? '') }
    case 'redactedThinking':
      return { type: 'thinking', text: '[redacted reasoning]' }
    case 'toolCall': {
      const { args, intent } = toolArgs(item.arguments)
      return {
        type: 'tool',
        id: String(item.id ?? ''),
        name: String(item.name ?? 'tool'),
        intent: typeof item.intent === 'string' ? item.intent : intent,
        args,
        status: 'pending'
      }
    }
    default:
      return null
  }
}

export function toBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.map(toBlock).filter((block): block is ContentBlock => block !== null)
}

export function messageCost(message: Json): number {
  const usage = message.usage as Json | undefined
  const cost = usage?.cost as Json | undefined
  const total = Number(cost?.total)
  return Number.isFinite(total) ? total : 0
}

export function messageModel(message: Json): string | null {
  if (typeof message.provider === 'string' && typeof message.model === 'string') {
    return `${message.provider}/${message.model}`
  }
  return null
}

export function messageError(message: Json): string | null {
  if (message.stopReason !== 'error') return null
  return typeof message.errorMessage === 'string' && message.errorMessage
    ? message.errorMessage
    : 'The model request failed.'
}

/** Rebuilds a transcript from `get_messages`, attaching tool results to their calls. */
export function historyFromMessages(messages: unknown[]): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const tools = new Map<string, ToolBlock>()
  for (const raw of messages) {
    const message = (raw || {}) as Json
    if (message.role === 'user') {
      if (message.attribution === 'agent') continue
      const text = contentText(message.content).trim()
      if (text) out.push({ role: 'user', blocks: [{ type: 'text', text }], model: null })
    } else if (message.role === 'assistant') {
      const blocks = toBlocks(message.content)
      for (const block of blocks) {
        if (block.type === 'tool') {
          block.status = 'done'
          tools.set(block.id, block)
        }
      }
      if (blocks.length) out.push({ role: 'assistant', blocks, model: messageModel(message) })
    } else if (message.role === 'toolResult') {
      const block = tools.get(String(message.toolCallId ?? ''))
      if (block) {
        block.output = clampOutput(contentText(message.content))
        block.status = message.isError ? 'error' : 'done'
      }
    }
  }
  return out
}

export function snapshotFromState(state: Json, costUsd: number): SessionSnapshot {
  const model = state.model as Json | undefined
  const context = state.contextUsage as Json | undefined
  const queued = (state.queuedMessages || {}) as Json
  const todos = Array.isArray(state.todoPhases) ? (state.todoPhases as Json[]) : []
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    thinking: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : null,
    sessionId: typeof state.sessionId === 'string' ? state.sessionId : null,
    sessionFile: typeof state.sessionFile === 'string' ? state.sessionFile : null,
    contextPercent: typeof context?.percent === 'number' ? context.percent : null,
    contextTokens: typeof context?.tokens === 'number' ? context.tokens : null,
    contextWindow: typeof context?.contextWindow === 'number' ? context.contextWindow : null,
    todos: todos.map(
      (phase): TodoPhase => ({
        name: String(phase.name ?? ''),
        tasks: Array.isArray(phase.tasks)
          ? (phase.tasks as Json[]).map((task) => ({ content: String(task.content ?? ''), status: String(task.status ?? '') }))
          : []
      })
    ),
    queue: {
      steering: Array.isArray(queued.steering) ? (queued.steering as unknown[]).map(String) : [],
      followUp: Array.isArray(queued.followUp) ? (queued.followUp as unknown[]).map(String) : []
    },
    costUsd
  }
}

export function commandsFromFrame(commands: unknown): SlashCommand[] {
  if (!Array.isArray(commands)) return []
  const out: SlashCommand[] = []
  for (const raw of commands) {
    const command = (raw || {}) as Json
    if (typeof command.name !== 'string') continue
    const input = command.input as Json | undefined
    out.push({
      name: command.name,
      description: typeof command.description === 'string' ? command.description : '',
      hint: typeof input?.hint === 'string' ? input.hint : ''
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** omp tool approvals arrive as a `select` whose title starts with "Allow tool: <name>". */
export function parseApproval(title: string): { tool: string; details: string[] } | null {
  const lines = title.split('\n')
  const match = lines[0]?.match(/^Allow tool:\s*(.+)$/)
  if (!match) return null
  return { tool: match[1].trim(), details: lines.slice(1).filter((line) => line.trim()) }
}
