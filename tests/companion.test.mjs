/*
 * 后端伴侣（companion/）的测试：真的起一个伴侣（数据目录在临时目录里），经 HTTP 调用。只用 Node 标准库。
 *   node --test tests/companion.test.mjs
 * 覆盖：放行流程与它的几道门（管理密钥、Host、来源、只收 JSON、令牌只交付一次、撤销、期限落盘只存哈希）；
 *       命令与后台任务；文件读写（CRLF、二进制、越界与符号链接、目录限制）与检索；HTTP 代发（含 SSE 提前返回）；
 *       stdio MCP 转发；无头浏览器（本机有 Chrome 才跑）；酒馆插件入口与独立运行入口。
 * 没覆盖：Windows 与 Termux 上的行为（命令外壳、盘符、taskkill）；真实酒馆里作为插件加载；局域网访问。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../companion/core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://tavern.test:8000';
const POSIX = process.platform !== 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(base, method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const named = Object.keys(headers).map((key) => key.toLowerCase());
    const req = http.request(new URL(target, base), { method, headers: { ...(payload !== null && !named.includes('content-type') ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function boot(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-companion-test-'));
  const companion = createCompanion({ mode: 'standalone', home, quiet: true, ...options });
  const started = await companion.start({ port: 0 });
  const ctx = { companion, home, workspace: companion.workspace, base: `http://127.0.0.1:${started.port}`, key: companion.adminKey(), token: '' };
  ctx.admin = (method, target, body) => request(ctx.base, method, target, { body, headers: { 'X-Admin-Key': ctx.key } });
  ctx.op = async (name, body = {}) => (await request(ctx.base, 'POST', '/op/' + name, { body, headers: { 'X-Reader-II-Token': ctx.token, Origin: ORIGIN } })).data;
  ctx.ok = async (name, body = {}) => {
    const out = await ctx.op(name, body);
    assert.equal(out.ok, true, `${name} 失败：${out && out.error}`);
    return out.result;
  };
  t.after(async () => {
    await companion.close();
    /* Windows 上刚被结束的子进程（stdio MCP 服务器）要过一小会儿才松开它的工作目录，立刻删会报 EPERM：重试几次。 */
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return ctx;
}

async function pair(ctx, ttl = 'hours:2', origin = ORIGIN) {
  const asked = await request(ctx.base, 'POST', '/pair', { body: { client: 'Reader-II test', ua: 'node' }, headers: { Origin: origin } });
  assert.equal(asked.data.ok, true);
  const approved = await ctx.admin('POST', '/admin/approve', { id: asked.data.id, ttl });
  assert.equal(approved.data.ok, true, approved.text);
  const polled = await request(ctx.base, 'GET', '/pair/' + asked.data.id);
  ctx.token = polled.data.token;
  return { id: asked.data.id, code: asked.data.code, polled: polled.data };
}

/* dev:/ 的路径段：设备上的绝对路径 → 段数组。 */
const segsOf = (full) => (POSIX ? full.split('/').filter(Boolean) : [full.slice(0, 2), ...full.slice(3).split('\\').filter(Boolean)]);

