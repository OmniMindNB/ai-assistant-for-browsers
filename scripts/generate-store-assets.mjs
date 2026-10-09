import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = join(root, 'docs', 'store-assets');
const icon = `data:image/png;base64,${readFileSync(join(assetRoot, 'icon-128.png')).toString('base64')}`;

// 截图顺序即商店展示顺序：第一张承担大部分转化，所以放差异化最强的“自动填表”，
// 人人都有的“总结问答”放最后。界面文案（确认卡片、保存为指令、快捷指令名、划词气泡）
// 与 lib/i18n 中的真实文案保持一致，页面一律用 example.com 下不带品牌的虚构站点。
const SCENES = [
  ['autofill', 'screenshot-01-autofill.png'],
  ['automation', 'screenshot-02-automation.png'],
  ['replay', 'screenshot-03-replay.png'],
  ['confirm', 'screenshot-04-confirm.png'],
  ['summary', 'screenshot-05-summary.png'],
];

const locales = {
  en: {
    tagline: 'Autofill forms. Automate the web.',
    panel: 'Current page',
    composer: 'Ask about this page, or type / for shortcuts…',
    form: {
      crumb: 'CUSTOMERS / NEW CUSTOMER',
      title: 'New customer',
      fields: [
        { label: 'Company', value: 'Bluewave Trading Ltd.' },
        { label: 'Contact', value: 'Alex Morgan' },
        { label: 'Phone', value: '(555) 010-2048' },
        { label: 'Email', value: 'alex@example.com' },
        { label: 'Customer type', value: 'Business', select: true },
        { label: 'Region', value: 'California', select: true },
        { label: 'Address', value: '100 Market Street, San Francisco', full: true },
        { label: 'Notes', placeholder: 'Optional', full: true },
      ],
      cancel: 'Cancel',
      save: 'Save customer',
    },
    list: {
      crumb: 'PRODUCTS / ALL PRODUCTS',
      title: 'Products',
      tabs: { running: ['All 36', 'Pending 8', 'Live 28'], done: ['All 36', 'Pending 2', 'Live 34'] },
      batch: 'Publish selected',
      columns: ['Product', 'SKU', 'Stock', 'Status'],
      pending: 'Pending',
      live: 'Live',
      count: '8 items',
      products: [
        ['Noise-cancelling Headphones', 'SKU-1024', 128],
        ['Portable Speaker', 'SKU-1031', 56],
        ['Mechanical Keyboard', 'SKU-1045', 0],
        ['Ergonomic Mouse', 'SKU-1052', 240],
        ['USB-C Dock', 'SKU-1060', 33],
        ['Monitor Arm', 'SKU-1077', 0],
        ['Desk Organizer', 'SKU-1083', 90],
        ['Wrist Rest', 'SKU-1091', 15],
      ],
    },
    article: {
      crumb: 'COLUMN · 8 MIN READ',
      title: 'A Practical Guide to Async Teamwork',
      sections: [
        ['1. Write it down before you meet', [
          'Turn every discussion into a one-page doc with context, options, and your',
          'recommendation. Comment in the doc first; meet only on open disagreements.',
        ]],
        ['2. Agree on response times', [
          'Async does not mean always online. Reply to regular messages within 24 hours',
          'and use a phone call for anything urgent.',
        ]],
        ['3. Keep decisions in the doc', [
          'Record each decision with the reason and an owner at the end of the doc,',
          'so new teammates never need to dig through chat history.',
        ]],
      ],
      selection: 'and use a phone call for anything urgent.',
      bubble: 'Ask Runi',
    },
    scenes: {
      autofill: {
        headline: 'Autofill forms in one sentence',
        subtitle: 'Finds the fields, fills them, and reads every value back — dropdowns too',
        url: 'crm.example.com/customers/new',
        overlay: 'Filling 7 fields',
        user: [
          'Create a customer: Bluewave Trading Ltd.,',
          'contact Alex Morgan, (555) 010-2048,',
          'alex@example.com, business, 100 Market',
          'Street, San Francisco, California',
        ],
        steps: [['Read form', '8 fields'], ['Filled 7 fields', ''], ['Read back & verify', '7/7 match']],
        answer: {
          title: 'Customer details filled in',
          lines: ['All 7 fields written and verified.', 'Notes left blank; saving will ask you first.'],
        },
      },
      automation: {
        headline: 'Multi-step web tasks, done for you',
        subtitle: 'Switch tabs, filter, select, click — describe it once and Runi runs it through',
        url: 'shop.example.com/admin/products',
        overlay: 'Clicking "Publish selected"',
        user: ['Publish all pending products with stock'],
        steps: [
          ['Open the Pending tab', '8 items'],
          ['Read list, keep stock > 0', '6 items'],
          ['Select 6 products', ''],
          ['Clicking "Publish selected"', '', 'running'],
        ],
      },
      replay: {
        headline: 'Do it once, replay it anytime',
        subtitle: 'Save a successful run as a task, then run it again with /',
        url: 'shop.example.com/admin/products',
        user: ['Publish all pending products with stock'],
        answer: { title: '6 products are now live', lines: ['2 out-of-stock items stay pending.'] },
        actions: ['Copy', 'Regenerate', 'Save as task'],
        palette: {
          header: 'Shortcuts',
          rows: [['Publish in-stock products', 'Saved'], ['New customer', 'Saved'], ['Summarize page', ''], ['Fill this form', '']],
        },
      },
      confirm: {
        headline: 'You stay in control',
        subtitle: 'Form submissions always wait for you, and you can take over anytime',
        url: 'crm.example.com/customers/new',
        overlay: 'Waiting for your approval',
        user: ['Save this customer'],
        card: {
          title: '🔒 Confirm form submission',
          body: ['Submit the "New customer" form on', 'crm.example.com with 7 filled fields.'],
          approve: 'Submit form',
          deny: 'Deny',
          hint: ['Every detected submission asks separately.'],
        },
        note: {
          title: '✋ Take over anytime',
          lines: ['Touch the mouse or keyboard and Runi pauses,', 'then asks whether to continue or stop.'],
        },
      },
      summary: {
        headline: 'Summarize, translate, ask across tabs',
        subtitle: 'Answers grounded in the page — attach PDFs and images, or reference other tabs',
        url: 'blog.example.com/async-teamwork',
        chips: [['PDF', 'team-handbook.pdf'], ['@', 'Sync notes']],
        user: ['Using the handbook and sync notes, which of', 'these ideas should our team start with?'],
        answer: {
          title: 'Start with these three',
          bullets: [
            'Write a one-page agenda before each sync',
            'Adopt the 24-hour reply rule',
            'Log every decision in the sync notes',
          ],
          footer: 'Sources: page · team-handbook.pdf · @Sync notes',
        },
      },
    },
  },
  'zh-CN': {
    tagline: '一句话自动填表、操作网页。',
    panel: '当前网页',
    composer: '询问当前网页，或输入 / 使用指令…',
    form: {
      crumb: '客户管理 / 新建客户',
      title: '新建客户',
      fields: [
        { label: '客户名称', value: '上海云帆贸易有限公司' },
        { label: '联系人', value: '王晓明' },
        { label: '手机号', value: '138 0013 8000' },
        { label: '邮箱', value: 'wang@example.com' },
        { label: '客户类型', value: '企业客户', select: true },
        { label: '所属地区', value: '上海市', select: true },
        { label: '详细地址', value: '上海市浦东新区世纪大道 100 号', full: true },
        { label: '备注', placeholder: '选填', full: true },
      ],
      cancel: '取消',
      save: '保存客户',
    },
    list: {
      crumb: '商品管理 / 全部商品',
      title: '商品列表',
      tabs: { running: ['全部 36', '待上架 8', '已上架 28'], done: ['全部 36', '待上架 2', '已上架 34'] },
      batch: '批量上架',
      columns: ['商品名称', '编码', '库存', '状态'],
      pending: '待上架',
      live: '已上架',
      count: '共 8 条',
      products: [
        ['无线降噪耳机 Pro', 'SKU-1024', 128],
        ['便携蓝牙音箱', 'SKU-1031', 56],
        ['机械键盘 87 键', 'SKU-1045', 0],
        ['人体工学鼠标', 'SKU-1052', 240],
        ['USB-C 扩展坞', 'SKU-1060', 33],
        ['显示器支架', 'SKU-1077', 0],
        ['桌面收纳盒', 'SKU-1083', 90],
        ['硅胶腕托', 'SKU-1091', 15],
      ],
    },
    article: {
      crumb: '专栏 · 阅读约 8 分钟',
      title: '远程团队的异步协作指南',
      sections: [
        ['1. 先写下来，再开会', [
          '需要讨论的问题先写成一页文档，列出背景、可选方案和你的倾向。',
          '参会者提前阅读并在文档里留言，会议只用来解决仍有分歧的部分。',
        ]],
        ['2. 约定响应时间', [
          '异步不等于随时在线。约定普通消息 24 小时内回复，紧急事项打电话，',
          '大家就不必一直盯着聊天工具。',
        ]],
        ['3. 把决策留在文档里', [
          '每次做出决定，都在文档末尾记下结论、原因和负责人。',
          '新成员不用翻聊天记录，也能知道事情为什么是现在这样。',
        ]],
      ],
      selection: '大家就不必一直盯着聊天工具。',
      bubble: '问 Runi',
    },
    scenes: {
      autofill: {
        headline: '一句话自动填表',
        subtitle: '识别字段、逐项填写并读回核对，下拉框和自研组件也能处理',
        url: 'crm.example.com/customers/new',
        overlay: '正在填写 7 个字段',
        user: [
          '用这段信息新建客户：上海云帆贸易有限公司，',
          '联系人王晓明，138 0013 8000，',
          'wang@example.com，企业客户，',
          '地址上海市浦东新区世纪大道 100 号',
        ],
        steps: [['读取表单', '8 个字段'], ['已填写 7 个字段', ''], ['读回核对', '7/7 一致']],
        answer: {
          title: '客户信息已填好',
          lines: ['7 个字段已写入并逐项核对一致。', '备注留空；点击保存时会先请你确认。'],
        },
      },
      automation: {
        headline: '多步网页操作，自动完成',
        subtitle: '切换、筛选、勾选、点击——说一次，Runi 连续执行到底',
        url: 'shop.example.com/admin/products',
        overlay: '正在点击「批量上架」',
        user: ['把库存大于 0 的待上架商品批量上架'],
        steps: [
          ['切换到「待上架」', '8 件'],
          ['读取列表，筛出库存 > 0', '6 件'],
          ['勾选 6 件商品', ''],
          ['正在点击「批量上架」', '', 'running'],
        ],
      },
      replay: {
        headline: '做过一次，下次一键重放',
        subtitle: '把成功的操作保存为指令，输入 / 即可再次执行',
        url: 'shop.example.com/admin/products',
        user: ['把库存大于 0 的待上架商品批量上架'],
        answer: { title: '6 件商品已上架', lines: ['库存为 0 的 2 件商品保持待上架。'] },
        actions: ['复制', '重新生成', '保存为指令'],
        palette: {
          header: '快捷指令',
          rows: [['批量上架有库存的商品', '已保存'], ['新建客户', '已保存'], ['总结本页', ''], ['帮我填表', '']],
        },
      },
      confirm: {
        headline: '始终由你掌控',
        subtitle: '表单提交前一定先问你，执行中随时可以接手',
        url: 'crm.example.com/customers/new',
        overlay: '等待你确认提交',
        user: ['保存这个客户'],
        card: {
          title: '🔒 请确认表单提交',
          body: ['向 crm.example.com 提交「新建客户」表单，', '包含 7 个已填写的字段。'],
          approve: '确认提交',
          deny: '拒绝',
          hint: ['检测到的表单提交会逐次确认，避免意外发送数据。'],
        },
        note: {
          title: '✋ 随时接手',
          lines: ['你一动鼠标或键盘，Runi 就会暂停，', '问你是继续还是到此为止。'],
        },
      },
      summary: {
        headline: '总结、翻译、跨标签页问答',
        subtitle: '基于页面原文回答，也可附加 PDF、图片或引用其他标签页',
        url: 'blog.example.com/async-teamwork',
        chips: [['PDF', '团队手册.pdf'], ['@', '周会纪要']],
        user: ['结合附件和周会纪要，这篇文章里哪些建议', '最适合我们团队先做？'],
        answer: {
          title: '建议先做这三件事',
          bullets: ['周会前先写一页议题文档（第 1 节）', '约定 24 小时回复，与手册的值班规则一致', '决策统一记到周会纪要末尾'],
          footer: '依据：当前网页 · 团队手册.pdf · @周会纪要',
        },
      },
    },
  },
};

