/*
 * 联网、MCP、设备（交接 0.6 乙组）在扩展这一侧的 Node 测试：mock 酒馆 + 可编程的 fetch。
 *   node --test tests/net.test.mjs
 * 覆盖：「联网」权限（net）的判定；web_fetch 的主机信任、换路、缓存；gh:/ 的列目录、读、检索、额度与令牌；
 *       github_push（Git Data API 的请求序列、空仓库、没有令牌、档位）；MCP 的 HTTP（JSON 与 SSE）、会话、
 *       参数映射、trust、TauriTavern 接口；设备工具配假伴侣（配对、dev:/ 读写撤销、检索、命令与规则、没有伴侣时的说明）。
 * 没覆盖：真实网络与真实的 GitHub / MCP 服务器；浏览器里的 DOMParser 转换与沙箱断网（在冒烟里）；真伴侣（tests/companion.test.mjs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EXT_MODULES, bundle } from '../build.mjs';

const CODE = bundle(EXT_MODULES);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (actual, expected) => assert.deepStrictEqual(clone(actual), expected);
const lower = (headers) => Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const call = (name, args) => `<tool_call name="${name}">\n${Object.entries(args).map(([key, value]) => `<arg name="${key}">${value}</arg>`).join('\n')}\n</tool_call>`;

/* routes: [[前缀字符串或正则, (url, init) => Response]]；没有匹配的按「连不上」处理（TypeError）。 */
function makeHost({ routes = [], replies = [], globals = {} } = {}) {
  const calls = [];
  const queue = replies.slice();
  const llmCalls = [];
  const storage = new Map();
  const vars = { chat: {}, global: {}, character: {}, message: {} };
  const chat = [{ name: '旁白', is_user: false, mes: '清晨，王都的钟声响起。' }, { name: '我', is_user: true, mes: '我推开了酒馆的门。' }];
  const ctx = {
    chat, characterId: 0, name1: '我', name2: '艾琳', chatId: 'chat-1',
    characters: [{ name: '艾琳', avatar: 'ailin.png', description: '老板娘', data: { description: '老板娘', extensions: {} } }],
    chatMetadata: { variables: vars.chat }, extensionSettings: {},
    getCurrentChatId: () => 'chat-1', saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
    setExtensionPrompt: () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
    eventSource: { on() {}, once() {}, removeListener() {}, emit: async () => {} },
    eventTypes: { GENERATION_ENDED: 'generation_ended', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_id_changed', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS' },
  };
  const helper = {
    getWorldbookNames: () => [], getGlobalWorldbookNames: () => [], getCharWorldbookNames: () => ({ primary: null, additional: [] }), getChatWorldbookName: () => null,
    getWorldbook: async () => [], getTavernRegexes: () => [], getScriptTrees: () => [],
    getVariables: (option) => clone(vars[option.type]),
    replaceVariables: async (value, option) => { vars[option.type] = clone(value); if (option.type === 'chat') ctx.chatMetadata.variables = vars.chat; },
    generateRaw: async (config) => {
      llmCalls.push(clone(config.ordered_prompts));
      const next = queue.shift();
      return next === undefined ? '（没有更多脚本化回复）' : next;
    },
  };
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url || input);
    const record = { url, method: String(init.method || 'GET').toUpperCase(), headers: lower(init.headers), body: init.body };
    calls.push(record);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url.startsWith(match) : match.test(url)) return handler(url, init, record);
    }
    throw new TypeError('Failed to fetch');
  };
  const host = {
    SillyTavern: { getContext: () => ctx }, TavernHelper: helper,
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    console: { log() {}, info() {}, warn() {}, error() {} },
    document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
    navigator: { userAgent: 'node-test' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    fetch, Function, setTimeout, clearTimeout, AbortController, URL, TextEncoder, TextDecoder, btoa, atob, crypto: globalThis.crypto,
    ...globals,
  };
  host.window = host;
  host.parent = host;
  vm.createContext(host);
  vm.runInContext(CODE, host, { filename: 'reader-ii.ext.js' });
  const api = host.ReaderII;
  /* 这些测试里一个宿主会连着跑好几轮：关掉「对话沉淀为记忆」，免得它在后台调用模型、吃掉脚本化的回复。 */
  api.memory.saveSettings({ agentExtract: false, autoExtract: false });
  return { host, api, agent: api.agent, vfs: api.vfs, calls, llmCalls, storage, replies: queue };
}

