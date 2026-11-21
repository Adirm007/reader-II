/*
 * Reader-II 后端伴侣的核心：配置、放行（grant）、接口分发、管理页。只用 Node 标准库（Node 18+）。
 *
 * 两种运行方式共用这一份：
 *   酒馆后端插件  index.mjs：接口挂在酒馆的 /api/plugins/reader-ii 下（走酒馆自己的登录与 CSRF）；
 *                 另开一个只听本机的端口放管理页。
 *   独立运行      standalone.mjs：接口与管理页在同一个端口上。
 *
 * 安全模型（重要，改之前先读）：
 *   酒馆页面里跑着别的扩展和角色卡自带的脚本，它们与夜梦助手同源，助手能发的请求它们也能发。
 *   所以「页面知道一个令牌」不构成边界。真正的边界是「放行」：
 *     1. 页面发起配对请求，得到一个 4 位配对码；
 *     2. 用户在「设备本机」打开管理页（另一个源，页面脚本读不到也点不了），核对配对码，选一个期限，点放行；
 *     3. 页面拿到令牌，在期限内可以调用操作接口。期限到了、被撤销、伴侣重启（选了「到重启为止」时）就失效。
 *   放行期间，这个酒馆页面（连同里面所有脚本）等同于拿到了这台设备。这是用户自己做的决定，管理页上写明了。
 *   管理页的接口要管理密钥（启动时打印在控制台，只存在本机磁盘上），并且：
 *     - 要求自定义请求头 X-Admin-Key：跨源请求带不了它（预检过不去）；
 *     - 只认本机的 Host（防 DNS 重绑定）；不给任何 CORS 头；禁止被嵌进 iframe。
 *   操作接口另外核对 Origin 与放行时记下的来源一致。
 *   伴侣自己的数据目录（密钥、放行记录）不能经文件接口读写。
 *
 * 数据目录：~/.reader-ii-companion（可用环境变量 READER_II_COMPANION_HOME 改）。更新伴侣不会动它。
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPage } from './admin.mjs';
import { createOps } from './ops.mjs';

export const API_VERSION = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = { adminPort: 8790, adminHost: '127.0.0.1', exec: true, browser: true, fsRoots: [], browserPath: '' };
const PAIR_TTL = 10 * 60 * 1000;
const MAX_BODY = 32 * 1024 * 1024;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function readVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'manifest.json'), 'utf8'));
    if (/Reader-II/i.test(String(manifest.display_name || '')) && typeof manifest.version === 'string') return manifest.version;
  } catch { /* 只拷了 companion 目录时没有上一层的 manifest */ }
  try { return String(JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
const clip = (value, limit) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').slice(0, limit);
const json = (status, body, headers) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(headers || {}) }, body: JSON.stringify(body) });

