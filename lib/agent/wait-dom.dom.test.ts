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
});
