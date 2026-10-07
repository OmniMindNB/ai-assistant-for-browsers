// 注入页面执行的函数（browser.scripting.executeScript 的 func）被序列化成源码送进页面，函数体外的
// 一切绑定——模块顶层常量、import 进来的函数——在页面里都不存在。单元测试直接调用这些函数，模块
// 作用域还在，所以违反这条约束的代码照样全绿。
//
// 2026-10-07 四份开端口导出里 browser_find_text 每次都「命中 0 个」：findTextInPage 引用了三个
// 模块顶层常量，打包后变成 w2e/S2e/C2e，在页面里一执行就 ReferenceError；executeInAllFrames 把
// 出错的帧静默过滤掉，结果只剩一个空数组——这个工具在生产构建里从来没有工作过。
//
// 这里对每个注入函数做静态检查：解析它运行时的源码（fn.toString()，和 executeScript 拿到的是同一份），
// 找出函数内没有声明、也不是页面全局的标识符。新增注入函数时把它加进 INJECTED。
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  applyFormFill,
  clickElementInPage,
  collectFormFields,
  pressKeyInPage,
  probeClickTarget,
  probeKeyTarget,
  scrollContainerInPage,
  scrollPageInPage,
  selectOptionInPage,
  typeTextInPage,
} from './form-dom';
import { findTextInPage } from './find-text-dom';
import { waitForConditionInPage } from './wait-dom';

const INJECTED: Record<string, (...args: never[]) => unknown> = {
  applyFormFill,
  clickElementInPage,
  collectFormFields,
  pressKeyInPage,
  probeClickTarget,
  probeKeyTarget,
  scrollContainerInPage,
  scrollPageInPage,
  selectOptionInPage,
  typeTextInPage,
  findTextInPage,
  waitForConditionInPage,
};

/**
 * 函数源码里引用了、却既没在函数内声明、也不是全局的标识符。作用域按「整个函数里声明过就算」
 * 近似处理：只会漏报（某个名字在别的块里声明过），不会误报。
 */
function freeIdentifiers(source: string): string[] {
  const file = ts.createSourceFile('injected.js', `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declared = new Set<string>();
  const referenced = new Set<string>();

  const declare = (name: ts.BindingName | ts.Identifier | undefined) => {
    if (!name) return;
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) declare(element.name);
  };

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) declare(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name) declare(node.name);
    if (ts.isCatchClause(node) && node.variableDeclaration) declare(node.variableDeclaration.name);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
      if (!isPropertyName) referenced.add(node.text);
      if (ts.isShorthandPropertyAssignment(parent)) referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return [...referenced].filter((name) => !declared.has(name) && !(name in globalThis) && name !== 'undefined' && name !== 'arguments');
}

describe('注入页面的函数不得引用函数体外的绑定', () => {
  it.each(Object.entries(INJECTED))('%s', (_name, fn) => {
    expect(freeIdentifiers(fn.toString())).toEqual([]);
  });

  // 守卫本身得能抓住这类问题，否则它全绿也说明不了什么。
  it('能识别出引用模块顶层常量的函数', () => {
    expect(freeIdentifiers('(input) => input.length > SOME_MODULE_CAP')).toEqual(['SOME_MODULE_CAP']);
    expect(freeIdentifiers('(input) => { const cap = 5; return input.slice(0, cap).map((x) => ({ x })); }')).toEqual([]);
  });
});

describe('findTextInPage 按序列化语义重建后照样能用', () => {
  it('从源码重建（模块作用域不在了）后仍能找到页面上的文字', () => {
    document.body.innerHTML = '<table><tbody><tr><td><span>6000</span></td><td>开放6000端口</td></tr></tbody></table>';
    // executeScript 做的就是这件事：只带走函数源码，在页面里重新求值。
    const rebuilt = new Function(`return (${findTextInPage.toString()})`)() as typeof findTextInPage;
    const output = rebuilt({ text: '6000', mode: 'contains' }, { text: '6000', mode: 'contains' });
    expect(output.matches.map((match) => match.text)).toEqual(['6000', '开放6000端口']);
  });
});
