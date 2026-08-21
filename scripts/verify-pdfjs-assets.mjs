import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const extensionOutput = resolve('.output/chrome-mv3');
const expectedAssetPaths = [
  'pdfjs/cmaps/78-EUC-H.bcmap',
  'pdfjs/standard_fonts/FoxitDingbats.pfb',
  'pdfjs/wasm/jbig2.wasm',
];
const missingAssets = expectedAssetPaths.filter((assetPath) => !existsSync(resolve(extensionOutput, assetPath)));

if (missingAssets.length > 0) {
  throw new Error(`Missing PDF.js build assets:\n${missingAssets.join('\n')}`);
}

console.log(`Verified PDF.js build assets:\n${expectedAssetPaths.join('\n')}`);
