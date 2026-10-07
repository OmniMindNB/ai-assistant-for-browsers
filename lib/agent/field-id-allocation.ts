// fieldId 的发号逻辑：按「元素身份」继承上一张句柄表的号码，而不是按文档序重新编号。
//
// 为什么不能按位置编号：snapshotFields 在每次成功写操作之后都会被 collectNewFieldsAfterWrite
// 整表重采一次（background.ts）。位置编号下，页面只要在中间冒出一个新的可交互元素——答题页
// 选完一个选项弹出的「解析」、电商页加入购物车后出现的「去结算」——它后面所有元素的号码就
// 集体后移一位。模型手里那批写操作之前拿到的 fieldId 于是全部指向邻居：轻则报「未知的
// fieldId」，重则 path 与 expect 都取自同一张新表、结构指纹自洽，一次点击悄无声息地落在
// 隔壁选项上（同一组单选题的 tag/type/name 完全相同，指纹校验看不出差别）。
//
// 号码只增不复用：元素消失后它的号码就此作废，绝不发给别的元素。模型可能还攥着那个号，
// 复用等于把「指向邻居」换个形式再犯一遍。代价是长会话里号码会变稀疏（f5、f9、f14），
// 这是有意的取舍。
import { pickFieldLabel, resolveFieldKind, type RawFormField } from './form-schema';
import { isSamePage, type PageIdentity } from './page-identity';
import type { FormFieldHandle, FormFieldTable } from './tab-form-fields';

/**
 * 元素的稳定身份。只取重采之间不会漂移的属性——位置、class、样式一律不进。
 *
 * 勾选类字段用 name+value 而不用标签文案：value 是静态属性，而标签文案在选中后经常被页面
 * 改写（补一个「✓ 已选」、换成「你的答案」），拿它当身份会让同一个选项在下一次重采里
 * 变成一个陌生元素。其余字段没有这么一个静态判别位，只能用标签文案。
 *
 * 文本类字段的 value 是用户正在输入的内容，绝不能进身份，否则边填边重采就会一直换号。
 */
export function fieldIdentity(raw: RawFormField): string {
  const kind = resolveFieldKind(raw);
  const isToggle = kind === 'radio' || kind === 'checkbox';
  return [
    raw.tag.toLowerCase(),
    (raw.type ?? '').toLowerCase(),
    raw.name ?? '',
    isToggle ? raw.value ?? '' : '',
    raw.href ?? '',
    isToggle ? '' : pickFieldLabel(raw) ?? '',
    raw.formIndex ?? '',
  ].join('|');
}

/** f12 → 12；不是 f 开头的纯数字号（s、t 前缀或异常值）一律返回 0。 */
function fieldNumber(fieldId: string): number {
  const matched = /^f(\d+)$/.exec(fieldId);
  return matched ? Number(matched[1]) : 0;
}

export interface FieldIdAllocation {
  /** 与 raws 同序的 fieldId。 */
  fieldIds: string[];
  /** 与 raws 同序的身份串，存进句柄表供下一次继承。 */
  identities: string[];
  /** 发完这一批之后已经发到第几号；存进 FormFieldTable.issuedThrough。 */
  issuedThrough: number;
}

/**
 * 给这一次采集到的字段发号。previous 是同一标签页上一张句柄表；地址不同即视为另一个页面，
 * 不继承任何号码（旧表本就对着别的页面，硬继承只会张冠李戴）。
 */
