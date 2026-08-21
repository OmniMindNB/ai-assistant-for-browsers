// lib/chat/attachments.ts
// 上传附件（文本类/图片/PDF）的纯逻辑：分类、读取、拼进 prompt、转成 ImageContent。
// 不用 FileReader——用 File.arrayBuffer()/.text() + btoa()，这样本文件能在
// vitest.config.ts 的 node 环境（lib/**/*.test.ts）下测试，不需要 jsdom。
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Translate } from '../i18n';
import type { PdfExtractionFailureReason } from './pdf-extractor';

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_TEXT_CHARS = 30000;
export const MAX_ATTACHMENT_IMAGE_BYTES = 5 * 1024 * 1024;

export interface AttachmentBase {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface TextAttachment extends AttachmentBase {
  kind: 'text';
  /** 截断后的原文 */
  textContent: string;
  /** 原文是否超过 MAX_ATTACHMENT_TEXT_CHARS 被截断 */
  truncated: boolean;
}
export interface ImageAttachment extends AttachmentBase {
  kind: 'image';
  /** 完整 data URL（带 data:mime;base64, 前缀），直接作为 <img src> */
  dataUrl: string;
}
export interface PdfAttachment extends AttachmentBase {
  kind: 'pdf';
  pageCount: number;
  extractedChars: number;
  truncated: boolean;
}

/** 历史消息可持久化的附件：PDF 原文永远不在这里。 */
export type MessageAttachment = TextAttachment | ImageAttachment | PdfAttachment;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.css', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.sh', '.bash', '.ini', '.toml', '.rb', '.php', '.sql',
]);

export function classifyFile(file: File): 'text' | 'image' | 'pdf' | 'unsupported' {
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (file.type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || file.type === 'application/json') return 'text';
  return TEXT_EXTENSIONS.has(ext) ? 'text' : 'unsupported';
}

export type AttachmentReadFailureReason = 'too-large' | 'unsupported-type' | 'read-failed';
export interface AttachmentReadFailure {
  name: string;
  reason: AttachmentReadFailureReason;
}
export type AttachmentReadResult =
  | { ok: true; attachment: TextAttachment | ImageAttachment }
  | { ok: false; failure: AttachmentReadFailure };

/**
 * Reads text/image attachments after the store reserves a stable display ID.
 * PDF extraction is intentionally handled by the dedicated PDF queue.
 */
export function readAttachment(file: File): Promise<AttachmentReadResult>;
export function readAttachment(file: File, id: string): Promise<AttachmentReadResult>;
export async function readAttachment(file: File, id?: string): Promise<AttachmentReadResult> {
  const attachmentId = id ?? crypto.randomUUID();
  const kind = classifyFile(file);
  if (kind === 'unsupported' || kind === 'pdf') {
    return { ok: false, failure: { name: file.name, reason: 'unsupported-type' } };
  }
  if (kind === 'image' && file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
    return { ok: false, failure: { name: file.name, reason: 'too-large' } };
  }
  try {
    if (kind === 'image') {
      const dataUrl = await readFileAsDataUrl(file);
      return {
        ok: true,
        attachment: {
          id: attachmentId,
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
        id: attachmentId,
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
    content: JSON.stringify(attachment.kind === 'text' ? attachment.textContent : ''),
  });
}

/** dataUrl（带 data: 前缀）→ pi-ai 的 ImageContent（data 字段是裸 base64）。 */
export function toImageContent(attachment: ImageAttachment): ImageContent {
  const base64 = attachment.dataUrl.replace(/^data:[^;]*;base64,/, '');
  return { type: 'image', data: base64, mimeType: attachment.mimeType };
}

export interface PendingAttachmentBase {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'text' | 'image' | 'pdf' | 'unsupported';
}
export type ReadyPendingAttachment = PendingAttachmentBase & {
  status: 'ready';
  attachment: MessageAttachment;
  /** PDF extraction text is available for the current prompt only, never history. */
  transientText?: string;
};
export type PendingAttachment =
  | ReadyPendingAttachment
  | PendingAttachmentBase & {
      status: 'queued' | 'parsing';
      taskId: string; file: File; kind: 'text' | 'image' | 'pdf';
      completedPages?: number; pageCount?: number;
    }
  | PendingAttachmentBase & {
      status: 'error';
      file?: File;
      reason: AttachmentReadFailureReason | PdfExtractionFailureReason;
      retryable: boolean;
    };

export function isAttachmentBusy(item: PendingAttachment): boolean {
  return item.status === 'queued' || item.status === 'parsing';
}

export function isAttachmentReady(item: PendingAttachment): item is ReadyPendingAttachment {
  return item.status === 'ready';
}

/** Projects only a settled attachment into the history-safe metadata shape. */
export function toMessageAttachment(item: PendingAttachment): MessageAttachment | null {
  return item.status === 'ready' ? item.attachment : null;
}

/** Builds the current-turn text payload without making PDF extraction text persistable. */
export function buildPendingAttachmentText(item: PendingAttachment, translate: Translate): string {
  if (item.status !== 'ready' || item.attachment.kind === 'image') return '';
  const content = item.attachment.kind === 'pdf'
    ? item.transientText ?? ''
    : item.attachment.textContent;
  return translate('store.attachmentTextTemplate', {
    name: item.attachment.name,
    content: JSON.stringify(content),
  });
}

/** Converts only a ready image into pi-ai content; pending/error items cannot enter a prompt. */
export function toPendingImageContent(item: PendingAttachment): ImageContent | null {
  if (item.status !== 'ready' || item.attachment.kind !== 'image') return null;
  return toImageContent(item.attachment);
}

export function attachmentFailureLabel(
  reason: AttachmentReadFailureReason | PdfExtractionFailureReason,
  name: string,
  translate: Translate,
  kind: PendingAttachmentBase['kind'],
): string {
  const keys = {
    'too-large': kind === 'pdf' ? 'workbench.pdfTooLarge' : 'workbench.attachmentTooLarge',
    'unsupported-type': 'workbench.attachmentUnsupportedType',
    'read-failed': 'workbench.attachmentReadFailed',
    'invalid-pdf': 'workbench.pdfInvalid',
    'password-protected': 'workbench.pdfPasswordProtected',
    'no-extractable-text': 'workbench.pdfNoText',
    'parse-failed': 'workbench.pdfParseFailed',
    cancelled: 'workbench.pdfParseFailed',
  } as const;
  return translate(keys[reason], { name });
}