const esc = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const text = (x, y, value, options = '') => `<text x="${x}" y="${y}" ${options}>${esc(value)}</text>`;

// resvg 没有文本测量 API，按字符粗估宽度：CJK 记一个字号宽，其余记 0.58 个字号。
// 只用来定气泡宽度和检查溢出，略偏宽，宁可气泡留白也不让文字出框。
function textWidth(value, size) {
  let width = 0;
  for (const ch of String(value)) width += /[⺀-￿]/.test(ch) ? size : size * 0.58;
  return width;
}

// 文案是手工断行的，换语言或改措辞时最容易悄悄溢出；出图时直接报出来，而不是等肉眼发现。
const overflows = [];
function fit(value, size, maxWidth, where) {
  if (textWidth(value, size) > maxWidth) overflows.push(`${where}: “${value}”`);
  return value;
}

const commonDefs = `
  <defs>
    <linearGradient id="brandBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07132f"/><stop offset="0.58" stop-color="#0a2858"/><stop offset="1" stop-color="#0e3b73"/>
    </linearGradient>
    <linearGradient id="pageBg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#fbfcfe"/><stop offset="1" stop-color="#f1f5f9"/>
    </linearGradient>
    <radialGradient id="glow" cx="84%" cy="4%" r="50%"><stop stop-color="#3f92ff" stop-opacity=".38"/><stop offset="1" stop-color="#3f92ff" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#fff" stroke-opacity=".035"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000617" flood-opacity=".38"/></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#0f172a" flood-opacity=".16"/></filter>
    <clipPath id="captureClip"><rect x="64" y="205" width="1152" height="545" rx="22"/></clipPath>
  </defs>`;

