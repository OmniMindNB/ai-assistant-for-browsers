import { describe, expect, it, vi } from 'vitest';
import { fetchPageResourceText, isPageResourceUrlAllowed } from './page-resource-fetch';

describe('isPageResourceUrlAllowed', () => {
  it.each([
    'file:///etc/passwd',
    'http://localhost/private',
    'http://127.0.0.1/private',
    'http://0.0.0.0/private',
    'http://10.0.0.1/private',
    'http://172.16.0.1/private',
    'http://192.168.1.1/private',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/private',
    'http://[::]/private',
    'http://[fe80::1]/private',
    'http://[fd00::1]/private',
    'http://[::ffff:127.0.0.1]/private',
    'http://[::ffff:192.168.1.1]/private',
  ])('rejects unsafe page resource URLs: %s', (url) => {
    expect(isPageResourceUrlAllowed(url)).toBe(false);
  });
});

describe('fetchPageResourceText', () => {
  it('fails closed when Chrome hides a manual redirect as opaqueredirect', async () => {
    const opaqueRedirect = Response.error();
    Object.defineProperty(opaqueRedirect, 'type', { value: 'opaqueredirect' });
    const request = vi.fn().mockResolvedValue(opaqueRedirect);

    await expect(fetchPageResourceText('https://example.com/start', 100, request)).resolves.toMatchObject({
      error: expect.stringContaining('无法安全验证重定向目标'),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('validates each manual redirect target and resolves a relative Location header', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/assets/app.js' } }))
      .mockResolvedValueOnce(new Response('const app = true;', { status: 200 }));

    await expect(fetchPageResourceText('https://example.com/start', 100, request)).resolves.toMatchObject({
      text: 'const app = true;',
      length: 17,
      truncated: false,
    });
    expect(request).toHaveBeenNthCalledWith(1, 'https://example.com/start', { redirect: 'manual' });
    expect(request).toHaveBeenNthCalledWith(2, 'https://example.com/assets/app.js', { redirect: 'manual' });
  });

  it('blocks a redirect to an unsafe IPv4-mapped IPv6 target before requesting it', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'http://[::ffff:127.0.0.1]/admin' } }),
    );

    await expect(fetchPageResourceText('https://example.com/start', 100, request)).resolves.toMatchObject({
      error: expect.stringContaining('重定向目标地址不允许访问'),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports missing redirect locations and a finite redirect limit', async () => {
    const missingLocation = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    await expect(fetchPageResourceText('https://example.com/start', 100, missingLocation)).resolves.toMatchObject({
      error: expect.stringContaining('缺少 Location'),
    });

    const loop = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: '/again' } }));
    await expect(fetchPageResourceText('https://example.com/start', 100, loop)).resolves.toMatchObject({
      error: expect.stringContaining('重定向次数过多'),
    });
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it('preserves successful truncation and ordinary HTTP errors', async () => {
    await expect(
      fetchPageResourceText('https://example.com/app.js', 3, vi.fn().mockResolvedValue(new Response('abcdef', { status: 200 }))),
    ).resolves.toEqual({ text: 'abc', length: 6, truncated: true });

    await expect(
      fetchPageResourceText('https://example.com/missing.js', 3, vi.fn().mockResolvedValue(new Response('missing', { status: 404, statusText: 'Not Found' }))),
    ).resolves.toEqual({ length: 0, truncated: false, error: '404 Not Found' });
  });
});
