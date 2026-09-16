import { describe, expect, it } from 'vitest';
import { finishActivityStep, upsertActivityStep, type ActivityStep } from './activity-steps';

describe('upsertActivityStep', () => {
  it('appends a new step when the id is not already present', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = upsertActivityStep(steps, { id: 'b', description: 'B', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(steps).toEqual([{ id: 'a', description: 'A', status: 'running' }]);
  });

  it('replaces the step in place when the id already exists, preserving position', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = upsertActivityStep(steps, { id: 'a', description: 'A updated', status: 'running' });
    expect(next).toEqual([
      { id: 'a', description: 'A updated', status: 'running' },
      { id: 'b', description: 'B', status: 'running' },
    ]);
    expect(next).toHaveLength(2);
  });
});

// 同一个调用失败后模型往往原样再试一次。每次都是新的 toolCallId，所以过去会在列表里
// 堆出两三行几乎一样的红字，用户看到的是"它卡住了"，而不是"它在重试第 N 次"。
describe('upsertActivityStep 的重试合并', () => {
  const failed = (signature: string): ActivityStep => ({
    id: 'call-1', description: '点击 "#pay" 失败', status: 'failed', signature,
  });

  it('紧跟在同签名失败步骤后的新尝试占用同一行，并累加次数', () => {
    const next = upsertActivityStep(
      [failed('browser_click:{"selector":"#pay"}')],
      { id: 'call-2', description: '正在点击 "#pay"', status: 'running', signature: 'browser_click:{"selector":"#pay"}' },
    );

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'call-2', status: 'running', attempt: 2 });
  });

  it('第三次尝试继续累加而不是重置', () => {
    const signature = 'browser_click:{"selector":"#pay"}';
    const after2 = upsertActivityStep([failed(signature)], { id: 'call-2', description: '再试', status: 'running', signature });
    const failedAgain = upsertActivityStep(after2, { ...after2[0], status: 'failed' as const });
    const after3 = upsertActivityStep(failedAgain, { id: 'call-3', description: '又试', status: 'running', signature });

    expect(after3).toHaveLength(1);
    expect(after3[0].attempt).toBe(3);
  });

  it('签名不同时照常新起一行', () => {
    const next = upsertActivityStep(
      [failed('browser_click:{"selector":"#pay"}')],
      { id: 'call-2', description: '正在点击 "#cancel"', status: 'running', signature: 'browser_click:{"selector":"#cancel"}' },
    );
    expect(next).toHaveLength(2);
  });

  // 只合并"紧接着的重试"：上一步成功了就说明这是一次全新的操作，不是重试。
  it('上一步没有失败时不合并', () => {
    const signature = 'browser_click:{"selector":"#pay"}';
    const next = upsertActivityStep(
      [{ id: 'call-1', description: '已点击', status: 'done', signature }],
      { id: 'call-2', description: '再次点击', status: 'running', signature },
    );
    expect(next).toHaveLength(2);
  });

  it('没有签名的步骤（如接管痕迹）永远不参与合并', () => {
    const next = upsertActivityStep(
      [{ id: 'call-1', description: '失败', status: 'failed' }],
      { id: 'call-2', description: '你接管了页面', status: 'done' },
    );
    expect(next).toHaveLength(2);
  });

  it('按 id 原地替换时保留已累加的次数', () => {
    const signature = 'browser_click:{"selector":"#pay"}';
    const merged = upsertActivityStep([failed(signature)], { id: 'call-2', description: '再试', status: 'running', signature });
    const updated = upsertActivityStep(merged, { id: 'call-2', description: '再试（参数已更新）', status: 'running', signature });

    expect(updated[0].attempt).toBe(2);
  });
});

describe('finishActivityStep', () => {
  it('flips a running step to done, replacing its description', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running' }];
    const next = finishActivityStep(steps, 'a', 'done', 'Clicked X');
    expect(next).toEqual([{ id: 'a', description: 'Clicked X', status: 'done' }]);
  });

  it('flips a running step to failed', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'Clicking X', status: 'running' }];
    const next = finishActivityStep(steps, 'a', 'failed', 'Failed to click X');
    expect(next).toEqual([{ id: 'a', description: 'Failed to click X', status: 'failed' }]);
  });

  it('is a no-op (same array reference) when the id is not found', () => {
    const steps: ActivityStep[] = [{ id: 'a', description: 'A', status: 'running' }];
    const next = finishActivityStep(steps, 'missing', 'done', 'irrelevant');
    expect(next).toBe(steps);
  });

  it('does not mutate steps for entries other than the target id', () => {
    const steps: ActivityStep[] = [
      { id: 'a', description: 'A', status: 'done' },
      { id: 'b', description: 'B', status: 'running' },
    ];
    const next = finishActivityStep(steps, 'b', 'done', 'B done');
    expect(next[0]).toBe(steps[0]);
    expect(next[1]).toEqual({ id: 'b', description: 'B done', status: 'done' });
  });
});