// ---------------------------------------------------------------------------
// 通用小部件
// ---------------------------------------------------------------------------

const PAGE = { x: 64, y: 243, w: 762, h: 507 };
const BUBBLE = { x: 853, w: 330, right: 1183 };

function checkIcon(cx, cy, r = 8) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#10b981"/><path d="M${cx - r * 0.42} ${cy}l${r * 0.3} ${r * 0.3} ${r * 0.55} -${r * 0.6}" fill="none" stroke="#fff" stroke-width="${r * 0.24}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function cursor(x, y, ripple = false) {
  const rings = ripple
    ? `<circle cx="${x}" cy="${y}" r="18" fill="#6366f1" fill-opacity=".14"/><circle cx="${x}" cy="${y}" r="10" fill="none" stroke="#6366f1" stroke-opacity=".55" stroke-width="2"/>`
    : '';
  return `${rings}<path transform="translate(${x} ${y})" d="M0 0V19L5 14.5L8.4 22L11.2 20.8L7.8 13.4H14.2Z" fill="#0f172a" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>`;
}

// 执行期浮层：与 agent-overlay.ts 一致，是一圈不挡操作的发光描边加顶部状态标签。
function overlay(label) {
  const width = textWidth(label, 11) + 40;
  const x = PAGE.x + PAGE.w / 2 - width / 2;
  return `<rect x="${PAGE.x + 2}" y="${PAGE.y + 2}" width="${PAGE.w - 4}" height="${PAGE.h - 4}" fill="none" stroke="#6366f1" stroke-opacity=".14" stroke-width="10"/>
    <rect x="${PAGE.x + 1.5}" y="${PAGE.y + 1.5}" width="${PAGE.w - 3}" height="${PAGE.h - 3}" fill="none" stroke="#6366f1" stroke-opacity=".7" stroke-width="3"/>
    <rect x="${x}" y="${PAGE.y + 10}" width="${width}" height="26" rx="13" fill="#4f46e5" filter="url(#soft)"/>
    <circle cx="${x + 15}" cy="${PAGE.y + 23}" r="3.5" fill="#a5f3fc"/>
    ${text(x + 26, PAGE.y + 27, label, 'class="overlay-label"')}`;
}

function pageHeading(crumb, title) {
  return `${text(100, 292, crumb, 'class="kicker"')}${text(100, 328, title, 'class="page-title"')}`;
}

// ---------------------------------------------------------------------------
// 左侧网页
// ---------------------------------------------------------------------------

