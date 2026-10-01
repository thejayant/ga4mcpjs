// Packages plugin/marketer-companion-dashboard into dist/<name>-<version>.zip: the file
// uploaded to the OpenAI Plugins dashboard or to a workspace (Admin > Plugins > Upload).
// No dependencies: writes a standard deflate ZIP with Node's zlib.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = new URL('./marketer-companion-dashboard/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
for (const key of ['logo', 'composerIcon']) {
  const file = manifest.extensions?.['com.openai']?.interface?.[key];
  if (file) statSync(join(root, file)); // throws if a referenced asset is missing
}

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(root);

const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const local = [], central = [];
let offset = 0;
for (const path of files) {
  const name = Buffer.from(relative(root, path).split(sep).join('/'));
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  local.push(header, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += header.length + name.length + packed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);

const outDir = new URL('../dist/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const out = new URL(`${manifest.name}-${manifest.version}.zip`, outDir);
writeFileSync(out, Buffer.concat([...local, directory, end]));
console.log(`Packaged ${files.length} files → dist/${manifest.name}-${manifest.version}.zip`);