test('放行：没有令牌什么都做不了；管理页的几道门；令牌只交付一次；来源核对；撤销', async (t) => {
  const ctx = await boot(t);
  const status = await request(ctx.base, 'GET', '/status');
  assert.equal(status.data.name, 'reader-ii-companion');
  assert.equal(status.data.api, 1);
  assert.equal(status.data.grant, null);
  assert.match(status.data.adminUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(!status.text.includes(ctx.key), '状态接口不该带出管理密钥');

  const denied = await request(ctx.base, 'POST', '/op/env', { body: {} });
  assert.equal(denied.status, 401);
  assert.equal(denied.data.code, 'no_grant');
  assert.equal((await request(ctx.base, 'POST', '/op/env', { body: {}, headers: { 'X-Reader-II-Token': 'f'.repeat(64) } })).status, 401);

  const asked = await request(ctx.base, 'POST', '/pair', { body: { client: 'Reader-II test', ua: 'node' }, headers: { Origin: ORIGIN } });
  assert.match(asked.data.code, /^\d{4}$/);
  assert.ok(!asked.text.includes(ctx.key), '配对回应不该带出管理密钥');
  assert.equal((await request(ctx.base, 'GET', '/pair/' + asked.data.id)).data.state, 'pending');

  /* 管理页的门：密钥、Host、来源、只收 JSON。 */
  assert.equal((await request(ctx.base, 'GET', '/admin/state')).status, 401);
  assert.equal((await request(ctx.base, 'GET', '/admin/state', { headers: { 'X-Admin-Key': 'x'.repeat(48) } })).status, 401);
  assert.equal((await request(ctx.base, 'GET', '/admin/state', { headers: { 'X-Admin-Key': ctx.key, Host: 'evil.example:80' } })).status, 403, '只认发给本机地址的请求（防 DNS 重绑定）');
  assert.equal((await request(ctx.base, 'POST', '/admin/approve', { body: { id: asked.data.id, ttl: 'always' }, headers: { 'X-Admin-Key': ctx.key, Origin: ORIGIN } })).status, 403, '别的源不能调管理接口');
  assert.equal((await request(ctx.base, 'POST', '/admin/approve', { body: JSON.stringify({ id: asked.data.id, ttl: 'always' }), headers: { 'X-Admin-Key': ctx.key, 'Content-Type': 'text/plain' } })).status, 415, '只收 JSON 请求体');
  assert.equal((await request(ctx.base, 'POST', '/admin/approve', { body: { id: asked.data.id, ttl: 'always' } })).status, 401);
  assert.equal((await request(ctx.base, 'GET', '/pair/' + asked.data.id)).data.state, 'pending', '上面几次都不该放行成功');
  const page = await request(ctx.base, 'GET', '/');
  assert.match(page.text, /管理页/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!page.text.includes(ctx.key), '管理页本身不带密钥');
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const state = await ctx.admin('GET', '/admin/state');
  assert.equal(state.data.pending.length, 1);
  assert.equal(state.data.pending[0].code, asked.data.code);
  assert.equal(state.data.pending[0].origin, ORIGIN);

  const approved = await ctx.admin('POST', '/admin/approve', { id: asked.data.id, ttl: 'hours:2' });
  assert.equal(approved.data.ok, true);
  const first = await request(ctx.base, 'GET', '/pair/' + asked.data.id);
  assert.equal(first.data.state, 'approved');
  assert.match(first.data.token, /^[a-f0-9]{64}$/);
  assert.ok(first.data.expiresAt > Date.now() + 3600 * 1000);
  assert.equal((await request(ctx.base, 'GET', '/pair/' + asked.data.id)).data.state, 'expired', '令牌只交付一次');
  ctx.token = first.data.token;

  const saved = fs.readFileSync(path.join(ctx.home, 'grants.json'), 'utf8');
  assert.ok(!saved.includes(ctx.token), '磁盘上只存令牌的哈希');
  assert.equal((await request(ctx.base, 'GET', '/status', { headers: { 'X-Reader-II-Token': ctx.token, Origin: ORIGIN } })).data.grant.persistent, false);

  const wrongOrigin = await request(ctx.base, 'POST', '/op/env', { body: {}, headers: { 'X-Reader-II-Token': ctx.token, Origin: 'http://other.test' } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.data.code, 'bad_origin');

  const env = await ctx.ok('env');
  assert.equal(env.platform, process.platform);
  assert.match(env.tools.node, /^\d+\.\d+/);
  assert.equal(env.workspace, ctx.workspace);
  assert.equal((await ctx.op('nope')).code, 'unknown_op');

  const preflight = await request(ctx.base, 'OPTIONS', '/op/env', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

  const audit = (await ctx.admin('GET', '/admin/state')).data;
  assert.equal(audit.grants.length, 1);
  assert.ok(audit.audit.some((entry) => entry.op === 'grant'));
  await ctx.admin('POST', '/admin/revoke', { id: audit.grants[0].id });
  assert.equal((await request(ctx.base, 'POST', '/op/env', { body: {}, headers: { 'X-Reader-II-Token': ctx.token, Origin: ORIGIN } })).status, 401, '撤销后令牌失效');

  /* 「到伴侣重启为止」的放行不落盘；页面主动断开。 */
  await pair(ctx, 'session');
  assert.ok(!fs.readFileSync(path.join(ctx.home, 'grants.json'), 'utf8').includes('"persistent": true'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, 'grants.json'), 'utf8')).length, 0);
  await request(ctx.base, 'POST', '/release', { body: {}, headers: { 'X-Reader-II-Token': ctx.token, Origin: ORIGIN } });
  assert.equal((await ctx.op('env')).code, 'no_grant');
});

test('放行：长期放行落盘，伴侣重启后仍有效；过期的不再有效', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-companion-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = createCompanion({ mode: 'standalone', home, quiet: true });
  const started = await first.start({ port: 0 });
  const ctx = { base: `http://127.0.0.1:${started.port}`, key: first.adminKey(), token: '' };
  ctx.admin = (method, target, body) => request(ctx.base, method, target, { body, headers: { 'X-Admin-Key': ctx.key } });
  await pair(ctx, 'always');
  const forever = ctx.token;
  await pair(ctx, 'hours:0.05');
  const brief = ctx.token;
  await first.close();

  /* 把短期放行改成已经过期，再重启。 */
  const file = path.join(home, 'grants.json');
  const grants = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(grants.length, 2);
  for (const grant of grants) if (grant.expiresAt) grant.expiresAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(grants));
  const second = createCompanion({ mode: 'standalone', home, quiet: true });
  t.after(() => second.close());
  const again = await second.start({ port: 0 });
  assert.equal(second.adminKey(), ctx.key, '管理密钥跨重启不变');
  const base = `http://127.0.0.1:${again.port}`;
  const withToken = (token) => request(base, 'GET', '/status', { headers: { 'X-Reader-II-Token': token, Origin: ORIGIN } });
  assert.equal((await withToken(forever)).data.grant.persistent, true);
  assert.equal((await withToken(brief)).data.grant, null);
});