function pageForm(c, mode) {
  const f = c.form;
  let markup = pageHeading(f.crumb, f.title);
  markup += `<rect x="100" y="344" width="690" height="394" rx="16" fill="#fff" stroke="#e2e8f0"/>`;
  let row = 0;
  let col = 0;
  const boxes = [];
  for (const field of f.fields) {
    if (field.full && col === 1) {
      row += 1;
      col = 0;
    }
    const labelY = 376 + row * 62;
    const x = field.full ? 124 : col === 0 ? 124 : 462;
    const w = field.full ? 642 : 304;
    boxes.push({ x, y: labelY + 8, w, h: 34 });
    const filled = Boolean(field.value);
    markup += text(x, labelY, field.label, 'class="field-label"');
    markup += `<rect x="${x}" y="${labelY + 8}" width="${w}" height="34" rx="8" fill="${filled ? '#f5f7ff' : '#fff'}" stroke="${filled ? '#a5b4fc' : '#d6dde6'}"/>`;
    markup += filled
      ? text(x + 12, labelY + 30, fit(field.value, 13, w - 60, 'form'), 'class="field-value"')
      : text(x + 12, labelY + 30, field.placeholder, 'class="field-placeholder"');
    if (field.select) {
      markup += `<path d="M${x + w - 24} ${labelY + 21}l5 5 5-5" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (filled) markup += checkIcon(x + w - (field.select ? 46 : 18), labelY + 25, 7);
    if (field.full) {
      row += 1;
      col = 0;
    } else if (col === 0) {
      col = 1;
    } else {
      row += 1;
      col = 0;
    }
  }
  const buttonsY = 376 + row * 62 - 6;
  const saveWidth = textWidth(f.save, 13) + 36;
  const saveX = 766 - saveWidth;
  const cancelWidth = textWidth(f.cancel, 13) + 36;
  const cancelX = saveX - 12 - cancelWidth;
  markup += `<rect x="${cancelX}" y="${buttonsY}" width="${cancelWidth}" height="36" rx="8" fill="#fff" stroke="#d6dde6"/>${text(cancelX + cancelWidth / 2, buttonsY + 23, f.cancel, 'class="button-secondary" text-anchor="middle"')}`;
  if (mode === 'confirm') {
    markup += `<rect x="${saveX - 5}" y="${buttonsY - 5}" width="${saveWidth + 10}" height="46" rx="12" fill="none" stroke="#6366f1" stroke-width="2.5"/>`;
  }
  markup += `<rect x="${saveX}" y="${buttonsY}" width="${saveWidth}" height="36" rx="8" fill="#4f46e5"/>${text(saveX + saveWidth / 2, buttonsY + 23, f.save, 'class="button-primary" text-anchor="middle"')}`;

  if (mode === 'filling') {
    // 高亮框画在刚写完的那个字段上：与 form-dom.ts 一样，框、光标和事件指向同一个元素。
    const target = boxes[6];
    markup += `<rect x="${target.x - 4}" y="${target.y - 4}" width="${target.w + 8}" height="${target.h + 8}" rx="11" fill="none" stroke="#6366f1" stroke-width="2.5"/>`;
    markup += cursor(target.x + target.w * 0.55, target.y + 20);
  } else {
    markup += cursor(saveX + saveWidth * 0.84, buttonsY + 27, true);
  }
  return markup;
}

function pageList(c, mode) {
  const l = c.list;
  let markup = pageHeading(l.crumb, l.title);
  const tabs = l.tabs[mode];
  const activeTab = mode === 'running' ? 1 : 0;
  let tabX = 100;
  tabs.forEach((label, i) => {
    const width = textWidth(label, 12) + 28;
    const active = i === activeTab;
    markup += `<rect x="${tabX}" y="346" width="${width}" height="30" rx="15" fill="${active ? '#1e293b' : '#fff'}" stroke="${active ? '#1e293b' : '#d6dde6'}"/>${text(tabX + width / 2, 365, label, `class="${active ? 'tab-active' : 'tab'}" text-anchor="middle"`)}`;
    tabX += width + 8;
  });
  const batchWidth = textWidth(l.batch, 13) + 36;
  const batchX = 790 - batchWidth;
  if (mode === 'running') {
    markup += `<rect x="${batchX - 5}" y="${341}" width="${batchWidth + 10}" height="44" rx="12" fill="none" stroke="#6366f1" stroke-width="2.5"/>`;
  }
  markup += `<rect x="${batchX}" y="346" width="${batchWidth}" height="34" rx="8" fill="${mode === 'running' ? '#4f46e5' : '#c7d2fe'}"/>${text(batchX + batchWidth / 2, 368, l.batch, 'class="button-primary" text-anchor="middle"')}`;

  markup += `<rect x="100" y="392" width="690" height="312" rx="14" fill="#fff" stroke="#e2e8f0"/>`;
  markup += `<path d="M100 426H790" stroke="#e2e8f0"/>`;
  const cols = [150, 452, 580, 676];
  l.columns.forEach((label, i) => {
    markup += text(cols[i], 414, label, 'class="table-head"');
  });
  markup += `<rect x="118" y="402" width="14" height="14" rx="3.5" fill="#fff" stroke="#94a3b8"/>`;
  l.products.forEach(([name, sku, stock], i) => {
    const top = 426 + i * 34.5;
    const baseline = top + 22;
    const selected = mode === 'running' && stock > 0;
    const live = mode === 'done' && stock > 0;
    if (i > 0) markup += `<path d="M116 ${top}H774" stroke="#f1f5f9"/>`;
    if (selected) markup += `<rect x="101" y="${top + 1}" width="688" height="32.5" fill="#eef2ff"/>`;
    markup += selected
      ? `<rect x="118" y="${top + 10}" width="14" height="14" rx="3.5" fill="#4f46e5"/><path d="M121 ${top + 17}l3 3 5-6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="118" y="${top + 10}" width="14" height="14" rx="3.5" fill="#fff" stroke="#94a3b8"/>`;
    markup += text(cols[0], baseline, fit(name, 13, 290, 'list'), 'class="table-cell"');
    markup += text(cols[1], baseline, sku, 'class="table-muted"');
    markup += text(cols[2], baseline, String(stock), `class="${stock > 0 ? 'table-cell' : 'table-zero'}"`);
    const status = live ? l.live : l.pending;
    const statusWidth = textWidth(status, 11) + 18;
    markup += `<rect x="${cols[3]}" y="${top + 8}" width="${statusWidth}" height="20" rx="10" fill="${live ? '#d1fae5' : '#fef3c7'}"/>${text(cols[3] + statusWidth / 2, top + 22, status, `class="${live ? 'badge-live' : 'badge-pending'}" text-anchor="middle"`)}`;
  });
  markup += text(790, 728, l.count, 'class="table-muted" text-anchor="end"');
  if (mode === 'running') markup += cursor(batchX + batchWidth * 0.84, 373, true);
  return markup;
}

