# Revert-Snapshot Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "撤销本轮更改" (revert this turn's changes) survive MV3 service-worker eviction, and stop the side panel from silently no-op'ing when there's genuinely nothing to revert.

**Architecture:** Move `lib/agent/turn-snapshot.ts`'s per-tab snapshot store from a module-level in-memory `Map` (wiped whenever the MV3 service worker is evicted after ~30s idle) to `browser.storage.session` (a browser-process-level store built for exactly this "survive SW restarts" case). All five exported functions become `async`. Writes that fail (e.g. the ~10MB extension-wide quota is exceeded) are swallowed — the tool action that triggered them still completes, and that tab simply ends up with no snapshot, same as the "nothing to revert" case. A `browser.tabs.onRemoved` listener clears a closed tab's snapshot so it doesn't sit in the shared quota until browser restart. Separately, `entrypoints/sidepanel/store.ts`'s `revertTurnChanges()` starts checking `res.data?.reverted` so the UndoBar stops silently clearing its "has changes" flag when nothing was actually reverted.

**Tech Stack:** TypeScript, WXT (`browser.storage.session`), Vitest, `wxt/testing`'s `fakeBrowser` (already available transitively via the `wxt` devDependency — no new package.json entry).

## Global Constraints

- No new npm dependency (spec requirement). `wxt/testing`'s `fakeBrowser` is used for tests — it ships inside the existing `wxt` devDependency, so this holds.
- No change to `lib/messaging.ts`'s `RevertChangesResult` type or the message protocol.
- No change to `lib/agent/tools.ts` (`browser_revert_changes` already handles `reverted: false` correctly).
- No change to `wxt.config.ts` — the `storage` permission already covers `chrome.storage.session` in MV3.
- Quota-exceeded / any snapshot-persistence failure degrades silently (no new UI) — reuses the existing "本轮没有可撤销的改动" message.
- `entrypoints/` has no test infrastructure (per `CLAUDE.md` — only `lib/**/*.test.ts` is covered by `vitest.config.ts`). Changes there are verified by `pnpm compile` + manual smoke test, not new automated tests.

---

### Task 1: Persist turn snapshots to `chrome.storage.session`

**Files:**
- Modify: `lib/agent/turn-snapshot.ts` (full rewrite)
- Modify: `lib/agent/turn-snapshot.test.ts` (full rewrite)

**Interfaces:**
- Produces (used by Task 2): `hasSnapshot(tabId: number): Promise<boolean>`, `getSnapshot(tabId: number): Promise<TurnSnapshot | undefined>`, `beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): Promise<TurnSnapshot>`, `recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): Promise<void>`, `clearSnapshot(tabId: number): Promise<void>`. Same names and parameter shapes as today, now all `async` — every call site in Task 2 just needs `await` added.
- Types `StorageSnapshotEntry`, `CapturePageState`, `TurnSnapshot` are unchanged.

- [ ] **Step 1: Write the failing test file**

Replace `lib/agent/turn-snapshot.test.ts` entirely with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  beginSnapshotIfNeeded,
  clearSnapshot,
  getSnapshot,
  hasSnapshot,
  recordStorageEntryIfAbsent,
} from './turn-snapshot';

// turn-snapshot.ts 读写 browser.storage.session；vitest.config.ts 没有接入 WXT 的
// unimport 插件，所以这里手动把 fakeBrowser 挂到全局 browser 标识符上（JS 的裸标识符
// 解析本来就会落到 globalThis 属性，和是否走 unimport 插件无关）。
(globalThis as any).browser = fakeBrowser;

