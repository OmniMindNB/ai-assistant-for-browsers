// 句柄表跨「写操作 → 内部重采」的存活性：把 2026-09-08 答题页点击失效那次排查的现场
// 固化下来（ref: docs/superpowers/specs/2026-09-08-field-handle-stability-design.md）。
//
// background.ts 的 snapshotFields 没有任何 vitest project 覆盖（CLAUDE.md 有记），它做的
// 三件事——发号（allocateFieldIds）、装期望结构（fieldExpectation）、保留 t*
// （keepFindTextHandles）——都已经拆成 lib 里的纯函数。本文件按 snapshotFields 的接线顺序
// 把它们组合起来，再接上真正注入页面的 applyFormFill，覆盖单元测试各自看不到的那条缝：
// 一次成功的点击之后，模型手里的 fieldId 还指不指得着原来那个元素。
import { beforeEach, describe, expect, it } from 'vitest';
import { allocateFieldIds } from './field-id-allocation';
import { keepFindTextHandles, mergeFindTextHandles } from './find-text';
import { planFieldClicks } from './fill-form-request';
import { applyFormFill, collectFormFields } from './form-dom';
import { fieldExpectation, toFieldDescriptor } from './form-schema';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

const INPUT = { maxFields: 120, maxOptions: 50 };
// jsdom 的 location 不可写：句柄表的 url 必须与它相符，否则 applyFormFill 一进门就判 stale。
const URL = location.href;

