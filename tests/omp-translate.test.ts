import { describe, expect, it } from 'vitest'
import { FrameDecoder, LineSplitter } from '../src/main/omp/rpc'
import { commandsFromFrame, historyFromMessages, parseApproval, snapshotFromState, toBlock } from '../src/main/omp/translate'
import { sessionDirFor } from '../src/main/services/sessions'

describe('omp translation', () => {
  it('parses approval prompts', () => {
    expect(parseApproval('Allow tool: bash\nCommand: echo hi > x.txt && ls')).toEqual({
      tool: 'bash',
      details: ['Command: echo hi > x.txt && ls']
    })
    expect(parseApproval('Pick a database')).toBeNull()
  })

  it('strips the intent argument from tool calls', () => {
    const block = toBlock({ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls', i: 'Listing' } })
    expect(block).toEqual({ type: 'tool', id: 't1', name: 'bash', intent: 'Listing', args: { command: 'ls' }, status: 'pending' })
  })

  it('rebuilds history with tool results attached and agent prompts hidden', () => {
    const history = historyFromMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', attribution: 'agent', content: 'internal' },
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        content: [
          { type: 'text', text: 'running' },
          { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'x' } }
        ]
      },
      { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'file body' }], isError: false }
    ])
    expect(history).toHaveLength(2)
    expect(history[1].model).toBe('anthropic/claude-sonnet-5-5')
    expect(history[1].blocks[1]).toMatchObject({ type: 'tool', output: 'file body', status: 'done' })
  })

  it('maps get_state into a snapshot', () => {
    const snapshot = snapshotFromState(
      {
        model: { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash' },
        thinkingLevel: 'high',
        contextUsage: { tokens: 1100, contextWindow: 200000, percent: 0.55 },
        queuedMessages: { steering: ['now'], followUp: [] },
        todoPhases: [{ name: 'Todos', tasks: [{ content: 'a', status: 'in_progress' }] }]
      },
      0.25
    )
    expect(snapshot).toMatchObject({
      model: 'commandcode/deepseek/deepseek-v4.1-flash',
      thinking: 'high',
      contextPercent: 0.55,
      queue: { steering: ['now'], followUp: [] },
      costUsd: 0.25
    })
    expect(snapshot.todos[0].tasks[0].status).toBe('in_progress')
  })

  it('sorts slash commands', () => {
    expect(commandsFromFrame([{ name: 'model' }, { name: 'compact', input: { hint: '[focus]' } }]).map((c) => c.name)).toEqual(['compact', 'model'])
  })
})

describe('rpc framing', () => {
  it('splits lines across chunks without breaking UTF-8', () => {
    const splitter = new LineSplitter()
    const bytes = Buffer.from('{"a":"é"}\n{"b":1}\n', 'utf8')
    const first = splitter.push(bytes.subarray(0, 7))
    const rest = splitter.push(bytes.subarray(7))
    expect([...first, ...rest]).toEqual(['{"a":"é"}', '{"b":1}'])
  })

  it('reassembles rpc_chunk frames', () => {
    const decoder = new FrameDecoder()
    const payload = Buffer.from(JSON.stringify({ type: 'response', id: 'x', success: true, data: 'é'.repeat(10) }))
    const half = Math.floor(payload.length / 2)
    const parts = [payload.subarray(0, half), payload.subarray(half)]
    const frames = parts.map((part, index) => ({
      type: 'rpc_chunk',
      chunkId: 'c1',
      index,
      count: 2,
      byteLength: payload.length,
      data: part.toString('base64')
    }))
    expect(decoder.push(frames[0])).toBeNull()
    expect(decoder.push(frames[1])).toMatchObject({ type: 'response', id: 'x' })
    expect(() => decoder.push({ ...frames[1], index: 1 })).toThrow()
  })
})

describe('session paths', () => {
  it('maps workspace paths to omp session folders', () => {
    expect(sessionDirFor('/Users/me/code/app', '/Users/me')).toBe('/Users/me/.omp/agent/sessions/-code-app')
    expect(sessionDirFor('/tmp/omp-probe', '/Users/me')).toBe('/Users/me/.omp/agent/sessions/--tmp-omp-probe--')
  })
})