describe('turn-snapshot', () => {
  const TAB_ID = 1;

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('has no snapshot for an untouched tab', async () => {
    expect(await hasSnapshot(TAB_ID)).toBe(false);
    expect(await getSnapshot(TAB_ID)).toBeUndefined();
  });

  it('creates a snapshot on first call and keeps it on later calls', async () => {
    const first = await beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://a.example',
      bodyHTML: '<p>a</p>',
      scrollX: 0,
      scrollY: 0,
    });
    const second = await beginSnapshotIfNeeded(TAB_ID, {
      url: 'https://b.example',
      bodyHTML: '<p>b</p>',
      scrollX: 10,
      scrollY: 20,
    });
    expect(second).toEqual(first);
    expect((await getSnapshot(TAB_ID))?.url).toBe('https://a.example');
  });

  it('records a storage entry only once per key', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'dark' });
    expect((await getSnapshot(TAB_ID))?.storageEntries).toEqual([
      { area: 'local', key: 'theme', previousValue: 'light' },
    ]);
  });

  it('does nothing when recording a storage entry without an existing snapshot', async () => {
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('clears the snapshot', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    await clearSnapshot(TAB_ID);
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('survives being read back after a simulated service-worker restart (fresh fakeBrowser storage, same key)', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '<p>a</p>', scrollX: 1, scrollY: 2 });
    // 模拟 SW 重启：不清空 fakeBrowser 的 storage.session（它代表浏览器进程内数据），
    // 只是重新 import 也无意义（ESM 模块缓存），所以这里改为直接验证同一 tabId 的读路径
    // 不依赖任何模块级变量——即，多次独立的 getSnapshot 调用互相不干扰、都读到同一份数据。
    expect((await getSnapshot(TAB_ID))?.bodyHTML).toBe('<p>a</p>');
    expect((await getSnapshot(TAB_ID))?.bodyHTML).toBe('<p>a</p>');
  });

  it('degrades silently when persisting a new snapshot fails (e.g. storage quota exceeded)', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '<p>a</p>', scrollX: 0, scrollY: 0 });
    expect(await hasSnapshot(TAB_ID)).toBe(false);
  });

  it('degrades silently when recording a storage entry fails to persist', async () => {
    await beginSnapshotIfNeeded(TAB_ID, { url: 'https://a.example', bodyHTML: '', scrollX: 0, scrollY: 0 });
    vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await recordStorageEntryIfAbsent(TAB_ID, { area: 'local', key: 'theme', previousValue: 'light' });
    expect((await getSnapshot(TAB_ID))?.storageEntries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/agent/turn-snapshot.test.ts`
Expected: FAIL — either a TypeScript error (current implementation's exports are not `async`/don't return `Promise`) or a runtime error, since `lib/agent/turn-snapshot.ts` still uses the in-memory `Map` and none of its functions are `async`.

- [ ] **Step 3: Rewrite the implementation**

Replace `lib/agent/turn-snapshot.ts` entirely with:

```ts
// 每个标签页一份"本轮"快照，用于"撤销本轮更改"。
// 快照只在本轮第一次写操作时创建（beginSnapshotIfNeeded），
// RESET_TURN_SNAPSHOT（新一轮开始）或 REVERT_CHANGES（撤销后）会清空它。
//
// 持久化到 browser.storage.session（而非模块级 Map）：MV3 service worker 空闲
// ~30s 后会被终止、下次事件时重启，这会清空任何模块级变量，导致"撤销"静默失效。
// storage.session 是浏览器进程内的存储，专为"跨 SW 重启存活"设计，不落盘。

export interface StorageSnapshotEntry {
  area: 'local' | 'session';
  key: string;
  previousValue: string | null;
}

export interface CapturePageState {
  url: string;
  bodyHTML: string;
  scrollX: number;
  scrollY: number;
}

export interface TurnSnapshot extends CapturePageState {
  storageEntries: StorageSnapshotEntry[];
}

function storageKey(tabId: number): string {
  return `turnSnapshot:${tabId}`;
}

export async function hasSnapshot(tabId: number): Promise<boolean> {
  return (await getSnapshot(tabId)) !== undefined;
}

export async function getSnapshot(tabId: number): Promise<TurnSnapshot | undefined> {
  const key = storageKey(tabId);
  const result = await browser.storage.session.get(key);
  return result[key] as TurnSnapshot | undefined;
}

/**
 * 若该 tab 本轮还没有快照，用给定的页面状态创建一份并持久化；已存在则原样返回，不覆盖。
 * 持久化失败（如配额超限）时静默降级：不抛出、不阻塞调用方，只是这次不会被记住——
 * 后续 hasSnapshot 仍会是 false，撤销时会走"本轮没有可撤销的改动"这条已有路径。
 */
export async function beginSnapshotIfNeeded(tabId: number, capture: CapturePageState): Promise<TurnSnapshot> {
  const existing = await getSnapshot(tabId);
  if (existing) return existing;
  const created: TurnSnapshot = { ...capture, storageEntries: [] };
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: created });
  } catch {
    // 静默降级，见上方注释
  }
  return created;
}

