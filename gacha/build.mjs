// Reader-II 命运抽卡（通用版）→ ../generated/reader-gacha.generic.js（读者控制器里的 window.ReaderGacha）。
// 用法：在 gacha/ 的盘外副本里 npm install 一次（共享盘上不能放 node_modules），之后 npm run build。
// 构建先把 ../模板/ 里的通用角色条目模板同步成 src/gacha/entry-template.generated.ts，再打包。
import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, relative} from 'node:path';
import {TEMPLATE_MODULE, renderTemplateModule} from './sync-template.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(here, '../generated/reader-gacha.generic.js');
const template = await renderTemplateModule();
let stale = '';
try {stale = (await readFile(TEMPLATE_MODULE, 'utf8')).replace(/\r\n/g, '\n');} catch {/* 还没有生成过 */}
if (stale !== template) await writeFile(TEMPLATE_MODULE, template);

const result = await build({entryPoints: [resolve(here, 'src/reader/gacha-entry.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', charset: 'utf8', minify: true, legalComments: 'none', write: false, metafile: true});
const js = result.outputFiles[0].text.trim();
// 控制器脚本会经过酒馆宏替换（<user>、{{char}} 等）；它还可能被放进酒馆正则的替换文本
// （"$" 加数字、$<名字>、{{match}} 会被换成捕获组）或 <script> 里。这些都不能出现。
const macro = /<user>|\{\{user\}\}|<(?:bot|char)>|\{\{char\}\}|\{\{match\}\}/i.exec(js);
if (macro) throw Error('打包结果里有酒馆宏 ' + macro[0] + '，请改写源码或模板里的这段文字');
const group = /\$(?:\d|<)/.exec(js);
if (group) throw Error('打包结果里有正则替换记号 ' + group[0] + '（…' + js.slice(Math.max(0, group.index - 40), group.index + 10) + '…），请改用替换函数');
if (/<\/script/i.test(js)) throw Error('打包结果里有 </script');
// 通用版不认定宿主是哪一张卡：上游读者专属的名词不该出现在包里。
const specific = /命定之诗|命定契约|阿斯塔利亚|书海的旅程/.exec(js);
if (specific) throw Error('打包结果里有上游读者专属的字样「' + specific[0] + '」（…' + js.slice(Math.max(0, specific.index - 30), specific.index + 20) + '…）');
const inputs = Object.keys(result.metafile.inputs).sort();
const digest = createHash('sha256');
for (const file of inputs) digest.update(file.replace(/\\/g, '/') + '\n').update((await readFile(resolve(here, file), 'utf8')).replace(/\r\n/g, '\n'));
const version = /READER_GACHA_VERSION = '([^']+)'/.exec(await readFile(resolve(here, 'src/reader/gacha-reader.ts'), 'utf8'))?.[1] ?? '0';
// 首尾的记号与上游读者相同，卡内组件的构建可以照上游的办法把它放进控制器。
const source = `/* DREAM_READER_GACHA_BEGIN */\n/* 命运抽卡 ${version}（Reader-II 通用版）：由 gacha/src/reader/gacha-entry.ts 打包生成，改源码后在 gacha/ 里运行 npm run build，不要手改。\n * 源码 ${inputs.length} 个文件，SHA-256 ${digest.digest('hex')}。 */\n${js}\n/* DREAM_READER_GACHA_END */\n`;
new Script(source, {filename: 'reader-gacha.generic.js'});
await mkdir(dirname(out), {recursive: true});
await writeFile(out, source);
console.log(JSON.stringify({out: relative(process.cwd(), out), version, bytes: Buffer.byteLength(source), inputs: inputs.length}));