test('命令：输出与退出码、工作目录、标准输入、超时转后台、查看与停掉任务、管理页关掉命令', { skip: !POSIX && '命令写法按 sh 写的' }, async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const node = JSON.stringify(process.execPath);

  const hello = await ctx.ok('exec', { command: `${node} -e "console.log('你好', 1 + 1); console.error('到标准错误')"` });
  assert.equal(hello.exitCode, 0);
  assert.equal(hello.running, false);
  assert.match(hello.output, /你好 2/);
  assert.match(hello.output, /到标准错误/);
  assert.equal((await ctx.ok('exec', { command: `${node} -e "process.exit(3)"` })).exitCode, 3);

  const where = await ctx.ok('exec', { command: `${node} -e "console.log(process.cwd())"`, cwdSegs: ['@ws'] });
  assert.equal(where.output.trim(), fs.realpathSync(ctx.workspace));
  const piped = await ctx.ok('exec', { command: `${node} -e "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"`, stdin: 'abc' });
  assert.equal(piped.output, 'ABC');
  assert.match((await ctx.op('exec', { command: 'echo hi', cwd: path.join(ctx.workspace, 'no-such-dir') })).error, /工作目录不存在/);
  assert.match((await ctx.op('exec', { command: 'echo hi', cwd: ctx.home })).error, /数据目录/);

  const slow = await ctx.ok('exec', { command: `${node} -e "setInterval(() => console.log('tick'), 100)"`, timeoutSec: 1 });
  assert.equal(slow.running, true, '超时后应当转成后台任务，而不是杀掉');
  assert.match(slow.output, /tick/);
  const listed = await ctx.ok('job', { action: 'list' });
  assert.ok(listed.jobs.some((job) => job.id === slow.id && job.running));
  const log = await ctx.ok('job', { action: 'log', id: slow.id, offset: 0 });
  assert.match(log.text, /tick/);
  assert.equal(log.next, log.text.length);
  const killed = await ctx.ok('job', { action: 'kill', id: slow.id });
  assert.equal(killed.killed, true);
  assert.equal(killed.running, false);
  assert.equal((await ctx.ok('job', { action: 'status', id: slow.id })).running, false);

  const background = await ctx.ok('exec', { command: `${node} -e "setInterval(() => {}, 1000)"`, background: true, rid: 'request-1' });
  assert.equal(background.running, true);
  assert.equal((await ctx.ok('job', { action: 'kill', rid: 'request-1' })).killed, true, '前端点了停止时按请求号停掉');
  assert.equal((await ctx.ok('job', { action: 'kill', rid: 'no-such' })).killed, false);
  assert.match((await ctx.op('job', { action: 'status', id: 'j999' })).error, /没有这个任务/);

  await ctx.admin('POST', '/admin/config', { exec: false });
  const off = await ctx.op('exec', { command: 'echo hi' });
  assert.equal(off.ok, false);
  assert.equal(off.code, 'disabled');
  assert.equal((await ctx.op('mcp_start', { id: 'x', command: 'node' })).code, 'disabled');
  await ctx.admin('POST', '/admin/config', { exec: true });
  assert.equal((await ctx.ok('exec', { command: 'echo back' })).output.trim(), 'back');
  const audit = (await ctx.admin('GET', '/admin/state')).data.audit;
  assert.ok(audit.some((entry) => entry.op === 'exec' && /echo back/.test(entry.summary)), '命令要记进操作记录');
});

