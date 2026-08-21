import { existsSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const extensionOutput = resolve(process.argv[2] ?? '.output/chrome-mv3');
const expectedAssetPaths = [
  'pdfjs/cmaps/78-EUC-H.bcmap',
  'pdfjs/standard_fonts/FoxitDingbats.pfb',
  'pdfjs/wasm/jbig2.wasm',
];
const missingAssets = expectedAssetPaths.filter((assetPath) => !existsSync(resolve(extensionOutput, assetPath)));

if (missingAssets.length > 0) {
  throw new Error(`Missing PDF.js build assets:\n${missingAssets.join('\n')}`);
}

const files = [];
const directories = [extensionOutput];
while (directories.length > 0) {
  const directory = directories.pop();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) directories.push(entryPath);
    else if (entry.isFile()) files.push(entryPath);
  }
}

const workerCandidates = files.filter((filePath) => /^pdf\.worker.*\.mjs$/.test(filePath.split(sep).at(-1)));
const hashedWorkers = workerCandidates.filter((filePath) =>
  /^pdf\.worker(?:\.min)?-[A-Za-z0-9_-]+\.mjs$/.test(filePath.split(sep).at(-1)),
);
if (workerCandidates.length !== 1 || hashedWorkers.length !== 1) {
  const found = workerCandidates.length > 0
    ? workerCandidates.map((filePath) => relative(extensionOutput, filePath).split(sep).join('/')).join('\n')
    : '(none)';
  throw new Error(`Expected exactly one emitted hashed PDF.js Worker inside the extension build; found:\n${found}`);
}

const workerPath = relative(extensionOutput, hashedWorkers[0]).split(sep).join('/');
console.log(`Verified PDF.js build assets:\n${[...expectedAssetPaths, workerPath].join('\n')}`);
