import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/* 小型标准 ZIP（DEFLATE），固定时间与换行，同一版本跨平台可复现；构建仍只依赖 Node。 */
const names = ['README.md', 'package.json', 'admin.mjs', 'browser.mjs', 'core.mjs', 'index.mjs', 'mcp-stdio.mjs', 'ops.mjs', 'standalone.mjs', 'setup.mjs', 'setup-desktop.mjs', 'Windows-SillyTavern.cmd', 'Windows-Tauri.cmd', 'tauri-windows.mjs', 'LICENSE'];
function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
export function companionZip(root) {
  const entries = [], directory = [];
  let offset = 0;
  for (const name of names) {
    const file = name === 'LICENSE' ? join(root, name) : join(root, 'companion', name);
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const body = Buffer.from(name.endsWith('.cmd') ? text.replace(/\n/g, '\r\n') : text);
    const packed = deflateRawSync(body);
    const filename = Buffer.from('reader-ii-companion/' + name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    entries.push(header, filename, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + packed.length;
  }
  const catalog = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(catalog.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, catalog, end]);
}
