# Task 3 report — transient attachment states and metadata-only persistence

## Scope delivered

- Added discriminated stored attachment types: `TextAttachment`, `ImageAttachment`, and `PdfAttachment`, united as `MessageAttachment`.
- Added pending-state unions plus ready/busy helpers and history/prompt/image projections.
- Classified PDFs before image/text detection and made `readAttachment(file, id)` retain a caller-reserved ID while retaining a one-argument compatibility overload for the pre-integration store.
- Kept PDF extraction text exclusively on ready pending items as `transientText`; `PdfAttachment` contains only page count, extracted-character count, and truncation metadata.
- Did not add `attachmentFailureLabel` or modify locale files, per the binding preflight ruling.

## RED evidence

Added tests first for PDF MIME/extension classification, reserved IDs, ready/busy/error states, metadata-only PDF projection, transient prompt text, ready-only image conversion, and message-record persistence. The focused run initially failed as intended against the missing behavior: PDF classified as `unsupported`, caller ID was regenerated, and each new pending helper was undefined (6 failures; 33 existing tests passed). `pnpm vitest ...` could not locate its binary in this worktree, so the equivalent local Vitest executable was used for the executable test runs.

## GREEN evidence

- Focused: `node_modules/.bin/vitest.cmd run lib/chat/attachments.test.ts lib/chat/messages.test.ts` — 2 files, 39 tests passed.
- TypeScript: `pnpm compile` — passed.
- Full: `node_modules/.bin/vitest.cmd run` — 597 of 599 tests passed; exactly the two documented baseline `lib/legal-pages.test.ts` CRLF/front-matter failures remain. No new failures.
- `git diff --check` completed without whitespace errors.

## Interface decisions

- `ChatMessage.attachments` and `ChatMessageRecord.attachments` remain `MessageAttachment[]`; pending files, queue IDs/status, and PDF text are therefore not representable in the database path.
- `toMessageAttachment` returns an attachment only for `ready` items; `buildPendingAttachmentText` reads PDF `transientText` only at prompt construction; `toPendingImageContent` returns `null` unless the item is ready and an image.
- `toImageContent` accepts only `ImageAttachment`; a small `AttachmentChip` narrowing adjustment was necessary for the stricter discriminated union to compile. It preserves the existing image/text display behavior and lets future PDF chips render their truncation badge.
- `readAttachment` handles text/images only. A classified PDF receives `unsupported-type` from this legacy helper; the subsequent store integration sends PDFs to the dedicated extraction queue instead.

## Files changed

- `lib/chat/attachments.ts`
- `lib/chat/attachments.test.ts`
- `lib/chat/messages.ts`
- `lib/chat/messages.test.ts`
- `lib/db.ts`
- `entrypoints/sidepanel/components/AttachmentChip.tsx` (required type narrowing)

## Self-review

- Verified `PdfAttachment` intentionally has no raw file, data URL, task ID, status, or extraction text fields.
- Verified persistence tests assert PDF metadata survives while transient/queue fields are absent.
- Verified text/image compatibility tests remain green, including data-URL conversion and existing prompt-template rendering.
- Confirmed no locale files changed and no failure-label mapper was introduced.

## Concerns

- The full suite retains the two known legal-pages CRLF baseline failures only.
- `pnpm vitest` does not resolve the worktree’s executable even though `node_modules/.bin/vitest.cmd` is present; focused/full Vitest evidence uses that local executable. `pnpm compile` resolves normally.
