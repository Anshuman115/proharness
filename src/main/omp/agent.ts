import type { ContentBlock, SessionEvent, SessionSnapshot, UiRequest } from '@shared/types'
import type { UiAnswer, UiBroker } from '../services/ui-broker'
import { OmpRpc, type Frame } from './rpc'
import {
  clampOutput,
  commandsFromFrame,
  contentText,
  historyFromMessages,
  messageCost,
  messageError,
  messageModel,
  parseApproval,
  snapshotFromState,
  toBlock,
  toBlocks
} from './translate'

type Json = Record<string, unknown>

export interface HostTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>
}

export interface OmpAgentOptions {
  ompPath: string
  env: NodeJS.ProcessEnv
  cwd: string
  model?: string
  thinking?: string
  approval: string
  /** `rpc-ui` enables the interactive `ask` tool. */
  mode: 'rpc' | 'rpc-ui'
  ephemeral: boolean
  tools?: string[]
  noExtensions?: boolean
  noSkills?: boolean
  configOverlays?: string[]
  appendSystemPrompt?: string
  hostTools?: HostTool[]
  broker: UiBroker
  origin: UiRequest['origin']
  originId: string
  originLabel: () => string
  onEvent: (event: SessionEvent) => void
}

export interface TurnResult {
  status: 'completed' | 'aborted' | 'error'
  error: string | null
  text: string
  costUsd: number
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

/**
 * One omp process driven over RPC. Translates omp frames into ProHarness
 * session events and serves host tools and dialogs.
 */
export class OmpAgent {
  readonly rpc: OmpRpc
  private dialogs = new Map<string, { brokerId: string; controller: AbortController }>()
  private hostCalls = new Map<string, AbortController>()
  private turnWaiters = new Map<string, (result: { status: TurnResult['status']; error: string | null }) => void>()
  private stateTimer: NodeJS.Timeout | null = null
  private costUsd = 0
  private lastText = ''
  private working = false
  private closed = false

  constructor(private readonly options: OmpAgentOptions) {
    const args = ['--mode', options.mode, '--approval-mode', options.approval]
    if (options.model) args.push('--model', options.model)
    if (options.thinking) args.push('--thinking', options.thinking)
    if (options.ephemeral) args.push('--no-session')
    if (options.tools) args.push('--tools', options.tools.join(','))
    if (options.noExtensions) args.push('--no-extensions')
    if (options.noSkills) args.push('--no-skills')
    for (const overlay of options.configOverlays || []) args.push('--config', overlay)
    if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt)
    this.rpc = new OmpRpc({
      command: options.ompPath,
      args,
      cwd: options.cwd,
      env: { ...options.env, PI_RPC_EMIT_TITLE: '0' }
    })
    this.rpc.on('frame', (frame: Frame) => this.handle(frame))
    this.rpc.on('exit', (info: { error: string | null }) => {
      this.closed = true
      for (const waiter of this.turnWaiters.values()) waiter({ status: 'error', error: info.error || 'omp exited.' })
      this.turnWaiters.clear()
      this.abortPending()
      this.emit({ type: 'status', status: info.error ? 'error' : 'closed', detail: info.error || undefined })
      if (info.error) this.emit({ type: 'notice', level: 'error', message: info.error })
    })
  }

  get isWorking(): boolean {
    return this.working
  }

  get alive(): boolean {
    return this.rpc.alive && !this.closed
  }

  get totalCost(): number {
    return this.costUsd
  }

  private emit(event: SessionEvent): void {
    this.options.onEvent(event)
  }