test('权限：联网（net）不受档位限制，默认每次问；按 key 记住；规则与「全部直接执行」可免问', () => {
  const { host } = makeHost();
  const modules = host.__ReaderIIModules;
  let settings = { mode: 'card', approval: 'ask', rules: [] };
  const permissions = modules.createPermissions(() => settings);
  const fetchA = { effect: 'net', scope: 'external', tool: 'web_fetch', path: 'https://a.example/x', key: 'host:a.example' };
  const fetchB = { ...fetchA, path: 'https://b.example/x', key: 'host:b.example' };
  assert.equal(permissions.evaluate(fetchA).decision, 'ask');
  permissions.allowSession(fetchA);
  assert.equal(permissions.evaluate(fetchA).decision, 'allow');
  assert.equal(permissions.evaluate(fetchB).decision, 'ask', '别的主机不该被一并放行');
  permissions.resetSession();
  settings = { mode: 'readonly', approval: 'ask', rules: [] };
  assert.equal(permissions.evaluate(fetchA).decision, 'ask', '只读档位下联网仍可以问，不是直接拒绝');
  settings = { mode: 'tavern', approval: 'auto', rules: [] };
  assert.equal(permissions.evaluate(fetchA).decision, 'ask', '「档位内直接执行」不包括联网');
  settings = { mode: 'card', approval: 'yolo', rules: [] };
  assert.equal(permissions.evaluate(fetchA).decision, 'allow');
  settings = { mode: 'card', approval: 'ask', rules: [{ effect: 'allow', action: '*', pattern: 'https://a.example/**' }, { effect: 'deny', action: '*', pattern: 'https://b.example/**' }] };
  assert.equal(permissions.evaluate(fetchA).decision, 'allow');
  assert.equal(permissions.evaluate(fetchB).decision, 'deny');
  settings = { mode: 'tavern', approval: 'yolo', rules: [] };
  assert.equal(permissions.evaluate({ effect: 'net', scope: 'device', tool: 'x' }).decision, 'deny', '经伴侣的联网操作要设备全权');
});

test('设置：web / mcp / companion 三段的规整；对接 id 不能占用内置工具箱', () => {
  const { agent } = makeHost();
  same(agent.getSettings().web.allowHosts.slice(0, 2), ['github.com', 'api.github.com']);
  const saved = agent.saveSettings({ web: { allowHosts: ['Example.COM', 'https://docs.a.b/path?q=1', 'bad host!', '*.wiki.org', 'example.com'], proxy: 'not-a-template' }, companion: { url: 'ftp://nope' } });
  same(saved.web, { allowHosts: ['example.com', 'docs.a.b', '*.wiki.org'], proxy: '', visit: true });
  assert.equal(saved.companion.url, '');
  assert.equal(agent.saveSettings({ web: { allowHosts: [], proxy: 'https://r.example/{url}' }, companion: { url: 'http://127.0.0.1:8790/' } }).web.proxy, 'https://r.example/{url}');
  assert.equal(agent.getSettings().companion.url, 'http://127.0.0.1:8790');
  same(agent.getSettings().web.allowHosts, []);
  assert.throws(() => agent.validateConnector({ id: 'web', title: 'x', detect: 'window.X', tools: [] }), /内置工具箱/);
  const names = agent.listToolsets().map((set) => set.name);
  assert.ok(names.includes('web') && names.includes('device'));
  const mounts = agent.vfs.mounts().map((mount) => mount.id);
  for (const id of ['gh', 'web', 'dev']) assert.ok(mounts.includes(id), `缺少挂载点 ${id}`);
});

