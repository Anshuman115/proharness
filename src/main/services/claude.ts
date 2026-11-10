import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AssistantBlock,
  PermissionMode,
  SessionEvent,
  SessionResultMeta
} from '@shared/types'
import { classifyRisk, type PermissionBroker } from './permissions'
import type { PlanService } from './plan'
import type { GitService } from './git'
import type { ProviderService } from './providers'
import { createProHarnessMcpServer } from './mcp'

const SYSTEM_PROMPT_APPEND = [
  'You are running inside ProHarness, a desktop control room for Claude Code.',
  'Project plans live under goals/<goal>/DESIGN.md and task checklists live under goals/<goal>/PLAN.md.',
  'Use the proharness MCP tools to read and update the plan when the user asks you to work on the plan.',
  'Use plan_next_task to choose work, and plan_complete_task only after the task is implemented and verified.',
  'Use delegate_model or review_changes when the user asks for an independent model review.',
  'Never run destructive git commands, force-push, or rewrite history unless explicitly asked. Do not commit unless asked.'
].join('\n')

const TOOL_RESULT_LIMIT = 60_000

export interface RunTurnOptions {
  cwd: string
  prompt: string
  resume: string | null
  model: string
  permissionMode: PermissionMode
  origin: 'session' | 'loop'
  originId: string
  originLabel: string
  autoApprove: boolean
  alwaysAllowed: Set<string>
  signal: AbortSignal
  onEvent: (event: SessionEvent) => void
  title?: string
  retryOnInvalidResume?: boolean
  planService: PlanService
  gitService: GitService
  providerService: ProviderService
  defaultReviewer: () => 'openai' | 'deepseek' | 'kimi'
  defaultReviewerModel: () => string
  claudeApiKey?: string
  executablePath?: string
}

export interface RunTurnResult {
  sdkSessionId: string | null
  text: string
  meta: SessionResultMeta | null
  aborted: boolean
  error: string | null
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text
  if (typeof block.thinking === 'string') return block.thinking
  return ''
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const block = item as Record<string, unknown>
          if (block.type === 'text' && typeof block.text === 'string') return block.text
          if (block.type === 'image') return '[image output]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

function mapAssistantBlocks(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return []
  const blocks: AssistantBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as unknown as Record<string, unknown>
    if (block.type === 'text') {
      const text = blockText(block)
      if (text) blocks.push({ type: 'text', text })
    } else if (block.type === 'thinking') {
      const text = blockText(block)
      if (text) blocks.push({ type: 'thinking', text })
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input:
          block.input && typeof block.input === 'object'
            ? (block.input as Record<string, unknown>)
            : {}
      })
    }
  }
  return blocks
}