function sameSecret(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCompanion(options = {}) {
  const mode = options.mode === 'plugin' ? 'plugin' : 'standalone';
  const home = path.resolve(options.home || process.env.READER_II_COMPANION_HOME || path.join(os.homedir(), '.reader-ii-companion'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const version = readVersion();
  const say = options.quiet ? () => {} : (...parts) => console.log('[Reader-II 伴侣]', ...parts);

  /* ---------- 配置 ---------- */
  const configFile = path.join(home, 'config.json');
  function normalizeConfig(input) {
    const source = input && typeof input === 'object' ? input : {};
    const port = Math.trunc(Number(source.adminPort));
    return {
      adminPort: Number.isFinite(port) && port >= 0 && port < 65536 ? port : DEFAULT_CONFIG.adminPort,
      adminHost: typeof source.adminHost === 'string' && source.adminHost.trim() ? source.adminHost.trim() : DEFAULT_CONFIG.adminHost,
      exec: source.exec !== false,
      browser: source.browser !== false,
      fsRoots: (Array.isArray(source.fsRoots) ? source.fsRoots : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 20),
      browserPath: typeof source.browserPath === 'string' ? source.browserPath.trim().slice(0, 400) : '',
    };
  }
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { stored = {}; }
  const config = normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
  function saveConfig() {
    try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); } catch (error) { say('配置没能写进磁盘：', error.message); }
  }

  /* ---------- 管理密钥 ---------- */
  const keyFile = path.join(home, 'admin.key');
  let adminKey = '';
  try { adminKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch { adminKey = ''; }
  if (!/^[a-f0-9]{48}$/.test(adminKey)) {
    adminKey = randomBytes(24).toString('hex');
    fs.writeFileSync(keyFile, adminKey + '\n', { mode: 0o600 });
  }

  /* ---------- 操作记录 ---------- */
  const audit = [];
  const auditFile = path.join(home, 'audit.log');
  function log(op, summary, origin) {
    const entry = { at: Date.now(), op: String(op), summary: clip(summary, 400), origin: clip(origin || '', 120) };
    audit.push(entry);
    if (audit.length > 300) audit.splice(0, audit.length - 300);
    try {
      if (fs.existsSync(auditFile) && fs.statSync(auditFile).size > 1024 * 1024) fs.renameSync(auditFile, auditFile + '.1');
      fs.appendFileSync(auditFile, `${new Date(entry.at).toISOString()}\t${entry.op}\t${entry.origin}\t${entry.summary}\n`, { mode: 0o600 });
    } catch { /* 记录写不进磁盘不影响操作 */ }
  }

  /* ---------- 放行 ---------- */
  const grants = new Map();
  const pending = new Map();
  const grantsFile = path.join(home, 'grants.json');
  try {
    for (const item of JSON.parse(fs.readFileSync(grantsFile, 'utf8'))) {
      if (!item || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) continue;
      if (item.expiresAt && Date.now() > item.expiresAt) continue;
      grants.set(String(item.id), { id: String(item.id), hash: item.hash, origin: String(item.origin || ''), label: String(item.label || ''), createdAt: Number(item.createdAt) || 0, expiresAt: Number(item.expiresAt) || 0, persistent: item.persistent === true });
    }
  } catch { /* 没有放行记录 */ }

  function persistGrants() {
    const keep = [...grants.values()].filter((grant) => grant.persistent || grant.expiresAt);
    try { fs.writeFileSync(grantsFile, JSON.stringify(keep, null, 2) + '\n', { mode: 0o600 }); } catch (error) { say('放行记录没能写进磁盘：', error.message); }
  }

  function originOf(headers) {
    if (headers.origin && headers.origin !== 'null') return String(headers.origin);
    try { return headers.referer ? new URL(headers.referer).origin : ''; } catch { return ''; }
  }

  /* 返回放行记录；{ denied } 表示令牌对，但来源不对；null 表示没有有效的放行。 */
  function grantOf(headers) {
    const token = String(headers['x-reader-ii-token'] || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = sha(token);
    for (const grant of grants.values()) {
      if (!sameSecret(grant.hash, hash)) continue;
      if (grant.expiresAt && Date.now() > grant.expiresAt) { grants.delete(grant.id); persistGrants(); return null; }
      const origin = originOf(headers);
      if (grant.origin && origin && origin !== grant.origin) return { denied: 'bad_origin' };
      return grant;
    }
    return null;
  }

  function sweepPending() {
    for (const [id, item] of pending) if (Date.now() - item.createdAt > PAIR_TTL) pending.delete(id);
  }

  function approve(id, ttl) {
    sweepPending();
    const item = pending.get(String(id));
    if (!item || item.state !== 'pending') throw new Error('这个请求已经不在了（过期，或已经处理过）');
    const token = randomBytes(32).toString('hex');
    const hours = /^hours:(\d+(?:\.\d+)?)$/.exec(String(ttl || ''));
    const grant = {
      id: randomBytes(6).toString('hex'), hash: sha(token), origin: item.origin, label: item.client, createdAt: Date.now(),
      expiresAt: hours ? Date.now() + Math.min(24 * 30, Math.max(0.05, Number(hours[1]))) * 3600 * 1000 : 0,
      persistent: ttl === 'always',
    };
    grants.set(grant.id, grant);
    persistGrants();
    item.state = 'approved';
    item.token = token;
    item.expiresAt = grant.expiresAt;
    log('grant', `放行 ${item.origin || '未知来源'}（${hours ? hours[1] + ' 小时' : grant.persistent ? '长期' : '到重启为止'}）`, item.origin);
    return grant;
  }

  /* ---------- 操作 ---------- */
  const ops = createOps({ config, home, workspace, log, version });
  const SUMMARY = {
    exec: (body) => String(body.command || ''),
    fs_write: (body) => 'dev:/' + (body.segs || []).join('/'),
    fs_remove: (body) => 'dev:/' + (body.segs || []).join('/'),
    http: (body) => `${body.method || 'GET'} ${body.url || ''}`,
    browser: (body) => `${body.action || ''} ${body.url || body.selector || ''}`,
    mcp_start: (body) => `${body.command || ''} ${(body.args || []).join(' ')}`,
    job: (body) => (body.action === 'kill' ? `kill ${body.id || body.rid || ''}` : ''),
  };

  let server = null;
  let actualPort = 0;
  const adminUrl = () => (actualPort ? `http://${/^(?:0\.0\.0\.0|::)$/.test(config.adminHost) ? '127.0.0.1' : config.adminHost}:${actualPort}/` : '');

  async function handleApi(req) {
    const route = String(req.path || '/').replace(/\/+$/, '') || '/';
    const headers = req.headers || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (req.method === 'GET' && route === '/status') {
      const grant = grantOf(headers);
      return json(200, {
        ok: true, name: 'reader-ii-companion', api: API_VERSION, version, mode,
        platform: `${os.type()} ${os.release()} ${os.arch()}`, adminUrl: adminUrl(),
        grant: grant && !grant.denied ? { expiresAt: grant.expiresAt, persistent: grant.persistent, label: grant.label } : null,
      });
    }

    if (req.method === 'POST' && route === '/pair') {
      sweepPending();
      while (pending.size >= 8) pending.delete(pending.keys().next().value);
      const id = randomBytes(12).toString('hex');
      const item = { id, code: String(randomInt(1000, 10000)), origin: originOf(headers), client: clip(body.client, 80), ua: clip(body.ua, 160), remote: clip(req.remote, 60), createdAt: Date.now(), state: 'pending' };
      pending.set(id, item);
      log('pair', `放行请求，配对码 ${item.code}`, item.origin);
      say(`有新的放行请求（配对码 ${item.code}，来自 ${item.origin || '未知来源'}）。到管理页处理：${adminUrl()}#key=${adminKey}`);
      return json(200, { ok: true, id, code: item.code, adminUrl: adminUrl(), expiresInSec: PAIR_TTL / 1000 });
    }

    const pairMatch = /^\/pair\/([a-f0-9]{24})$/.exec(route);
    if (req.method === 'GET' && pairMatch) {
      sweepPending();
      const item = pending.get(pairMatch[1]);
      if (!item) return json(200, { ok: true, state: 'expired' });
      if (item.state === 'approved') {
        pending.delete(item.id);   /* 令牌只交付一次 */
        return json(200, { ok: true, state: 'approved', token: item.token, expiresAt: item.expiresAt });
      }
      if (item.state === 'denied') pending.delete(item.id);
      return json(200, { ok: true, state: item.state });
    }

    if (req.method === 'POST' && route === '/release') {
      const grant = grantOf(headers);
      if (grant && !grant.denied) { grants.delete(grant.id); persistGrants(); log('release', '页面主动断开', grant.origin); }
      return json(200, { ok: true });
    }

    const opMatch = /^\/op\/([a-z_]+)$/.exec(route);
    if (req.method === 'POST' && opMatch) {
      const grant = grantOf(headers);
      if (!grant) return json(401, { ok: false, code: 'no_grant', error: '还没有放行，或放行已经到期' });
      if (grant.denied) return json(403, { ok: false, code: grant.denied, error: '这个令牌不是发给当前页面的' });
      const name = opMatch[1];
      const op = Object.prototype.hasOwnProperty.call(ops.table, name) ? ops.table[name] : null;
      if (!op) return json(200, { ok: false, code: 'unknown_op', error: `伴侣不认识「${name}」这个操作（伴侣的版本可能比扩展旧，请更新伴侣）` });
      try {
        const result = await op(body, { grant });
        if (SUMMARY[name]) { const summary = SUMMARY[name](body); if (summary) log(name, summary, grant.origin); }
        return json(200, { ok: true, result: result === undefined ? null : result });
      } catch (error) {
        return json(200, { ok: false, code: (error && error.code) || 'failed', error: String((error && error.message) || error).slice(0, 4000) });
      }
    }

    return json(404, { ok: false, code: 'not_found', error: '没有这个接口' });
  }

  async function handleAdmin(req) {
    const route = String(req.path || '/').replace(/\/+$/, '') || '/';
    const headers = req.headers || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method === 'GET' && route === '/') {
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        },
        body: adminPage(),
      };
    }
    if (!route.startsWith('/admin/')) return json(404, { ok: false, error: '没有这个页面' });
    if (!sameSecret(String(headers['x-admin-key'] || ''), adminKey)) return json(401, { ok: false, error: '管理密钥不对。请用伴侣启动时在控制台里打印的那个地址打开管理页。' });

    if (req.method === 'GET' && route === '/admin/state') {
      sweepPending();
      for (const grant of [...grants.values()]) if (grant.expiresAt && Date.now() > grant.expiresAt) grants.delete(grant.id);
      return json(200, {
        ok: true, version, mode, home, workspace, platform: `${os.type()} ${os.release()} ${os.arch()}`, now: Date.now(),
        config: { exec: config.exec, browser: config.browser, fsRoots: config.fsRoots, browserPath: config.browserPath },
        pending: [...pending.values()].filter((item) => item.state === 'pending').map((item) => ({ id: item.id, code: item.code, origin: item.origin, client: item.client, ua: item.ua, remote: item.remote, createdAt: item.createdAt })),
        grants: [...grants.values()].map((grant) => ({ id: grant.id, origin: grant.origin, label: grant.label, createdAt: grant.createdAt, expiresAt: grant.expiresAt, persistent: grant.persistent })),
        audit: audit.slice(-80).reverse(), jobs: ops.jobsBrief(),
      });
    }
    if (req.method !== 'POST') return json(405, { ok: false, error: '请求方式不对' });
    try {
      if (route === '/admin/approve') { approve(body.id, body.ttl); return json(200, { ok: true }); }
      if (route === '/admin/deny') {
        const item = pending.get(String(body.id));
        if (item && item.state === 'pending') { item.state = 'denied'; log('deny', '拒绝了放行请求', item.origin); }
        return json(200, { ok: true });
      }
      if (route === '/admin/revoke') {
        const targets = body.all === true ? [...grants.values()] : [grants.get(String(body.id))].filter(Boolean);
        for (const grant of targets) { grants.delete(grant.id); log('revoke', '撤销放行', grant.origin); }
        persistGrants();
        return json(200, { ok: true, revoked: targets.length });
      }
      if (route === '/admin/config') {
        const next = normalizeConfig({ ...config, ...body, adminPort: config.adminPort, adminHost: config.adminHost });
        Object.assign(config, next);
        saveConfig();
        log('config', `命令 ${config.exec ? '开' : '关'}，浏览器 ${config.browser ? '开' : '关'}，目录限制 ${config.fsRoots.length ? config.fsRoots.join('；') : '无'}`);
        return json(200, { ok: true });
      }
    } catch (error) {
      return json(400, { ok: false, error: String((error && error.message) || error) });
    }
    return json(404, { ok: false, error: '没有这个接口' });
  }

  /* ---------- 自己的 HTTP 监听（管理页；独立运行时也放操作接口） ---------- */
  function readJson(request) {
    return new Promise((resolve, reject) => {
      const type = String(request.headers['content-type'] || '');
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('请求体太大'), { status: 413 })); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on('error', reject);
      request.on('end', () => {
        if (!size) { resolve({}); return; }
        /* 只收 JSON：这样跨源页面发不出「不经预检」的请求。 */
        if (!/^application\/json\b/i.test(type)) { reject(Object.assign(new Error('请求体要是 JSON'), { status: 415 })); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('请求体不是合法的 JSON'), { status: 400 })); }
      });
    });
  }

  function send(response, out) {
    response.writeHead(out.status, out.headers || {});
    response.end(out.body === undefined ? '' : out.body);
  }

  function cors(origin) {
    const headers = { Vary: 'Origin' };
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Headers'] = 'content-type, x-reader-ii-token';
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Private-Network'] = 'true';
      headers['Access-Control-Max-Age'] = '600';
    }
    return headers;
  }

  function listener(serveApi) {
    return async (request, response) => {
      try {
        const headers = request.headers;
        const pathname = new URL(request.url || '/', 'http://local').pathname;
        const loopbackOnly = LOOPBACK.test(`${config.adminHost}`);
        if (loopbackOnly && !LOOPBACK.test(String(headers.host || ''))) { send(response, json(403, { ok: false, error: '只接受发给本机地址的请求' })); return; }
        const isAdmin = pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/');
        if (isAdmin) {
          /* 管理接口不给任何跨源许可；带了 Origin 的请求必须来自管理页自己。 */
          if (headers.origin && headers.origin !== `http://${headers.host}`) { send(response, json(403, { ok: false, error: '管理页只能在它自己的地址上使用' })); return; }
          const body = request.method === 'POST' ? await readJson(request) : undefined;
          send(response, await handleAdmin({ method: request.method, path: pathname, headers, body }));
          return;
        }
        if (!serveApi) { send(response, json(404, { ok: false, error: '这个端口只有管理页；操作接口在酒馆的 /api/plugins/reader-ii 下' })); return; }
        const allow = cors(headers.origin);
        if (request.method === 'OPTIONS') { send(response, { status: 204, headers: allow, body: '' }); return; }
        const body = request.method === 'POST' ? await readJson(request) : undefined;
        const out = await handleApi({ method: request.method, path: pathname, headers, body, remote: request.socket.remoteAddress });
        out.headers = { ...allow, ...out.headers };
        send(response, out);
      } catch (error) {
        try { send(response, json((error && error.status) || 500, { ok: false, error: String((error && error.message) || error) })); } catch { /* 连接已断 */ }
      }
    };
  }

  function listen(target, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => { target.off('listening', onListening); reject(error); };
      const onListening = () => { target.off('error', onError); resolve(); };
      target.once('error', onError);
      target.once('listening', onListening);
      target.listen(port, host);
    });
  }

  /* serveApi：这个端口上是否也放操作接口（独立运行时是）。port 传 0 表示随便找一个空闲端口。 */
  async function start({ serveApi = mode === 'standalone', port, host, portFallback = true } = {}) {
    if (server) return { port: actualPort, adminUrl: adminUrl() };
    if (host) config.adminHost = host;
    const wanted = port === undefined ? config.adminPort : port;
    server = http.createServer(listener(serveApi));
    for (let attempt = 0; ; attempt += 1) {
      try { await listen(server, wanted === 0 ? 0 : wanted + attempt, config.adminHost); break; }
      catch (error) {
        if (!portFallback || error.code !== 'EADDRINUSE' || wanted === 0 || attempt >= 10) { server = null; throw error; }
      }
    }
    actualPort = server.address().port;
    const full = `${adminUrl()}#key=${adminKey}`;
    try { fs.writeFileSync(path.join(home, 'admin-url.txt'), full + '\n', { mode: 0o600 }); } catch { /* ignore */ }
    say(`已启动（${mode === 'plugin' ? '酒馆后端插件' : '独立运行'}），版本 ${version}`);
    say(`管理页（在这台设备的浏览器里打开；放行「设备全权」要在这里点）：${full}`);
    if (!LOOPBACK.test(config.adminHost)) say('注意：管理页没有只听本机。别人拿到上面带 key 的地址就能放行，请不要外传。');
    return { port: actualPort, adminUrl: adminUrl() };
  }

  async function close() {
    await ops.close();
    if (server) {
      const closing = server;
      server = null;
      await new Promise((resolve) => { closing.close(() => resolve()); if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections(); });
    }
  }

  return {
    version, mode, home, workspace, config, handleApi, handleAdmin, start, close,
    adminKey: () => adminKey, adminUrl, port: () => actualPort, ops,
  };
}
