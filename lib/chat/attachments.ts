// lib/chat/attachments.ts
// 上传附件（文本类/图片）的纯逻辑：分类、读取、校验、拼进 prompt、转成 ImageContent。
// 不用 FileReader——用 File.arrayBuffer()/.text() + btoa()，这样本文件能在
// vitest.config.ts 的 node 环境（lib/**/*.test.ts）下测试，不需要 jsdom。
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Translate } from '../i18n';

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_TEXT_CHARS = 30000;
export const MAX_ATTACHMENT_IMAGE_BYTES = 5 * 1024 * 1024;

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'text' | 'image';
  /** kind 'text'：截断后的原文 */
  textContent?: string;
  /** kind 'text'：原文是否超过 MAX_ATTACHMENT_TEXT_CHARS 被截断 */
  truncated?: boolean;
  /** kind 'image'：完整 data URL（带 data:mime;base64, 前缀），直接作为 <img src> */
  dataUrl?: string;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.css', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.sh', '.bash', '.ini', '.toml', '.rb', '.php', '.sql',
]);

export function classifyFile(file: File): 'text' | 'image' | 'unsupported' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text';
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext) ? 'text' : 'unsupported';
}

export type AttachmentReadFailureReason = 'too-large' | 'unsupported-type' | 'read-failed';
export interface AttachmentReadFailure {
  name: string;
  reason: AttachmentReadFailureReason;
}
export type AttachmentReadResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; failure: AttachmentReadFailure };

export async function readAttachment(file: File): Promise<AttachmentReadResult> {
  const kind = classifyFile(file);
  if (kind === 'unsupported') return { ok: false, failure: { name: file.name, reason: 'unsupported-type' } };
  if (kind === 'image' && file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
    return { ok: false, failure: { name: file.name, reason: 'too-large' } };
  }
  try {
    if (kind === 'image') {
      const dataUrl = await readFileAsDataUrl(file);
      return {
        ok: true,
        attachment: {
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          kind: 'image',
          dataUrl,
        },
      };
    }
    const readByteLimit = MAX_ATTACHMENT_TEXT_CHARS * 4; // UTF-8 worst case: 4 bytes/char
    const readSource = file.size > readByteLimit ? file.slice(0, readByteLimit) : file;
    const text = await readSource.text();
    const truncated = file.size > readByteLimit || text.length > MAX_ATTACHMENT_TEXT_CHARS;
    return {
      ok: true,
      attachment: {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'text/plain',
        size: file.size,
        kind: 'text',
        textContent: text.length > MAX_ATTACHMENT_TEXT_CHARS ? text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : text,
        truncated,
      },
    };
  } catch {
    return { ok: false, failure: { name: file.name, reason: 'read-failed' } };
  }
}

async function readFileAsDataUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK_SIZE = 0x8000; // 避免 String.fromCharCode(...bytes) 在大文件上撑爆调用栈
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  const mimeType = file.type || 'application/octet-stream';
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** 拼进当轮 prompt 文本部分的模板；标注为参考数据而非指令，呼应 selection-ask 的处理方式。 */
export function buildAttachmentTextTemplate(attachment: MessageAttachment, translate: Translate): string {
  return translate('store.attachmentTextTemplate', {
    name: attachment.name,
    content: JSON.stringify(attachment.textContent ?? ''),
  });
}

/** dataUrl（带 data: 前缀）→ pi-ai 的 ImageContent（data 字段是裸 base64）。 */
export function toImageContent(attachment: MessageAttachment): ImageContent {
  const base64 = attachment.dataUrl?.replace(/^data:[^;]*;base64,/, '') ?? '';
  return { type: 'image', data: base64, mimeType: attachment.mimeType };
}