test('文件：读写、CRLF 还原、二进制、越界与符号链接、目录限制、删除', async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const roots = await ctx.ok('fs_list', { segs: [] });
  assert.ok(roots.items.some((item) => item.name === '~') && roots.items.some((item) => item.name === '@ws'));

  const written = await ctx.ok('fs_write', { segs: ['@ws', 'a', 'b.txt'], text: '第一行\n第二行\n' });
  assert.equal(written.created, true);
  assert.equal(fs.readFileSync(path.join(ctx.workspace, 'a', 'b.txt'), 'utf8'), '第一行\n第二行\n');
  assert.equal((await ctx.ok('fs_read', { segs: ['@ws', 'a', 'b.txt'] })).text, '第一行\n第二行\n');
  assert.equal((await ctx.ok('fs_write', { segs: ['@ws', 'a', 'b.txt'], text: '改过\n' })).created, false);
  const listing = await ctx.ok('fs_list', { segs: ['@ws', 'a'] });
  assert.deepEqual(listing.items.map((item) => [item.name, item.dir, item.size]), [['b.txt', false, Buffer.byteLength('改过\n')]]);
  assert.deepEqual(await ctx.ok('fs_read', { segs: ['@ws', 'a', 'none.txt'] }), { missing: true });
  assert.deepEqual(await ctx.ok('fs_read', { segs: ['@ws', 'a'] }), { dir: true });
  assert.match((await ctx.op('fs_list', { segs: ['@ws', 'nope'] })).error, /没有这个目录/);

  /* Windows 换行：读到的是 \n，写回去还原成 \r\n。 */
  fs.writeFileSync(path.join(ctx.workspace, 'crlf.txt'), 'one\r\ntwo\r\n');
  assert.equal((await ctx.ok('fs_read', { segs: ['@ws', 'crlf.txt'] })).text, 'one\ntwo\n');
  await ctx.ok('fs_write', { segs: ['@ws', 'crlf.txt'], text: 'one\n2\n' });
  assert.equal(fs.readFileSync(path.join(ctx.workspace, 'crlf.txt'), 'utf8'), 'one\r\n2\r\n');

  fs.writeFileSync(path.join(ctx.workspace, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  assert.deepEqual(await ctx.ok('fs_read', { segs: ['@ws', 'blob.bin'] }), { binary: true, bytes: 4 });

  /* 越界：.. 、伴侣自己的数据目录、符号链接。 */
  assert.match((await ctx.op('fs_read', { segs: ['@ws', '..', 'admin.key'] })).error, /不允许的段/);
  assert.match((await ctx.op('fs_read', { segs: [...segsOf(ctx.home), 'admin.key'] })).error, /数据目录/);
  assert.match((await ctx.op('fs_write', { segs: [...segsOf(ctx.home), 'config.json'], text: '{}' })).error, /数据目录/);
  assert.match((await ctx.op('fs_list', { segs: segsOf(ctx.home) })).error, /数据目录/);
  if (POSIX) {
    fs.symlinkSync(ctx.home, path.join(ctx.workspace, 'escape'));
    assert.match((await ctx.op('fs_read', { segs: ['@ws', 'escape', 'admin.key'] })).error, /数据目录/, '不能用符号链接绕出去');
  }

  /* 管理页上限定目录之后，只能在限定的目录与工作目录里活动。 */
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-outside-'));
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-allowed-'));
  t.after(() => { fs.rmSync(outside, { recursive: true, force: true }); fs.rmSync(allowed, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
  fs.writeFileSync(path.join(allowed, 'y.txt'), 'allowed');
  assert.equal((await ctx.ok('fs_read', { segs: [...segsOf(outside), 'x.txt'] })).text, 'outside');
  await ctx.admin('POST', '/admin/config', { fsRoots: [allowed] });
  assert.match((await ctx.op('fs_read', { segs: [...segsOf(outside), 'x.txt'] })).error, /不在允许的目录里/);
  assert.equal((await ctx.ok('fs_read', { segs: [...segsOf(allowed), 'y.txt'] })).text, 'allowed');
  assert.equal((await ctx.ok('fs_read', { segs: ['@ws', 'a', 'b.txt'] })).text, '改过\n');
  await ctx.admin('POST', '/admin/config', { fsRoots: [] });

  assert.match((await ctx.op('fs_remove', { segs: ['@ws', 'a'] })).error, /不是空的/);
  await ctx.ok('fs_remove', { segs: ['@ws', 'a', 'b.txt'] });
  await ctx.ok('fs_remove', { segs: ['@ws', 'a'] });
  assert.equal(fs.existsSync(path.join(ctx.workspace, 'a')), false);
  assert.match((await ctx.op('fs_remove', { segs: ['@ws', 'a'] })).error, /没有这个文件/);
});

test('检索：在设备上找，带上下文，跳过依赖目录与二进制，单个文件', async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const base = path.join(ctx.workspace, 'proj');
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.mkdirSync(path.join(base, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(base, 'src', 'main.js'), 'const a = 1;\nfunction registerTool() {}\nconst b = 2;\n');
  fs.writeFileSync(path.join(base, 'README.md'), '# 说明\n这里提到 registerTool 一次。\n');
  fs.writeFileSync(path.join(base, 'node_modules', 'dep', 'index.js'), 'registerTool();\n');
  fs.writeFileSync(path.join(base, 'data.bin'), Buffer.from([0, 1, 2, 114, 101, 103]));
  const found = await ctx.ok('fs_grep', { segs: ['@ws', 'proj'], pattern: 'registertool', flags: 'i', limit: 10 });
  assert.equal(found.total, 2);
  assert.equal(found.files, 2);
  assert.equal(found.single, false);
  assert.deepEqual(found.hits.map((hit) => [hit.rel, hit.line]).sort(), [['README.md', 2], ['src/main.js', 2]]);
  const context = await ctx.ok('fs_grep', { segs: ['@ws', 'proj', 'src'], pattern: 'registerTool', context: 1 });
  assert.deepEqual(context.hits, [{ rel: 'main.js', from: 1, lines: ['const a = 1;', 'function registerTool() {}', 'const b = 2;'] }]);
  const single = await ctx.ok('fs_grep', { segs: ['@ws', 'proj', 'src', 'main.js'], pattern: 'const' });
  assert.equal(single.single, true);
  assert.equal(single.total, 2);
  assert.equal((await ctx.ok('fs_grep', { segs: ['@ws', 'proj'], pattern: 'zzz-not-here' })).total, 0);
  assert.match((await ctx.op('fs_grep', { segs: ['@ws', 'nowhere'], pattern: 'x' })).error, /没有这个路径/);
});

test('HTTP 代发：状态与响应头、请求体与请求头、二进制、SSE 拿到结果就返回', async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/json') { res.writeHead(201, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'abc' }); res.end('{"ok":true}'); return; }
      if (req.url === '/echo') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${req.method} ${req.headers['x-test']} ${Buffer.concat(chunks).toString('utf8')}`); return; }
      if (req.url === '/image') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from([1, 2, 3])); return; }
      if (req.url === '/sse') {
        /* 发完结果也不关流：伴侣应当拿到 id 对上的结果就返回。 */
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
        setTimeout(() => res.write('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"done":true}}\n\n'), 150);
        return;
      }
      res.writeHead(404); res.end('no');
    });
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => { target.closeAllConnections(); target.close(); });
  const origin = `http://127.0.0.1:${target.address().port}`;

  const json = await ctx.ok('http', { url: origin + '/json' });
  assert.equal(json.status, 201);
  assert.equal(json.text, '{"ok":true}');
  assert.equal(json.headers['mcp-session-id'], 'abc');
  const echo = await ctx.ok('http', { url: origin + '/echo', method: 'POST', headers: { 'X-Test': 'yes', Host: 'ignored.example' }, body: '正文' });
  assert.equal(echo.text, 'POST yes 正文');
  assert.equal((await ctx.ok('http', { url: origin + '/image' })).binary, true);
  assert.equal((await ctx.ok('http', { url: origin + '/missing' })).status, 404);
  const started = Date.now();
  const sse = await ctx.ok('http', { url: origin + '/sse', method: 'POST', body: '{}', sseUntilId: 7, timeoutMs: 8000 });
  assert.ok(Date.now() - started < 4000, '不该等到超时');
  assert.match(sse.text, /"id":7/);
  assert.match((await ctx.op('http', { url: 'file:///etc/passwd' })).error, /只能访问 http/);
  assert.match((await ctx.op('http', { url: 'http://127.0.0.1:1/' })).error, /请求失败/);
});

test('stdio MCP：启动、转发请求与通知、重复启动不重开、停止、启动失败说明原因', async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const script = path.join(ctx.workspace, 'fake-mcp.mjs');
  fs.writeFileSync(script, [
    "import readline from 'node:readline';",
    "const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "process.stderr.write('fake server up\\n');",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') out({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: process.env.FAKE_VERSION || '0' } } });",
    "  else if (message.method === 'tools/list') { out({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' }); out({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } }); }",
    "  else if (message.method === 'tools/call') out({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(message.params.arguments) }] } });",
    "  else if (message.id !== undefined && message.result === undefined && message.error === undefined) out({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });",
    "  else if (message.error) process.stderr.write('client rejected ' + message.id + '\\n');",
    "});",
  ].join('\n'));
  const start = { id: 'fake', command: process.execPath, args: [script], env: { FAKE_VERSION: '9' } };
  assert.equal((await ctx.ok('mcp_start', start)).started, true);
  assert.equal((await ctx.ok('mcp_start', start)).started, false, '同一条命令不重复启动');
  const init = await ctx.ok('mcp_send', { id: 'fake', message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(init.response.result.serverInfo.version, '9', '环境变量要传给服务器');
  assert.equal((await ctx.ok('mcp_send', { id: 'fake', message: { jsonrpc: '2.0', method: 'notifications/initialized' } })).response, null);
  const tools = await ctx.ok('mcp_send', { id: 'fake', message: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.equal(tools.response.result.tools[0].name, 'echo');
  const called = await ctx.ok('mcp_send', { id: 'fake', message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { 文字: '夜梦' } } } });
  assert.equal(called.response.result.content[0].text, '{"文字":"夜梦"}');
  assert.equal((await ctx.ok('mcp_stop', { id: 'fake' })).wasRunning, true);
  const gone = await ctx.op('mcp_send', { id: 'fake', message: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
  assert.equal(gone.code, 'mcp_not_running');
  const bad = await ctx.op('mcp_start', { id: 'bad', command: path.join(ctx.workspace, 'missing-mcp-executable'), args: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /一启动就退出了|ENOENT|找不到|not found/i);

  /* 进程启动不等于协议就绪：让服务器在收到请求后才退出，不假设 Node 能在 250ms 内启动。 */
  const broken = path.join(ctx.workspace, 'broken-mcp.mjs');
  fs.writeFileSync(broken, "process.stdin.once('data', () => { console.error('缺少依赖'); process.exit(2); });");
  await ctx.ok('mcp_start', { id: 'broken', command: process.execPath, args: [broken] });
  const message = { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} };
  const failed = await ctx.op('mcp_send', { id: 'broken', message, timeoutMs: 10000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'mcp_not_running');
  assert.match(failed.error, /缺少依赖/);
  const again = await ctx.op('mcp_send', { id: 'broken', message });
  assert.equal(again.code, 'mcp_not_running');
  assert.match(again.error, /缺少依赖/, '退出后的后续请求仍应说明原因');
});

test('无头浏览器：打开、取文字、输入与点击、控制台、截图、关闭', async (t) => {
  const ctx = await boot(t);
  await pair(ctx);
  const env = await ctx.ok('env');
  if (!env.browser) { t.skip('这台机器上没有 Chrome / Chromium / Edge'); return; }
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>试验页</title><h1 id="t">标题</h1><input id="name"><button id="go" onclick="document.getElementById(\'t\').textContent = \'你好，\' + document.getElementById(\'name\').value">go</button><script>console.error("page-error-1")</script>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => { site.closeAllConnections(); site.close(); });
  const url = `http://127.0.0.1:${site.address().port}/`;
  assert.match((await ctx.op('browser', { action: 'text' })).error, /还没打开/);
  const opened = await ctx.ok('browser', { action: 'open', url });
  assert.match(opened, /试验页/);
  assert.match(opened, /1 条报错/);
  assert.match(await ctx.ok('browser', { action: 'text' }), /标题/);
  await ctx.ok('browser', { action: 'type', selector: '#name', text: '夜梦' });
  await ctx.ok('browser', { action: 'click', selector: '#go' });
  assert.equal(await ctx.ok('browser', { action: 'eval', code: "return document.getElementById('t').textContent" }), '你好，夜梦');
  assert.equal(await ctx.ok('browser', { action: 'text', selector: '#t' }).then((text) => /你好，夜梦/.test(text)), true);
  assert.match(await ctx.ok('browser', { action: 'console' }), /page-error-1/);
  assert.match((await ctx.op('browser', { action: 'click', selector: '#nope' })).error, /没有匹配/);
  assert.match((await ctx.op('browser', { action: 'eval', code: 'throw new Error("炸了")' })).error, /炸了/);
  const shot = await ctx.ok('browser', { action: 'screenshot' });
  const name = /screenshots\/([\w.-]+\.png)/.exec(shot)[1];
  assert.ok(fs.statSync(path.join(ctx.workspace, 'screenshots', name)).size > 500);
  assert.match(await ctx.ok('browser', { action: 'close' }), /已关闭/);
  await ctx.admin('POST', '/admin/config', { browser: false });
  assert.equal((await ctx.op('browser', { action: 'open', url })).code, 'disabled');
});

test('入口：酒馆后端插件（接口挂在路由上，管理页另开端口）与独立运行', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-ii-companion-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  /* 插件入口：在子进程里加载，免得环境变量与端口影响别的测试。 */
  const probe = [
    "const { pathToFileURL } = await import('node:url');",
    "const plugin = await import(pathToFileURL(process.argv[1]).href);",
    "let handler = null;",
    "const router = { stack: [], use(fn) { handler = fn; this.stack.push(fn); } };",
    "await plugin.init(router);",
    "const call = (req) => new Promise((resolve) => { const res = { code: 0, headers: {}, status(code) { this.code = code; return this; }, setHeader(name, value) { this.headers[name] = value; }, send(body) { resolve({ status: this.code, body }); }, json(body) { resolve({ status: this.code, body: JSON.stringify(body) }); } }; handler(req, res); });",
    "const status = await call({ method: 'GET', path: '/status', headers: {}, body: undefined });",
    "const denied = await call({ method: 'POST', path: '/op/env', headers: {}, body: {} });",
    "const pairing = await call({ method: 'POST', path: '/pair', headers: { origin: 'http://127.0.0.1:8000' }, body: { client: 'x' } });",
    "console.log('RESULT ' + JSON.stringify({ info: plugin.info, layers: router.stack.length, status: JSON.parse(status.body), denied: denied.status, pairing: JSON.parse(pairing.body) }));",
    "await plugin.exit();",
  ].join('\n');
  const plugin = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', probe, path.join(ROOT, 'companion', 'index.mjs')], { env: { ...process.env, READER_II_COMPANION_HOME: home, READER_II_COMPANION_ADMIN_PORT: '0' } });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`插件入口退出码 ${code}：${err || out}`))));
  });
  const result = JSON.parse(/RESULT (.*)/.exec(plugin)[1]);
  assert.equal(result.info.id, 'reader-ii');
  assert.equal(result.layers, 1, '要往路由上挂东西，酒馆才会把它接到 /api/plugins/reader-ii');
  assert.equal(result.status.mode, 'plugin');
  assert.match(result.status.adminUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(result.denied, 401);
  assert.match(result.pairing.code, /^\d{4}$/);
  assert.match(plugin, /管理页（在这台设备的浏览器里打开/);

  /* 仓库根的 package.json 把入口指向伴侣：整个仓库克隆进 plugins/ 时酒馆能找到它。 */
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(rootPackage.main, 'companion/index.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, rootPackage.main)));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
  assert.equal(rootPackage.version, version, '构建会把版本号同步到 package.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'companion', 'package.json'), 'utf8')).version, version);
  assert.equal(result.status.version, version);

  /* 独立运行。 */
  const child = spawn(process.execPath, [path.join(ROOT, 'companion', 'standalone.mjs'), '--port', '0', '--home', home]);
  t.after(() => child.kill());
  const printed = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('独立运行 10 秒内没有起来：' + out)), 10000);
    child.stdout.on('data', (chunk) => { out += chunk; if (/伴侣地址填成/.test(out)) { clearTimeout(timer); resolve(out); } });
    child.on('close', (code) => { clearTimeout(timer); reject(new Error(`独立运行提前退出（${code}）：${out}`)); });
  });
  const base = /伴侣地址填成：(http:\/\/127\.0\.0\.1:\d+)/.exec(printed)[1];
  const status = await request(base, 'GET', '/status');
  assert.equal(status.data.mode, 'standalone');
  assert.match(printed, /#key=[a-f0-9]{48}/);
  child.kill('SIGTERM');
  await sleep(200);
});