// jsdom 的 getBoundingClientRect 恒为 0×0，collectFormFields 会据此把每个元素判成不可见；
// 同款 stub 与完整理由见 form-dom.dom.test.ts 顶部。
const NON_ZERO_RECT = {
  width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0,
  toJSON() { return this; },
} as DOMRect;
Element.prototype.getBoundingClientRect = () => NON_ZERO_RECT;
(document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;

// jsdom 把 Document 的 :scope 解析成 documentElement 而非 document 自身，导致
// `document.querySelectorAll(':scope > html')` 恒为空，而 collectFormFields 产出的每条
// path 都以这一步开头。同款补丁与完整理由见 form-dom.dom.test.ts。
const originalDocumentQuerySelectorAll = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function (this: Document, selectors: string) {
  if (/^:scope\s*>\s*html$/.exec(selectors.trim())) {
    return Array.from(this.children).filter(
      (element) => element.tagName.toLowerCase() === 'html',
    ) as unknown as NodeListOf<Element>;
  }
  return originalDocumentQuerySelectorAll.call(this, selectors);
} as typeof originalDocumentQuerySelectorAll;

/** 按 background.ts snapshotFields 的接线顺序重建一张句柄表。 */
function snapshot(previous: FormFieldTable | undefined, keepTextHandles: boolean): FormFieldTable {
  const collected = collectFormFields(INPUT);
  const { fieldIds, identities } = allocateFieldIds(collected.raws, previous, URL);
  const fields: Record<string, FormFieldHandle> = keepTextHandles
    ? keepFindTextHandles(previous, URL)
    : {};
  collected.raws.forEach((raw, index) => {
    fields[fieldIds[index]] = {
      path: raw.path,
      expect: fieldExpectation(raw),
      sensitive: false,
      kind: toFieldDescriptor(raw, fieldIds[index]).kind,
      identity: identities[index],
    };
  });
  return { url: URL, fields };
}

/** 按 fieldId 点一次，等价于 background 的 clickElementByFieldId。 */
function clickByFieldId(table: FormFieldTable, fieldId: string) {
  const handle = table.fields[fieldId];
  return applyFormFill({
    url: table.url,
    items: [],
    submit: { fieldId, path: handle.path, expect: handle.expect },
  });
}

function labelOf(table: FormFieldTable, fieldId: string): string | undefined {
  return table.fields[fieldId]?.expect.label;
}

describe('答题页：一次点击之后，模型手里的 fieldId 仍然指着原来那个选项', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="paper">
        <div class="q"><p>第1题</p>
          <label><input type="radio" name="q1" value="A" />A</label>
          <label><input type="radio" name="q1" value="B" />B</label>
        </div>
        <div class="q"><p>第2题</p>
          <label><input type="radio" name="q2" value="A" />A</label>
          <label><input type="radio" name="q2" value="B" />B</label>
        </div>
      </div>`;
  });

  it('页面在第 1 题下方插入解析后，第 2 题的 B 依然是同一个 fieldId', async () => {
    const read = snapshot(undefined, false);
    const q2b = Object.keys(read.fields).find(
      (id) => read.fields[id].expect.name === 'q2' && read.fields[id].expect.value === 'B',
    )!;

    await clickByFieldId(read, Object.keys(read.fields)[0]);
    // 答题站选完一个选项后最常见的反应：原地展开一段带按钮的解析
    document.querySelector('.q')!.insertAdjacentHTML(
      'beforeend',
      '<div class="explain"><button>收起解析</button></div>',
    );
    const refreshed = snapshot(read, true); // collectNewFieldsAfterWrite

    expect(labelOf(refreshed, q2b)).toBe(labelOf(read, q2b));
    expect(refreshed.fields[q2b].expect.name).toBe('q2');
    expect(refreshed.fields[q2b].expect.value).toBe('B');

    const clicked = await clickByFieldId(refreshed, q2b);
    expect(clicked.submitted?.status).toBe('ok');
    const [optionA, optionB] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name=q2]'),
    );
    expect(optionB.checked).toBe(true);
    expect(optionA.checked).toBe(false);
  });

  it('句柄的内容判别位错位时报 mismatch，绝不静默点到隔壁选项', async () => {
    const read = snapshot(undefined, false);
    const q2a = Object.keys(read.fields).find(
      (id) => read.fields[id].expect.name === 'q2' && read.fields[id].expect.value === 'A',
    )!;

    // 手工把句柄的 path 挪到隔壁选项上，模拟任何一种没被身份继承兜住的漂移
    const q2b = Object.keys(read.fields).find(
      (id) => read.fields[id].expect.name === 'q2' && read.fields[id].expect.value === 'B',
    )!;
    read.fields[q2a] = { ...read.fields[q2a], path: read.fields[q2b].path };

    const clicked = await clickByFieldId(read, q2a);
    expect(clicked.submitted?.status).toBe('mismatch');
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>('input[name=q2]')).some((el) => el.checked),
    ).toBe(false);
  });

  it('写操作之后的内部重采不会抹掉 browser_find_text 发的 t*', async () => {
    const read = snapshot(undefined, false);
    const withText = mergeFindTextHandles(read, URL, [
      { path: read.fields.f3.path, tag: 'input', type: 'radio', name: 'q2', frameId: 0, frameOrigin: 'https://exam.test' },
      { path: read.fields.f4.path, tag: 'input', type: 'radio', name: 'q2', frameId: 0, frameOrigin: 'https://exam.test' },
    ]);

    await clickByFieldId(withText, 'f1');
    const refreshed = snapshot(withText, true);

    expect(refreshed.fields.t1).toBeDefined();
    expect(refreshed.fields.t2).toBeDefined();
  });

  it('模型主动重读表单时 t* 照旧作废：那是它自己表示页面状态变了', () => {
    const read = snapshot(undefined, false);
    const withText = mergeFindTextHandles(read, URL, [
      { path: read.fields.f1.path, tag: 'input', frameId: 0, frameOrigin: 'https://exam.test' },
    ]);

    const reread = snapshot(withText, false); // browser_get_form

    expect(reread.fields.t1).toBeUndefined();
  });
});

describe('多选题：一题之内连续操作多个选项', () => {
  it('一次 fill_form 勾选多个真 checkbox，全部落地', async () => {
    document.body.innerHTML = `
      <div class="q"><p>第1题（多选）</p>
        <label><input type="checkbox" name="q1" value="A" />A</label>
        <label><input type="checkbox" name="q1" value="B" />B</label>
        <label><input type="checkbox" name="q1" value="C" />C</label>
      </div>`;
    const read = snapshot(undefined, false);
    const idOf = (value: string) =>
      Object.keys(read.fields).find((id) => read.fields[id].expect.value === value)!;

    const output = await applyFormFill({
      url: read.url,
      items: [idOf('A'), idOf('C')].map((fieldId) => ({
        fieldId,
        path: read.fields[fieldId].path,
        expect: read.fields[fieldId].expect,
        kind: 'checkbox',
        checked: true,
      })),
    });

    expect(output.outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok']);
    const checked = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((el) => el.checked);
    expect(checked).toEqual([true, false, true]);
  });

  it('勾完一个之后，同题其余选项的 fieldId 不变（重采发生在两次点击之间）', async () => {
    document.body.innerHTML = `
      <div class="q"><p>第1题（多选）</p>
        <label><input type="checkbox" name="q1" value="A" />A</label>
        <label><input type="checkbox" name="q1" value="B" />B</label>
      </div>`;
    const read = snapshot(undefined, false);
    const optionB = Object.keys(read.fields).find((id) => read.fields[id].expect.value === 'B')!;

    await clickByFieldId(read, Object.keys(read.fields)[0]);
    // 多选题勾中一个之后常见的反应：右侧冒出「已选 1/2」计数
    document.querySelector('.q')!.insertAdjacentHTML('beforeend', '<button>已选 1/2</button>');
    const refreshed = snapshot(read, true);

    expect(refreshed.fields[optionB]?.expect.value).toBe('B');
    const clicked = await clickByFieldId(refreshed, optionB);
    expect(clicked.submitted?.status).toBe('ok');
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((el) => el.checked)).toEqual([true, true]);
  });

  it('选项是 div 且选中后文案变了：句柄换号，退化成一次显式的「查无此 fieldId」而不是点错', async () => {
    document.body.innerHTML = `
      <div class="q"><p>第1题（多选）</p>
        <div role="button" tabindex="0">A. 甲</div>
        <div role="button" tabindex="0">B. 乙</div>
      </div>`;
    const read = snapshot(undefined, false);
    const optionA = Object.keys(read.fields).find((id) => read.fields[id].expect.text === 'A. 甲')!;

    await clickByFieldId(read, optionA);
    document.querySelectorAll('div[role=button]')[0].textContent = 'A. 甲 ✓已选';
    const refreshed = snapshot(read, true);

    // 文案就是这类元素的全部身份，改了就认不回来了——号码作废，不会被顶给别的元素
    expect(refreshed.fields[optionA]).toBeUndefined();
    expect(
      Object.values(refreshed.fields).some((handle) => handle.expect.text === 'B. 乙'),
    ).toBe(true);
  });
});

// ⚠️ 下面这组覆盖的是 planFieldClicks 的查表语义 + applyFormFill 在批量场景下的逐目标校验。
// 循环本身是照 background.ts 的 clickElementsByFieldIds 复刻的（那里没有 vitest project
// 能覆盖），所以「一个失败不影响其余」这条在这里验的是语义可行，不是 background 真的那么写了——
// 改 clickElementsByFieldIds 时不要以为有测试守着它。
describe('批量点击：一次点完多选题的若干选项', () => {
  /** 按 background.ts clickElementsByFieldIds 的循环重放一遍：逐个查表、逐个注入。 */
  async function clickBatch(table: FormFieldTable, fieldIds: string[]) {
    const plans = planFieldClicks(fieldIds, table);
    const statuses: string[] = [];
    for (const plan of plans) {
      if (!plan.ok || !plan.submit) {
        statuses.push(plan.reason!);
        continue;
      }
      const applied = await applyFormFill({
        url: table.url,
        items: [],
        submit: plan.submit,
        expectOrigin: plan.expectOrigin,
      });
      statuses.push(applied.submitted?.status ?? 'not_found');
    }
    return statuses;
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="q"><p>第1题（多选）</p>
        <div role="button" tabindex="0">A. 甲</div>
        <div role="button" tabindex="0">B. 乙</div>
        <div role="button" tabindex="0">C. 丙</div>
      </div>`;
  });

  it('三个 div 选项一次点完，全部落地', async () => {
    const clicked: string[] = [];
    document.querySelectorAll('div[role=button]').forEach((element) => {
      element.addEventListener('click', () => clicked.push(element.textContent!));
    });
    const read = snapshot(undefined, false);
    const ids = ['A. 甲', 'B. 乙', 'C. 丙'].map(
      (text) => Object.keys(read.fields).find((id) => read.fields[id].expect.text === text)!,
    );

    expect(await clickBatch(read, ids)).toEqual(['ok', 'ok', 'ok']);
    expect(clicked).toEqual(['A. 甲', 'B. 乙', 'C. 丙']);
  });

  it('中间一个目标失效，其余照点——失败语义是「继续点完、逐个回报」', async () => {
    const clicked: string[] = [];
    document.querySelectorAll('div[role=button]').forEach((element) => {
      element.addEventListener('click', () => clicked.push(element.textContent!));
    });
    const read = snapshot(undefined, false);
    const ids = ['A. 甲', 'B. 乙', 'C. 丙'].map(
      (text) => Object.keys(read.fields).find((id) => read.fields[id].expect.text === text)!,
    );
    // 第二个选项在读表单之后被页面改写了文案：内容判别位对不上，只有它该失败
    document.querySelectorAll('div[role=button]')[1].textContent = 'B. 乙（已作废）';

    expect(await clickBatch(read, ids)).toEqual(['ok', 'mismatch', 'ok']);
    expect(clicked).toEqual(['A. 甲', 'C. 丙']);
  });

  it('重复的 fieldId 只点一次', async () => {
    const clicked: string[] = [];
    document.querySelectorAll('div[role=button]').forEach((element) => {
      element.addEventListener('click', () => clicked.push(element.textContent!));
    });
    const read = snapshot(undefined, false);
    const optionA = Object.keys(read.fields).find((id) => read.fields[id].expect.text === 'A. 甲')!;

    expect(await clickBatch(read, [optionA, optionA])).toEqual(['ok', 'duplicate']);
    expect(clicked).toEqual(['A. 甲']);
  });
});
