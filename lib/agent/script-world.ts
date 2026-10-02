// browser_run_script 的运行环境（ref: docs/superpowers/specs/2026-10-02-run-script-design.md §3.3）。
//
// 这道 CSP 管的是脚本 world 自己发起的请求（fetch / XHR / WebSocket / sendBeacon）。脚本与页面
// 共享 DOM：往页面里插 <img>、改 location 走的是页面自己的 CSP，这里拦不住——见设计稿 §6。
// 不做静态危险 API 扫描：window['fe' + 'tch'] 一类写法就能绕过，CSP 才是边界。

export const SCRIPT_WORLD_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'";

export interface ScriptWorldDeps {
  configureWorld: (properties: { csp: string; messaging: boolean }) => Promise<void>;
}

/**
 * configureWorld 在每次 service worker 启动后做一次就够；失败不缓存——"允许用户脚本"开关
 * 关着时 userScripts 的方法会抛错，用户打开开关后下一次调用必须能自己恢复，不需要重启扩展。
 */
export function createScriptWorld(deps: ScriptWorldDeps): { ensure(): Promise<boolean> } {
  let configured = false;
  return {
    async ensure() {
      if (configured) return true;
      try {
        await deps.configureWorld({ csp: SCRIPT_WORLD_CSP, messaging: false });
        configured = true;
        return true;
      } catch {
        return false;
      }
    },
  };
}