function pageArticle(c) {
  const a = c.article;
  let markup = `${text(100, 292, a.crumb, 'class="kicker"')}${text(100, 330, a.title, 'class="article-title"')}`;
  let y = 382;
  a.sections.forEach(([heading, lines], i) => {
    markup += text(100, y, heading, 'class="article-heading"');
    y += 28;
    lines.forEach((line, j) => {
      if (i === 1 && j === lines.length - 1) {
        // 选区放在段落最后一行，气泡浮在选区下方的段间空白里，不压住正文和小标题。
        const width = textWidth(a.selection, 13.5);
        markup += `<rect x="98" y="${y - 16}" width="${width + 4}" height="22" rx="3" fill="#bfdbfe"/>`;
        // 划词提问气泡：与 content.ts 渲染的“问 Runi”气泡同一形态。
        const bubbleWidth = textWidth(a.bubble, 12) + 40;
        const bubbleX = 100 + width / 2 - bubbleWidth / 2;
        markup += `<g filter="url(#soft)"><rect x="${bubbleX}" y="${y + 16}" width="${bubbleWidth}" height="28" rx="14" fill="#4f46e5"/></g>
          <path d="M${100 + width / 2 - 6} ${y + 16.5}l6 -6 6 6Z" fill="#4f46e5"/>
          <image href="${icon}" x="${bubbleX + 7}" y="${y + 21}" width="18" height="18"/>
          ${text(bubbleX + 30, y + 34.5, a.bubble, 'class="ask-bubble"')}`;
      }
      markup += text(100, y, fit(line, 13.5, 690, 'article'), 'class="article-copy"');
      y += 24;
    });
    y += i === 1 ? 52 : 24;
  });
  return markup;
}

// ---------------------------------------------------------------------------
// 右侧侧边栏：组件自上而下堆叠，每个返回 [markup, height]
// ---------------------------------------------------------------------------

function userMessage(lines, chips = []) {
  return (y) => {
    let markup = '';
    let offset = 0;
    if (chips.length) {
      let x = BUBBLE.right;
      for (const [kind, label] of [...chips].reverse()) {
        const width = textWidth(label, 10.5) + 44;
        x -= width;
        const badge = kind === 'PDF'
          ? `<rect x="${x + 7}" y="${y + 5}" width="22" height="18" rx="4" fill="#ef4444"/>${text(x + 18, y + 17.5, 'PDF', 'class="chip-kind" text-anchor="middle"')}`
          : `<rect x="${x + 7}" y="${y + 5}" width="22" height="18" rx="4" fill="#0ea5e9"/>${text(x + 18, y + 18, '@', 'class="chip-kind-at" text-anchor="middle"')}`;
        markup += `<rect x="${x}" y="${y}" width="${width}" height="28" rx="9" fill="#fff" stroke="#dbe2ea"/>${badge}${text(x + 36, y + 18.5, label, 'class="chip-label"')}`;
        x -= 6;
      }
      offset = 36;
    }
    const width = Math.min(BUBBLE.w, Math.max(...lines.map((line) => textWidth(line, 12))) + 28);
    const height = lines.length * 19 + 17;
    const x = BUBBLE.right - width;
    markup += `<rect x="${x}" y="${y + offset}" width="${width}" height="${height}" rx="14" fill="#4f46e5"/>`;
    lines.forEach((line, i) => {
      markup += text(x + 14, y + offset + 23 + i * 19, fit(line, 12, BUBBLE.w - 28, 'user'), 'class="user-copy"');
    });
    return [markup, offset + height];
  };
}

function steps(items) {
  return (y) => {
    const height = items.length * 30 + 12;
    let markup = `<rect x="${BUBBLE.x}" y="${y}" width="${BUBBLE.w}" height="${height}" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>`;
    items.forEach(([label, detail, state], i) => {
      const cy = y + 6 + i * 30 + 15;
      if (i < items.length - 1) markup += `<path d="M873 ${cy + 9}V${cy + 21}" stroke="#cbd5e1" stroke-width="1.5"/>`;
      markup += state === 'running'
        ? `<circle cx="873" cy="${cy}" r="8" fill="#eef2ff" stroke="#6366f1" stroke-width="1.6"/><circle cx="873" cy="${cy}" r="3" fill="#6366f1"/>`
        : checkIcon(873, cy);
      markup += text(890, cy + 4, fit(label, 11.5, 200, 'step'), `class="${state === 'running' ? 'step-running' : 'step-label'}"`);
      if (detail) markup += text(BUBBLE.right - 14, cy + 4, detail, 'class="step-detail" text-anchor="end"');
    });
    return [markup, height];
  };
}

function answer({ title, lines = [], bullets = [], footer }) {
  return (y) => {
    let markup = text(BUBBLE.x + 18, y + 27, title, 'class="answer-title"');
    let cursorY = y + 52;
    for (const line of lines) {
      markup += text(BUBBLE.x + 18, cursorY, fit(line, 11.5, BUBBLE.w - 36, 'answer'), 'class="answer-copy"');
      cursorY += 20;
    }
    for (const line of bullets) {
      markup += `<circle cx="${BUBBLE.x + 22}" cy="${cursorY - 4}" r="2.6" fill="#4f46e5"/>`;
      markup += text(BUBBLE.x + 32, cursorY, fit(line, 11.5, BUBBLE.w - 50, 'bullet'), 'class="answer-copy"');
      cursorY += 21;
    }
    if (footer) {
      markup += `<path d="M${BUBBLE.x + 18} ${cursorY - 4}H${BUBBLE.right - 18}" stroke="#e2e8f0"/>`;
      markup += text(BUBBLE.x + 18, cursorY + 14, fit(footer, 10, BUBBLE.w - 36, 'footer'), 'class="answer-footer"');
      cursorY += 22;
    }
    const height = cursorY - y - 2;
    return [`<rect x="${BUBBLE.x}" y="${y}" width="${BUBBLE.w}" height="${height}" rx="14" fill="#f8fafc" stroke="#e2e8f0"/>${markup}`, height];
  };
}

function actions(labels) {
  return (y) => {
    let markup = '';
    let x = BUBBLE.x;
    labels.forEach((label, i) => {
      const highlighted = i === labels.length - 1;
      const width = textWidth(label, 11) + 24;
      markup += `<rect x="${x}" y="${y}" width="${width}" height="26" rx="13" fill="${highlighted ? '#eef2ff' : '#fff'}" stroke="${highlighted ? '#6366f1' : '#dbe2ea'}" stroke-width="${highlighted ? 1.6 : 1}"/>${text(x + width / 2, y + 17, label, `class="${highlighted ? 'action-hot' : 'action'}" text-anchor="middle"`)}`;
      if (highlighted) markup += cursor(x + width * 0.94, y + 22, true);
      x += width + 8;
    });
    return [markup, 26];
  };
}

