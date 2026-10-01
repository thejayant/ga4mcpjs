// Builds dashboard/dist/dashboard.html: inlines the app modules into index.html.
// Needs no packages. Each module runs in its own scope and hands its exports to
// the modules that import it. If esbuild is installed, the result is minified.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const root = new URL('./', import.meta.url);
const IMPORT = /^import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)\.js';\s*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

const order = [], seen = new Set();
function visit(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = readFileSync(new URL(`${name}.js`, root), 'utf8');
  for (const [, , dependency] of source.matchAll(IMPORT)) visit(dependency);
  order.push({ name, source });
}
visit('app');

const id = name => `__module_${name.replace(/\W/g, '_')}`;
const parts = order.map(({ name, source }) => {
  const exported = [...source.matchAll(EXPORT)].map(match => match[1]);
  const body = source
    .replace(IMPORT, (_, names, dependency) => `const {${names}} = ${id(dependency)};`)
    .replace(/^export\s+/gm, '');
  return `const ${id(name)} = (() => {\n${body}\nreturn { ${exported.join(', ')} };\n})();`;
});
let script = `(() => {\n'use strict';\n${parts.join('\n')}\n})();`;

try {
  const { transform } = await import('esbuild');
  script = (await transform(script, { minify: true, target: 'es2022' })).code;
} catch {
  // esbuild not installed: ship the readable bundle.
}

script = script.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(new URL('index.html', root), 'utf8').replace('/* APP_SCRIPT */', () => script);
mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL('dist/dashboard.html', root), html);
console.log(`Built dashboard (${Math.round(Buffer.byteLength(html) / 1024)} KB, modules: ${order.map(m => m.name).join(' → ')})`);
