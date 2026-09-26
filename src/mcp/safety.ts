/** Only an explicit accept action with a literal true value counts as approval. */
export function isExplicitLiveOrderApproval(action: string, approve: unknown): boolean {
  return action === "accept" && approve === true;
}

/** A one-use, per-order confirmation latch consumed by the MCP callback after client elicitation. */
export class LiveOrderApproval {
  private consumed = false;

  consume(approved: boolean): boolean {
    if (this.consumed || !approved) return false;
    this.consumed = true;
    return true;
  }
}
