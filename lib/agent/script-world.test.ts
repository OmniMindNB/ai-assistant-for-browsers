import { describe, expect, it, vi } from 'vitest';
import { SCRIPT_WORLD_CSP, createScriptWorld } from './script-world';

describe('SCRIPT_WORLD_CSP', () => {
  it('blocks network APIs and everything else by default', () => {
    expect(SCRIPT_WORLD_CSP).toContain("default-src 'none'");
    expect(SCRIPT_WORLD_CSP).toContain("connect-src 'none'");
    expect(SCRIPT_WORLD_CSP).toContain("img-src 'none'");
    expect(SCRIPT_WORLD_CSP).toContain("form-action 'none'");
  });
});

describe('createScriptWorld', () => {
  it('configures the world once with the CSP and messaging disabled', async () => {
    const configureWorld = vi.fn().mockResolvedValue(undefined);
    const world = createScriptWorld({ configureWorld });
    expect(await world.ensure()).toBe(true);
    expect(await world.ensure()).toBe(true);
    expect(configureWorld).toHaveBeenCalledTimes(1);
    expect(configureWorld).toHaveBeenCalledWith({ csp: SCRIPT_WORLD_CSP, messaging: false });
  });

  it('reports unavailable when the API is missing and retries next time', async () => {
    // 开关打开前失败，打开后下一次调用要能成功，不需要重启扩展。
    const configureWorld = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'configureWorld')"))
      .mockResolvedValueOnce(undefined);
    const world = createScriptWorld({ configureWorld });
    expect(await world.ensure()).toBe(false);
    expect(await world.ensure()).toBe(true);
    expect(configureWorld).toHaveBeenCalledTimes(2);
  });

  it('treats a synchronous throw as unavailable', async () => {
    const world = createScriptWorld({ configureWorld: () => { throw new Error('userScripts disabled'); } });
    expect(await world.ensure()).toBe(false);
  });
});

describe('createScriptWorld.invalidate', () => {
  it('forces the next ensure to configure again', async () => {
    const configureWorld = vi.fn().mockResolvedValue(undefined);
    const world = createScriptWorld({ configureWorld });
    await world.ensure();
    world.invalidate();
    await world.ensure();
    expect(configureWorld).toHaveBeenCalledTimes(2);
  });
});
