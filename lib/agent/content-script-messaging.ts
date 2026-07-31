import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import type { Message, MessageResponse } from '@/lib/messaging';

// entrypoints/content.ts 是唯一的内容脚本入口，WXT 按约定固定输出到这个路径
// （见 .output/chrome-mv3/manifest.json 的 content_scripts.js，以及 .wxt/types/paths.d.ts
// 生成的 PublicPath 联合类型——用该类型能保证这里引用的是构建产物里真实存在的文件）。
const CONTENT_SCRIPT_FILES: ScriptPublicPath[] = ['/content-scripts/content.js'];

// Chrome 在“该 tab 尚未跑过内容脚本监听器”时，tabs.sendMessage 会以这句原样报错——
// 常见于扩展刚安装/重载后，早于此之前就已打开的标签页（内容脚本只在页面加载时静态注入，
// 不会补跑到已打开的标签页里）。这是唯一可安全重试的错误：先按需注入内容脚本，再重发一次。
function isMissingReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Receiving end does not exist');
}

// 除 EXTRACT_PAGE/GET_SELECTION 外的所有工具都走 executeInTab（scripting.executeScript
// 现场注入函数执行），天然不依赖内容脚本提前跑起来。这两个消息类型依赖 entrypoints/content.ts
// 里注册的静态监听器（因为要用到 Readability 等无法内联进 executeScript func 的依赖），
// 所以只有它们需要这层“按需注入后重试一次”的兜底。
export async function sendToContentScript<T>(
  tabId: number,
  message: Message,
): Promise<MessageResponse<T>> {
  try {
    return (await browser.tabs.sendMessage(tabId, message)) as MessageResponse<T>;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;

    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES,
      });
    } catch (injectError) {
      throw new Error(
        `内容脚本未就绪且无法注入（可能是受限页面，如 chrome:// 或应用商店页）：${
          injectError instanceof Error ? injectError.message : String(injectError)
        }`,
      );
    }

    return (await browser.tabs.sendMessage(tabId, message)) as MessageResponse<T>;
  }
}
