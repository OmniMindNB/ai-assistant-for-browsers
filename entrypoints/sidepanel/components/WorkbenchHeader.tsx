import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/lib/i18n';
import type { ResolvedTheme } from '@/lib/theme';
import { IconGear, IconMenu, IconMoon, IconMore, IconPlus, IconSun } from '../icons';

export interface WorkbenchHeaderProps {
  historyOpen: boolean;
  /** 决定"切换主题"菜单项显示太阳还是月亮——反映当前实际生效的外观，而不是固定图标。 */
  themeResolved: ResolvedTheme;
  onToggleHistory(): void;
  onNewChat(): void;
  onOpenSettings(): void;
  onToggleTheme(): void;
  historyTriggerRef?: RefObject<HTMLButtonElement | null>;
}

export function WorkbenchHeader({
  historyOpen,
  themeResolved,
  onToggleHistory,
  onNewChat,
  onOpenSettings,
  onToggleTheme,
  historyTriggerRef,
}: WorkbenchHeaderProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        moreTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (historyOpen) setMenuOpen(false);
  }, [historyOpen]);

  function openSettings() {
    setMenuOpen(false);
    onOpenSettings();
  }

  function toggleTheme() {
    setMenuOpen(false);
    onToggleTheme();
  }

  return (
    <header className="relative z-30 flex items-center gap-1 border-b border-neutral-200 bg-neutral-50/80 px-2 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <button
        ref={historyTriggerRef}
        type="button"
        aria-label={t('workbench.history')}
        aria-expanded={historyOpen}
        aria-haspopup="dialog"
        onClick={onToggleHistory}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        <IconMenu className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 items-center gap-2 px-1">
        <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">Runi</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          aria-label={t('common.newChat')}
          title={t('common.newChat')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        >
          <IconPlus className="h-5 w-5" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            ref={moreTriggerRef}
            type="button"
            aria-label={t('workbench.more')}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
          >
            <IconMore className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 min-w-36 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            >
              <button
                type="button"
                role="menuitem"
                onClick={openSettings}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <IconGear className="h-4 w-4" />
                {t('common.settings')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={toggleTheme}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                {themeResolved === 'dark' ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
                {t('workbench.toggleTheme')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
