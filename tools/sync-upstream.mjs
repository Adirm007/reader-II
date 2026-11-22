// 把 reader 仓库里通用版要用到的源码逐字复制到 upstream/reader/（统一 LF），并记录提交与哈希。
// 用法：node tools/sync-upstream.mjs [reader 仓库路径，默认 ../reader]
// 之后运行 node build.mjs；某个变换的锚点对不上时构建会直接报出是哪一处，按提示更新 build/ 里的变换即可。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reader = path.resolve(process.argv[2] || path.join(here, '..', 'reader'));
const target = path.join(here, 'upstream', 'reader');

// 逐字使用的运行时源码（变换在 build/ 里做，不改这些文件）。
const FILES = [
  'source/legacy-reader.js', 'source/legacy-reader.css', 'source/legacy-body.html',
  'source/letter.js', 'source/letter-body.html', 'source/legacy-letter-body.html', 'source/reader-letter.css',
  'source/controller-prelude.js', 'source/controller-adapter.js', 'source/core-runtime.mjs',
  'source/reader-transactions.js', 'source/booksea-album.js', 'source/template-system.js',
  'source/extra-settings.js', 'source/black-author.prompt.json',
  'source/reader-ui.js', 'source/reader-ui-switch.js',
  'worldbook/读者核心本体.txt', 'worldbook/notes.txt',
  'LICENSE',
];
// 抽卡的原始 TypeScript（reader-II/gacha 是它的通用化分叉；留一份原件方便以后比对上游改动）。
const TREES = ['gacha/src', 'gacha/tests'];
const EXTRA = ['gacha/package.json', 'gacha/tsconfig.json', 'gacha/build.mjs', 'gacha/README.md'];

if (!fs.existsSync(path.join(reader, 'source', 'legacy-reader.js'))) {
  console.error('找不到 reader 仓库：' + reader);
  process.exit(1);
}
const walk = dir => fs.readdirSync(path.join(reader, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.posix.join(dir, entry.name)) : [path.posix.join(dir, entry.name)]);
const list = [...FILES, ...EXTRA, ...TREES.flatMap(walk)].sort();

let commit = 'unknown', dirty = [];
try {
  commit = execFileSync('git', ['-C', reader, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = execFileSync('git', ['-C', reader, 'status', '--short', '--', ...list], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { /* 没有 git 时只记录哈希 */ }

fs.rmSync(target, { recursive: true, force: true });
const files = {};
for (const name of list) {
  const text = fs.readFileSync(path.join(reader, name), 'utf8').replace(/\r\n/g, '\n');
  const out = path.join(target, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  files[name] = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
}
let release = '';
try { release = JSON.parse(fs.readFileSync(path.join(reader, 'release-manifest.json'), 'utf8')).version || ''; } catch { /* 可选 */ }
const manifest = { repository: 'Adirm007/reader', commit, release, dirty, syncedAt: new Date().toISOString(), files };
fs.writeFileSync(path.join(here, 'upstream', 'UPSTREAM.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ commit, release, files: list.length, dirty: dirty.length }));
