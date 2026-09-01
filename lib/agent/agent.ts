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
  type GetTabUrlResult,
  type MessageResponse,
  type ProbeClickTargetPayload,
  type ProbeClickTargetResult,
  type SetAgentOverlayPayload,
} from '@/lib/messaging';
import { browserOpenAIStream } from './openai-stream';
import { browserAnthropicStream } from './anthropic-stream';
import { beforeToolCallPermissionGate, READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from './permissions';
import { REPORT_TASK_OUTCOME_TOOL_NAME, type TaskOutcome } from './task-outcome';
import { createConfirmGateState, type ConfirmFn } from './confirm-gate';
import { createBrowserTools, type BrowserAgentTool } from './tools';
import { createTabSession, type TabSessionController } from './tab-session';
import { createAgentToolPolicy } from './tool-policy';
import { describeToolActivity } from './activity-description';
import {
  DEFAULT_READ_TOOL_CALL_BUDGET,
  DEFAULT_WRITE_TOOL_CALL_BUDGET,
  SYSTEM_PROMPT,
} from './system-prompt';

const MAX_CONTEXT_MESSAGES = 24;
const MAX_TOOL_RESULT_CHARS = 30000;
/**
 * browser_navigate/browser_open_tab 自己的结果文案已经告诉模型跳到哪了；这里只补这三个
 * 工具可能*隐式*触发的导航（链接点击、表单提交、回车提交），此前对模型完全不可见
 * （ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.2）。
 */
const NAVIGATION_WATCH_TOOLS = new Set(['browser_click', 'browser_fill_form', 'browser_type']);
const POST_NAVIGATION_SETTLE_MS = 500;
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
  /** 本回合固定的面板绑定标签页 ID（ref: turn-tabid-pinning 设计文档）。 */
  tabId: number;
  /**
   * 多标签页会话状态；省略时退化为"只有面板自己这一个 tab"的单 tab session，
   * 行为与未接入多标签页编排前完全一致（ref: 2026-08-26-multi-tab-orchestration-design.md）。
   */
  session?: TabSessionController;
  systemPrompt?: string;
  tools?: BrowserAgentTool[];
  messages?: AgentMessage[];
  readToolCallBudget?: number;
  writeToolCallBudget?: number;
  onConfirm?: ConfirmFn;
  onAskUser?: (toolCallId: string, question: string, signal?: AbortSignal) => Promise<string>;
  /** report_task_outcome 工具被调用时转发给外层，用于把成败信号落到对应的 assistant 消息上。 */
  onTaskOutcome?: (outcome: TaskOutcome) => void;
  /**
   * 写操作获批、或当前操作目标切换时通知外层同步执行期遮罩。第二个参数是这次遮罩状态
   * 要作用的 tabId——遮罩必须跟随当前实际被操作的 tab，不再总是面板自己绑定的那个
   * （ref: 设计文档 §3.4）。
   */
  onOverlay?: (payload: SetAgentOverlayPayload, targetTabId: number) => void;
  /** 标签页追踪状态发生变化（open/switch/close 成功执行）时通知外层立即持久化，
   * 不要只等到回合结束才存——面板文档可能在回合结束前就被销毁，或者这次回合被
   * 新一轮请求取代，两种情况都不会走到 store.ts 的 finally 里那次保存
   * （ref: 最终审查 Important #4）。 */
  onSessionChange?: (session: TabSessionController) => void;
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
  const session = options.session ?? createTabSession(options.tabId);
  const tools = options.tools ?? createBrowserTools(session, { onAskUser: options.onAskUser, onTaskOutcome: options.onTaskOutcome });
  const reportTaskOutcomeTool = tools.find((tool) => tool.name === REPORT_TASK_OUTCOME_TOOL_NAME);
  const readToolCallBudget = options.readToolCallBudget ?? DEFAULT_READ_TOOL_CALL_BUDGET;
  const writeToolCallBudget = options.writeToolCallBudget ?? DEFAULT_WRITE_TOOL_CALL_BUDGET;
  const policy = createAgentToolPolicy({ readToolCallBudget, writeToolCallBudget });
  let implementationDossierCollected = false;
  let postDossierFollowUps = 0;
  let writeToolRanThisRun = false;
  let outcomeReported = false;
  let outcomeForceAttempted = false;
  const toolCallCounts = new Map<string, number>();
  const confirmGateState = createConfirmGateState();
  let overlayTabId = options.tabId;
  // tabId -> 最后一次已知的 URL，用于识别 browser_click/fill_form/type 隐式触发的导航。
  const lastKnownUrl = new Map<number, string>();
  const TAB_SESSION_MUTATING_TOOLS = new Set(['browser_open_tab', 'browser_switch_tab', 'browser_close_tab']);
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

      const isWriteTool = WRITE_TOOL_NAMES.has(context.toolCall.name);
      // report_task_outcome 完全豁免预算记账：它既不占预算，也绝不能被预算上限拦下——
      // 预算耗尽的那一轮恰恰是最需要 failure 徽标的一轮（ref: 最终审查 Important）。
      if (context.toolCall.name !== REPORT_TASK_OUTCOME_TOOL_NAME) {
        const policyBlock = policy.preflight(context.toolCall.name, context.args, isWriteTool);
        if (policyBlock) return recordPreExecutionBlock(policyBlock);
      }

      const permissionBlock = await beforeToolCallPermissionGate(context, {
        gateState: confirmGateState,
        onConfirm: options.onConfirm,
        targetTabId: session.currentTabId,
        signal,
        resolveSubmitIntent: async (toolName, args) => {
          const payload = buildSubmitIntentProbePayload(toolName, args);
          // 只有结构探测明确识别出的提交才确认；无响应或异常不属于“已检测到提交”，
          // 按普通已知操作自动执行。
          try {
            const response = (await sendMessage<ProbeClickTargetPayload, ProbeClickTargetResult>(
              'PROBE_CLICK_TARGET',
              payload,
              session.currentTabId,
            )) as MessageResponse<ProbeClickTargetResult> | undefined;
            return response?.ok && response.data ? response.data : { isSubmit: false };
          } catch {
            return { isSubmit: false };
          }
        },
      });
      if (permissionBlock) return recordPreExecutionBlock(permissionBlock);

      if (isWriteTool) {
        policy.approveWrite();
        const approvedPolicyBlock = policy.preflight(context.toolCall.name, context.args, isWriteTool);
        if (approvedPolicyBlock) return recordPreExecutionBlock(approvedPolicyBlock);
        options.onOverlay?.(
          { active: true, label: describeToolActivity(context.toolCall.name, context.toolCall.arguments, 'running') },
          session.currentTabId,
        );
        overlayTabId = session.currentTabId;
        return undefined;
      }
      return undefined;
    },
    afterToolCall: async (context) => {
      const toolName = context.toolCall.name;
      // 与 beforeToolCall 的豁免对称：调用 report_task_outcome 不消耗任何预算额度。
      if (toolName !== REPORT_TASK_OUTCOME_TOOL_NAME) {
        policy.recordExecution(toolName, context.args, context.isError);
      }
      toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1);

      if (!context.isError && WRITE_TOOL_NAMES.has(toolName)) writeToolRanThisRun = true;
      if (!context.isError && toolName === REPORT_TASK_OUTCOME_TOOL_NAME) outcomeReported = true;

      if (!context.isError) {
        if (toolName === 'browser_navigate' || toolName === 'browser_open_tab') {
          const url = (context.result.details as { url?: string } | undefined)?.url;
          if (url) lastKnownUrl.set(session.currentTabId, url);
        } else if (NAVIGATION_WATCH_TOOLS.has(toolName)) {
          const newUrl = await fetchTabUrl(session.currentTabId);
          if (newUrl) {
            const previousUrl = lastKnownUrl.get(session.currentTabId);
            if (previousUrl !== undefined && previousUrl !== newUrl) {
              options.steer({
                role: 'user',
                content: `[系统观察] 页面地址已变化：从 "${previousUrl}" 跳转到 "${newUrl}"。页面可能仍在加载，原有的元素/表单状态可能已经失效，请视情况重新获取页面信息。`,
                timestamp: Date.now(),
              });
              await sleep(POST_NAVIGATION_SETTLE_MS);
            }
            lastKnownUrl.set(session.currentTabId, newUrl);
          }
        }
      }

      // 切换/开新/关闭标签页导致当前操作目标变化时，遮罩要跟过去：
      // 先关旧目标（如果它还是遮罩最后一次开在的那个 tab），再开新目标。
      if (!context.isError && TAB_SESSION_MUTATING_TOOLS.has(toolName) && session.currentTabId !== overlayTabId) {
        const previousTabId = overlayTabId;
        overlayTabId = session.currentTabId;
        options.onOverlay?.({ active: false }, previousTabId);
        options.onOverlay?.(
          { active: true, label: describeToolActivity(toolName, context.toolCall.arguments, 'running') },
          overlayTabId,
        );
      }

      // 标签页追踪状态本身发生了变化（不只是 currentTabId——关掉一个非当前的 tracked tab
      // 也算），立即通知外层持久化，不要等回合结束（ref: 最终审查 Important #4）。
      if (!context.isError && TAB_SESSION_MUTATING_TOOLS.has(toolName)) {
        options.onSessionChange?.(session);
      }

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
      if (policy.prepareFinalResponse()) {
        // 这是预算耗尽/连续被阻断的运行唯一一次收尾轮。如果写工具跑过却还没汇报结果，
        // 必须在这一轮把 report_task_outcome 递回去——否则最需要 failure 徽标的运行
        // 反而永远拿不到徽标（ref: 最终审查 Important）。判断条件与下面 else if 分支
        // 完全一致，只是不看 hasToolCalls：这一轮本来就是在通知模型停止调用工具。
        const outcomeStillOwed = Boolean(
          writeToolRanThisRun && !outcomeReported && !outcomeForceAttempted && reportTaskOutcomeTool,
        );
        // 与 else if 分支共用同一个标志位，保证每次 agent.prompt() 最多补调一次。
        if (outcomeStillOwed) outcomeForceAttempted = true;
        const baseInstruction = budgetExhausted
          ? '工具调用预算已经用完。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。'
          : '工具调用连续被阻止，工具调用阶段已经结束。不要再调用任何工具，请立即基于已有结果给出最终回答，并明确说明仍不确定的部分。';
        const finalInstruction: AgentMessage = {
          role: 'user',
          content: outcomeStillOwed
            ? `${baseInstruction}唯一的例外是 report_task_outcome：它不占用工具预算，仍然必须调用它，说明这次操作是 success/partial/failure，并给出一句话原因。`
            : baseInstruction,
          timestamp: Date.now(),
        };
        return {
          context: {
            ...context.context,
            messages: [...context.context.messages, finalInstruction],
            tools: outcomeStillOwed && reportTaskOutcomeTool ? [reportTaskOutcomeTool] : [],
          },
        };
      }

      // 写工具跑过、这轮消息没有（新的）工具调用（模型认为自己已经收尾）、还没汇报过、
      // 还没强制补调过一次、且 report_task_outcome 确实在可用工具里——五个条件同时成立才补一轮。
      const hasToolCalls = context.message?.content?.some((part) => part.type === 'toolCall') ?? false;
      if (writeToolRanThisRun && !outcomeReported && !outcomeForceAttempted && !hasToolCalls && reportTaskOutcomeTool) {
        outcomeForceAttempted = true; // 保证最多补调一次，绝不循环
        options.steer({
          role: 'user',
          content:
            '任务已结束但还没有汇报结果。请立即调用 report_task_outcome，说明这次操作是 success/partial/failure，并给出一句话原因，然后停止。',
          timestamp: Date.now(),
        });
        return { context: { ...context.context, tools: [reportTaskOutcomeTool] } };
      }
      return undefined;
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

