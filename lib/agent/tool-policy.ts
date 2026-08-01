export interface AgentToolPolicyOptions {
  readToolCallBudget: number;
  writeToolCallBudget: number;
}

export interface ToolPreflightBlock {
  block: true;
  reason: string;
}

export interface AgentToolPolicy {
  readonly completedToolCalls: number;
  readonly currentBudget: number;
  readonly exhausted: boolean;
  preflight(toolName: string, args: unknown, isConfirmTool: boolean): ToolPreflightBlock | undefined;
  approveWrite(): void;
  recordExecution(toolName: string, args: unknown, isError: boolean): void;
  prepareFinalResponse(): boolean;
  shouldStopAfterTurn(): boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function toolSignature(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(canonicalize(args))}`;
}

export function createAgentToolPolicy(options: AgentToolPolicyOptions): AgentToolPolicy {
  const writeToolCallBudget = Math.max(options.readToolCallBudget, options.writeToolCallBudget);
  let completedToolCalls = 0;
  let writeApproved = false;
  let consecutiveFailure: { signature: string; count: number } | undefined;
  let phase: 'active' | 'final_response_prepared' | 'final_response_running' = 'active';

  return {
    get completedToolCalls() {
      return completedToolCalls;
    },
    get currentBudget() {
      return writeApproved ? writeToolCallBudget : options.readToolCallBudget;
    },
    get exhausted() {
      return completedToolCalls >= this.currentBudget;
    },
    preflight(toolName, args, isConfirmTool) {
      const signature = toolSignature(toolName, args);
      if (consecutiveFailure?.signature === signature && consecutiveFailure.count >= 2) {
        return { block: true, reason: '相同工具调用连续失败两次，已停止重复尝试。' };
      }
      if (completedToolCalls >= this.currentBudget && !(isConfirmTool && !writeApproved)) {
        return { block: true, reason: `工具调用次数已达到预算上限 ${this.currentBudget}。` };
      }
      return undefined;
    },
    approveWrite() {
      writeApproved = true;
    },
    recordExecution(toolName, args, isError) {
      completedToolCalls += 1;
      if (!isError) {
        consecutiveFailure = undefined;
        return;
      }

      const signature = toolSignature(toolName, args);
      if (consecutiveFailure?.signature === signature) {
        consecutiveFailure.count += 1;
      } else {
        consecutiveFailure = { signature, count: 1 };
      }
    },
    prepareFinalResponse() {
      if (phase !== 'active' || !this.exhausted) return false;
      phase = 'final_response_prepared';
      return true;
    },
    shouldStopAfterTurn() {
      if (phase === 'final_response_prepared') {
        phase = 'final_response_running';
        return false;
      }
      return phase === 'final_response_running';
    },
  };
}
