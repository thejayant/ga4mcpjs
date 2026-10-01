import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const bundle = await build({ entryPoints: [new URL('app.js', root).pathname], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022', write: false });
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(new URL('index.html', root), 'utf8').replace('/* APP_SCRIPT */', () => script);
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/dashboard.html', root), html);
console.log(`Built dashboard (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