/**
 * 内部专用 GET_TAB_URL 查询；无响应/异常一律视为"查不到"，不阻塞、不误报导航
 * （与 beforeToolCall 里 resolveSubmitIntent 的失败即降级处理保持一致）。
 */
async function fetchTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const response = (await sendMessage<undefined, GetTabUrlResult>('GET_TAB_URL', undefined, tabId)) as
      | MessageResponse<GetTabUrlResult>
      | undefined;
    return response?.ok ? response.data?.url : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只读工具（browser_read_page/get_html/get_form/query_dom/...）的结果才是真正的"浏览器
 * 状态快照"，又大又会过期；写/交互工具的结果本来就是 action-result-text.ts 生成的一句话，
 * 不需要压缩。只让最新一份只读结果保留完整内容，更早的一律压成 describeToolActivity 的
 * 摘要——否则旧 DOM dump 会一直占着上下文，模型还可能照着过期快照继续操作
 * （ref: docs/superpowers/specs/2026-08-31-page-agent-benchmark.md §3.1）。
 */
function compactAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  const kept = windowWithIntactToolCalls(messages, MAX_CONTEXT_MESSAGES);
  const toolCallArgs = collectToolCallArguments(kept);

  let lastReadResultIndex = -1;
  kept.forEach((message, index) => {
    if (message.role === 'toolResult' && READ_ONLY_TOOL_NAMES.has(message.toolName)) lastReadResultIndex = index;
  });

  return kept.map((message, index) => {
    if (message.role !== 'toolResult' || !READ_ONLY_TOOL_NAMES.has(message.toolName)) return message;

    if (index !== lastReadResultIndex) {
      const summary = describeToolActivity(
        message.toolName,
        toolCallArgs.get(message.toolCallId),
        message.isError ? 'failed' : 'done',
      );
      return { ...message, content: [{ type: 'text', text: summary }] };
    }

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

/**
 * 按条数盲切（slice(-size)）会把「带 tool_calls 的 assistant」和它的 toolResult 切散。
 * 窗口一旦以无主的 tool 消息开头，OpenAI 兼容协议一律判 400——实测 DeepSeek 回的是
 * "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"，
 * 整轮运行当场失败，用户等了一分多钟却拿不到任何回答。
 *
 * 严格 assistant/toolResult 交替时切点永远落在 assistant 上，所以这个坑长期没暴露；
 * 是 afterToolCall 里的 steer（[系统观察] 导航通知、预算软提醒）插入单条 user 消息
 * 打破了奇偶，才让切点有机会落到 toolResult 上。
 *
 * 修法：切点先回退到宣告这批结果的那条 assistant；回退不到（历史本身残缺）则把仍然
 * 无主的结果丢掉，宁可少一条上下文也不能发出必然被拒的请求。
 */
function windowWithIntactToolCalls(messages: AgentMessage[], size: number): AgentMessage[] {
  if (messages.length <= size) return messages;

  let start = messages.length - size;
  while (start > 0 && messages[start].role === 'toolResult') start -= 1;

  const announced = new Set<string>();
  return messages.slice(start).filter((message) => {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'toolCall') announced.add(part.id);
      }
      return true;
    }
    if (message.role === 'toolResult') return announced.has(message.toolCallId);
    return true;
  });
}

function collectToolCallArguments(messages: AgentMessage[]): Map<string, unknown> {
  const args = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'toolCall') args.set(part.id, part.arguments);
    }
  }
  return args;
}