function confirmCard(card) {
  return (y) => {
    let markup = text(BUBBLE.x + 18, y + 28, card.title, 'class="confirm-title"');
    card.body.forEach((line, i) => {
      markup += text(BUBBLE.x + 18, y + 54 + i * 19, fit(line, 11.5, BUBBLE.w - 36, 'confirm'), 'class="confirm-copy"');
    });
    const buttonsY = y + 54 + card.body.length * 19 + 4;
    const approveWidth = textWidth(card.approve, 11.5) + 32;
    const denyWidth = textWidth(card.deny, 11.5) + 32;
    markup += `<rect x="${BUBBLE.x + 18}" y="${buttonsY}" width="${approveWidth}" height="32" rx="8" fill="#059669"/>${text(BUBBLE.x + 18 + approveWidth / 2, buttonsY + 21, card.approve, 'class="confirm-button" text-anchor="middle"')}`;
    markup += `<rect x="${BUBBLE.x + 26 + approveWidth}" y="${buttonsY}" width="${denyWidth}" height="32" rx="8" fill="#fff" stroke="#cbd5e1"/>${text(BUBBLE.x + 26 + approveWidth + denyWidth / 2, buttonsY + 21, card.deny, 'class="deny-button" text-anchor="middle"')}`;
    let cursorY = buttonsY + 54;
    for (const line of card.hint) {
      markup += text(BUBBLE.x + 18, cursorY, fit(line, 10, BUBBLE.w - 36, 'hint'), 'class="confirm-hint"');
      cursorY += 16;
    }
    const height = cursorY - y;
    return [`<rect x="${BUBBLE.x}" y="${y}" width="${BUBBLE.w}" height="${height}" rx="14" fill="#fffbeb" stroke="#fbbf24"/>${markup}`, height];
  };
}

function note({ title, lines }) {
  return (y) => {
    let markup = text(BUBBLE.x + 18, y + 26, title, 'class="note-title"');
    lines.forEach((line, i) => {
      markup += text(BUBBLE.x + 18, y + 50 + i * 19, fit(line, 11.5, BUBBLE.w - 36, 'note'), 'class="answer-copy"');
    });
    const height = 50 + lines.length * 19 - 4;
    return [`<rect x="${BUBBLE.x}" y="${y}" width="${BUBBLE.w}" height="${height}" rx="14" fill="#fff" stroke="#e2e8f0"/>${markup}`, height];
  };
}

function stack(blocks, top = 310, gap = 12) {
  let y = top;
  let markup = '';
  for (const block of blocks) {
    const [part, height] = block(y);
    markup += part;
    y += height + gap;
  }
  if (y - gap > 682) overflows.push(`panel: 内容底部 ${y - gap} 超过输入框上沿 682`);
  return markup;
}

// “/” 快捷指令面板，贴着输入框上沿弹出。
function palette({ header, rows }) {
  const height = 30 + rows.length * 34 + 6;
  const top = 683 - height;
  let markup = `<g filter="url(#soft)"><rect x="840" y="${top}" width="362" height="${height}" rx="12" fill="#fff" stroke="#dbe2ea"/></g>`;
  markup += text(856, top + 21, header, 'class="palette-header"');
  rows.forEach(([label, tag], i) => {
    const rowTop = top + 30 + i * 34;
    if (i === 0) markup += `<rect x="846" y="${rowTop}" width="350" height="32" rx="8" fill="#eef2ff"/>`;
    markup += `<rect x="856" y="${rowTop + 7}" width="18" height="18" rx="5" fill="${tag ? '#4f46e5' : '#e2e8f0'}"/>${text(865, rowTop + 20, '/', `class="${tag ? 'palette-icon' : 'palette-icon-muted'}" text-anchor="middle"`)}`;
    markup += text(884, rowTop + 21, label, `class="${i === 0 ? 'palette-hot' : 'palette-row'}"`);
    if (tag) {
      const tagWidth = textWidth(tag, 10) + 16;
      markup += `<rect x="${1184 - tagWidth}" y="${rowTop + 7}" width="${tagWidth}" height="18" rx="9" fill="#e0e7ff"/>${text(1184 - tagWidth / 2, rowTop + 20, tag, 'class="palette-tag" text-anchor="middle"')}`;
    }
  });
  return markup;
}

function composer(c, typed) {
  const content = typed
    ? `${text(879, 717, typed, 'class="composer-typed"')}<path d="M${887 + textWidth(typed, 12)} 705V721" stroke="#4f46e5" stroke-width="1.5"/>`
    : text(879, 716, c.composer, 'class="composer"');
  return `<rect x="840" y="691" width="362" height="43" rx="12" fill="#fff" stroke="${typed ? '#a5b4fc' : '#dbe2ea'}"/>${text(857, 719, '+', 'class="attach-icon"')}${content}`;
}

function sceneContent(locale, sceneName) {
  const c = locales[locale];
  const s = c.scenes[sceneName];
  switch (sceneName) {
    case 'autofill':
      return {
        page: pageForm(c, 'filling') + overlay(s.overlay),
        panel: stack([userMessage(s.user), steps(s.steps), answer(s.answer)]),
        composer: composer(c),
      };
    case 'automation':
      return {
        page: pageList(c, 'running') + overlay(s.overlay),
        panel: stack([userMessage(s.user), steps(s.steps)]),
        composer: composer(c),
      };
    case 'replay':
      return {
        page: pageList(c, 'done'),
        panel: stack([userMessage(s.user), answer(s.answer), actions(s.actions)]) + palette(s.palette),
        composer: composer(c, '/'),
      };
    case 'confirm':
      return {
        page: pageForm(c, 'confirm') + overlay(s.overlay),
        panel: stack([userMessage(s.user), confirmCard(s.card), note(s.note)]),
        composer: composer(c),
      };
    case 'summary':
      return {
        page: pageArticle(c),
        panel: stack([userMessage(s.user, s.chips), answer(s.answer)]),
        composer: composer(c),
      };
    default:
      throw new Error(`unknown scene ${sceneName}`);
  }
}

