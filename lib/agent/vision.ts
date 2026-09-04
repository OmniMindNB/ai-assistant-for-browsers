// 视觉能力判定。用户可以把 baseURL 指向任意 OpenAI 兼容端点（包括本地小模型），
// 因此"这个模型能不能收图片"只能由用户声明，无法可靠探测。
import type { ProviderConfig } from '@/lib/settings';

export function supportsVision(provider: ProviderConfig | undefined, modelId: string | undefined): boolean {
  if (!provider || !modelId) return false;
  const declared = provider.visionModels;
  if (!declared?.length) return false;
  const target = modelId.trim();
  return declared.some((entry) => entry.trim() === target);
}
