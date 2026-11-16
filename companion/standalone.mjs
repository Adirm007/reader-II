#!/usr/bin/env node
/*
 * Reader-II 后端伴侣 · 独立运行。给装不了酒馆后端插件的情况用（例如电脑上的 TauriTavern），也可以与酒馆分开跑。
 *
 *   node companion/standalone.mjs [--port 8790] [--host 127.0.0.1] [--home <数据目录>]
 *
 * 操作接口与管理页在同一个端口上。启动后：
 *   1. 在夜梦助手的设置页「后端伴侣」里把「伴侣地址」填成 http://127.0.0.1:<端口>，点「检测」「申请放行」；
 *   2. 在这台设备的浏览器里打开下面打印的管理页地址，核对配对码后放行。
 * 默认只听本机。--host 0.0.0.0 会让局域网里的设备也能连：那样管理页只靠地址里的 key 保护，请不要外传。
 * 只用 Node 标准库（Node 18+），不需要 npm install。安全模型见 core.mjs 开头。
 */
import { createCompanion } from './core.mjs';

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--port') options.port = Number(argv[++index]);
    else if (name === '--host') options.host = String(argv[++index] || '');
    else if (name === '--home') options.home = String(argv[++index] || '');
    else { console.error('不认识的参数：' + name); options.help = true; options.bad = true; }
  }
  return options;
}

const options = parse(process.argv.slice(2));
if (options.help) {
  console.log('用法：node companion/standalone.mjs [--port 8790] [--host 127.0.0.1] [--home <数据目录>]');
  process.exit(options.bad ? 1 : 0);
}
if (options.port !== undefined && !(Number.isInteger(options.port) && options.port >= 0 && options.port < 65536)) {
  console.error('--port 要是 0–65535 的整数');
  process.exit(1);
}

const companion = createCompanion({ mode: 'standalone', home: options.home || undefined });
try {
  const started = await companion.start({ serveApi: true, port: options.port, host: options.host || undefined });
  console.log(`[Reader-II 伴侣] 在夜梦助手的设置页「后端伴侣」里，把伴侣地址填成：http://127.0.0.1:${started.port}`);
  console.log('[Reader-II 伴侣] 按 Ctrl+C 退出。');
} catch (error) {
  console.error('[Reader-II 伴侣] 启动失败：' + ((error && error.message) || error));
  process.exit(1);
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await companion.close(); } finally { process.exit(0); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
