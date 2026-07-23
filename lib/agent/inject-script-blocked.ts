const INJECT_SCRIPT_TOOL_NAME = 'browser_inject_script';
const USER_SCRIPTS_TOGGLE_MARKER = '允许用户脚本';

/**
 * Detects whether a `browser_inject_script` failure was caused by the user not having enabled
 * Chrome's per-extension "Allow User Scripts" toggle. `entrypoints/background.ts`'s `injectScript()`
 * always appends the `USER_SCRIPTS_TOGGLE_MARKER` phrase when `browser.userScripts.execute()` throws,
 * so a substring match against the stringified tool result is sufficient — see the design doc for why
 * this doesn't need a structured error code.
 */
export function isUserScriptsToggleBlocked(toolName: string, result: unknown): boolean {
  if (toolName !== INJECT_SCRIPT_TOOL_NAME) return false;
  let text: string;
  try {
    text = JSON.stringify(result) ?? '';
  } catch {
    return false;
  }
  return text.includes(USER_SCRIPTS_TOGGLE_MARKER);
}