// resvg 逐字形回退时不沿用 font-weight：Segoe UI 没有中文字形，中文字符回退到 CJK 字体后
// 粗细会丢失，headline 的 font-weight:800 会渲染成常规字重（rsvg-convert 没有这个问题，
// 换渲染器后才暴露出来）。中文素材因此把自带 Bold 的 Microsoft YaHei 放在首位；英文素材
// 维持 Segoe UI 优先，它的 Bold 本来就解析正常。
function fontStack(locale) {
  return locale === 'zh-CN'
    ? '"Microsoft YaHei","Microsoft YaHei UI","Segoe UI",Arial,sans-serif'
    : '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif';
}

function screenshotSvg(locale, sceneName) {
  const c = locales[locale];
  const scene = c.scenes[sceneName];
  const content = sceneContent(locale, sceneName);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
    ${commonDefs}
    <style>
      text{font-family:${fontStack(locale)}}
      .brand{fill:#f8fbff;font-size:20px;font-weight:750}
      .headline{fill:#f8fbff;font-size:44px;font-weight:800;letter-spacing:-1.2px}.subtitle{fill:#cbdcf7;font-size:19px;font-weight:500}
      .toolbar{fill:#64748b;font-size:11.5px;font-weight:600}
      .kicker{fill:#64748b;font-size:11px;font-weight:700;letter-spacing:.8px}.page-title{fill:#0f172a;font-size:26px;font-weight:800}
      .field-label{fill:#334155;font-size:12px;font-weight:650}.field-value{fill:#0f172a;font-size:13px}.field-placeholder{fill:#94a3b8;font-size:13px}
      .button-primary{fill:#fff;font-size:13px;font-weight:700}.button-secondary{fill:#334155;font-size:13px;font-weight:600}
      .tab{fill:#475569;font-size:12px;font-weight:600}.tab-active{fill:#fff;font-size:12px;font-weight:700}
      .table-head{fill:#64748b;font-size:11.5px;font-weight:700}.table-cell{fill:#0f172a;font-size:13px}.table-muted{fill:#64748b;font-size:12px}.table-zero{fill:#dc2626;font-size:13px;font-weight:700}
      .badge-pending{fill:#92400e;font-size:11px;font-weight:700}.badge-live{fill:#065f46;font-size:11px;font-weight:700}
      .article-title{fill:#0f172a;font-size:28px;font-weight:800}.article-heading{fill:#1e293b;font-size:16px;font-weight:750}.article-copy{fill:#475569;font-size:13.5px}
      .ask-bubble{fill:#fff;font-size:12px;font-weight:700}
      .overlay-label{fill:#fff;font-size:11px;font-weight:700}
      .panel-title{fill:#111827;font-size:13px;font-weight:750}.panel-label{fill:#94a3b8;font-size:10.5px;font-weight:650}
      .user-copy{fill:#fff;font-size:12px;font-weight:600}
      .chip-label{fill:#334155;font-size:10.5px;font-weight:650}.chip-kind{fill:#fff;font-size:7.5px;font-weight:800}.chip-kind-at{fill:#fff;font-size:11px;font-weight:800}
      .step-label{fill:#334155;font-size:11.5px;font-weight:600}.step-running{fill:#4338ca;font-size:11.5px;font-weight:700}.step-detail{fill:#64748b;font-size:10.5px}
      .answer-title{fill:#172554;font-size:12.5px;font-weight:750}.answer-copy{fill:#475569;font-size:11.5px}.answer-footer{fill:#64748b;font-size:10px}
      .action{fill:#475569;font-size:11px;font-weight:600}.action-hot{fill:#4338ca;font-size:11px;font-weight:700}
      .confirm-title{fill:#78350f;font-size:12px;font-weight:750}.confirm-copy{fill:#78350f;font-size:11.5px}.confirm-button{fill:#fff;font-size:11.5px;font-weight:700}.deny-button{fill:#475569;font-size:11.5px;font-weight:700}.confirm-hint{fill:#92400e;font-size:10px}
      .note-title{fill:#1e293b;font-size:12px;font-weight:750}
      .palette-header{fill:#94a3b8;font-size:10.5px;font-weight:700}.palette-row{fill:#334155;font-size:12px}.palette-hot{fill:#312e81;font-size:12px;font-weight:700}
      .palette-icon{fill:#fff;font-size:11px;font-weight:800}.palette-icon-muted{fill:#64748b;font-size:11px;font-weight:800}.palette-tag{fill:#4338ca;font-size:10px;font-weight:700}
      .composer{fill:#94a3b8;font-size:11px}.composer-typed{fill:#0f172a;font-size:12px;font-weight:600}.attach-icon{fill:#64748b;font-size:18px;font-weight:500}
    </style>
    <rect width="1280" height="800" fill="url(#brandBg)"/><rect width="1280" height="800" fill="url(#glow)"/><rect width="1280" height="800" fill="url(#grid)"/>
    <image href="${icon}" x="64" y="43" width="36" height="36"/><rect x="64" y="43" width="36" height="36" rx="9" fill="none" stroke="#fff" stroke-opacity=".22"/>
    ${text(112, 68, 'Runi', 'class="brand"')}
    ${text(64, 134, fit(scene.headline, 44, 1152, 'headline'), 'class="headline"')}${text(64, 174, fit(scene.subtitle, 19, 1152, 'subtitle'), 'class="subtitle"')}
    <g filter="url(#shadow)"><rect x="64" y="205" width="1152" height="545" rx="22" fill="#f7f8fb" stroke="#cfe3ff" stroke-opacity=".7"/></g>
    <g clip-path="url(#captureClip)">
      <rect x="64" y="205" width="1152" height="38" fill="#edf1f6"/><path d="M64 243H1216" stroke="#dbe2ea"/>
      <circle cx="81" cy="224" r="3.5" fill="#94a3b8"/><circle cx="93" cy="224" r="3.5" fill="#94a3b8"/><circle cx="105" cy="224" r="3.5" fill="#94a3b8"/>
      <rect x="121" y="212" width="300" height="24" rx="12" fill="#fff" stroke="#d5dde7"/>${text(137, 228, scene.url, 'class="toolbar"')}
      <rect x="${PAGE.x}" y="${PAGE.y}" width="${PAGE.w}" height="${PAGE.h}" fill="url(#pageBg)"/><rect x="826" y="243" width="390" height="507" fill="#fff"/><path d="M826 243V750" stroke="#dce3ec"/>
      ${content.page}
      <rect x="826" y="243" width="390" height="50" fill="#fff"/><path d="M826 293H1216" stroke="#e5e7eb"/>
      <image href="${icon}" x="842" y="253" width="29" height="29"/>${text(880, 273, 'Runi', 'class="panel-title"')}${text(1199, 273, c.panel, 'class="panel-label" text-anchor="end"')}
      ${content.panel}
      ${content.composer}
    </g>
    <rect x="64" y="205" width="1152" height="545" rx="22" fill="none" stroke="#fff" stroke-opacity=".36"/>
  </svg>`;
}

function promoSvg(locale) {
  const c = locales[locale];
  // 小宣传图里的示意窗口画成一张已填好的表单（每个字段带对勾），和第一张截图讲同一件事。
  const fields = [0, 1, 2]
    .map((i) => {
      const y = 58 + i * 36;
      return `<rect x="18" y="${y}" width="40" height="5" rx="2.5" fill="#64748b" opacity=".55"/><rect x="18" y="${y + 10}" width="166" height="18" rx="5" fill="#f5f7ff" stroke="#a5b4fc"/><rect x="26" y="${y + 16.5}" width="${[86, 64, 104][i]}" height="5" rx="2.5" fill="#1e293b" opacity=".75"/>${checkIcon(172, y + 19, 5.5)}`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07142f"/><stop offset=".66" stop-color="#0b2c5e"/><stop offset="1" stop-color="#104276"/></linearGradient><radialGradient id="promoGlow" cx="80%" cy="13%" r="58%"><stop stop-color="#4d9dff" stop-opacity=".4"/><stop offset="1" stop-color="#4d9dff" stop-opacity="0"/></radialGradient><filter id="promoShadow" x="-30%" y="-30%" width="170%" height="190%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-opacity=".36"/></filter></defs>
    <style>text{font-family:${fontStack(locale)}}.promo-brand{fill:#fff;font-size:25px;font-weight:800}.tagline{fill:#d8e8ff;font-size:16px;font-weight:650}</style>
    <rect width="440" height="280" fill="url(#bg)"/><rect width="440" height="280" fill="url(#promoGlow)"/>
    <image href="${icon}" x="32" y="30" width="48" height="48"/>${text(92, 62, 'Runi', 'class="promo-brand"')}${text(33, 106, fit(c.tagline, 16, 380, 'promo'), 'class="tagline"')}
    <g transform="translate(131 122) rotate(-4 165 102)" filter="url(#promoShadow)"><rect width="330" height="205" rx="16" fill="#f3f7fb" stroke="#ddebff"/><rect width="330" height="28" rx="16" fill="#eaf1f8"/><rect y="16" width="330" height="12" fill="#eaf1f8"/><circle cx="14" cy="14" r="3" fill="#91a6bc"/><circle cx="24" cy="14" r="3" fill="#91a6bc"/><circle cx="34" cy="14" r="3" fill="#91a6bc"/>
      <rect y="28" width="206" height="177" fill="#fbfcfe"/><rect x="206" y="28" width="124" height="177" fill="#fff"/><path d="M206 28V205" stroke="#dce6f1"/>
      <rect x="18" y="40" width="70" height="8" rx="4" fill="#0f172a" opacity=".8"/>${fields}
      <rect x="220" y="45" width="96" height="30" rx="9" fill="#4f46e5"/><rect x="230" y="57" width="70" height="5" rx="2.5" fill="#fff" opacity=".85"/>
      <rect x="220" y="85" width="96" height="70" rx="9" fill="#f8fafc" stroke="#e2e8f0"/>${checkIcon(233, 100, 5)}<rect x="243" y="98" width="58" height="5" rx="2.5" fill="#64748b"/>${checkIcon(233, 118, 5)}<rect x="243" y="116" width="48" height="5" rx="2.5" fill="#64748b"/>${checkIcon(233, 136, 5)}<rect x="243" y="134" width="62" height="5" rx="2.5" fill="#64748b"/>
    </g>
    <rect x="369" y="208" width="48" height="48" rx="15" fill="#5ee0be" stroke="#fff" stroke-width="3"/><path d="M383 232l7 7 13-16" fill="none" stroke="#06385c" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// 用 @resvg/resvg-js 而不是 shell 出去调 rsvg-convert：后者在 Windows 上没有任何
// 包管理器提供现成二进制（winget 搜 rsvg/librsvg 均无结果），装它要么拖进整套 MSYS2
// 工具链，要么手动下载来路不明的二进制。resvg-js 是预编译的 npm 依赖，pnpm install
// 之后本机、新机器和 CI 都能直接重出图。
function render(svg, output, width, height) {
  mkdirSync(dirname(output), { recursive: true });
  const rendered = new Resvg(svg, {
    // SVG 根节点已声明 width/height 且 viewBox 同比，按宽定标即可。
    fitTo: { mode: 'width', value: width },
    // 文案用的是 Segoe UI / 微软雅黑 等系统字体；不读系统字体表的话中文会整片渲染成空白。
    font: { loadSystemFonts: true },
  }).render();
  // 商店对截图尺寸是硬性要求（1280x800），渲染结果对不上必须当场炸掉而不是悄悄出一张废图。
  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(`${output}: 期望 ${width}x${height}，实际渲染 ${rendered.width}x${rendered.height}`);
  }
  writeFileSync(output, rendered.asPng());
}

for (const locale of Object.keys(locales)) {
  const destination = join(assetRoot, locale);
  render(promoSvg(locale), join(destination, 'promo-small-440x280.png'), 440, 280);
  for (const [scene, file] of SCENES) {
    render(screenshotSvg(locale, scene), join(destination, file), 1280, 800);
  }
}

if (overflows.length) {
  throw new Error(`以下文案按估算会溢出容器，请改短或改断行：\n${overflows.join('\n')}`);
}

console.log(`Generated ${Object.keys(locales).length * (SCENES.length + 1)} localized Runi store assets.`);