  async start(): Promise<void> {
    this.emit({ type: 'status', status: 'starting' })
    await this.rpc.start()
    await this.rpc.request({ type: 'set_event_filter', events: null, messageUpdates: 'delta' })
    const hostTools = this.options.hostTools || []
    if (hostTools.length) {
      await this.rpc.request({
        type: 'set_host_tools',
        tools: hostTools.map((tool) => ({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          loadMode: 'essential'
        }))
      })
    }
    await this.refreshState()
    this.emit({ type: 'status', status: 'idle' })
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /** Starts a turn, or queues the text when the agent is already working. */
  async prompt(text: string, behavior: 'steer' | 'followUp' = 'followUp'): Promise<string> {
    const request = this.rpc.request({
      type: 'prompt',
      message: text,
      ...(this.working ? { streamingBehavior: behavior } : {})
    })
    const data = (await request) as Json | undefined
    if (data && data.agentInvoked === false) {
      // A local slash command finished without a model turn.
      this.emit({ type: 'turn_end', status: 'completed' })
      void this.refreshState()
    } else if (!this.working) {
      this.working = true
      this.emit({ type: 'status', status: 'working' })
    }
    return request.id
  }

  /** Runs one prompt to completion and returns the final assistant text. */
  async runTurn(text: string, signal: AbortSignal): Promise<TurnResult> {
    const costBefore = this.costUsd
    this.lastText = ''
    const request = this.rpc.request({ type: 'prompt', message: text }, 120_000)
    const finished = new Promise<{ status: TurnResult['status']; error: string | null }>((resolve) => {
      this.turnWaiters.set(request.id, resolve)
    })
    const onAbort = (): void => void this.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const data = (await request) as Json | undefined
      if (data && data.agentInvoked === false) {
        this.turnWaiters.delete(request.id)
        return { status: 'completed', error: null, text: '', costUsd: 0 }
      }
      this.working = true
      this.emit({ type: 'status', status: 'working' })
      const result = await finished
      let finalText = this.lastText
      try {
        const last = (await this.rpc.request({ type: 'get_last_assistant_text' }, 15_000)) as Json | string | null
        if (typeof last === 'string') finalText = last
        else if (last && typeof last.text === 'string') finalText = last.text
      } catch {
        // Keep the streamed text.
      }
      return { ...result, text: finalText, costUsd: this.costUsd - costBefore }
    } catch (error) {
      this.turnWaiters.delete(request.id)
      return { status: 'error', error: (error as Error).message, text: this.lastText, costUsd: this.costUsd - costBefore }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async abort(): Promise<void> {
    if (!this.alive) return
    this.emit({ type: 'status', status: 'stopping' })
    this.abortPending()
    try {
      await this.rpc.request({ type: 'abort' }, 30_000)
    } catch {
      // The turn may already be over.
    }
  }

  async setModel(model: string): Promise<void> {
    const slash = model.indexOf('/')
    if (slash <= 0) throw new Error(`Model "${model}" must be provider/id.`)
    await this.rpc.request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) }, 60_000)
    await this.refreshState()
  }

  async setThinking(level: string): Promise<void> {
    await this.rpc.request({ type: 'set_thinking_level', level })
    await this.refreshState()
  }

  async newSession(): Promise<void> {
    await this.rpc.request({ type: 'new_session' })
    this.costUsd = 0
    this.emit({ type: 'history', messages: [] })
    await this.refreshState()
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.rpc.request({ type: 'switch_session', sessionPath }, 60_000)
    await this.loadHistory()
    await this.refreshState()
  }

  async loadHistory(): Promise<void> {
    const data = (await this.rpc.request({ type: 'get_messages' }, 60_000)) as Json
    const messages = Array.isArray(data?.messages) ? (data.messages as unknown[]) : []
    this.emit({ type: 'history', messages: historyFromMessages(messages) })
  }

  async compact(): Promise<void> {
    await this.rpc.request({ type: 'compact' }, 10 * 60_000)
    await this.refreshState()
  }

  async removeQueued(message: string, queue: 'steering' | 'followUp'): Promise<void> {
    await this.rpc.request({ type: 'remove_queued_message', message, queue })
  }

  async refreshState(): Promise<SessionSnapshot | null> {
    if (!this.alive) return null
    try {
      const state = (await this.rpc.request({ type: 'get_state' }, 20_000)) as Json
      const snapshot = snapshotFromState(state, this.costUsd)
      this.emit({ type: 'snapshot', snapshot })
      return snapshot
    } catch {
      return null
    }
  }

  private scheduleState(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      void this.refreshState()
    }, 250)
  }

  async close(): Promise<void> {
    this.closed = true
    this.abortPending()
    if (this.stateTimer) clearTimeout(this.stateTimer)
    await this.rpc.close()
  }

  private abortPending(): void {
    for (const [ompId, dialog] of this.dialogs) {
      dialog.controller.abort()
      this.dialogs.delete(ompId)
    }
    for (const controller of this.hostCalls.values()) controller.abort()
    this.hostCalls.clear()
  }

  // ── frames ─────────────────────────────────────────────────────────────────

  private handle(frame: Frame): void {
    switch (frame.type) {
      case 'agent_start':
        this.working = true
        this.emit({ type: 'status', status: 'working' })
        return
      case 'message_start':
        this.onMessageStart(frame)
        return
      case 'message_update':
        this.onMessageUpdate(frame)
        return
      case 'message_end':
        this.onMessageEnd(frame)
        return
      case 'tool_execution_start':
        this.emit({ type: 'tool', toolId: String(frame.toolCallId), status: 'running' })
        return
      case 'tool_execution_update': {
        const partial = frame.partialResult as Json | undefined
        const output = contentText(partial?.content)
        if (output) this.emit({ type: 'tool', toolId: String(frame.toolCallId), status: 'running', output: clampOutput(output) })
        return
      }
      case 'tool_execution_end': {
        const result = frame.result as Json | undefined
        this.emit({
          type: 'tool',
          toolId: String(frame.toolCallId),
          status: frame.isError ? 'error' : 'done',
          output: clampOutput(contentText(result?.content))
        })
        return
      }
      case 'prompt_result':
        this.onPromptResult(frame)
        return
      case 'session_settled':
        this.working = false
        this.emit({ type: 'status', status: 'idle' })
        this.scheduleState()
        return
      case 'queue_update':
      case 'todo_reminder':
      case 'todo_auto_clear':
      case 'model_changed':
      case 'thinking_level_changed':
      case 'turn_end':
      case 'auto_compaction_end':
      case 'manual_compaction_end':
        this.scheduleState()
        return
      case 'available_commands_update':
        this.emit({ type: 'commands', commands: commandsFromFrame(frame.commands) })
        return
      case 'extension_ui_request':
        this.onUiRequest(frame)
        return
      case 'host_tool_call':
        void this.onHostToolCall(frame)
        return
      case 'host_tool_cancel': {
        const controller = this.hostCalls.get(String(frame.targetId))
        controller?.abort()
        return
      }
      case 'command_output':
        if (typeof frame.text === 'string' && frame.text.trim()) {
          this.emit({ type: 'notice', level: 'info', message: frame.text })
        }
        return
      case 'notice':
        this.emit({
          type: 'notice',
          level: frame.level === 'error' ? 'error' : frame.level === 'warn' || frame.level === 'warning' ? 'warn' : 'info',
          message: String(frame.message ?? '')
        })
        return
      case 'auto_retry_start':
        this.emit({
          type: 'notice',
          level: 'warn',
          message: `Retrying after a provider error${frame.errorMessage ? `: ${String(frame.errorMessage).slice(0, 300)}` : '.'}`
        })
        return
      case 'auto_compaction_start':
        this.emit({ type: 'notice', level: 'info', message: 'Compacting context…' })
        return
      case 'retry_fallback_applied':
        this.emit({ type: 'notice', level: 'warn', message: `Fell back from ${String(frame.from)} to ${String(frame.to)}.` })
        return
      case 'extension_error':
        this.emit({ type: 'notice', level: 'warn', message: `Extension error: ${String(frame.error ?? '').slice(0, 400)}` })
        return
      case 'response':
        // Late failure for an admitted prompt.
        if (frame.command === 'prompt' && frame.success === false) {
          this.emit({ type: 'notice', level: 'error', message: String(frame.error ?? 'Prompt failed.') })
        }
        return
      default:
        return
    }
  }

  private onMessageStart(frame: Frame): void {
    const message = (frame.message || {}) as Json
    if (message.role === 'user') {
      if (message.attribution === 'agent') return
      const text = contentText(message.content).trim()
      if (text) this.emit({ type: 'user', text })
      return
    }
    if (message.role !== 'assistant') return
    const messageId = String(frame.messageId ?? '')
    this.emit({ type: 'message_start', messageId, model: messageModel(message) })
  }

  private onMessageUpdate(frame: Frame): void {
    const event = (frame.assistantMessageEvent || {}) as Json
    const messageId = String(frame.messageId ?? '')
    const index = Number(event.contentIndex ?? 0)
    switch (event.type) {
      case 'text_start':
      case 'thinking_start':
      case 'toolcall_start': {
        const block = toBlock(event.block)
        if (block) this.emit({ type: 'block', messageId, index, block })
        return
      }
      case 'text_delta':
      case 'thinking_delta':
        if (typeof event.delta === 'string' && event.delta) {
          if (event.type === 'text_delta') this.lastText += event.delta
          this.emit({ type: 'delta', messageId, index, text: event.delta })
        }
        return
      case 'text_end':
      case 'thinking_end': {
        const base = (event.block || {}) as Json
        const block = toBlock(
          event.type === 'text_end'
            ? { ...base, type: 'text', text: event.content }
            : { ...base, type: 'thinking', thinking: event.content }
        )
        if (block) this.emit({ type: 'block', messageId, index, block })
        return
      }
      case 'toolcall_end': {
        const block = toBlock(event.toolCall)
        if (block) this.emit({ type: 'block', messageId, index, block })
        return
      }
      case 'start': {
        const message = (event.message || {}) as Json
        toBlocks(message.content).forEach((block, blockIndex) => {
          this.emit({ type: 'block', messageId, index: blockIndex, block })
        })
        return
      }
      default:
        return
    }
  }

  private onMessageEnd(frame: Frame): void {
    const message = (frame.message || {}) as Json
    if (message.role !== 'assistant') return
    const cost = messageCost(message)
    this.costUsd += cost
    const blocks: ContentBlock[] = toBlocks(message.content)
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    if (text.trim()) this.lastText = text
    this.emit({
      type: 'message_end',
      messageId: String(frame.messageId ?? ''),
      blocks,
      costUsd: cost,
      error: messageError(message)
    })
  }

  private onPromptResult(frame: Frame): void {
    const status = (frame.status === 'aborted' || frame.status === 'error' ? frame.status : 'completed') as TurnResult['status']
    const errorInfo = frame.error as Json | undefined
    const error = status === 'error' ? String(errorInfo?.message ?? 'The turn failed.') : null
    const waiter = this.turnWaiters.get(String(frame.id ?? ''))
    if (waiter) {
      this.turnWaiters.delete(String(frame.id))
      waiter({ status, error })
    }
    this.emit({ type: 'turn_end', status, error: error || undefined })
    if (frame.sessionSettled) {
      this.working = false
      this.emit({ type: 'status', status: 'idle' })
    }
    this.scheduleState()
  }

  private onUiRequest(frame: Frame): void {
    const method = String(frame.method ?? '')
    const ompId = String(frame.id ?? '')
    if (method === 'cancel') {
      const target = String(frame.targetId ?? '')
      const dialog = this.dialogs.get(target)
      if (dialog) {
        this.dialogs.delete(target)
        dialog.controller.abort()
      }
      return
    }
    if (method === 'notify') {
      const message = String(frame.message ?? '')
      if (message.trim()) {
        const level = frame.notifyType === 'error' ? 'error' : frame.notifyType === 'warning' ? 'warn' : 'info'
        this.emit({ type: 'notice', level, message })
      }
      return
    }
    if (!DIALOG_METHODS.has(method)) return

    const title = String(frame.title ?? '')
    const options = Array.isArray(frame.options) ? (frame.options as unknown[]).map(String) : []
    const details = Array.isArray(frame.optionDetails)
      ? (frame.optionDetails as Json[]).map((item) => String(item?.description ?? ''))
      : []
    const controller = new AbortController()
    const { id: brokerId, answer } = this.options.broker.ask(
      {
        origin: this.options.origin,
        originId: this.options.originId,
        originLabel: this.options.originLabel(),
        method: method as UiRequest['method'],
        title,
        message: typeof frame.message === 'string' ? frame.message : '',
        options,
        optionDetails: details,
        placeholder: typeof frame.placeholder === 'string' ? frame.placeholder : '',
        approval: method === 'select' ? parseApproval(title) : null
      },
      controller.signal
    )
    this.dialogs.set(ompId, { brokerId, controller })
    void answer.then((value) => {
      if (!this.dialogs.has(ompId)) return
      this.dialogs.delete(ompId)
      this.rpc.write(this.uiResponse(ompId, value))
    })
  }

  private uiResponse(id: string, answer: UiAnswer): Record<string, unknown> {
    if (answer.kind === 'value') return { type: 'extension_ui_response', id, value: answer.value }
    if (answer.kind === 'confirmed') return { type: 'extension_ui_response', id, confirmed: answer.confirmed }
    return { type: 'extension_ui_response', id, cancelled: true }
  }

  private async onHostToolCall(frame: Frame): Promise<void> {
    const id = String(frame.id ?? '')
    const tool = (this.options.hostTools || []).find((item) => item.name === frame.toolName)
    if (!tool) {
      this.rpc.write({
        type: 'host_tool_result',
        id,
        isError: true,
        result: { content: [{ type: 'text', text: `Unknown host tool: ${String(frame.toolName)}` }] }
      })
      return
    }
    const controller = new AbortController()
    this.hostCalls.set(id, controller)
    try {
      const args = (frame.arguments || {}) as Record<string, unknown>
      const text = await tool.run(args, controller.signal)
      this.rpc.write({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text }] } })
    } catch (error) {
      this.rpc.write({
        type: 'host_tool_result',
        id,
        isError: true,
        result: { content: [{ type: 'text', text: (error as Error).message || 'Host tool failed.' }] }
      })
    } finally {
      this.hostCalls.delete(id)
    }
  }
}
