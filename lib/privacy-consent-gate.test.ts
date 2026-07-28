import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { PRIVACY_CONSENT_KEY, PRIVACY_CONSENT_VERSION } from './privacy-consent';

const hookHarness = vi.hoisted(() => ({
  states: [] as unknown[],
  stateCursor: 0,
  effectCursor: 0,
  effects: [] as Array<() => unknown>,
  effectDependencies: [] as Array<readonly unknown[] | undefined>,
  reset() {
    this.states = [];
    this.stateCursor = 0;
    this.effectCursor = 0;
    this.effects = [];
    this.effectDependencies = [];
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const index = hookHarness.stateCursor++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      return [hookHarness.states[index] as T, (next: T | ((current: T) => T)) => {
        hookHarness.states[index] = typeof next === 'function'
          ? (next as (current: T) => T)(hookHarness.states[index] as T)
          : next;
      }];
    },
    useEffect(effect: () => unknown, dependencies?: readonly unknown[]) {
      const index = hookHarness.effectCursor++;
      const previous = hookHarness.effectDependencies[index];
      const changed = !previous
        || !dependencies
        || previous.length !== dependencies.length
        || previous.some((value, dependencyIndex) => value !== dependencies[dependencyIndex]);
      if (changed) hookHarness.effects.push(effect);
      hookHarness.effectDependencies[index] = dependencies;
    },
  };
});

vi.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    resolved: 'en',
    t: (key: string) => key,
  }),
}));

import PrivacyConsentGate from '@/components/PrivacyConsentGate';

type GateElementProps = {
  children?: ReactNode;
  onClick?: () => Promise<void> | void;
  role?: string;
};

type GateTree = ReactElement<GateElementProps>;

function renderGate(child: string): GateTree {
  hookHarness.stateCursor = 0;
  hookHarness.effectCursor = 0;
  return PrivacyConsentGate({ children: child }) as GateTree;
}

async function settleMount() {
  await Promise.all(hookHarness.effects.map((effect) => effect()));
  await Promise.resolve();
  await Promise.resolve();
}

function findElements(node: ReactNode, type: string): ReactElement<GateElementProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, type));
  if (!isValidElement<GateElementProps>(node)) return [];
  const matches = node.type === type ? [node] : [];
  return [...matches, ...findElements(node.props.children, type)];
}

function includesText(node: ReactNode, expected: string): boolean {
  if (node === expected) return true;
  if (Array.isArray(node)) return node.some((child) => includesText(child, expected));
  return isValidElement<GateElementProps>(node) && includesText(node.props.children, expected);
}

function clickButton(tree: GateTree, label: string): Promise<void> | void {
  const button = findElements(tree, 'button').find((element) => element.props.children === label);
  expect(button).toBeDefined();
  return button!.props.onClick!();
}

function installStorage(initial: Record<string, unknown> = {}, rejectWrites = false) {
  const store = { ...initial };
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          if (rejectWrites) throw new Error('write rejected');
          Object.assign(store, items);
        },
      },
    },
  };
  return store;
}

describe('PrivacyConsentGate runtime harness', () => {
  const originalBrowser = (globalThis as any).browser;

  beforeEach(() => {
    hookHarness.reset();
  });

  afterEach(() => {
    (globalThis as any).browser = originalBrowser;
  });

  it('keeps the sidepanel and Options products unmounted for empty storage', async () => {
    installStorage();

    let tree = renderGate('Sidepanel product');
    expect(includesText(tree, 'Sidepanel product')).toBe(false);
    await settleMount();
    tree = renderGate('Sidepanel product');
    expect(includesText(tree, 'privacy.title')).toBe(true);
    expect(includesText(tree, 'Sidepanel product')).toBe(false);

    hookHarness.reset();
    tree = renderGate('Options product');
    await settleMount();
    tree = renderGate('Options product');
    expect(includesText(tree, 'privacy.title')).toBe(true);
    expect(includesText(tree, 'Options product')).toBe(false);
  });

  it('keeps the notice visible after Not now', async () => {
    installStorage();
    renderGate('Sidepanel product');
    await settleMount();
    let tree = renderGate('Sidepanel product');

    clickButton(tree, 'privacy.notNow');
    tree = renderGate('Sidepanel product');

    expect(includesText(tree, 'privacy.deferred')).toBe(true);
    expect(includesText(tree, 'Sidepanel product')).toBe(false);
  });

  it('persists acceptance from the sidepanel and unlocks Options after reopen', async () => {
    const store = installStorage();
    renderGate('Sidepanel product');
    await settleMount();
    let tree = renderGate('Sidepanel product');

    await clickButton(tree, 'privacy.agree');
    tree = renderGate('Sidepanel product');
    expect(includesText(tree, 'Sidepanel product')).toBe(true);
    expect(store[PRIVACY_CONSENT_KEY]).toMatchObject({ version: PRIVACY_CONSENT_VERSION });

    hookHarness.reset();
    tree = renderGate('Options product');
    await settleMount();
    tree = renderGate('Options product');
    expect(includesText(tree, 'Options product')).toBe(true);
  });

  it('shows the notice for a stale consent record', async () => {
    installStorage({
      [PRIVACY_CONSENT_KEY]: { version: 0, acceptedAt: '2026-07-27T00:00:00.000Z' },
    });
    renderGate('Options product');
    await settleMount();
    const tree = renderGate('Options product');

    expect(includesText(tree, 'privacy.title')).toBe(true);
    expect(includesText(tree, 'Options product')).toBe(false);
  });

  it('shows a save error and keeps the product unmounted when storage rejects', async () => {
    installStorage({}, true);
    renderGate('Sidepanel product');
    await settleMount();
    let tree = renderGate('Sidepanel product');

    await clickButton(tree, 'privacy.agree');
    tree = renderGate('Sidepanel product');

    expect(includesText(tree, 'privacy.saveFailed')).toBe(true);
    expect(findElements(tree, 'p').some((element) => element.props.role === 'alert')).toBe(true);
    expect(includesText(tree, 'Sidepanel product')).toBe(false);
  });

  it('places the gate above App in both extension roots', () => {
    for (const entrypoint of ['entrypoints/sidepanel/main.tsx', 'entrypoints/options/main.tsx']) {
      const source = readFileSync(entrypoint, 'utf8');
      expect(source).toMatch(/<LocaleProvider>\s*<PrivacyConsentGate>\s*<App \/>/);
    }
  });
});
