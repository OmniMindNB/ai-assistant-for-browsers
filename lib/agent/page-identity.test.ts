import { describe, expect, it } from 'vitest';
import { isSamePage } from './page-identity';

const DETAIL = 'https://console.example.com/instance/detail?id=1';
const FIREWALL = 'https://console.example.com/instance/detail?id=1&tab=firewall';

describe('isSamePage', () => {
  it('地址相同即同一页面（旧版本存下的表没有 documentId，也照此判定）', () => {
    expect(isSamePage({ url: DETAIL }, { url: DETAIL, documentId: '100.5' })).toBe(true);
  });

  it('单页应用 pushState 改了地址、文档没换：仍是同一页面', () => {
    expect(isSamePage({ url: DETAIL, documentId: '100.5' }, { url: FIREWALL, documentId: '100.5' })).toBe(true);
  });

  it('地址和文档都变了：换了页面', () => {
    expect(isSamePage({ url: DETAIL, documentId: '100.5' }, { url: FIREWALL, documentId: '200.25' })).toBe(false);
  });

  it('任一侧缺 documentId 时只看地址', () => {
    expect(isSamePage({ url: DETAIL }, { url: FIREWALL, documentId: '100.5' })).toBe(false);
    expect(isSamePage({ url: DETAIL, documentId: '100.5' }, { url: FIREWALL })).toBe(false);
  });

  it('没有上一张表就不是同一页面', () => {
    expect(isSamePage(undefined, { url: DETAIL, documentId: '100.5' })).toBe(false);
  });
});
