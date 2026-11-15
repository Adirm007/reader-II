// 把 ../模板/ 里的通用角色条目模板生成 src/gacha/entry-template.generated.ts（抽卡包自带的默认生成模板）。
// 用法：node sync-template.mjs          生成（npm run build 会先跑它）
//       node sync-template.mjs --check  只检查生成文件有没有过期（过期时退出码 1）
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(here, '../模板');
export const TEMPLATE_MODULE = resolve(here, 'src/gacha/entry-template.generated.ts');
const read = async name => (await readFile(resolve(dir, name), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** 生成文件应有的内容。模板里不能有酒馆宏与正则替换记号：抽卡包会经过酒馆的宏替换，旧完整版里还是正则的替换文本。 */
export async function renderTemplateModule() {
  const text = (await read('通用角色条目模板.txt')).trim(), settings = JSON.parse(await read('通用角色条目模板.设置.json'));
  for (const key of ['id', 'name', 'generationInstruction', 'entryNameRule']) if (typeof settings[key] !== 'string' || !settings[key].trim()) throw Error('通用角色条目模板.设置.json 缺少 ' + key);
  if (!settings.output || typeof settings.output !== 'object' || !String(settings.output.targetWorldbook ?? '').trim()) throw Error('通用角色条目模板.设置.json 的 output 没有写目标世界书');
  const template = {id: settings.id, name: settings.name, templateText: text, generationInstruction: settings.generationInstruction, entryNameRule: settings.entryNameRule, output: settings.output, builtin: true};
  const body = JSON.stringify(template, null, 2);
  const bad = /<user>|\{\{user\}\}|<(?:bot|char)>|\{\{char\}\}|\{\{match\}\}|\$(?:\d|<)|<\/script/i.exec(body);
  if (bad) throw Error('模板里有抽卡包不能带的记号 ' + bad[0] + '（酒馆宏、正则替换记号或 </script），请改写');
  return '/** 抽卡包自带的默认生成模板「' + settings.name + '」。由 gacha/sync-template.mjs 从 ../模板/通用角色条目模板.txt 与 通用角色条目模板.设置.json 生成，不要手改。 */\n'
    + 'export const GENERIC_ENTRY_TEMPLATE: Readonly<Record<string, unknown>> = ' + body + ';\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = await renderTemplateModule();
  let old = '';
  try {old = (await readFile(TEMPLATE_MODULE, 'utf8')).replace(/\r\n/g, '\n');} catch {/* 还没有生成过 */}
  if (old === next) console.log('entry-template.generated.ts 已是最新');
  else if (process.argv.includes('--check')) {console.error('entry-template.generated.ts 已过期：在 gacha/ 里运行 node sync-template.mjs'); process.exit(1);}
  else {await writeFile(TEMPLATE_MODULE, next); console.log('已生成 src/gacha/entry-template.generated.ts');}
}
