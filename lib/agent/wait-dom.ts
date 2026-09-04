// 注入页面执行的等待观察函数。
//
// ⚠️ 与 form-dom.ts 同一约束：这个函数会被 browser.scripting.executeScript
// 序列化后送进页面执行，函数体内不得引用任何模块作用域的绑定（本文件的其它
// 函数、常量、import 的值），否则在页面里一律是 undefined。所有配置通过
// input 参数传入。类型导入（import type）会被编译期擦除，不受此限制。
import type { WaitConditionKind } from './wait-condition';

export interface WaitForInput {
  kind: WaitConditionKind;
  selector?: string;
  text?: string;
  idleMs: number;
  timeoutMs: number;
}

export interface WaitForOutput {
  met: boolean;
  elapsedMs: number;
  matched?: number;
  error?: string;
}

export async function waitForConditionInPage(input: WaitForInput): Promise<WaitForOutput> {
  const startedAt = Date.now();
  // MutationObserver 只在有变动时唤醒；轮询是兜底——有些命中条件（例如
  // domIdle 的"够久没动"）本质上不由变动触发，而是由"没有变动"触发。
  const POLL_MS = 50;
  let lastMutationAt = Date.now();

  const check = (): { met: boolean; matched?: number; error?: string } => {
    try {
      if (input.kind === 'appear' || input.kind === 'disappear') {
        const matched = document.querySelectorAll(input.selector as string).length;
        return { met: input.kind === 'appear' ? matched > 0 : matched === 0, matched };
      }
      if (input.kind === 'textContains') {
        const scope = input.selector ? document.querySelector(input.selector) : document.body;
        if (!scope) return { met: false };
        // innerText 在注入的真实页面里更贴近"用户看得见的文本"；jsdom 没有实现
        // 它，会落到 textContent。两者对"文本是否出现"这个判断都够用。
        const text = (scope as HTMLElement).innerText ?? scope.textContent ?? '';
        return { met: text.includes(input.text as string) };
      }
      return { met: Date.now() - lastMutationAt >= input.idleMs };
    } catch (error) {
      return { met: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const immediate = check();
  if (immediate.error) return { met: false, elapsedMs: Date.now() - startedAt, error: immediate.error };
  // domIdle 不走快速路径：刚进来时 lastMutationAt 就是此刻，必然还没静止够久。
  if (immediate.met && input.kind !== 'domIdle') {
    return { met: true, elapsedMs: Date.now() - startedAt, matched: immediate.matched };
  }

  return new Promise<WaitForOutput>((resolve) => {
    let settled = false;
    // 只有 domIdle 才需要"最近一次变动发生在何时"；appear/disappear/textContains
    // 全靠下面的轮询判定，装个 observer 只是让它白白订阅整份文档的变动通知
    // （subtree+attributes+characterData，可能在真实页面上被频繁触发），却没人读它。
    const observer =
      input.kind === 'domIdle'
        ? new MutationObserver(() => {
            lastMutationAt = Date.now();
          })
        : undefined;
    observer?.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });

    const finish = (output: WaitForOutput) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve(output);
    };

    const poll = setInterval(() => {
      const current = check();
      if (current.error) {
        finish({ met: false, elapsedMs: Date.now() - startedAt, error: current.error });
        return;
      }
      if (current.met) {
        finish({ met: true, elapsedMs: Date.now() - startedAt, matched: current.matched });
      }
    }, POLL_MS);

    const timer = setTimeout(() => {
      finish({ met: false, elapsedMs: Date.now() - startedAt });
    }, input.timeoutMs);
  });
}
