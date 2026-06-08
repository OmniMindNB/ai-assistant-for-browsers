// 注入脚本的静态安全校验（ref: technical-plan.md §4.2 安全要点）。
// 用 acorn 解析 LLM 生成的脚本，校验语法并扫描危险 API。
// 结果仅用于向用户提示风险，最终是否执行由用户确认。

import { parse, type Node } from 'acorn';

export interface SecurityIssue {
  level: 'danger' | 'warn';
  message: string;
}

export interface SecurityReport {
  /** 语法是否合法 */
  valid: boolean;
  syntaxError?: string;
  issues: SecurityIssue[];
}

// 危险的成员访问（对象.属性）
const DANGEROUS_MEMBERS: Record<string, SecurityIssue> = {
  'document.cookie': { level: 'danger', message: '访问 document.cookie（可能窃取登录态）' },
  'localStorage.getItem': { level: 'warn', message: '读取 localStorage' },
  'sessionStorage.getItem': { level: 'warn', message: '读取 sessionStorage' },
  'navigator.sendBeacon': { level: 'danger', message: '使用 navigator.sendBeacon 外发数据' },
};

// 危险的标识符 / 调用
const DANGEROUS_CALLEES: Record<string, SecurityIssue> = {
  eval: { level: 'danger', message: '使用 eval 执行动态代码' },
  Function: { level: 'warn', message: '使用 Function 构造器动态执行代码' },
  fetch: { level: 'warn', message: '发起 fetch 网络请求（注意数据外发）' },
  XMLHttpRequest: { level: 'warn', message: '发起 XHR 网络请求（注意数据外发）' },
  importScripts: { level: 'danger', message: '加载外部脚本' },
};

function memberPath(node: any): string | null {
  if (node.type !== 'MemberExpression' || node.computed) return null;
  const objName =
    node.object.type === 'Identifier'
      ? node.object.name
      : node.object.type === 'MemberExpression'
        ? memberPath(node.object)
        : null;
  if (!objName) return null;
  return `${objName}.${node.property.name}`;
}

function walk(node: Node | null | undefined, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = (node as any)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visit);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

export function analyzeScript(code: string): SecurityReport {
  const issues: SecurityIssue[] = [];
  const seen = new Set<string>();

  const push = (issue: SecurityIssue) => {
    const key = `${issue.level}:${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  let ast: Node;
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    return {
      valid: false,
      syntaxError: e instanceof Error ? e.message : String(e),
      issues,
    };
  }

  walk(ast, (n) => {
    // new Function(...) / Function(...)
    if (
      (n.type === 'NewExpression' || n.type === 'CallExpression') &&
      n.callee?.type === 'Identifier' &&
      DANGEROUS_CALLEES[n.callee.name]
    ) {
      push(DANGEROUS_CALLEES[n.callee.name]);
    }
    // 成员访问扫描
    if (n.type === 'MemberExpression') {
      const path = memberPath(n);
      if (path && DANGEROUS_MEMBERS[path]) push(DANGEROUS_MEMBERS[path]);
    }
    // 标识符直接引用（如裸 eval 赋值）
    if (n.type === 'Identifier' && DANGEROUS_CALLEES[n.name]) {
      push(DANGEROUS_CALLEES[n.name]);
    }
  });

  return { valid: true, issues };
}
