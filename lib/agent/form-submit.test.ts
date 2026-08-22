import { describe, expect, it } from 'vitest';
import { decideSubmitIntent, type ClickTargetInfo } from './form-submit';

function target(overrides: Partial<ClickTargetInfo> = {}): ClickTargetInfo {
  return { tag: 'button', hasFormOwner: false, ...overrides };
}

describe('decideSubmitIntent', () => {
  it('treats a form-owned button with no explicit type as a submit', () => {
    expect(decideSubmitIntent(target({ hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('treats a form-owned button[type=submit] as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'submit', hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('treats input[type=submit] and input[type=image] as submits', () => {
    expect(decideSubmitIntent(target({ tag: 'input', type: 'submit', hasFormOwner: true })).isSubmit).toBe(true);
    expect(decideSubmitIntent(target({ tag: 'input', type: 'image', hasFormOwner: true })).isSubmit).toBe(true);
  });

  it('does not treat button[type=button] as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true })).isSubmit).toBe(false);
  });

  it('does not treat a button outside any form as a submit', () => {
    expect(decideSubmitIntent(target({ type: 'submit', hasFormOwner: false })).isSubmit).toBe(false);
  });

  it('does not treat links or divs as submits', () => {
    expect(decideSubmitIntent(target({ tag: 'a', hasFormOwner: true })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ tag: 'div', hasFormOwner: true })).isSubmit).toBe(false);
  });

  // 锁住 Spec-0005 的非目标：不做文案启发式。
  it('ignores button text entirely — no copy heuristics', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, textContent: '立即下单' })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, textContent: '支付' })).isSubmit).toBe(false);
    expect(decideSubmitIntent(target({ hasFormOwner: true, textContent: '取消' })).isSubmit).toBe(true);
  });

  it('carries the form action and field count through for the confirmation card', () => {
    const intent = decideSubmitIntent(
      target({ hasFormOwner: true, formAction: 'https://example.com/checkout', fieldCount: 12 }),
    );
    expect(intent).toEqual({ isSubmit: true, formAction: 'https://example.com/checkout', fieldCount: 12 });
  });

  it('reports no action or count when the target is not a submit', () => {
    expect(decideSubmitIntent(target({ type: 'button', hasFormOwner: true, formAction: 'https://x.test' })))
      .toEqual({ isSubmit: false });
  });
});
