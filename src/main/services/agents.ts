import type { ApprovalMode, SessionEvent } from '@shared/types'
import { OmpAgent } from '../omp/agent'
import type { GitService } from './git'
import { createPlanTools, PLAN_SYSTEM_PROMPT } from './host-tools'
import type { OmpService } from './omp'
import type { PlanService } from './plan'
import type { SettingsService } from './settings'
import type { LoopAgentFactory } from './task-loop'
import type { UiBroker } from './ui-broker'

/** Read-only tool set for reviewers and consults. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'glob']

export class AgentFactory implements LoopAgentFactory {
  constructor(
    private readonly settings: SettingsService,
    private readonly omp: OmpService,
    private readonly plan: PlanService,
    private readonly git: GitService,
    private readonly broker: UiBroker,
    private readonly overlay: () => string
  ) {}

  defaultModel(): string | null {
    return this.omp.current().defaultModel
  }

  async implementer(options: {
    model: string
    approval: ApprovalMode
    label: string
    onEvent: (event: SessionEvent) => void
  }): Promise<OmpAgent> {
    return new OmpAgent({
      ompPath: await this.omp.binary(),
      env: await this.omp.env(),
      cwd: this.settings.workspacePath,
      model: options.model || undefined,
      approval: options.approval,
      mode: 'rpc',
      ephemeral: false,
      configOverlays: [this.overlay()],
      appendSystemPrompt: PLAN_SYSTEM_PROMPT,
      hostTools: createPlanTools({ plan: this.plan, git: this.git, allowComplete: false }),
      broker: this.broker,
      origin: 'loop',
      originId: 'loop',
      originLabel: () => options.label,
      onEvent: options.onEvent
    })
  }

  /** Ephemeral, read-only omp used for reviews and second opinions. */
  async reviewer(options: { model: string; label: string; onEvent: (event: SessionEvent) => void }): Promise<OmpAgent> {
    return new OmpAgent({
      ompPath: await this.omp.binary(),
      env: await this.omp.env(),
      cwd: this.settings.workspacePath,
      model: options.model,
      approval: 'yolo',
      mode: 'rpc',
      ephemeral: true,
      tools: READ_ONLY_TOOLS,
      noExtensions: true,
      broker: this.broker,
      origin: 'loop',
      originId: 'review',
      originLabel: () => options.label,
      onEvent: options.onEvent
    })
  }
}
