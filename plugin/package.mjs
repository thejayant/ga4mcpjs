// Writes the plugin package to dist/: the file uploaded to the OpenAI Plugins dashboard
// or to a workspace (Admin > Plugins > Upload). The deployed server also offers it at
// /download/plugin.zip.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildPluginZip } from './zip.js';

const { fileName, files, buffer } = buildPluginZip();
const outDir = new URL('../dist/', import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(new URL(fileName, outDir), buffer);
console.log(`Packaged ${files} files → dist/${fileName}`);
