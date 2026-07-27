import { zh } from './zh';

export const en: Record<keyof typeof zh, string> = {
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.hide': 'Hide',
  'common.show': 'Show',
  'common.settings': 'Settings',
  'common.newChat': 'New Chat',
  'common.collapseSidebar': 'Collapse sidebar',
  'common.expandSidebar': 'Expand sidebar',
  'common.send': 'Send',
  'common.followSystem': 'System',
  'appearance.heading': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.themeAriaLabel': 'Theme: {label}, click to toggle',
  'appearance.themeTitle': 'Theme: {label}',
  'language.heading': 'Language',
  'language.zh': '中文',
  'language.en': 'English',
  'settings.pageTitle': 'Aluminum Settings',
  'settings.descriptionPrefix':
    'Configure an OpenAI-compatible model provider. The API key is stored only on this device in',
  'settings.optionsDescriptionSuffix': ', and is never uploaded or synced (ref: technical-plan.md §6).',
  'chat.editMessageEditorAriaLabel': 'Edit message',
  'chat.editDiscardWarning': 'Submitting will discard the following {count} message(s)',
};
