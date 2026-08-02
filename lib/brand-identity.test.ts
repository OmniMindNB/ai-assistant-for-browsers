import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Runi active product identity', () => {
  it('uses Runi in package and extension locale metadata', () => {
    expect(JSON.parse(read('package.json'))).toMatchObject({
      name: 'runi',
      description: expect.stringContaining('Runi'),
    });
    expect(JSON.parse(read('public/_locales/en/messages.json')).extName.message).toBe('Runi');
    expect(JSON.parse(read('public/_locales/zh_CN/messages.json')).extName.message).toBe('Runi');
  });

  it.each([
    'entrypoints/options/index.html',
    'entrypoints/sidepanel/index.html',
    'entrypoints/sidepanel/components/WorkbenchHeader.tsx',
    'lib/i18n/locales/en.ts',
    'lib/i18n/locales/zh.ts',
    'lib/agent/system-prompt.ts',
    'entrypoints/background.ts',
    'entrypoints/sidepanel/store.ts',
  ])('%s has no active Aluminum branding', (path) => {
    expect(read(path)).not.toMatch(/Aluminum/);
  });
});