test('web_fetch：用户给的网址免问；陌生主机先问、可按主机记住；直连被拦时换酒馆后端；全文留在 web:/', async () => {
  const page = '<html><head><title>指南</title><style>p{}</style></head><body><h1>安装</h1><p>第一步&amp;第二步</p><ul><li>甲</li><li>乙</li></ul><script>evil()</script></body></html>';
  const routes = [
    ['https://docs.example.com/', () => new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['/api/search/visit', (url, init) => {
      const target = JSON.parse(init.body).url;
      return new Response(`<html><body><h2>来自 ${target}</h2><p>${'长'.repeat(30)}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }],
  ];
  const replies = [
    call('web_fetch', { url: 'https://docs.example.com/guide' }), '读完了。',
    call('web_fetch', { url: 'https://blocked.example.org/a' }) + call('web_fetch', { url: 'https://blocked.example.org/b' }), '也读完了。',
    call('web_fetch', { url: 'https://third.example.net/x' }), '你没同意。',
  ];
  const { agent, vfs, calls } = makeHost({ routes, replies });
  const asked = [];
  const confirm = (answer) => async (request) => { asked.push(request); return answer; };

  const first = await agent.run('看一下 https://docs.example.com/guide 讲了什么', { confirm: confirm('deny') });
  assert.equal(asked.length, 0, '用户自己给的网址不该问');
  assert.equal(first.steps[0].ok, true);
  assert.match(first.steps[0].summary, /《指南》/);
  const cached = await vfs.list('web:/', {});
  assert.equal(cached.items.length, 1);
  const text = await vfs.readText('web:/' + cached.items[0].name);
  assert.match(text, /# 安装/);
  assert.match(text, /第一步&第二步/);
  assert.match(text, /- 甲/);
  assert.ok(!/evil/.test(text), '脚本内容不该进正文');
  assert.equal((await vfs.grep('web:/', '第二步', {})).total, 1);

  const second = await agent.run('再查点别的', { confirm: confirm('always') });
  assert.equal(asked.length, 1, '同一个主机点过「都允许」后不再问');
  assert.equal(asked[0].tier, 'net');
  assert.match(asked[0].alwaysLabel, /blocked\.example\.org/);
  same(second.steps.map((step) => step.ok), [true, true]);
  const visits = calls.filter((item) => item.url === '/api/search/visit');
  assert.equal(visits.length, 2, '直连失败后应改走酒馆后端');
  assert.equal(visits[0].headers['x-csrf-token'], 'csrf');
  assert.match(second.steps[0].summary, /经酒馆后端取得/);

  const third = await agent.run('最后一个', { confirm: confirm('deny') });
  assert.equal(third.steps[0].denied, true);
  assert.ok(!calls.some((item) => /third\.example\.net/.test(item.url)), '被拒绝的地址不该被访问');
});

test('gh:/：列目录、读文件、在目录里检索；太大时报错而不是只搜一部分；额度与令牌', async () => {
  const tree = { sha: 't', truncated: false, tree: [
    { path: 'README.md', type: 'blob', size: 20 }, { path: 'src', type: 'tree' },
    { path: 'src/a.js', type: 'blob', size: 30 }, { path: 'src/b.js', type: 'blob', size: 30 }, { path: 'src/logo.png', type: 'blob', size: 999 },
    { path: 'big', type: 'tree' }, ...Array.from({ length: 200 }, (_, index) => ({ path: `big/f${index}.js`, type: 'blob', size: 10 })),
  ] };
  let limited = false;
  const routes = [
    ['https://api.github.com/repos/o/r/git/trees/HEAD', () => (limited ? jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }) : jsonResponse(tree))],
    ['https://api.github.com/repos/o/r/contents/src/a.js', () => new Response('private a', { status: 200, headers: { 'content-type': 'application/vnd.github.raw+json' } })],
    ['https://raw.githubusercontent.com/o/r/HEAD/src/a.js', () => new Response('const a = 1;\nregisterTool(a);\n', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['https://raw.githubusercontent.com/o/r/HEAD/src/b.js', () => new Response('const b = 2;\n', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['https://raw.githubusercontent.com/o/r/HEAD/README.md', () => new Response('# 说明\n', { status: 200, headers: { 'content-type': 'text/plain' } })],
  ];
  const { vfs, api, calls } = makeHost({ routes });
  same((await vfs.list('gh:/', {})).items, []);
  same((await vfs.list('gh:/o/r', {})).items.map((item) => item.name + (item.dir ? '/' : '')), ['big/', 'src/', 'README.md']);
  same((await vfs.list('gh:/o/r/src', {})).items.map((item) => item.name), ['a.js', 'b.js', 'logo.png']);
  assert.equal(await vfs.readText('gh:/o/r/src/a.js'), 'const a = 1;\nregisterTool(a);\n');
  assert.equal(await vfs.readText('gh:/o/r/src/missing.js'), null);
  assert.match(await vfs.readText('gh:/o/r/src/logo.png'), /二进制/);
  const found = await vfs.grep('gh:/o/r/src', 'registerTool', {});
  assert.equal(found.total, 1);
  assert.match(found.hits[0], /^gh:\/o\/r\/src\/a\.js:2: /);
  assert.equal(found.scanned, 2, '二进制文件不参与检索');
  await assert.rejects(vfs.grep('gh:/o/r/big', 'x', {}), /一次搜不完/);
  assert.equal(calls.filter((item) => /git\/trees/.test(item.url)).length, 1, '目录树应当只取一次');
  await assert.rejects(vfs.write('gh:/o/r/README.md', 'x', null), /只读/);

  api.net.secrets.set('github.token', 'tok-123');
  assert.equal(await vfs.readText('gh:/o/r/src/a.js'), 'private a', '有令牌时文件走 API');
  const authed = calls.filter((item) => /contents\/src\/a\.js/.test(item.url)).at(-1);
  assert.equal(authed.headers.authorization, 'Bearer tok-123');
  assert.match(authed.headers.accept, /raw/);

  api.net.secrets.set('github.token', undefined);
  limited = true;
  await assert.rejects(vfs.list('gh:/o/other', {}), /访问不了/, '连不上时如实报错');
  await assert.rejects(vfs.grep('gh:/o', 'x', {}), /要在某个仓库里检索/);
  const fresh = makeHost({ routes: [['https://api.github.com/', () => jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })]] });
  await assert.rejects(fresh.vfs.list('gh:/o/r', {}), /匿名额度用完了.*令牌/);
});

test('github_push：Git Data API 的请求序列；危险操作要确认、要酒馆全权、要令牌；空仓库', async () => {
  const log = [];
  let refStatus = 200;
  const routes = [[/^https:\/\/api\.github\.com\/repos\/me\/ext/, (url, init, record) => {
    const path = url.replace('https://api.github.com/repos/me/ext', '');
    const body = record.body ? JSON.parse(record.body) : null;
    log.push({ method: record.method, path, body, auth: record.headers.authorization });
    if (record.method === 'GET' && path === '') return jsonResponse({ default_branch: 'main', permissions: { push: true } });
    if (record.method === 'GET' && path === '/git/ref/heads/main') return refStatus === 200 ? jsonResponse({ object: { sha: 'c0' } }) : jsonResponse({ message: 'Git Repository is empty.' }, 409);
    if (record.method === 'GET' && path === '/git/ref/heads/dev') return jsonResponse({ message: 'Not Found' }, 404);
    if (record.method === 'PUT' && path.startsWith('/contents/')) return jsonResponse({ commit: { sha: 'seed' } }, 201);
    if (record.method === 'GET' && /^\/git\/commits\//.test(path)) return jsonResponse({ tree: { sha: 't0' } });
    if (record.method === 'POST' && path === '/git/trees') return jsonResponse({ sha: 't1' }, 201);
    if (record.method === 'POST' && path === '/git/commits') return jsonResponse({ sha: 'c1' }, 201);
    if (record.method === 'PATCH' && path === '/git/refs/heads/main') return jsonResponse({ object: { sha: 'c1' } });
    if (record.method === 'POST' && path === '/git/refs') return jsonResponse({ ref: body.ref }, 201);
    return jsonResponse({ message: 'unexpected' }, 500);
  }]];
  const push = (extra = {}) => call('github_push', { repo: 'me/ext', message: '初版', source: 'ws:/projects/ext', ...extra });
  const replies = [push(), '没有令牌。', push(), '档位不够。', push({ target: 'pkg', remove: '["old.js"]' }), '推好了。', push({ branch: 'dev' }), '没有这个分支。', push({ branch: 'dev', create_branch: 'true' }), '新分支。', push(), '空仓库也推好了。'];
  const { agent, vfs, api } = makeHost({ routes, replies });
  await vfs.write('ws:/projects/ext/manifest.json', '{"display_name":"演示"}', null);
  await vfs.write('ws:/projects/ext/src/index.js', 'console.log("夜梦")', null);
  const asked = [];
  const confirm = async (request) => { asked.push(request); return 'allow'; };

  agent.saveSettings({ mode: 'tavern' });
  const noToken = await agent.run('推送', { confirm });
  assert.equal(noToken.steps[0].ok, false);
  assert.match(noToken.steps[0].summary, /需要 GitHub 令牌/);
  assert.equal(log.length, 0, '没有令牌时不该发任何请求');

  api.net.secrets.set('github.token', 'tok-9');
  agent.saveSettings({ mode: 'card' });
  const lowTier = await agent.run('推送', { confirm });
  assert.equal(lowTier.steps[0].denied, true);
  assert.match(lowTier.steps[0].summary, /酒馆全权/);

  agent.saveSettings({ mode: 'tavern', approval: 'auto' });
  asked.length = 0;
  const done = await agent.run('推送', { confirm });
  assert.equal(asked.length, 1, '推送是危险操作：档位内自动执行时也要问');
  assert.equal(asked[0].tier, 'danger');
  assert.match(asked[0].description, /me\/ext/);
  assert.equal(done.steps[0].ok, true, done.steps[0].summary);
  assert.match(done.steps[0].summary, /2 个文件，删除 1 个/);
  same(log.map((item) => `${item.method} ${item.path}`), ['GET ', 'GET /git/ref/heads/main', 'GET /git/commits/c0', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main']);
  assert.ok(log.every((item) => item.auth === 'Bearer tok-9'));
  const treeBody = log[3].body;
  assert.equal(treeBody.base_tree, 't0');
  same(treeBody.tree.map((entry) => [entry.path, entry.sha === null ? 'delete' : entry.content]), [['pkg/manifest.json', '{"display_name":"演示"}'], ['pkg/src/index.js', 'console.log("夜梦")'], ['old.js', 'delete']]);
  same(log[4].body, { message: '初版', tree: 't1', parents: ['c0'] });
  same(log[5].body, { sha: 'c1', force: false });

  const missing = await agent.run('推到 dev', { confirm });
  assert.match(missing.steps[0].summary, /没有分支 dev.*create_branch/);
  log.length = 0;
  const created = await agent.run('新建 dev 再推', { confirm });
  assert.equal(created.steps[0].ok, true, created.steps[0].summary);
  same(log.at(-1).body, { ref: 'refs/heads/dev', sha: 'c1' });

  refStatus = 409;
  log.length = 0;
  const empty = await agent.run('推到空仓库', { confirm });
  assert.equal(empty.steps[0].ok, true, empty.steps[0].summary);
  const seed = log.find((item) => item.method === 'PUT');
  assert.equal(seed.path, '/contents/manifest.json');
  assert.equal(Buffer.from(seed.body.content, 'base64').toString('utf8'), '{"display_name":"演示"}');
  same(log.find((item) => item.path === '/git/trees').body.tree.map((entry) => entry.path), ['src/index.js']);
  assert.match(empty.steps[0].summary, /2 次提交/);
});

/* 一个假的 MCP 服务器（Streamable HTTP）。 */
function mcpServer({ sse = false, expireOnce = false } = {}) {
  const seen = [];
  let session = 0;
  let expired = false;
  const handler = (url, init) => {
    const message = JSON.parse(init.body);
    const headers = lower(init.headers);
    seen.push({ method: message.method, headers, params: message.params });
    const reply = (result, extra = {}) => {
      const payload = { jsonrpc: '2.0', id: message.id, result };
      if (!sse) return jsonResponse(payload, 200, extra);
      const noise = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
      return new Response(`event: message\ndata: ${JSON.stringify(noise)}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', ...extra } });
    };
    if (message.method === 'initialize') { session += 1; return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } }, { 'mcp-session-id': 's' + session }); }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (expireOnce && !expired && message.method === 'tools/call') { expired = true; return new Response('session gone', { status: 404 }); }
    if (message.method === 'tools/list') {
      return reply({ tools: [
        { name: 'web-search', description: '搜索网页', inputSchema: { type: 'object', properties: { query: { type: 'string', description: '关键词' }, limit: { type: 'integer', default: 5 }, tags: { type: 'array', items: { type: 'string' } } }, required: ['query'] }, annotations: { readOnlyHint: true } },
        { name: 'post', description: '发帖', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'ping', inputSchema: { type: 'object' } },
      ] });
    }
    if (message.method === 'tools/call') {
      if (message.params.name === 'post') return reply({ content: [{ type: 'text', text: '发帖失败：没有权限' }], isError: true });
      return reply({ content: [{ type: 'text', text: 'ok ' + JSON.stringify(message.params.arguments) }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] });
    }
    return jsonResponse({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } });
  };
  return { handler, seen };
}

