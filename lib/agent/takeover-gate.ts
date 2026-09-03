import type { BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { raceWithAbort } from './confirm-gate';

/**
 * 用户接管网关。
 *
 * 我们是侧边栏形态，遮罩全程 pointer-events:none，用户随时接管是正常预期
 * （见 lib/agent/agent-overlay.ts 的硬约束）。但"不阻断"不等于"当没发生"：
 * 在此之前，用户在 agent 打字时点了页面，agent 毫无察觉继续写，两边打架，
 * 事后对话里也没有任何痕迹。
 *
 * 这个网关只做一件事：agent 下一次要写之前，如果这个 tab 上发生过尚未处理的接管，
 * 就停下来问一次"继续还是结束"。它不拦读操作——读不会和用户抢，停下来只会拖慢。
 *
 * ⚠️ 与提交确认门（confirm-gate.ts）是两回事：那个是**事前**授权（这次提交要不要放行），
 * 这个是**事中**冲突检测（人已经插手了，还要不要接着做）。用户此前明确决定过写操作
 * 不需要逐次确认，本网关不改变那个决定——它只在人真的动手之后才出现。
 */
export type TakeoverPromptFn = (
  toolCallId: string,
  toolName: string,
  args: unknown,
  tabId: number,
) => Promise<boolean>;

export interface TakeoverGateState {
  /** tabId -> 已经就"那一刻的接管"问过用户并获准继续。再次接管会写入更大的时间戳。 */
  acknowledged: Map<number, number>;
}

export function createTakeoverGateState(): TakeoverGateState {
  return { acknowledged: new Map() };
}

/**
 * @param takeoverAt 该 tab 最近一次接管的时间戳；没有接管过时传 undefined。
 * @returns 需要拦下这次工具调用时返回 block，否则 undefined。
 */
export async function resolveTakeoverGate(
  state: TakeoverGateState,
  toolCallId: string,
  toolName: string,
  args: unknown,
  tabId: number,
  takeoverAt: number | undefined,
  onTakeover: TakeoverPromptFn | undefined,
  signal?: AbortSignal,
): Promise<BeforeToolCallResult | undefined> {
  if (takeoverAt === undefined) return undefined;

  // 已经就这一次（或更晚的一次）接管问过了，不重复打断。
  const acknowledged = state.acknowledged.get(tabId);
  if (acknowledged !== undefined && acknowledged >= takeoverAt) return undefined;

  // 没有接入 UI 时倾向于放行而不是拦死：接管提示是"避免和用户抢"的体贴，
  // 不是安全边界（安全边界在 permissions.ts）。拦死会让没有 UI 的调用方彻底无法写入。
  if (!onTakeover) {
    state.acknowledged.set(tabId, takeoverAt);
    return undefined;
  }

  const shouldContinue = await raceWithAbort(onTakeover(toolCallId, toolName, args, tabId), signal);
  // 无论继续还是结束都记账：用户选了"结束"之后如果模型仍在尝试写，
  // 不该把同一个问题反复弹给用户——下面的 block 会把这一轮引导到收尾。
  state.acknowledged.set(tabId, takeoverAt);
  if (!shouldContinue) {
    return {
      block: true,
      reason:
        '用户在你操作期间自己接管了页面，并选择不再继续本次自动操作。请立即停止调用任何写操作工具，向用户说明已完成到哪一步、还剩什么没做。',
    };
  }
  return undefined;
}
