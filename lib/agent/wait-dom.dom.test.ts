import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForConditionInPage } from './wait-dom';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('waitForConditionInPage', () => {
  it('条件一开始就满足时立即返回，不等待', async () => {
    document.body.innerHTML = '<div class="result">ok</div>';
    const output = await waitForConditionInPage({
      kind: 'appear', selector: '.result', idleMs: 500, timeoutMs: 5000,
    });
    expect(output.met).toBe(true);
    expect(output.matched).toBe(1);
  });

  it('元素稍后出现时命中 appear', async () => {
    const promise = waitForConditionInPage({
      kind: 'appear', selector: '.late', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => {
      const node = document.createElement('div');
      node.className = 'late';
      document.body.append(node);
    }, 30);
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.matched).toBe(1);
  });

  it('元素被移除时命中 disappear', async () => {
    document.body.innerHTML = '<div class="spinner"></div>';
    const promise = waitForConditionInPage({
      kind: 'disappear', selector: '.spinner', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => document.querySelector('.spinner')?.remove(), 30);
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.matched).toBe(0);
  });

  it('文本出现时命中 textContains', async () => {
    document.body.innerHTML = '<main></main>';
    const promise = waitForConditionInPage({
      kind: 'textContains', selector: 'main', text: '已完成', idleMs: 500, timeoutMs: 3000,
    });
    setTimeout(() => {
      document.querySelector('main')!.textContent = '任务已完成';
    }, 30);
    const output = await promise;
    expect(output.met).toBe(true);
  });

  it('textContains 不给 selector 时在整个 body 里找', async () => {
    document.body.innerHTML = '<section>结果已就绪</section>';
    const output = await waitForConditionInPage({
      kind: 'textContains', text: '已就绪', idleMs: 500, timeoutMs: 3000,
    });
    expect(output.met).toBe(true);
  });

  it('DOM 停止变动后命中 domIdle', async () => {
    const promise = waitForConditionInPage({ kind: 'domIdle', idleMs: 120, timeoutMs: 5000 });
    // 先制造几次变动，再停下来：命中时间必须晚于最后一次变动
    for (const delay of [20, 60, 100]) {
      setTimeout(() => document.body.append(document.createElement('span')), delay);
    }
    const output = await promise;
    expect(output.met).toBe(true);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(120);
  });

  it('条件始终不满足时超时返回 met:false，不抛异常', async () => {
    const output = await waitForConditionInPage({
      kind: 'appear', selector: '.never', idleMs: 500, timeoutMs: 200,
    });
    expect(output.met).toBe(false);
    expect(output.elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('非法选择器返回 error 而不是抛异常', async () => {
    const output = await waitForConditionInPage({
      kind: 'appear', selector: ':::bad', idleMs: 500, timeoutMs: 200,
    });
    expect(output.met).toBe(false);
    expect(output.error).toBeTruthy();
  });

  // appear/disappear/textContains 全靠 50ms 轮询判定，不读 MutationObserver 的
  // lastMutationAt；给它们装一个订阅整份文档变动的 observer 纯属白白开销
  // （尤其在真实页面上，subtree+attributes+characterData 可能被频繁触发）。
  describe('MutationObserver 只在 domIdle 时安装', () => {
    let created: number;
    let OriginalMutationObserver: typeof MutationObserver;

    beforeEach(() => {
      created = 0;
      OriginalMutationObserver = globalThis.MutationObserver;
      class SpyMutationObserver extends OriginalMutationObserver {
        constructor(...args: ConstructorParameters<typeof MutationObserver>) {
          super(...args);
          created += 1;
        }
      }
      globalThis.MutationObserver = SpyMutationObserver;
    });

    afterEach(() => {
      globalThis.MutationObserver = OriginalMutationObserver;
    });

    it('appear 等待期间不安装 MutationObserver', async () => {
      const promise = waitForConditionInPage({
        kind: 'appear', selector: '.late', idleMs: 500, timeoutMs: 3000,
      });
      setTimeout(() => {
        const node = document.createElement('div');
        node.className = 'late';
        document.body.append(node);
      }, 30);
      const output = await promise;
      expect(output.met).toBe(true);
      expect(created).toBe(0);
    });

    it('超时路径（非 domIdle）也不安装 MutationObserver', async () => {
      // .never 选择器一直不出现：必须真正进入轮询/Promise 分支直到超时，
      // 而不是走"一开始就满足"的快速路径，才能验证 observer 分支没被创建。
      const output = await waitForConditionInPage({
        kind: 'appear', selector: '.never', idleMs: 500, timeoutMs: 150,
      });
      expect(output.met).toBe(false);
      expect(created).toBe(0);
    });

    it('domIdle 等待仍会安装 MutationObserver，且行为不受影响', async () => {
      const promise = waitForConditionInPage({ kind: 'domIdle', idleMs: 120, timeoutMs: 3000 });
      setTimeout(() => document.body.append(document.createElement('span')), 20);
      const output = await promise;
      expect(output.met).toBe(true);
      expect(created).toBe(1);
    });
  });
});