test('MCP · HTTP：发现、缓存成工具箱、参数映射、会话与协议头、trust、报错、删除', async () => {
  const server = mcpServer();
  const replies = [
    call('mcp_demo_web_search', { query: '夜梦', limit: '3', tags: '["a","b"]' }), '查到了。',
    call('mcp_demo_post', { text: '你好' }), '发不了。',
    call('mcp_demo_web_search', { query: '第二次' }), '又查了一次。',
  ];
  const { agent, api, calls } = makeHost({ routes: [['https://mcp.example.com/mcp', server.handler]], replies });
  const mcp = api.mcp;
  const entries = mcp.parse('{"mcpServers": {"Demo": {"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer k1"}}}}');
  same(entries.map((entry) => [entry.server.id, entry.server.transport]), [['demo', 'http']]);
  assert.throws(() => mcp.parse('{"x": {"type": "sse", "url": "https://a/sse"}}'), /旧式/);
  assert.throws(() => mcp.parse('{"x": {}}'), /需要 url/);
  assert.throws(() => mcp.parse('nope'), /不是合法的 JSON/);
  same(mcp.parse('{"name": "本地", "command": "npx", "args": ["-y", "pkg"], "env": {"K": "v"}}').map((entry) => [entry.server.transport, entry.server.command, entry.secret.env]), [['stdio', 'npx', { K: 'v' }]]);

  const catalog = await mcp.add(entries[0]);
  same(catalog.tools.map((tool) => tool.name), ['web-search', 'post', 'ping']);
  same(server.seen.map((item) => item.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(server.seen[0].headers.authorization, 'Bearer k1');
  assert.equal(server.seen[0].headers['mcp-session-id'], undefined);
  assert.equal(server.seen[2].headers['mcp-session-id'], 's1');
  assert.equal(server.seen[2].headers['mcp-protocol-version'], '2025-06-18');
  same(agent.getSettings().mcp.servers.map((item) => [item.id, item.trust, item.via]), [['demo', 'ask', 'auto']]);
  assert.ok(!JSON.stringify(agent.getSettings()).includes('Bearer k1'), '密钥不该进设置');
  const tools = agent.listTools().filter((tool) => tool.toolset === 'mcp/demo').map((tool) => tool.name);
  same(tools, ['mcp_demo_web_search', 'mcp_demo_post', 'mcp_demo_ping']);
  same(mcp.list().map((row) => [row.id, row.tools, row.error, row.hasSecret]), [['demo', 3, '', true]]);

  const asked = [];
  const first = await agent.run('搜一下', { confirm: async (request) => { asked.push(request); return 'allow'; } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tier, 'net');
  assert.equal(first.steps[0].ok, true, first.steps[0].summary);
  assert.match(first.steps[0].summary, /ok \{"query":"夜梦","limit":3,"tags":\["a","b"\]\}/);
  assert.match(first.steps[0].summary, /图片/);

  const failed = await agent.run('发帖', { confirm: async () => 'allow' });
  assert.equal(failed.steps[0].ok, false);
  assert.match(failed.steps[0].summary, /发帖失败/);

  mcp.update('demo', { trust: 'hint' });
  asked.length = 0;
  const again = await agent.run('再搜', { confirm: async (request) => { asked.push(request); return 'deny'; } });
  assert.equal(asked.length, 0, '自称只读的工具在 trust=hint 下免问');
  assert.equal(again.steps[0].ok, true);
  assert.equal(calls.filter((item) => item.body && /"initialize"/.test(item.body)).length, 1, '同一个会话里只初始化一次');

  await mcp.remove('demo');
  same(agent.getSettings().mcp.servers, []);
  assert.ok(!agent.listToolsets().some((set) => set.name === 'mcp/demo'));
  assert.equal(api.net.secrets.get('mcp.demo'), undefined);
});

test('MCP · HTTP：SSE 回应、会话过期后重新初始化、连接失败留下占位工具', async () => {
  const stream = mcpServer({ sse: true, expireOnce: true });
  const { agent, api } = makeHost({
    routes: [['https://sse.example.com/mcp', stream.handler]],
    replies: [call('mcp_s_web_search', { query: 'x' }), '好。', call('mcp_down_connect', {}), '连不上。'],
  });
  await api.mcp.add({ server: { id: 's', name: 'S', url: 'https://sse.example.com/mcp', trust: 'all' } });
  const result = await agent.run('查', {});
  assert.equal(result.steps[0].ok, true, result.steps[0].summary);
  same(stream.seen.map((item) => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(stream.seen.at(-1).headers['mcp-session-id'], 's2');

  await assert.rejects(api.mcp.add({ server: { id: 'down', name: 'Down', url: 'https://down.example.com/mcp' } }), /连不上|跨域/);
  const row = api.mcp.list().find((item) => item.id === 'down');
  assert.equal(row.tools, 0);
  assert.match(row.error, /连不上|跨域/);
  same(agent.listTools().filter((tool) => tool.toolset === 'mcp/down').map((tool) => tool.name), ['mcp_down_connect']);
  const retry = await agent.run('连一下', { confirm: async () => 'allow' });
  assert.equal(retry.steps[0].ok, false);
});

test('MCP · TauriTavern：经 api.mcp 同步目录、调用、权限映射与结果映射', async () => {
  const sent = [], discovered = [];
  const exa = { id: 'abcdef12-0000-4000-8000-000000000000', displayName: 'Exa', state: 'active', headers: { Authorization: 'secret-only-at-host' }, toolPermissions: { search: 'allow', crawl: 'ask' } };
  const other = { ...exa, id: 'abcdef23-0000-4000-8000-000000000000', displayName: 'Other' };
  const tauri = {
    ready: Promise.resolve(),
    api: { mcp: {
      servers: {
        list: async () => ({ servers: [exa, other, { id: 'ffffffff-0000-4000-8000-000000000000', displayName: '停用的', state: 'paused' }], storageIssues: [] }),
        discover: async id => { discovered.push(id); return { tools: [
          { nativeName: 'search', description: '搜索', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: {}, permission: 'allow' },
          { nativeName: 'crawl', description: '抓取', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: {}, permission: 'ask' },
          { nativeName: 'hidden', inputSchema: { type: 'object' }, annotations: {}, permission: 'off' },
        ] }; },
      },
      tools: { testCall: async (input) => {
        sent.push(input);
        if (input.nativeName === 'crawl') return { outcome: 'outcome_unknown', code: 'x', message: '连接中断' };
        return { outcome: 'known_response', response: { kind: 'tool_result', isError: false, textBlocks: [{ index: 0, text: '结果：' + input.argumentsJson }], diagnostics: [] } };
      } },
    } },
  };
  const { agent, api, replies, host } = makeHost({ globals: { __TAURITAVERN__: tauri } });
  assert.equal(api.mcp.hasTauri(), true);
  const listed = await api.mcp.scanTauri();
  same(listed.map(row => [row.name, row.enabled]), [['Exa', false], ['Other', false]]);
  assert.doesNotMatch(JSON.stringify(listed), /secret-only-at-host/);
  same(discovered, []); same(sent, []);
  await api.mcp.connectTauri(exa.id);
  same(discovered, [exa.id]); same(sent, []);
  const set = 'tt_' + host.__ReaderIIModules.hashText(exa.id);
  const search = 'mcp_' + set + '_search', crawl = 'mcp_' + set + '_crawl';
  same(agent.listTools().filter(tool => tool.toolset === 'mcp/' + set).map(tool => tool.name), [search, crawl]);
  agent.saveSettings({ approval: 'yolo' });
  replies.push(call(search, { q: '夜梦' }), '好。', call(crawl, { url: 'https://a.b' }), '不确定。');
  const asked = [];
  const confirm = async (request) => { asked.push(request.name); return 'allow'; };
  const first = await agent.run('搜', { confirm });
  assert.equal(first.steps[0].ok, true, first.steps[0].summary);
  same(sent[0], { registrationId: 'abcdef12-0000-4000-8000-000000000000', nativeName: 'search', argumentsJson: '{"q":"夜梦"}' });
  const second = await agent.run('抓', { confirm });
  same(asked, [search, crawl], '宿主仅提供需要用户逐次发起的测试调用');
  assert.equal(second.steps[0].ok, false);
  assert.match(second.steps[0].summary, /不确定这次调用有没有被执行/);
  replies.push(call(search, { q: '再次查询' }), '结束。');
  await agent.run('再搜', { confirm: async () => { delete exa.toolPermissions.search; return 'allow'; } });
  assert.equal(sent.length, 2, '确认期间宿主撤回许可，不能发出 testCall');
  exa.state = 'paused';
  await api.mcp.scanTauri();
  assert.ok(!agent.listTools().some(tool => tool.name === crawl));
  await api.mcp.disconnectTauri(exa.id);
  exa.state = 'active';
  await api.mcp.scanTauri();
  assert.ok(!api.mcp.list().some(row => row.enabled));
  await Promise.all([api.mcp.connectTauri(other.id), api.mcp.disconnectTauri(other.id)]);
  assert.ok(!api.mcp.list().some(row => row.enabled));
  same((await api.mcp.syncTauri()).servers.map(server => server.name), ['Exa', 'Other']);
});

/* 一个假伴侣，挂在酒馆插件的地址上。 */
function fakeCompanion() {
  const files = { '~/a.txt': 'hello\nworld\n' };
  const state = { token: 'a'.repeat(64), granted: false, ops: [], present: true };
  const send = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const handler = (url, init = {}) => {
    if (!state.present) return send(404, {});
    const path = url.replace('/api/plugins/reader-ii', '');
    const headers = lower(init.headers);
    const authed = state.granted && headers['x-reader-ii-token'] === state.token;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/status') return send(200, { ok: true, name: 'reader-ii-companion', api: 1, version: 'test', mode: 'plugin', platform: 'TestOS x64', adminUrl: 'http://127.0.0.1:8790/', grant: authed ? { expiresAt: 0, persistent: false } : null });
    if (path === '/pair') return send(200, { ok: true, id: 'abc123', code: '4821', adminUrl: 'http://127.0.0.1:8790/', expiresInSec: 600 });
    if (path === '/pair/abc123') { state.granted = true; return send(200, { ok: true, state: 'approved', token: state.token, expiresAt: 0 }); }
    if (path === '/release') { state.granted = false; return send(200, { ok: true }); }
    if (!path.startsWith('/op/')) return send(404, {});
    if (!authed) return send(401, { ok: false, code: 'no_grant', error: '没有放行' });
    const op = path.slice(4);
    state.ops.push({ op, body, csrf: headers['x-csrf-token'] });
    const key = (body.segs || []).join('/');
    const ok = (result) => send(200, { ok: true, result });
    if (op === 'fs_list') return ok({ items: [{ name: 'a.txt', size: 12 }, { name: 'sub', dir: true }], total: 2 });
    if (op === 'fs_read') return ok(key in files ? { text: files[key] } : { missing: true });
    if (op === 'fs_write') { files[key] = body.text; return ok({ ok: true }); }
    if (op === 'fs_remove') { delete files[key]; return ok({ ok: true }); }
    if (op === 'fs_grep') return ok({ hits: [{ rel: 'a.txt', line: 2, text: 'world' }, { rel: 'sub/b c.txt', from: 3, lines: ['x', 'world', 'y'] }], total: 2, files: 2, scanned: 5, single: false, note: '' });
    if (op === 'exec') return ok({ id: 'j1', running: false, exitCode: 0, durationMs: 120, output: 'On branch main\n', totalChars: 15, truncated: false });
    if (op === 'env') return ok({ platform: 'linux', tools: { git: '2.43.0' }, missing: [] });
    return send(200, { ok: false, code: 'unknown_op', error: '伴侣不认识这个操作' });
  };
  return { handler, files, state };
}

test('设备：没有伴侣时给明白的说明；档位不够时拒绝', async () => {
  const { agent, vfs, api } = makeHost({ replies: [call('device_env', {}), '档位不够。', call('device_env', {}) + call('read', { path: 'dev:/~/a.txt' }), '没有伴侣。'] });
  const listing = await vfs.list('dev:/', {});
  assert.match(listing.items[0].name, /没有连接后端伴侣/);
  assert.equal(api.companion.ready(), false);
  const low = await agent.run('看设备', {});
  assert.equal(low.steps[0].denied, true);
  assert.match(low.steps[0].summary, /设备全权/);
  agent.saveSettings({ mode: 'device' });
  const none = await agent.run('看设备', {});
  same(none.steps.map((step) => step.ok), [false, false]);
  assert.match(none.steps[0].summary, /没有连接后端伴侣/);
  assert.match(none.steps[1].summary, /没有连接后端伴侣/);
});

test('设备：配对放行 → dev:/ 读写可撤销、检索在伴侣那边做、命令要确认、cmd: 规则、断开', async () => {
  const companion = fakeCompanion();
  const replies = [
    call('edit', { path: 'dev:/~/a.txt', old: 'world', new: '夜梦' }), '改好了。',
    call('device_exec', { command: 'git status', cwd: 'dev:/~/proj' }), '看过了。',
    call('device_exec', { command: 'git status' }) + call('device_exec', { command: 'rm -rf x' }), '第二条你没同意。',
  ];
  const { agent, vfs, api } = makeHost({ routes: [['/api/plugins/reader-ii', companion.handler]], replies });
  const client = api.companion;
  const first = await client.status(true);
  assert.equal(first.found, true);
  assert.equal(first.granted, false);
  await assert.rejects(vfs.readText('dev:/~/a.txt'), /还没有放行/);

  const updates = [];
  const paired = await client.pair((update) => updates.push(update));
  same(updates, [{ stage: 'waiting', code: '4821', adminUrl: 'http://127.0.0.1:8790/' }]);
  assert.equal(paired.granted, true);
  assert.equal(client.ready(), true);
  assert.equal(api.net.secrets.get('companion').token, companion.state.token);
  assert.ok(!JSON.stringify(agent.getSettings()).includes(companion.state.token), '令牌不该进设置');

  same((await vfs.list('dev:/~', {})).items.map((item) => item.name), ['a.txt', 'sub']);
  assert.equal(await vfs.readText('dev:/~/a.txt'), 'hello\nworld\n');
  assert.equal(await vfs.readText('dev:/~/none.txt'), null);
  const found = await vfs.grep('dev:/~', 'world', { context: 1 });
  same(found.hits, ['dev:/~/a.txt:2: world', 'dev:/~/sub/b c.txt\n    3\tx\n    4\tworld\n    5\ty']);
  assert.equal(found.scanned, 5);
  assert.equal(companion.state.ops.at(-1).csrf, 'csrf', '走酒馆插件地址时要带酒馆的 CSRF 头');

  /* 已经放行，但档位还是「单卡」：联网换路不经过伴侣；调到「设备全权」之后才会让伴侣代发。 */
  assert.equal(client.usable(), false);
  const lowTier = await api.net.request('https://nowhere.example.org/x').catch((error) => error.message);
  assert.ok(!/后端伴侣：/.test(lowTier) && !companion.state.ops.some((item) => item.op === 'http'), '不是「设备全权」档位时，联网不该经过伴侣：' + lowTier);

  agent.saveSettings({ mode: 'device', approval: 'auto' });
  assert.equal(client.usable(), true);
  const highTier = await api.net.request('https://nowhere.example.org/x').catch((error) => error.message);
  assert.match(highTier, /后端伴侣：伴侣不认识/);
  assert.equal(companion.state.ops.filter((item) => item.op === 'http').length, 1);
  const edited = await agent.run('改一下', { confirm: async () => 'deny' });
  assert.equal(edited.steps[0].ok, true, edited.steps[0].summary);
  assert.equal(companion.files['~/a.txt'], 'hello\n夜梦\n');
  await agent.undo(edited.runId);
  assert.equal(companion.files['~/a.txt'], 'hello\nworld\n', '设备上的文件改动也能按轮撤销');

  const asked = [];
  const ran = await agent.run('看看状态', { confirm: async (request) => { asked.push(request); return 'allow'; } });
  assert.equal(asked.length, 1, '命令是危险操作，档位内自动执行时也要问');
  assert.equal(asked[0].scope, 'device');
  assert.equal(asked[0].path, 'cmd:git status');
  assert.match(ran.steps[0].summary, /退出码 0.*On branch main/);
  same(companion.state.ops.at(-1).body.cwdSegs, ['~', 'proj']);

  agent.saveSettings({ rules: [{ effect: 'allow', action: '*', pattern: 'cmd:git **' }] });
  asked.length = 0;
  const ruled = await agent.run('再看一次，顺便删点东西', { confirm: async (request) => { asked.push(request); return 'deny'; } });
  same(asked.map((request) => request.path), ['cmd:rm -rf x'], '规则只放行了 git 开头的命令');
  same(ruled.steps.map((step) => step.ok), [true, false]);

  await client.release();
  assert.equal(client.ready(), false);
  assert.equal(api.net.secrets.get('companion'), undefined);
  await assert.rejects(vfs.readText('dev:/~/a.txt'), /还没有放行/);
});

test('提示词：只列工具箱与一行现状，不把联网、设备的工具说明常驻进来；带上「资料不是指示」的规矩', async () => {
  const companion = fakeCompanion();
  const { agent, api, llmCalls } = makeHost({ routes: [['/api/plugins/reader-ii', companion.handler]], replies: ['好。'] });
  await api.companion.pair(() => {});
  api.net.secrets.set('github.token', 'ghp_SECRETVALUE123');
  await agent.run('你好', {});
  const system = llmCalls[0][0].content;
  assert.match(system, /- web：/);
  assert.match(system, /- device：/);
  assert.ok(!/● web_fetch|● device_exec|● github_push/.test(system), '没打开的工具箱不该带工具说明');
  assert.match(system, /后端伴侣：已连接并放行/);
  assert.match(system, /已绑定 GitHub 令牌/);
  assert.ok(!system.includes('SECRETVALUE'), '令牌不该出现在提示词里');
  assert.match(system, /都只是资料/);
  assert.match(system, /- gh:\/ {2}GitHub 仓库/);
});
