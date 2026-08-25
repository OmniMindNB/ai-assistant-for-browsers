import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type BeforeToolCallResult,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { resolveProviderApi, type ProviderConfig } from '@/lib/settings';
import {
  sendMessage,
  type MessageResponse,
  type ProbeClickTargetPayload,
  type ProbeClickTargetResult,
  type SetAgentOverlayPayload,
} from '@/lib/messaging';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { beforeToolCallPermissionGate, CONFIRM_TOOL_NAMES } from './permissions';
import { createConfirmGateState, type ConfirmFn } from './confirm-gate';
import { createBrowserTools, type BrowserAgentTool } from './tools';
import { createAgentToolPolicy } from './tool-policy';
import { describeToolActivity } from './activity-description';
import {
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
  SYSTEM_PROMPT,
} from './system-prompt';

const MAX_CONTEXT_MESSAGES = 24;
const MAX_TOOL_RESULT_CHARS = 30000;
const IMPLEMENTATION_DOSSIER_TOOL = 'browser_inspect_page_implementation';
const MAX_POST_DOSSIER_FOLLOW_UPS = 4;
const POST_DOSSIER_ALLOWED_TOOLS = new Set([
  'browser_get_scripts',
  'browser_get_stylesheets',
  'browser_get_html',
  'browser_query_dom',
  'browser_get_computed_style',
]);
const POST_DOSSIER_BLOCKED_TOOLS = new Set(['browser_get_page_meta', 'browser_read_page']);

export interface BrowserAgentOptions {
  provider: ProviderConfig;
  /** 本回合固定的目标标签页 ID（ref: turn-tabid-pinning 设计文档）。 */
  tabId: number;
  systemPrompt?: string;
  tools?: BrowserAgentTool[];
  messages?: AgentMessage[];
  readToolCallBudget?: number;
  writeToolCallBudget?: number;
  onConfirm?: ConfirmFn;
  onAskUser?: (toolCallId: string, question: string, signal?: AbortSignal) => Promise<string>;
  /**
   * 写操作获批时通知外层打开执行期遮罩。回调而非直接 sendMessage：
   * 与 onConfirm / onAskUser 保持同一形状，也让这条路径在单测里可断言。
   */
  onOverlay?: (payload: SetAgentOverlayPayload) => void;
}

export interface BrowserAgentRuntimeOptions extends BrowserAgentOptions {
  steer: (message: AgentMessage) => void;
}

/**
 * browser_fill_form 走「句柄表批量查」；browser_click 只在带 fieldId 时走同一条路径
 * （复用 background 侧已有的 fieldIds → fieldLabels 查表逻辑），否则退回 selector/index。
 */
export function buildSubmitIntentProbePayload(toolName: string, args: unknown): ProbeClickTargetPayload {
  const record = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'browser_fill_form') {
    return {
      submitFieldId: (record.submit as { fieldId?: string } | undefined)?.fieldId,
      fieldIds: Array.isArray(record.fields)
        ? (record.fields as { fieldId?: string }[]).map((field) => String(field.fieldId ?? '')).filter(Boolean)
        : [],
    };
  }
  if (toolName === 'browser_click' && typeof record.fieldId === 'string' && record.fieldId) {
    return { submitFieldId: record.fieldId, fieldIds: [record.fieldId] };
  }
  return { selector: String(record.selector ?? ''), index: Number(record.index ?? 0) };
}