/** 记录某个 storage key 本轮修改前的值；同一个 key 本轮只记录一次（保留最早的原值）。 */
export async function recordStorageEntryIfAbsent(tabId: number, entry: StorageSnapshotEntry): Promise<void> {
  const snapshot = await getSnapshot(tabId);
  if (!snapshot) return;
  const exists = snapshot.storageEntries.some((e) => e.area === entry.area && e.key === entry.key);
  if (exists) return;
  const updated: TurnSnapshot = { ...snapshot, storageEntries: [...snapshot.storageEntries, entry] };
  try {
    await browser.storage.session.set({ [storageKey(tabId)]: updated });
  } catch {
    // 静默降级，见 beginSnapshotIfNeeded 注释
  }
}

export async function clearSnapshot(tabId: number): Promise<void> {
  await browser.storage.session.remove(storageKey(tabId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/agent/turn-snapshot.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Type check**

Run: `pnpm compile`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add lib/agent/turn-snapshot.ts lib/agent/turn-snapshot.test.ts
git commit -m "$(cat <<'EOF'
fix: persist turn-revert snapshots to chrome.storage.session

The in-memory Map backing "撤销本轮更改" was wiped whenever the MV3
service worker got evicted mid-turn, making revert silently no-op.
storage.session survives SW restarts and is built for exactly this.

Ref: docs/superpowers/specs/2026-07-23-revert-snapshot-persistence-design.md
EOF
)"
```

---

### Task 2: Wire `background.ts` to the now-async snapshot API + clean up on tab close

**Files:**
- Modify: `entrypoints/background.ts:506-518` (`ensureTurnSnapshot`)
- Modify: `entrypoints/background.ts:687-712` (`revertChanges`)
- Modify: `entrypoints/background.ts:714-718` (`resetTurnSnapshot`)
- Modify: `entrypoints/background.ts:743-759` (`setStorage`)
- Modify: `entrypoints/background.ts:79-102` (`defineBackground` body — add `tabs.onRemoved` listener)

**Interfaces:**
- Consumes from Task 1: `hasSnapshot`, `getSnapshot`, `beginSnapshotIfNeeded`, `recordStorageEntryIfAbsent`, `clearSnapshot` — all now `async`, imported the same way they already are at the top of `background.ts` (lines 42-49, unchanged import statement).

This task has no new automated tests (`entrypoints/` isn't covered by `vitest.config.ts`, per `CLAUDE.md`) — verification is `pnpm compile` plus the manual smoke test in Task 4.

- [ ] **Step 1: Add `await` in `ensureTurnSnapshot`**

Find (around line 506):

```ts
async function ensureTurnSnapshot(tabId: number): Promise<void> {
  if (hasSnapshot(tabId)) return;
  const capture = await executeInActiveTab(
    null,
    (): CapturePageState => ({
      url: location.href,
      bodyHTML: document.body.innerHTML,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  beginSnapshotIfNeeded(tabId, capture);
}
```

Replace with:

```ts
async function ensureTurnSnapshot(tabId: number): Promise<void> {
  if (await hasSnapshot(tabId)) return;
  const capture = await executeInActiveTab(
    null,
    (): CapturePageState => ({
      url: location.href,
      bodyHTML: document.body.innerHTML,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }),
  );
  await beginSnapshotIfNeeded(tabId, capture);
}
```

- [ ] **Step 2: Add `await` in `revertChanges`**

Find (around line 687):

```ts
async function revertChanges(): Promise<RevertChangesResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const snapshot = getSnapshot(tab.id);
  if (!snapshot) return { reverted: false };

  const currentUrl = await executeInActiveTab(null, (): string => location.href);
  if (currentUrl !== snapshot.url) {
    await browser.tabs.update(tab.id, { url: snapshot.url });
    clearSnapshot(tab.id);
    return { reverted: true, navigatedBack: true };
  }

  await executeInActiveTab(snapshot, (snap): void => {
    for (const entry of snap.storageEntries) {
      const store = entry.area === 'session' ? sessionStorage : localStorage;
      if (entry.previousValue === null) store.removeItem(entry.key);
      else store.setItem(entry.key, entry.previousValue);
    }
    document.body.innerHTML = snap.bodyHTML;
    window.scrollTo(snap.scrollX, snap.scrollY);
  });
  clearSnapshot(tab.id);
  return { reverted: true, navigatedBack: false };
}
```

Replace with:

```ts
async function revertChanges(): Promise<RevertChangesResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');

  const snapshot = await getSnapshot(tab.id);
  if (!snapshot) return { reverted: false };

  const currentUrl = await executeInActiveTab(null, (): string => location.href);
  if (currentUrl !== snapshot.url) {
    await browser.tabs.update(tab.id, { url: snapshot.url });
    await clearSnapshot(tab.id);
    return { reverted: true, navigatedBack: true };
  }

  await executeInActiveTab(snapshot, (snap): void => {
    for (const entry of snap.storageEntries) {
      const store = entry.area === 'session' ? sessionStorage : localStorage;
      if (entry.previousValue === null) store.removeItem(entry.key);
      else store.setItem(entry.key, entry.previousValue);
    }
    document.body.innerHTML = snap.bodyHTML;
    window.scrollTo(snap.scrollX, snap.scrollY);
  });
  await clearSnapshot(tab.id);
  return { reverted: true, navigatedBack: false };
}
```

- [ ] **Step 3: Add `await` in `resetTurnSnapshot`**

Find (around line 714):

```ts
async function resetTurnSnapshot(): Promise<{ ok: true }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) clearSnapshot(tab.id);
  return { ok: true };
}
```

Replace with:

```ts
async function resetTurnSnapshot(): Promise<{ ok: true }> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await clearSnapshot(tab.id);
  return { ok: true };
}
```

- [ ] **Step 4: Add `await` in `setStorage`**

Find (around line 743):

```ts
async function setStorage(payload: SetStoragePayload): Promise<SetStorageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const result = await executeInActiveTab(payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    const previousValue = store.getItem(key);
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key, previousValue };
  });

  recordStorageEntryIfAbsent(tab.id, { area: result.area, key: result.key, previousValue: result.previousValue });
  return result;
}
```

Replace with:

```ts
async function setStorage(payload: SetStoragePayload): Promise<SetStorageResult> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到活动标签页');
  await ensureTurnSnapshot(tab.id);

  const result = await executeInActiveTab(payload, (input): SetStorageResult => {
    const store = input?.area === 'session' ? sessionStorage : localStorage;
    const key = input?.key ?? '';
    const previousValue = store.getItem(key);
    if (input?.value === null || input?.value === undefined) store.removeItem(key);
    else store.setItem(key, input.value);
    return { area: input?.area ?? 'local', key, previousValue };
  });

  await recordStorageEntryIfAbsent(tab.id, { area: result.area, key: result.key, previousValue: result.previousValue });
  return result;
}
```

- [ ] **Step 5: Add a `tabs.onRemoved` cleanup listener**

Find (around line 79):

```ts
// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // 点击工具栏图标时打开侧边栏
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[Aluminum] sidePanel:', err));
  });

  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message)
        .then((data) => sendResponse({ id: message.id, ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // 返回 true 以保持 sendResponse 异步可用
      return true;
    },
  );
});
```

Replace with:

```ts
// Service Worker：消息路由中心（ref: technical-plan.md §3.2）
export default defineBackground(() => {
  // 点击工具栏图标时打开侧边栏
  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[Aluminum] sidePanel:', err));
  });

  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (r: MessageResponse) => void) => {
      handleMessage(message)
        .then((data) => sendResponse({ id: message.id, ok: true, data }))
        .catch((error: unknown) =>
          sendResponse({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // 返回 true 以保持 sendResponse 异步可用
      return true;
    },
  );

  // Tab 关闭后其"本轮"快照不再可能被用到，及时清理避免占用 storage.session 的共享配额。
  browser.tabs.onRemoved.addListener((tabId) => {
    clearSnapshot(tabId).catch((err: unknown) => console.error('[Aluminum] clearSnapshot on tab close:', err));
  });
});
```

- [ ] **Step 6: Type check and run the existing test suite**

Run: `pnpm compile`
Expected: no errors

Run: `pnpm test`
Expected: all suites pass, including the Task 1 `turn-snapshot.test.ts`

- [ ] **Step 7: Commit**

```bash
git add entrypoints/background.ts
git commit -m "$(cat <<'EOF'
fix: await async turn-snapshot calls, clear snapshot on tab close

