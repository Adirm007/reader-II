/*
 * Reader-II 后端伴侣 · 酒馆后端插件入口。
 *
 * 装法（二选一），然后在酒馆的 config.yaml 里把 enableServerPlugins 设为 true 并重启酒馆：
 *   - 把整个仓库克隆进酒馆的 plugins/：  git clone https://github.com/Adirm007/reader-II plugins/reader-ii
 *     （仓库根的 package.json 把入口指到这里）
 *   - 或只把 companion/ 这个目录拷进去：  plugins/reader-ii-companion/
 * 不需要 npm install：只用 Node 标准库。
 *
 * 操作接口挂在 /api/plugins/reader-ii 下，走酒馆自己的登录、白名单与 CSRF；
 * 管理页另开一个只听本机的端口（默认 8790，地址在启动时打印）。安全模型见 core.mjs 开头。
 */
import { createCompanion } from './core.mjs';

export const info = {
  id: 'reader-ii',
  name: 'Reader-II Companion',
  description: 'Reader-II 夜梦助手的后端伴侣：经用户在本机放行后，提供命令、文件、无头浏览器与 stdio MCP（设备全权）。',
};

let companion = null;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= 32 * 1024 * 1024) chunks.push(chunk); });
    req.on('error', () => resolve({}));
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { resolve({}); }
    });
  });
}

export async function init(router) {
  companion = createCompanion({ mode: 'plugin' });
  const port = process.env.READER_II_COMPANION_ADMIN_PORT;
  try {
    await companion.start({ serveApi: false, port: port === undefined || port === '' ? undefined : Number(port) });
  } catch (error) {
    /* 管理页起不来时接口照常挂上，但没法放行：把原因说清楚。 */
    console.error('[Reader-II 伴侣] 管理页没能启动（' + ((error && error.message) || error) + '）。没有管理页就无法放行；可以在 ~/.reader-ii-companion/config.json 里换一个 adminPort 再重启酒馆。');
  }
  router.use(async (req, res) => {
    try {
      /* 酒馆已经把 JSON 请求体解析好了；万一没有（中间件顺序变了），自己读。 */
      let body = req.body;
      if (req.method === 'POST' && (body === undefined || body === null) && req.readable) body = await readBody(req);
      const out = await companion.handleApi({ method: req.method, path: req.path, headers: req.headers, body, remote: req.ip || (req.socket && req.socket.remoteAddress) });
      res.status(out.status);
      for (const [name, value] of Object.entries(out.headers || {})) res.setHeader(name, value);
      res.send(out.body);
    } catch (error) {
      res.status(500).json({ ok: false, error: String((error && error.message) || error) });
    }
  });
}

export async function exit() {
  if (companion) { await companion.close(); companion = null; }
}

export default { info, init, exit };