function archiveText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export class ClaudeService {
  constructor(
    private readonly permissionBroker: PermissionBroker
  ) {}

  private buildCanUseTool(options: RunTurnOptions): CanUseTool {
    return async (toolName, input, sdkOptions): Promise<PermissionResult> => {
      const trustedMcp = toolName.startsWith('mcp__proharness__')
      if (trustedMcp || options.autoApprove || options.alwaysAllowed.has(toolName)) {
        return { behavior: 'allow', updatedInput: input, toolUseID: sdkOptions.toolUseID }
      }

      const outcome = await this.permissionBroker.ask(
        {
          origin: options.origin,
          originId: options.originId,
          originLabel: options.originLabel,
          toolName,
          toolUseId: sdkOptions.toolUseID,
          title: sdkOptions.title || `${sdkOptions.displayName || toolName} permission`,
          displayName: sdkOptions.displayName || toolName,
          description: sdkOptions.description || '',
          decisionReason: sdkOptions.decisionReason || null,
          blockedPath: sdkOptions.blockedPath || null,
          input,
          risk: classifyRisk(toolName),
          canRemember: Boolean(sdkOptions.suggestions?.length) && !sdkOptions.suppressAlwaysAllowRule,
          defaultToNo: Boolean(sdkOptions.defaultToNo)
        },
        sdkOptions.signal
      )

      if (!outcome.allow) {
        return {
          behavior: 'deny',
          message: outcome.message,
          toolUseID: sdkOptions.toolUseID,
          interrupt: false
        }
      }

      if (outcome.remember) {
        options.alwaysAllowed.add(toolName)
        if (sdkOptions.suggestions?.length) {
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: sdkOptions.suggestions,
            toolUseID: sdkOptions.toolUseID
          }
        }
      }

      return { behavior: 'allow', updatedInput: input, toolUseID: sdkOptions.toolUseID }
    }
  }

  async runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
    const abortController = new AbortController()
    const onOuterAbort = (): void => abortController.abort()
    options.signal.addEventListener('abort', onOuterAbort, { once: true })

    const mcp = createProHarnessMcpServer({
      planService: options.planService,
      gitService: options.gitService,
      providerService: options.providerService,
      defaultProvider: options.defaultReviewer,
      defaultReviewerModel: options.defaultReviewerModel
    })

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'proharness/0.1.0'
    }
    if (options.claudeApiKey) env.ANTHROPIC_API_KEY = options.claudeApiKey

    let sdkSessionId = options.resume
    let text = ''
    let meta: SessionResultMeta | null = null
    let runError: string | null = null
    let resumeInvalid = false
    let resumeInvalidReason = ''
    const startedMessages = new Set<string>()
    let currentStreamMessageId: string | null = null
    let currentStreamKind: 'text' | 'thinking' | null = null

    try {
      const stream = query({
        prompt: options.prompt,
        options: {
          cwd: options.cwd,
          resume: options.resume || undefined,
          model: options.model,
          permissionMode: options.permissionMode,
          allowDangerouslySkipPermissions: options.permissionMode === 'bypassPermissions',
          includePartialMessages: true,
          forwardSubagentText: true,
          canUseTool: this.buildCanUseTool(options),
          mcpServers: { proharness: mcp },
          settingSources: ['project'],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: SYSTEM_PROMPT_APPEND
          },
          pathToClaudeCodeExecutable: options.executablePath || undefined,
          abortController,
          title: options.title,
          env
        }
      })

      for await (const message of stream as AsyncIterable<SDKMessage>) {
        if (options.signal.aborted) break
        if (message.type === 'system' && message.subtype === 'init') {
          const sessionId = (message as unknown as { session_id?: string }).session_id
          if (sessionId) sdkSessionId = sessionId
          options.onEvent({
            type: 'init',
            sdkSessionId: sdkSessionId || '',
            model: message.model,
            cwd: message.cwd,
            tools: message.tools || [],
            mcpServers: (message.mcp_servers || []).map((server) => `${server.name}:${server.status}`),
            apiKeySource: message.apiKeySource
          })
          continue
        }

        if (message.type === 'stream_event') {
          const event = message.event as unknown as Record<string, unknown>
          if (event.type === 'message_start') {
            const payload = event.message as { id?: string } | undefined
            if (payload?.id) {
              currentStreamMessageId = payload.id
              currentStreamKind = null
              if (!startedMessages.has(payload.id)) {
                startedMessages.add(payload.id)
                options.onEvent({ type: 'message_start', messageId: payload.id })
              }
            }
            continue
          }
          if (event.type === 'content_block_start') {
            const block = event.content_block as { type?: string } | undefined
            currentStreamKind =
              block?.type === 'thinking' ? 'thinking' : block?.type === 'text' ? 'text' : null
            continue
          }
          if (event.type === 'content_block_delta' && currentStreamMessageId) {
            const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
            if (delta?.type === 'text_delta' && delta.text) {
              text += delta.text
              options.onEvent({
                type: 'delta',
                messageId: currentStreamMessageId,
                block: 'text',
                text: delta.text
              })
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              options.onEvent({
                type: 'delta',
                messageId: currentStreamMessageId,
                block: 'thinking',
                text: delta.thinking
              })
            }
            continue
          }
          continue
        }

        if (message.type === 'assistant') {
          if (message.parent_tool_use_id) {
            const blocks = mapAssistantBlocks(message.message.content)
            const subText = archiveText(blocks)
            if (subText.trim()) {
              options.onEvent({
                type: 'notice',
                level: 'info',
                message: subText.trim().slice(0, 2_000)
              })
            }
            continue
          }
          const messageId = message.message.id || message.uuid
          if (!startedMessages.has(messageId)) {
            startedMessages.add(messageId)
            options.onEvent({ type: 'message_start', messageId })
          }
          const blocks = mapAssistantBlocks(message.message.content)
          if (message.error) {
            options.onEvent({
              type: 'notice',
              level: 'error',
              message: `Claude reported ${message.error}.`
            })
          }
          if (blocks.length) {
            options.onEvent({ type: 'message', messageId, blocks })
            const assistantText = archiveText(blocks)
            if (assistantText && !text.endsWith(assistantText)) text += assistantText
          }
          continue
        }

        if (message.type === 'user') {
          const content = message.message.content
          if (!Array.isArray(content)) continue
          for (const raw of content) {
            if (!raw || typeof raw !== 'object') continue
            const block = raw as unknown as Record<string, unknown>
            if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            const resultText = toolResultText(block.content)
            options.onEvent({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content:
                resultText.length > TOOL_RESULT_LIMIT
                  ? `${resultText.slice(0, TOOL_RESULT_LIMIT)}\n… output truncated`
                  : resultText,
              isError: Boolean(block.is_error)
            })
          }
          continue
        }

        if (message.type === 'result') {
          const sessionId = (message as unknown as { session_id?: string }).session_id
          if (sessionId) sdkSessionId = sessionId
          meta = {
            costUsd: message.total_cost_usd || 0,
            durationMs: message.duration_ms || 0,
            numTurns: message.num_turns || 0,
            isError: message.is_error,
            resultText: 'result' in message ? String(message.result || '') : ''
          }
          if (meta.resultText && !text.trim()) text = meta.resultText
          if (
            options.resume &&
            options.retryOnInvalidResume !== false &&
            /No conversation found with session ID/i.test(meta.resultText)
          ) {
            resumeInvalid = true
            resumeInvalidReason = meta.resultText
            break
          }
          if (meta.isError && /not logged in|please run \/login|authentication_failed/i.test(meta.resultText)) {
            options.onEvent({
              type: 'notice',
              level: 'error',
              message:
                'Claude Code is not authenticated. Run `claude` in a terminal and use /login, or add an Anthropic API key in Settings.'
            })
          }
          options.onEvent({ type: 'result', meta })
          continue
        }

        if (message.type === 'system') {
          const subtype = (message as { subtype?: string }).subtype
          if (subtype === 'api_retry') {
            options.onEvent({ type: 'notice', level: 'warn', message: 'Claude API retry in progress.' })
          }
          continue
        }
      }
    } catch (error) {
      if (options.signal.aborted || abortController.signal.aborted) {
        options.onEvent({ type: 'notice', level: 'info', message: 'Stopped by user.' })
      } else {
        const message = (error as Error).message || 'Claude session failed.'
        if (
          options.resume &&
          options.retryOnInvalidResume !== false &&
          /No conversation found with session ID/i.test(message)
        ) {
          resumeInvalid = true
          resumeInvalidReason = message
        } else {
          runError = message
          options.onEvent({ type: 'error', message })
          options.onEvent({ type: 'notice', level: 'error', message })
        }
      }
    } finally {
      options.signal.removeEventListener('abort', onOuterAbort)
    }

    if (resumeInvalid && !options.signal.aborted) {
      options.onEvent({
        type: 'notice',
        level: 'warn',
        message: `The previous Claude transcript was not available (${resumeInvalidReason.slice(
          0,
          120
        )}). Starting a fresh conversation for this tab.`
      })
      return this.runTurn({
        ...options,
        resume: null,
        retryOnInvalidResume: false,
        alwaysAllowed: options.alwaysAllowed
      })
    }

    return {
      sdkSessionId,
      text: text.trim(),
      meta,
      aborted: options.signal.aborted,
      error: runError
    }
  }
}