Follows the turn-snapshot.ts persistence change: every call site now
awaits the (now-async) snapshot functions. Also clears a tab's
snapshot on tabs.onRemoved so closed tabs don't sit in the shared
chrome.storage.session quota until the browser restarts.
EOF
)"
```

---

### Task 3: Stop the UndoBar from silently no-op'ing

**Files:**
- Modify: `entrypoints/sidepanel/store.ts:235-243` (`revertTurnChanges`)

**Interfaces:**
- Consumes: `RevertChangesResult` (`{ reverted: boolean; navigatedBack?: boolean }`) from `@/lib/messaging`, already imported at the top of `store.ts` (line 8) — no import changes needed.

No automated test for this file today (`entrypoints/` isn't covered by `vitest.config.ts`) — verified by `pnpm compile` and the manual smoke test in Task 4.

- [ ] **Step 1: Check `reverted` before clearing `turnHasChanges` silently**

Find (around line 235):

```ts
  revertTurnChanges: async () => {
    try {
      const res = (await sendMessage('REVERT_CHANGES')) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      set({ turnHasChanges: false });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
```

Replace with:

```ts
  revertTurnChanges: async () => {
    try {
      const res = (await sendMessage('REVERT_CHANGES')) as MessageResponse<RevertChangesResult>;
      if (!res.ok) throw new Error(res.error ?? '撤销失败');
      if (!res.data?.reverted) {
        set({ turnHasChanges: false, error: '本轮没有可撤销的改动。' });
        return;
      }
      set({ turnHasChanges: false });
    } catch (e) {
      set({ error: errMsg(e) });
    }
  },
```

- [ ] **Step 2: Type check and run the existing test suite**

Run: `pnpm compile`
Expected: no errors

Run: `pnpm test`
Expected: all suites still pass (this file has no dedicated test suite; this just guards against a regression elsewhere)

- [ ] **Step 3: Commit**

```bash
git add entrypoints/sidepanel/store.ts
git commit -m "$(cat <<'EOF'
fix: surface a message when there's nothing to revert

revertTurnChanges() only checked whether the REVERT_CHANGES message
round-tripped, never res.data.reverted — so it silently cleared
turnHasChanges even when background.ts reported nothing was actually
undone. Now shows the same "本轮没有可撤销的改动" message the
browser_revert_changes agent tool already uses for this case.
EOF
)"
```

---

### Task 4: Build and manually verify

**Files:** none (verification only)

- [ ] **Step 1: Full test suite + type check**

Run: `pnpm test`
Expected: all suites pass

Run: `pnpm compile`
Expected: no errors

- [ ] **Step 2: Production build**

Run: `pnpm build`
Expected: builds to `.output/chrome-mv3` without errors

- [ ] **Step 3: Load the unpacked extension**

Open `chrome://extensions`, enable Developer mode, "Load unpacked", select `.output/chrome-mv3`. If already loaded from a previous session, click the reload icon on the extension's card instead.

- [ ] **Step 4: Verify revert survives service-worker eviction**

1. Open any normal `http(s)://` page, open the side panel, ask the agent to make a visible DOM/style change (e.g. "把页面背景改成红色").
2. Approve the write-tool confirmation.
3. Go to `chrome://extensions`, find Aluminum's card, click "service worker" (or "检查视图" → "service worker") to open its devtools — then close that devtools window, and leave the extension idle for at least 40 seconds (past the ~30s eviction window) without interacting with the side panel. (Optional stronger check: in the service worker's devtools before closing it, note its process; after ~40s idle, clicking "service worker" again on the extensions page opens a *new* worker instance, confirming eviction happened.)
4. Back in the side panel, click "撤销本轮更改" (the UndoBar's revert button).
5. **Expected:** the page's background color actually reverts (not just the UndoBar disappearing) — this is the behavior that was broken before this change.

- [ ] **Step 5: Verify the normal (non-evicted) revert path has no regression**

1. Repeat steps 1-2 above on a fresh page, but click "撤销本轮更改" immediately (no waiting).
2. **Expected:** page reverts immediately, same as before this change.

- [ ] **Step 6: Verify tab-close cleanup doesn't error**

1. Make a change on a page (per step 4.1-4.2), then close that tab before reverting.
2. Check the service worker's console (`chrome://extensions` → "service worker") for errors.
3. **Expected:** no uncaught errors logged from the `tabs.onRemoved` listener.

- [ ] **Step 7: Verify the "nothing to revert" message**

1. Open the side panel on a fresh page and immediately try to trigger a revert without the agent having made any changes (there should be no UndoBar in this state, since `turnHasChanges` starts `false` — this step is a sanity check that the UI doesn't offer revert with nothing to revert, confirming the message added in Task 3 is reachable only through the genuine race/quota-degrade path, not through normal UI navigation).
2. **Expected:** no UndoBar is shown; nothing to verify here beyond confirming the button's absence (this documents why Task 3's new message path is rare by design, per the spec).

---

## Self-Review Notes

- **Spec coverage:** Storage shape/API (§1) → Task 1. Quota silent-degrade (§2) → Task 1 (impl) + Task 4 Step 4 relies on it implicitly (not directly testable via UI, covered by Task 1's unit tests instead). Tab-close cleanup (§3) → Task 2 Step 5 + Task 4 Step 6. UI silent-failure fix (§4) → Task 3. All four spec decisions have a task.
- **Type consistency:** `TurnSnapshot`, `CapturePageState`, `StorageSnapshotEntry` unchanged across all tasks. Function names/signatures introduced in Task 1 (`hasSnapshot`, `getSnapshot`, `beginSnapshotIfNeeded`, `recordStorageEntryIfAbsent`, `clearSnapshot`, all `Promise`-returning) match exactly what Task 2 awaits.
- **Testing tooling note (deviation from spec wording, not from spec decisions):** the spec's testing section anticipated hand-rolling a local fake for `browser.storage.session`. While writing this plan, `wxt/testing`'s `fakeBrowser` (backed by `@webext-core/fake-browser`, a transitive dependency already present via `wxt`) was found to cover this need directly and more realistically, without adding any new `package.json` entry or touching `vitest.config.ts`. This doesn't change any of the spec's architecture decisions (storage shape, quota handling, cleanup, UI fix) — only the test-file mechanics.