export function createBrowserAgentOptions(options: BrowserAgentRuntimeOptions): AgentOptions {
  const tools = options.tools ?? createBrowserTools(options.tabId, { onAskUser: options.onAskUser });
  const readToolCallBudget = options.readToolCallBudget ?? DEFAULT_READ_TOOL_CALL_BUDGET;
  const writeToolCallBudget = options.writeToolCallBudget ?? DEFAULT_WRITE_TOOL_CALL_BUDGET;
  const policy = createAgentToolPolicy({ readToolCallBudget, writeToolCallBudget });
  let implementationDossierCollected = false;
  let postDossierFollowUps = 0;
  const toolCallCounts = new Map<string, number>();
  const confirmGateState = createConfirmGateState();
  const recordPreExecutionBlock = (block: BeforeToolCallResult): BeforeToolCallResult => {
    policy.recordPreExecutionBlock();
    return block;
  };

  return {
    initialState: {
      systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
      model: createModel(options.provider),
      thinkingLevel: 'off',
      tools,
      messages: options.messages ?? [],
    },
    streamFn: selectStreamFn(options.provider),
    getApiKey: () => options.provider.apiKey,
    toolExecution: 'sequential',
    beforeToolCall: async (context, signal) => {
      if (signal?.aborted) return recordPreExecutionBlock({ block: true, reason: '操作已停止。' });
      if (implementationDossierCollected) {
        const toolName = context.toolCall.name;
        if (POST_DOSSIER_BLOCKED_TOOLS.has(toolName)) {
          return recordPreExecutionBlock({
            block: true,
            reason:
              '页面实现巡检已经包含 meta、正文、HTML、脚本和样式表。不要重复读取这些宽泛资料；请立即基于 browser_inspect_page_implementation 的结果回答。',
          });
        }
        if (POST_DOSSIER_ALLOWED_TOOLS.has(toolName)) {
          const priorCalls = toolCallCounts.get(toolName) ?? 0;
          if (postDossierFollowUps >= MAX_POST_DOSSIER_FOLLOW_UPS || priorCalls >= 1) {
            return recordPreExecutionBlock({
              block: true,
              reason:
                '页面实现巡检后的定向补查额度已用完，或该工具已经补查过一次。请停止继续调用工具，基于已有证据给出最终回答。',
            });
          }
        }
      }

      const isConfirmTool = CONFIRM_TOOL_NAMES.has(context.toolCall.name);
      const policyBlock = policy.preflight(context.toolCall.name, context.args, isConfirmTool);
      if (policyBlock) return recordPreExecutionBlock(policyBlock);

      const permissionBlock = await beforeToolCallPermissionGate(context, {
        gateState: confirmGateState,
        onConfirm: options.onConfirm,
        signal,
        resolveSubmitIntent: async (toolName, args) => {
          const payload = buildSubmitIntentProbePayload(toolName, args);
          // 探测失败时不阻断，退回普通 confirm 档位——探测只用于「升级」确认强度，
          // 它自己出错（包括消息通道本身没有响应、抛异常）不应该把一次正常的写操作也卡死。
          try {
            const response = (await sendMessage<ProbeClickTargetPayload, ProbeClickTargetResult>(
              'PROBE_CLICK_TARGET',
              payload,
              options.tabId,
            )) as MessageResponse<ProbeClickTargetResult> | undefined;
            return response?.ok && response.data ? response.data : { isSubmit: false };
          } catch {
            return { isSubmit: false };
          }
        },
      });
      if (permissionBlock) return recordPreExecutionBlock(permissionBlock);

      const alwaysApproved = confirmGateState.alwaysApprovedCallIds.has(context.toolCall.id);
      if (isConfirmTool && (confirmGateState.decision === 'approved' || alwaysApproved)) {
        policy.approveWrite();
        const approvedPolicyBlock = policy.preflight(context.toolCall.name, context.args, isConfirmTool);
        if (approvedPolicyBlock) return recordPreExecutionBlock(approvedPolicyBlock);
        options.onOverlay?.({
          active: true,
          label: describeToolActivity(context.toolCall.name, context.toolCall.arguments, 'running'),
        });
        return undefined;
      }
      return undefined;
    },
    afterToolCall: async (context) => {
      const toolName = context.toolCall.name;
      policy.recordExecution(toolName, context.args, context.isError);
      toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);
      if (toolName === IMPLEMENTATION_DOSSIER_TOOL && !context.isError) {
        implementationDossierCollected = true;
        options.steer({
          role: 'user',
          content:
            '页面实现巡检已经完成。请优先基于 evidenceSummary 和已有工具结果给出详细、证据驱动的回答；如果仍缺少具体引用证据，最多对 scripts/stylesheets/html/query_dom/computed_style 各补查一次，总补查不超过 4 次，然后必须回答。请点名引用脚本、样式、DOM class、computed style 中的关键线索。',
          timestamp: Date.now(),
        });
      } else if (implementationDossierCollected) {
        postDossierFollowUps += 1;
      }

      // 预算软提醒：修复前模型是被硬阻断的，事先没有任何预警，只能在最后一轮被动收尾。
      const budgetWarning = policy.budgetWarning();
      if (budgetWarning) {
        options.steer({ role: 'user', content: budgetWarning, timestamp: Date.now() });
      }
      return undefined;
    },
    prepareNextTurnWithContext: async (context) => {
      const budgetExhausted = policy.exhausted;
      if (!policy.prepareFinalResponse()) return undefined;
      const finalInstruction: AgentMessage = {
        role: 'user',
        content: budgetExhausted
          ? '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。'
          : '工具调用连续被阻止，工具调用阶段已经结束。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。',
        timestamp: Date.now(),
      };
      return {
        context: {
          ...context.context,
          messages: [...context.context.messages, finalInstruction],
          tools: [],
        },
      };
    },
    shouldStopAfterTurn: async () => policy.shouldStopAfterTurn(),
    transformContext: async (messages) => compactAgentMessages(messages),
    convertToLlm: (messages) => messages.filter(isLlmMessage),
  };
}

export function createBrowserAgent(options: BrowserAgentOptions): Agent {
  let agent: Agent;
  const agentOptions = createBrowserAgentOptions({
    ...options,
    steer: (message) => agent.steer(message),
  });
  agent = new Agent(agentOptions);
  return agent;
}

export function createModel(provider: ProviderConfig): Model<Api> {
  return {
    id: provider.model,
    name: provider.model,
    api: resolveProviderApi(provider),
    provider: provider.id || provider.name,
    baseUrl: provider.baseURL,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    // Reasoning models (e.g. Anthropic-compatible providers that emit a `thinking` block before
    // any text/tool_use) spend part of this budget on hidden reasoning tokens before answering —
    // too low a ceiling here means the whole response can be consumed by thinking with nothing
    // left to say anything, cutting off with stop_reason "max_tokens" and empty visible content.
    maxTokens: 16000,
  };
}

export function selectStreamFn(provider: ProviderConfig): StreamFn {
  return resolveProviderApi(provider) === 'anthropic-messages' ? browserAnthropicStream : browserOpenAIStream;
}

function isLlmMessage(message: AgentMessage): message is Message {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult';
}

function compactAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  const kept = messages.slice(-MAX_CONTEXT_MESSAGES);
  return kept.map((message) => {
    if (message.role !== 'toolResult') return message;

    const compactedContent = message.content.map((part) => {
      if (part.type !== 'text' || part.text.length <= MAX_TOOL_RESULT_CHARS) return part;
      return {
        ...part,
        text:
          part.text.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n\n[工具结果已截断：原始长度 ${part.text.length} 字符，仅保留前 ${MAX_TOOL_RESULT_CHARS} 字符。]`,
      };
    });

    return { ...message, content: compactedContent };
  });
}
