import { describe, expect, it } from 'vitest';
import { decideTabAccess } from './tab-access';

const readTab = { id: 7, url: 'https://docs.example.com', access: 'read' as const };
const fullTab = { id: 2, url: 'https://a.example.com' };

describe('decideTabAccess', () => {
  it('allows read-only tools on a referenced tab', () => {
    expect(decideTabAccess('browser_read_page', readTab)).toEqual({ allowed: true });
    expect(decideTabAccess('browser_get_form', readTab)).toEqual({ allowed: true });
  });

  it('blocks write tools on a referenced tab and tells the model what to do instead', () => {
    const decision = decideTabAccess('browser_click', readTab);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain('browser_open_tab');
    expect(decision.reason).toContain('7');
  });

  it('blocks closing a referenced tab', () => {
    // browser_close_tab 已在 WRITE_TOOL_NAMES 中、被上一条规则覆盖；单列一条用例锁住它，
    // 是因为它的后果不可逆（关掉的是用户自己的页），日后若有人把它挪出写工具表要立刻红。
    expect(decideTabAccess('browser_close_tab', readTab).allowed).toBe(false);
  });

  it('allows write tools on tabs the agent opened itself', () => {
    expect(decideTabAccess('browser_click', fullTab)).toEqual({ allowed: true });
  });

  it('blocks write tools when the target cannot be resolved', () => {
    expect(decideTabAccess('browser_click', undefined).allowed).toBe(false);
  });

  it('allows read tools even when the target cannot be resolved', () => {
    expect(decideTabAccess('browser_read_page', undefined)).toEqual({ allowed: true });
  });
});