export function allocateFieldIds(
  raws: RawFormField[],
  previous: FormFieldTable | undefined,
  currentUrl: string,
  /** 本次采集时的 documentId；单页应用同一文档内改了地址仍继承号码（ref: page-identity.ts）。 */
  currentDocumentId?: string,
): FieldIdAllocation {
  const identities = raws.map(fieldIdentity);
  const inherited = new Map<string, string[]>();
  let maxIssued = 0;

  const samePage = previous !== undefined && isSamePage(previous, { url: currentUrl, documentId: currentDocumentId });
  if (samePage) {
    // 同一页面上号码绝不回头：消失元素的号已不在 fields 里，必须靠 issuedThrough 记住它发过；
    // 旧表没有 identity 也一样——无从继承只意味着这批元素拿新号，不意味着可以重发旧号。
    maxIssued = previous!.issuedThrough ?? 0;
    for (const fieldId of Object.keys(previous!.fields)) {
      maxIssued = Math.max(maxIssued, fieldNumber(fieldId));
    }
    for (const [fieldId, handle] of Object.entries(previous!.fields)) {
      if (fieldNumber(fieldId) === 0) continue;
      // identity 缺失 = 这张表是本次改动之前存下的，无从继承，只能整体退回文档序编号。
      if (!handle.identity) continue;
      const sameIdentity = inherited.get(handle.identity) ?? [];
      sameIdentity.push(fieldId);
      inherited.set(handle.identity, sameIdentity);
    }
  }

  if (inherited.size > 0) {
    // 同一身份的多个元素（列表里一排一模一样的「删除」）按发号顺序对齐第 1、2、3 次出现。
    for (const sameIdentity of inherited.values()) {
      sameIdentity.sort((left, right) => fieldNumber(left) - fieldNumber(right));
    }
  }

  const fieldIds = identities.map((identity) => {
    const candidates = inherited.get(identity);
    const reused = candidates?.shift();
    if (reused) return reused;
    maxIssued += 1;
    return `f${maxIssued}`;
  });

  return { fieldIds, identities, issuedThrough: maxIssued };
}

export interface ComposeFieldTableInput {
  previous: FormFieldTable | undefined;
  /** 这一次采集到的页面身份。 */
  page: PageIdentity;
  /** 这一次采集发出的句柄（f*、s*，以及写操作后内部重采保留的 t*）。 */
  handles: Record<string, FormFieldHandle>;
  /** 这一次采集的全部指纹（按文档序）。 */
  fingerprints: string[];
  /** allocateFieldIds 返回的 issuedThrough。 */
  issuedThrough: number;
  /** 是否只采了 selector 指定的那一块。 */
  scoped: boolean;
}

/**
 * 这一次采集之后要存的句柄表。
 *
 * 带 selector 的读取只看到页面的一小块，不能拿它覆盖整张表：2026-10-07 第三份开端口导出里
 * 模型用 selector 只读弹窗、读到 0 个元素，刚报给它的端口输入框和「确定」的 fieldId 随即作废，
 * 下一次完整读取又从小号重编，同一个 f107 先后指向两个不同的元素。所以同一页面上的范围读取
 * 并入旧表：范围外的旧句柄照留（写入前仍逐个校验 path + 结构指纹，失效的报 not_found /
 * mismatch，不会落到别处）；「新出现元素」的基线也不动，否则下一次完整读取会把范围外的一切
 * 都当成新元素。s* 是按位置发的号，不跨调用保留——与完整读取一致。
 *
 * 完整读取、或者已经换了页面时，整表替换。已发号同一页面上只增不减。
 */
export function composeFieldTable(input: ComposeFieldTableInput): FormFieldTable {
  const { previous, page, handles, fingerprints, scoped } = input;
  const samePage = previous !== undefined && isSamePage(previous, page);
  const issuedThrough = samePage ? Math.max(input.issuedThrough, previous!.issuedThrough ?? 0) : input.issuedThrough;

  if (!scoped || !samePage) {
    return { url: page.url, documentId: page.documentId, fields: handles, fingerprints, issuedThrough };
  }

  const kept = Object.fromEntries(Object.entries(previous!.fields).filter(([fieldId]) => fieldId.startsWith('f')));
  return {
    url: page.url,
    documentId: page.documentId,
    fields: { ...kept, ...handles },
    fingerprints: previous!.fingerprints,
    issuedThrough,
  };
}
