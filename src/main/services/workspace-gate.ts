/**
 * Admission control for workspace transitions. A transition begins the gate
 * before its first await and ends it in a finally; services reject new work
 * while a transition is busy and any token captured earlier is stale.
 */
export class WorkspaceGate {
  private epoch = 0
  private transitions = 0

  get blocked(): boolean {
    return this.transitions > 0
  }

  current(): number {
    return this.epoch
  }

  begin(): number {
    this.epoch += 1
    this.transitions += 1
    return this.epoch
  }

  end(): void {
    if (this.transitions > 0) this.transitions -= 1
  }

  assertOpen(token?: number): void {
    if (this.transitions > 0 || (token !== undefined && token !== this.epoch)) {
      throw new Error('The workspace is changing. Try again.')
    }
  }
}
