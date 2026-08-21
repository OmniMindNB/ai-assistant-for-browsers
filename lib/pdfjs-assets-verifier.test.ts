import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = fileURLToPath(new URL('../scripts/verify-pdfjs-assets.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

function buildOutput(workerPaths: string[]): string {
  const output = mkdtempSync(join(tmpdir(), 'runi-pdfjs-assets-'));
  temporaryDirectories.push(output);
  for (const assetPath of [
    'pdfjs/cmaps/78-EUC-H.bcmap',
    'pdfjs/standard_fonts/FoxitDingbats.pfb',
    'pdfjs/wasm/jbig2.wasm',
    ...workerPaths,
  ]) {
    const absolutePath = join(output, assetPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'fixture');
  }
  return output;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verify-pdfjs-assets', () => {
  it('accepts exactly one emitted hashed local PDF.js Worker', () => {
    const output = buildOutput(['assets/pdf.worker.min-AbC123_x.mjs']);
    const stdout = execFileSync(process.execPath, [verifier, output], { encoding: 'utf8' });
    expect(stdout).toContain('assets/pdf.worker.min-AbC123_x.mjs');
  });

  it('rejects a build with no emitted PDF.js Worker', () => {
    const output = buildOutput([]);
    const result = spawnSync(process.execPath, [verifier, output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one emitted hashed PDF.js Worker');
  });

  it('rejects duplicate emitted PDF.js Workers', () => {
    const output = buildOutput([
      'assets/pdf.worker.min-AbC123.mjs',
      'nested/pdf.worker-XyZ789.mjs',
    ]);
    const result = spawnSync(process.execPath, [verifier, output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one emitted hashed PDF.js Worker');
  });

  it('rejects an unhashed PDF.js Worker filename', () => {
    const output = buildOutput(['assets/pdf.worker.min.mjs']);
    const result = spawnSync(process.execPath, [verifier, output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one emitted hashed PDF.js Worker');
  });
});
