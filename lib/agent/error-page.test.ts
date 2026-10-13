import { describe, expect, it } from 'vitest';
import { createErrorPageGuard, describeNavigateErrorPage, describeOpenTabErrorPage, isErrorPageError, normalizeTabError, TAB_SHOWS_ERROR_PAGE_ERROR } from './error-page';

describe('normalizeTabError', () => {
  it('replaces Chrome\'s raw error-page failure with an actionable explanation', () => {
    const raw = new Error('Frame with ID 0 is showing error page');
    expect(isErrorPageError(raw)).toBe(true);
    expect((normalizeTabError(raw) as Error).message).toBe(TAB_SHOWS_ERROR_PAGE_ERROR);
  });

  // 读页面走 sendToContentScript，注入失败时被包成"内容脚本未就绪……可能是 chrome:// 受限页"，
  // 模型会以为是受限页面而不是地址打不开。
  it('also catches the error-page failure wrapped by the content-script injection fallback', () => {
    const wrapped = new Error('内容脚本未就绪且无法注入（可能是受限页面，如 chrome:// 或应用商店页）：Frame with ID 0 is showing error page');
    expect((normalizeTabError(wrapped) as Error).message).toBe(TAB_SHOWS_ERROR_PAGE_ERROR);
  });

  it('leaves unrelated errors untouched', () => {
    const other = new Error('Cannot access a chrome:// URL');
    expect(normalizeTabError(other)).toBe(other);
  });
});

describe('createErrorPageGuard', () => {
  it('marks the tab on a navigate that landed on an error page, not on open_tab failures', () => {
    const guard = createErrorPageGuard();
    // open_tab 失败时新标签页已关掉，当前目标没变：target-independent，不记。
    guard.record(1, true, true, describeOpenTabErrorPage('https://a.test', 'http://a.test:1/'));
    expect(guard.preflight('browser_read_page', 1, false)).toBeUndefined();

    guard.record(1, false, true, describeNavigateErrorPage('https://a.test', 'https://a.test/'));
    expect(guard.preflight('browser_read_page', 1, false)).toContain('标签页 1');
    expect(guard.preflight('browser_go_back', 1, false)).toBeUndefined();
  });

  it('ignores ordinary failures', () => {
    const guard = createErrorPageGuard();
    guard.record(1, false, true, '未找到元素 #ok');
    expect(guard.preflight('browser_click', 1, false)).toBeUndefined();
  });
});
