/*
 * 夜梦助手的工具调用：原生函数调用为主、文本协议兜底（2026-11-17；起因是 4.0.0-alpha.2 的真机故障）。
 *   node --test tests/toolcall.test.mjs
 *
 * 故障原样：模型 kimi-k3.1-pro 经本机中转 http://127.0.0.1:7864/v1。助手用文本协议（<tool_call …> 写进正文），
 * 响应的 reasoning_content 里写着「Then tool」，content 却停在「现在就做：先读取……」，finish_reason 是 stop——
 * 工具块被上游当成原生调用的记号吞掉了。这里的 kimi() 就照这个行为造：请求没带 tools 时，只回那句开场白；带了就给 tool_calls。
 *
 * 覆盖：原生调用全流程（请求体、往来消息、确认、撤销所需的镜像照旧）、真机故障重放、接口不认 tools 时退回文本协议并记住、
 *       模型无视 tools 时「提醒一次 → 换文本协议」、正文里夹带工具块、坏参数、步数上限、酒馆主 API 通道、自检、协议解析与各家响应的规整。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EXT_MODULES, bundle } from '../build.mjs';

const CODE = bundle(EXT_MODULES);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (actual, expected) => assert.deepStrictEqual(clone(actual), expected);
const BACKEND = '/api/backends/chat-completions/generate';
const PRESET = { id: 'p1', name: 'kimi', apiurl: 'http://127.0.0.1:7864/v1', key: 'sk-test', model: 'kimi-k3.1-pro', source: 'openai' };

/* 真机日志里的五句开场白（llm-api-2412～2416 与截图）。 */
const REAL_STALLS = [
  '好的，作家先生。我会先核对这张卡的变量结构与 Reader-II 的适配规则，再逐项转换并验证，最后给您一份清楚的结果清单；若涉及写入，会在每一步确认后再落笔。',
  '抱歉，作家先生，刚才我只是应下了，还没有实际开始。现在就做：先读取 Reader-II 的适配说明并定位卡内变量，再逐项核对、转换与验证。',
  '没有外部阻碍，是我前两次只作了口头回应，并未实际执行，耽误了您的时间，抱歉。现在直接开始，先读 Reader-II 的适配规则，再检查卡内变量。',
  '可以调用，作家先生；问题不在权限或工具，而是我此前没有真正发起调用。现在立即执行，先读取 Reader-II 的适配规则。',
  '您说得对，作家先生。前几轮我确实只作了回应，没有发出任何工具调用；这是我的失误。现在直接开始。',
];

const reply = (message, finish = 'stop') => ({ choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }] });
const nativeCall = (name, args, id = 'call_' + name) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const textCall = (name, args) => `<action name="${name}">\n${Object.entries(args).map(([key, value]) => `<param name="${key}">${value}</param>`).join('\n')}\n</action>`;

/*
 * options:
 *   preset    独立 API 方案（默认 PRESET）；null = 走酒馆主 API
 *   backend   (body) => 响应对象 | { status, body }   酒馆后端的应答
 *   text      (config) => 文本                        酒馆助手 generateRaw 的应答（文本协议的通道）
 *   openai    (messages, data) => 响应对象            酒馆主 API（sendOpenAIRequest）的应答
 *   settings  助手设置
 */
function makeHost(options = {}) {
  const chat = [
    { name: '我', is_user: true, mes: '我推开了酒馆的门。' },
    { name: '艾琳', is_user: false, mes: '「欢迎回来。」艾琳放下了手里的杯子。' },
  ];
  const worldbooks = {
    设定集: [{ uid: 0, name: '王都', enabled: true, content: '王都位于北方。\n人口十万。\n守卫队长是雷恩。', strategy: { type: 'selective', keys: ['王都'] }, position: {} }],
  };
  const storage = new Map();
  const preset = options.preset === undefined ? PRESET : options.preset;
  if (preset) storage.set('reader_ii_independent_api_v2', JSON.stringify({ version: 2, presets: [preset], defaultId: preset.id, routes: {} }));
  const log = { backend: [], text: [], openai: [], events: [] };
  const listeners = new Map();
  const eventSource = {
    on(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    once() {},
    removeListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter((item) => item !== handler)); },
    async emit(name, ...args) { for (const handler of (listeners.get(name) || []).slice()) await handler(...args); },
    count: (name) => (listeners.get(name) || []).length,
  };
  const ctx = {
    chat, characterId: 0, name1: '我', name2: '艾琳', chatId: 'chat-1', mainApi: 'openai',
    characters: [{ name: '艾琳', avatar: 'ailin.png', description: '老板娘', data: { description: '老板娘', extensions: {} } }],
    chatMetadata: { variables: {} },
    extensionSettings: { reader_ii: { agent: { plotContext: false, recall: false, ...(options.settings || {}) } } },
    getCurrentChatId: () => 'chat-1', saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
    setExtensionPrompt: () => {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }),
    eventSource,
    eventTypes: { GENERATION_ENDED: 'generation_ended', MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_id_changed', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready' },
  };
  const helper = {
    getWorldbookNames: () => Object.keys(worldbooks),
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: '设定集', additional: [] }),
    getChatWorldbookName: () => null,
    getWorldbook: async (name) => clone(worldbooks[name]),
    updateWorldbookWith: async (name, updater) => { worldbooks[name] = clone(updater(clone(worldbooks[name]))); return clone(worldbooks[name]); },
    getVariables: () => ({}),
    replaceVariables: async () => {},
    generateRaw: async (config) => {
      log.text.push(clone({ prompts: config.ordered_prompts, custom_api: config.custom_api, tools: config.tools }));
      if (!options.text) throw new Error('这个测试不该走到文本通道');
      return options.text(config, log.text.length);
    },
  };
  /* 酒馆主 API：模拟酒馆的 sendOpenAIRequest——组好请求、广播 CHAT_COMPLETION_SETTINGS_READY、再“发出去”。 */
  const openaiModule = {
    ...options.openaiBuilder,
    sendOpenAIRequest: async (type, messages) => {
      const data = { type, messages: messages.filter(Boolean), model: 'main-model', stream: true, temperature: 1, chat_completion_source: 'openai' };
      await eventSource.emit('chat_completion_settings_ready', data);
      log.openai.push(clone(data));
      if (!options.openai) throw new Error('这个测试不该走到酒馆主 API');
      return options.openai(data, log.openai.length);
    },
  };
  const hostFunction = function (...args) {
    if (args.length === 2 && args[0] === 'p' && args[1] === 'return import(p)') {
      return (path) => (path === '/scripts/openai.js' && options.openai !== null ? Promise.resolve(openaiModule) : Promise.reject(new Error('没有模块 ' + path)));
    }
    return Function(...args);
  };
  const host = {
    SillyTavern: { getContext: () => ctx }, TavernHelper: helper,
    localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    console: { log() {}, info() {}, warn() {}, error() {} },
    document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
    navigator: { userAgent: 'node-test' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    fetch: async (url, init = {}) => {
      if (url === BACKEND) {
        const body = JSON.parse(init.body);
        if (!body.tools && options.text) {
          const config = { ordered_prompts: body.messages, custom_api: { model: body.model } };
          log.text.push(clone({ prompts: body.messages, custom_api: config.custom_api }));
          return Response.json(reply({ content: await options.text(config, log.text.length) }));
        }
        log.backend.push({ body, headers: init.headers });
        if (!options.backend) throw new Error('这个测试不该请求酒馆后端');
        const answer = options.backend(body, log.backend.length);
        const status = answer && answer.status ? answer.status : 200;
        const payload = answer && answer.status ? answer.body : answer;
        if (options.wrapResponse) return options.wrapResponse(Response.json(payload, { status }));
        return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload), json: async () => clone(payload) };
      }
      return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => `---\nname: demo\ndescription: 演示\n---\n正文`, json: async () => [] };
    },
    Function: hostFunction, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto,
  };
  host.window = host;
  host.parent = host;
  vm.createContext(host);
  vm.runInContext(CODE, host, { filename: 'reader-ii.ext.js' });
  const agent = host.ReaderII.agent;
  const run = (input, extra = {}) => agent.run(input, { onEvent: (event) => log.events.push(event), confirm: async () => 'allow', ...extra });
  return { host, agent, run, log, worldbooks, ctx, eventSource, protocol: host.__ReaderIIModules.agentProtocol, llm: host.ReaderII.llm };
}

/* 照真机上的 kimi：请求里没有 tools 时，工具块被吞，只剩开场白；有 tools 时按 plan 给出原生调用。 */
function kimi(plan) {
  let stalls = 0;
  return (body, turn) => {
    if (!Array.isArray(body.tools) || !body.tools.length) return reply({ content: REAL_STALLS[Math.min(stalls++, REAL_STALLS.length - 1)], reasoning_content: 'I should tool call skill reader-ii and todo. Then tool.' });
    return plan(body, turn);
  };
}

test('普通制卡请求从能力查询找到插件、预检同一权限，再打开并实际调用', async () => {
  let writes = 0;
  const asked = [];
  const { agent, run, log } = makeHost({ backend: (body, turn) => {
    const calls = [
      nativeCall('capabilities', { query: '人物索引' }),
      nativeCall('capabilities', { tool: 'card_index', args: { title: '旅人' } }),
      nativeCall('toolbox', { name: 'card_notes' }),
      nativeCall('card_index', { title: '旅人' }),
    ];
    return calls[turn - 1] ? reply({ tool_calls: [calls[turn - 1]] }) : reply({ content: '已建人物索引。' });
  } });
  agent.registerTool({ name: 'card_index', toolset: 'card_notes', summary: '建立人物索引', effect: 'write', scope: 'card',
    params: [{ name: 'title', type: 'string', required: true }], run: () => { writes++; return { ok: true }; } });
  const result = await run('给旅人建一条人物索引', { confirm: async (request) => { asked.push(request); return 'allow'; } });
  assert.equal(result.error, '');
  assert.equal(writes, 1);
  same(asked.map((item) => item.name), ['card_index']);
  const search = JSON.parse(log.backend[1].body.messages.at(-1).content);
  assert.ok(search.tools.some((item) => item.name === 'card_index' && item.toolset === 'card_notes'));
  const preview = JSON.parse(log.backend[2].body.messages.at(-1).content);
  assert.equal(preview.open, false);
  assert.equal(preview.permission.decision, 'ask');
  assert.ok(log.backend[3].body.tools.some((item) => item.function.name === 'card_index'));
});

test('长调用整轮压缩，实际执行记录保留，原生协议无孤立工具消息', async () => {
  const large = '长文本'.repeat(22000);
  const { agent, run, log } = makeHost({ text: () => '已写入 ws:/长稿 并列出工作区。下一步回读核验。', backend: (body, turn) => {
    if (turn === 1) return reply({ tool_calls: [nativeCall('write', { path: 'ws:/长稿', content: large }), nativeCall('ls', { path: 'ws:/' })] });
    if (turn === 2) return reply({ tool_calls: [nativeCall('read', { path: 'ws:/长稿', limit: 1, column: large.length - 50 })] });
    return reply({ content: '写入后已回读。' });
  } });
  agent.saveModelSettings({ contextWindow: 20000 });
  const result = await run('请写稿并回读');
  assert.equal(result.error, '');
  same(result.steps.map((item) => item.ok), [true, true, true]);
  const messages = log.backend[1].body.messages;
  assert.ok(!JSON.stringify(messages).includes(large));
  assert.ok(messages.some((item) => item.content.includes('请写稿并回读')));
  assert.ok(messages.some((item) => item.content.includes('ws:/长稿')));
  assert.match(log.text[0].prompts[0].content, /交接单/);
  assert.ok(!messages.some((item) => item.role === 'tool' || item.tool_calls));
  const last = log.backend[2].body.messages;
  assert.equal(last.at(-1).tool_call_id, last.at(-2).tool_calls[0].id);
});

test('历史轮数为零时不会把之前的聊天带入下一次请求', async () => {
  const { run, log } = makeHost({ settings: { historyTurns: 0 }, backend: (body, turn) => reply({ content: '答复' + turn }) });
  await run('旧聊天内容应留在面板');
  await run('本次新问题');
  same(log.backend.at(-1).body.messages.slice(1), [{ role: 'user', content: '本次新问题' }]);
});

test('百万窗口保留长旧输入；缩为两万后新对话从交接结论接手，重新打开原对话仍可查原文', async () => {
  const marker = '日志定位#481';
  const document = '原始记录甲'.repeat(9000) + marker;
  const handoff = '已核对日志定位#481，守卫交班时间 17:30，下一步排班。';
  const { agent, run, log } = makeHost({ text: () => handoff, backend: () => reply({ content: '记录好了。' }) });
  await agent.threads.ready();
  const old = agent.threads.currentId();
  agent.saveModelSettings({ contextWindow: 1000000 });
  assert.equal((await run(document)).error, '');
  for (let n = 0; n < 11; n++) assert.equal((await run('续问' + n)).error, '');
  assert.ok(log.backend.at(-1).body.messages.some((message) => message.content === document));
  assert.equal(log.events.find((event) => event.type === 'context').contextWindow, 1000000);
  agent.saveModelSettings({ contextWindow: 20000 });
  agent.saveSettings({ contextStrategy: 'handoff' });
  const continued = await run('根据结论排班');
  assert.equal(continued.error, '');
  const current = agent.threads.currentId();
  assert.notEqual(current, old);
  assert.equal(log.events.filter((event) => event.type === 'handoff').length, 1);
  assert.equal(log.events.filter((event) => event.type === 'context').at(-1).contextWindow, 20000);
  const body = JSON.stringify(log.backend.at(-1).body.messages);
  assert.match(body, /17:30/);
  assert.doesNotMatch(body, /原始记录甲/);
  assert.ok(log.text.some((call) => JSON.stringify(call.prompts).includes(marker)));
  same(agent.getHistory().map((turn) => turn.text), ['根据结论排班', '记录好了。']);
  assert.equal(agent.threads.checkpoint().text, handoff);
  await agent.threads.select(old);
  assert.equal(agent.getHistory()[0].text, document);
  await agent.threads.select(current);
  assert.equal((await run('继续')).error, '');
  assert.match(JSON.stringify(log.backend.at(-1).body.messages), /17:30/);
});

test('子代理只接收分配的资料和任务，使用单独的无工具请求，结论交还父代理', async () => {
  const { agent, run, log } = makeHost({ text: () => '两种记载一致，地点为北门。', backend: (body, number) =>
    number === 2 ? reply({ tool_calls: [nativeCall('delegate_task', { task: '校对地点', material: '甲本和乙本都写北门。' })] })
      : reply({ content: number === 1 ? '知道了。' : '核对完成。' }) });
  await run('没有分给子代理的私密旧话题');
  const result = await run('请分别核对两版');
  assert.equal(result.error, '');
  assert.equal(result.steps[0].name, 'delegate_task');
  assert.equal(log.text.length, 1);
  assert.match(JSON.stringify(log.text[0].prompts), /甲本和乙本都写北门/);
  assert.doesNotMatch(JSON.stringify(log.text[0].prompts), /私密旧话题|请分别核对两版|tool_call/);
  assert.match(log.backend.at(-1).body.messages.at(-1).content, /地点为北门/);
  assert.equal(agent.getHistory().length, 4);
});

test('关闭子代理同时移除声明、查询目录和执行权限；模型已发出的旧调用也失效', async () => {
  const lookup = nativeCall('capabilities', { tool: 'delegate_task' });
  const { agent, run, log, llm } = makeHost({ backend: (_body, round) => {
    if (round === 1) {
      agent.saveSettings({ subagents: { enabled: false } });
      return reply({ tool_calls: [nativeCall('delegate_task', { task: '分析' }), lookup] });
    }
    return reply({ content: '当前已关闭子代理。' });
  } });
  llm.chatTask = () => assert.fail('禁止派发');
  const result = await run('检查可用工具');
  assert.equal(result.steps[0].ok, false);
  assert.ok(!agent.listTools().some(item => item.name === 'delegate_task'));
  assert.ok(log.backend[0].body.tools.some(item => item.function.name === 'delegate_task'));
  assert.ok(!log.backend[1].body.tools.some(item => item.function.name === 'delegate_task'));
  assert.match(log.backend[1].body.messages.at(-1).content, /未注册/);
});

test('倾向按用户配置的方案、模型与档位执行，不能在工具参数中改写固定模型', async () => {
  const calls = [];
  const { run, agent, llm, log } = makeHost({ backend: (_body, round) => round === 1 ? reply({ tool_calls: [
    nativeCall('delegate_task', { profile: 'design', task: '校对界面文案', model: 'other', effort: 'high' })
  ] }) : reply({ content: '已采纳校对结果' }) });
  agent.saveSettings({ subagents: { enabled: true, mode: 'rules', rules: [
    { id: 'design', name: '界面校对', task: '前端文案', model: 'reviewer', presetId: 'art', effort: 'medium' }
  ] } });
  llm.resolveTaskModel = async (kind, opts) => {
    assert.equal(kind, 'delegate'); assert.equal(opts.presetId, 'art'); assert.equal(opts.model, 'reviewer');
    return { model: 'reviewer', contextWindow: 24000, reasoningEfforts: ['low', 'high'] };
  };
  llm.chatTask = async opts => { calls.push(opts); return '按钮改为保存'; };
  assert.equal((await run('请核对')).error, '');
  assert.match(log.backend[0].body.messages[0].content, /design.*界面校对.*前端文案/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'reviewer'); assert.equal(calls[0].presetId, 'art');
  assert.equal(calls[0].reasoningEffort, 'high'); assert.equal(calls[0].textOnly, true);
  assert.equal(calls[0].tools, undefined); assert.equal(calls[0].messages.length, 2);
});

test('子代理执行途中关开关会取消本次请求，主对话仍然能收尾', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { run, agent, llm, log } = makeHost({ backend: (_body, round) => round === 1
    ? reply({ tool_calls: [nativeCall('delegate_task', { task: '分析', profile: 'analysis' })] }) : reply({ content: '已停止派发。' }) });
  agent.saveSettings({ subagents: { rules: [{ id: 'analysis', task: '分析资料', model: 'another' }] } });
  llm.resolveTaskModel = async () => ({ model: 'another', contextWindow: 32000 });
  llm.chatTask = async ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('停止派发'), { name: 'AbortError' })), { once: true });
    entered();
  });
  const pending = run('分析这份资料');
  await started;
  agent.saveSettings({ subagents: { enabled: false } });
  const result = await pending;
  assert.equal(agent.getSettings().subagents.rules[0].id, 'analysis');
  assert.equal(result.aborted, false);
  assert.equal(result.steps[0].ok, false);
  assert.match(result.steps[0].summary, /已关闭/);
  assert.ok(log.backend[1].body.tools.every(tool => tool.function.name !== 'delegate_task'));
});

test('智能派发时只拉一次实际连接目录，主模型选可用文本模型和经核实的档位', async () => {
  let listings = 0;
  const workers = [];
  const { run, agent, llm, log } = makeHost({ backend: (_body, round) => {
    const calls = [null, {task: '起草', material: '开头要提到码头'}, {task: '起草', model: 'writer', effort: 'high'}, {task: '校对', model: 'writer', effort: 'max'}];
    return calls[round] ? reply({ tool_calls: [nativeCall('delegate_task', calls[round])] }) : reply({ content: '整理好了' });
  } });
  agent.saveSettings({ subagents: { enabled: true, mode: 'smart' } });
  llm.listTaskModels = async (kind, opts) => {
    listings++; assert.equal(kind, 'delegate'); assert.equal(opts.selected, 'agent');
    return [{ id: 'writer', outputModalities: ['text'], reasoningEfforts: ['high'] }, { id: 'video-only', outputModalities: ['video'] },
      { id: 'embedder', outputModalities: [], supportsTextChat: false }];
  };
  llm.resolveTaskModel = async (_kind, opts) => ({ model: opts.model, contextWindow: 32000, reasoningEfforts: ['high'] });
  llm.chatTask = async opts => {
    if (!workers.length) assert.match(opts.messages.at(-1).content, /开头要提到码头/);
    else assert.doesNotMatch(opts.messages.at(-1).content, /开头要提到码头/);
    workers.push([opts.model, opts.reasoningEffort]); return '成稿';
  };
  assert.equal(listings, 0);
  assert.equal((await run('创作并校对')).error, '');
  assert.equal(listings, 1);
  const catalog = JSON.parse(log.backend[1].body.messages.at(-1).content);
  same(catalog.models.map(item => item.model), ['writer']);
  same(workers, [['writer', 'high'], ['writer', 'auto']]);
});

test('代理模型不可用、欠费、限流或超时会回退主助手，取消、内容拒绝或相同模型不再发送', async () => {
  for (const [failure, current, expected] of [[{ status: 404 }, false, 1], [{ status: 402 }, false, 1],
    [{ status: 429 }, false, 1], [{ name: 'TimeoutError' }, false, 1], [{ code: 'provider_stop' }, false, 0],
    [{ name: 'AbortError' }, false, 0], [{ status: 404 }, true, 0]]) {
    const { agent, run, llm, log } = makeHost({ text: () => '主助手完成了', backend: (_body, round) => round === 1
      ? reply({ tool_calls: [nativeCall('delegate_task', { task: '改写', profile: 'writing' })] }) : reply({ content: '收到结果。' }) });
    agent.saveSettings({ subagents: { rules: [{ id: 'writing', name: '写作', task: '改写', model: 'external' }] } });
    llm.resolveTaskModel = async () => ({ model: 'external', contextWindow: 32000, isCurrent: current });
    llm.chatTask = async () => { throw Object.assign(new Error('模型调用失败'), failure); };
    const result = await run('改写这段');
    assert.equal(log.text.length, expected);
    if (failure.name === 'AbortError') assert.equal(result.aborted, true);
    else assert.equal(result.steps[0].ok, expected === 1);
    if (expected) assert.match(log.backend.at(-1).body.messages.at(-1).content, /已改用主助手模型/);
  }
});

test('独立图像和视频工具只向主模型返附件编号；主模型失败也能保存和交付已生成的媒体', async () => {
  const { run, agent, llm, log } = makeHost({ backend: (_body, round) => round === 1 ? reply({ tool_calls: [
    nativeCall('generate_image', { prompt: '月亮插画' }), nativeCall('generate_video', { prompt: '月亮升起' })] })
    : { status: 403, body: { error: { message: '后续文字不可用' } } } });
  agent.saveSettings({ toolProtocol: 'native' });
  assert.ok(!agent.listTools().some(item => item.name === 'generate_video'));
  const image = 'data:image/png;base64,AQIDBA==', video = 'data:video/mp4;base64,AAEC';
  llm.getTaskConnection = () => ({ configured: true });
  llm.generateMedia = async (kind, prompt) => {
    assert.ok(prompt.includes('月亮'));
    return kind === 'image' ? { text: '月亮插画', images: [{ url: image }] } : { text: '预览 ' + video, videos: [{ url: video }] };
  };
  const result = await run('生成图像与视频');
  assert.ok(log.backend[0].body.tools.some(item => item.function.name === 'generate_video'));
  const wire = JSON.stringify(log.backend[1].body);
  assert.match(wire, /image-1/); assert.match(wire, /video-1/); assert.doesNotMatch(wire, /base64/);
  same(result.images, [{ url: image }]); same(result.videos, [{ url: video }]);
  same(agent.getHistory().at(-1).videos, [{ url: video }]);
  same(log.events.find(event => event.type === 'final').images, [{ url: image }]);
});

test('图片回复无文字时也保存和发出，后续模型只看到附件数量', async () => {
  const url = 'data:image/png;base64,AQIDBA==';
  const { agent, run, log } = makeHost({ backend: (body, number) => number === 1
    ? reply({ content: '', images: [{ type: 'image_url', image_url: { url } }] }) : reply({ content: '刚才发了一张图。' }) });
  const image = await run('画一张小猫');
  assert.equal(image.error, '');
  assert.equal(image.answer, '');
  same(image.images, [{ url }]);
  same(log.events.find((event) => event.type === 'final').images, [{ url }]);
  same(agent.getHistory().at(-1).images, [{ url }]);
  await run('你发了几张图？');
  assert.match(JSON.stringify(log.backend.at(-1).body.messages), /1 张图片/);
  assert.doesNotMatch(JSON.stringify(log.backend.at(-1).body.messages), /base64/);
});

test('生成摘要失败不创建交接对话，源历史可继续使用', async () => {
  const long = '札记'.repeat(20000);
  const { run, agent } = makeHost({ backend: () => reply({ content: '收到。' }),
    text: () => { throw new Error('摘要服务未响应'); } });
  agent.saveModelSettings({ contextWindow: 1000000 });
  await run(long);
  const source = agent.threads.currentId();
  agent.saveModelSettings({ contextWindow: 20000 });
  agent.saveSettings({ contextStrategy: 'handoff' });
  const interrupted = await run('整理内容');
  assert.match(interrupted.error, /摘要服务未响应/);
  assert.equal(agent.threads.currentId(), source);
  assert.equal(agent.threads.list().length, 1);
  assert.equal(agent.getHistory()[0].text, long);
  assert.equal(agent.threads.checkpoint(), undefined);
});

test('上游返回真实窗口比配置小，摘要每一块和重试主请求使用缩小后的预算', async () => {
  const long = '待核对的资料。'.repeat(3700) + '最后一个定位';
  const { run, agent, log } = makeHost({ text: () => '已核实资料，交接时间六点。', backend: (body, number) => {
    if (number === 2) return { status: 400, body: { error: { message: "This model's maximum context length is 8,000 tokens" } } };
    return reply({ content: '已核对。' });
  } });
  agent.saveModelSettings({ contextWindow: 1000000 });
  await run(long);
  const answer = await run('根据资料整理结论');
  assert.equal(answer.error, '');
  assert.ok(log.text.length > 1);
  for (const chunk of log.text) assert.ok(chunk.prompts.map(x => x.content).join('').length < 8000);
  assert.match(JSON.stringify(log.text.at(-1).prompts), /最后一个定位/);
  assert.ok(log.backend.at(-1).body.max_tokens < 4000);
  assert.match(JSON.stringify(log.backend.at(-1).body.messages), /交接时间六点/);
  assert.doesNotMatch(JSON.stringify(log.backend.at(-1).body.messages), /待核对的资料/);
  assert.equal(log.events.filter(event => event.type === 'context').at(-1).contextWindow, 8000);
});

test('新建交接对话后中断再打开，保留精确用户任务和已读结论', async () => {
  const task = '按附录 R-374 核对两地时差';
  const { run, agent, log } = makeHost({ text: () => '乙地时间比甲地早两小时。', backend: (body, number) =>
    number === 2 ? { status: 403, body: { error: { message: '当前请求被拒绝' } } } : reply({ content: '已处理。' }) });
  agent.saveModelSettings({ contextWindow: 1000000 });
  await run('原始读数'.repeat(7000));
  const old = agent.threads.currentId();
  agent.saveModelSettings({ contextWindow: 20000 });
  agent.saveSettings({ contextStrategy: 'handoff', toolProtocol: 'native' });
  const stopped = await run(task);
  assert.match(stopped.error, /拒绝/);
  const next = agent.threads.currentId();
  assert.notEqual(old, next);
  await agent.threads.select(old);
  await agent.threads.select(next);
  const resumed = await run('继续');
  assert.equal(resumed.error, '');
  const wire = JSON.stringify(log.backend.at(-1).body.messages);
  assert.ok(wire.includes(task));
  assert.match(wire, /早两小时/);
  assert.doesNotMatch(wire, /原始读数/);
});

test('旧预设开关失效，当前人格和助手专用文本随请求和工具续轮发送', async () => {
  const { run, agent, ctx, log } = makeHost({ settings: { historyTurns: 0, useAssistantPreset: true }, backend: (body, turn) =>
    turn === 1 ? reply({ tool_calls: [nativeCall('read', { path: 'wb:/设定集/王都' })] }) : reply({ content: '完成。' }) });
  ctx.substituteParams = () => assert.fail('助手不应展开预设宏');
  ctx.chatCompletionSettings = { prompts: [{ role: 'system', content: 'STORY_PRESET' }] };
  agent.saveSettings({ personaPrompts: { reader: 'READER_PERSONA', genki: 'GENKI_PERSONA', 'custom:id-a': 'CUSTOM_A' }, assistantSystemPrompt: 'AGENT_ONLY {{literal}}' });
  assert.equal(agent.getSettings().useAssistantPreset, undefined);
  assert.match(agent.personaContext().defaultPrompt, /开场白/);
  await run('第一轮');
  assert.equal(log.backend.length, 2);
  for (const entry of log.backend) {
    assert.match(entry.body.messages[0].content, /READER_PERSONA/);
    assert.match(entry.body.messages[0].content, /AGENT_ONLY \{\{literal\}\}/);
    assert.doesNotMatch(JSON.stringify(entry.body.messages), /STORY_PRESET|GENKI_PERSONA/);
  }
  ctx.chatMetadata.variables.dream_persona = 'genki';
  await run('第二轮');
  assert.match(log.backend[2].body.messages[0].content, /GENKI_PERSONA/);
  assert.doesNotMatch(log.backend[2].body.messages[0].content, /READER_PERSONA/);
  ctx.chatMetadata.variables.dream_persona = 'custom';
  ctx.chatMetadata.variables.dream_custom_persona = JSON.stringify({ id: 'id-a', name: '同名人格' });
  assert.equal(agent.personaContext().card, 'CUSTOM_A');
  ctx.chatMetadata.variables.dream_custom_persona = { id: 'id-b', name: '同名人格' };
  assert.equal(agent.personaContext().override, '');
});

test('文本补全轻聊只发送所选人格和助手专用系统指令；适配、整理均不读这些指令', async () => {
  const sample = makeHost({ preset: null, settings: { useAssistantPreset: true, assistantSystemPrompt: 'AGENT_ONLY' }, text: () => '收到。' });
  sample.ctx.mainApi = 'textgenerationwebui';
  sample.ctx.powerUserSettings = { sysprompt: { enabled: true, content: 'STORY_SYSTEM', post_history: 'STORY_POST' } };
  await sample.run('你好', { lite: true });
  assert.match(sample.log.text[0].prompts[0].content, /AGENT_ONLY/);
  assert.doesNotMatch(JSON.stringify(sample.log.text[0]), /STORY_/);
  for (const route of ['adapt', 'memory']) {
    await sample.llm.generate({ userInput: 'JSON', route });
    assert.doesNotMatch(JSON.stringify(sample.log.text.at(-1)), /AGENT_ONLY|STORY_/);
  }
});

test('自拍工具与助手同读当前外貌；换主题、换装和同名自定义人格均独立', async () => {
  const { agent, ctx, llm, run, log } = makeHost({ backend: (_body, round) => round === 1
    ? reply({ tool_calls: [nativeCall('generate_image', { prompt: '在窗前自拍', include_self: true })] }) : reply({ content: '拍好了。' }) });
  const vars = ctx.chatMetadata.variables;
  vars.dream_visual_theme = 'ink';
  vars.dream_appearance = 'victoria2';
  const outfit = agent.personaContext().appearance;
  assert.match(outfit.defaultPrompt, /短旗袍/);
  vars.dream_appearance = 'victoria1';
  assert.equal(agent.personaContext().appearance.key, outfit.key);
  agent.saveSettings({ appearancePrompts: { [outfit.key]: '换上蓝披肩', 'custom:a': '戴眼镜' } });
  llm.getTaskConnection = () => ({ configured: true });
  llm.generateMedia = async (_kind, prompt) => {
    assert.match(prompt, /在窗前自拍[\s\S]*换上蓝披肩/);
    return { images: [{ url: 'data:image/png;base64,AQIDBA==' }] };
  };
  assert.equal((await run('发我自拍')).images.length, 1);
  assert.ok(log.backend.every(entry => entry.body.messages[0].content.includes('换上蓝披肩')));
  vars.dream_visual_theme = 'cafe';
  assert.match(agent.personaContext().appearance.prompt, /维多利亚式/);
  vars.dream_appearance = 'white_hoodie';
  assert.match(agent.personaContext().appearance.prompt, /双马尾/);
  vars.dream_visual_theme = 'summer';
  assert.match(agent.personaContext().appearance.prompt, /连体泳衣/);
  vars.dream_persona = 'custom';
  vars.dream_custom_persona = JSON.stringify({ id: 'a', name: '同名', appearance: '短卷发' });
  assert.equal(agent.personaContext().appearance.prompt, '戴眼镜');
  vars.dream_custom_persona = { id: 'b', name: '同名', appearance: '紫色长发' };
  assert.equal(agent.personaContext().appearance.prompt, '紫色长发');
  agent.saveSettings({ appearancePrompts: {} });
  vars.dream_custom_persona = { id: 'a', name: '同名', appearance: '短卷发' };
  assert.equal(agent.personaContext().appearance.prompt, '短卷发');
});

test('纯生图模型收到本人的自拍外貌，其他主体仍使用用户原话', async () => {
  const { agent, run, llm } = makeHost();
  agent.saveModelSettings({ imageMode: 'generation' });
  const appearance = agent.personaContext().appearance.prompt;
  let prompt;
  llm.chatReply = async options => {
    prompt = options.messages.at(-1).content;
    return { images: [{ url: 'data:image/png;base64,AQIDBA==' }] };
  };
  await run('给我发一张自拍');
  assert.ok(prompt.includes(appearance));
  for (const other of ['画一张猫的自拍', '在山顶画一场流星雨']) {
    await run(other);
    assert.equal(prompt, other);
  }
});

test('原生函数调用：tools 随请求声明，调用取自 tool_calls，结果用 role: tool 交还；读 → 改（确认）→ 回答', async () => {
  const asked = [];
  const { run, log, worldbooks } = makeHost({
    backend: kimi((body, turn) => {
      if (turn === 1) return reply({ content: '我先看看这一条。', reasoning_content: '先读再改。', tool_calls: [nativeCall('read', { path: 'wb:/设定集/王都' })] }, 'tool_calls');
      if (turn === 2) return reply({ content: '', tool_calls: [nativeCall('edit', { path: 'wb:/设定集/王都', old: '人口十万', new: '人口三十万' })] }, 'tool_calls');
      return reply({ content: '改好了，作家先生：王都的人口现在是三十万。' });
    }),
  });
  const result = await run('把王都的人口改成三十万', { confirm: async (request) => { asked.push(request); return 'allow'; } });

  assert.equal(result.error, '');
  assert.equal(result.protocol, 'native');
  assert.equal(result.answer, '改好了，作家先生：王都的人口现在是三十万。');
  same(result.steps.map((step) => [step.name, step.ok]), [['read', true], ['edit', true]]);
  assert.match(worldbooks.设定集[0].content, /人口三十万/);
  assert.equal(asked.length, 1, '写入照旧要确认');
  assert.equal(result.changes, 1, '改动照旧记进运行日志（可撤销）');
  assert.equal(log.text.length, 0, '原生调用成功时不该再碰文本通道');

  /* 请求体：经酒馆后端代发到独立 API，工具是 JSON Schema。 */
  const first = log.backend[0].body;
  assert.equal(first.chat_completion_source, 'openai');
  assert.equal(first.reverse_proxy, PRESET.apiurl);
  assert.equal(first.proxy_password, PRESET.key);
  assert.equal(first.model, PRESET.model);
  assert.equal(first.stream, false);
  assert.equal(first.tool_choice, 'auto');
  assert.equal(log.backend[0].headers['X-CSRF-Token'], 'csrf', '带上酒馆的请求头');
  const names = first.tools.map((tool) => tool.function.name);
  for (const name of ['ls', 'read', 'grep', 'edit', 'write', 'remove', 'run_js', 'todo', 'skill', 'toolbox']) assert.ok(names.includes(name), `缺少工具 ${name}`);
  assert.ok(!names.includes('slash_run'), '没打开的工具箱不声明');
  const read = first.tools.find((tool) => tool.function.name === 'read').function;
  same(read.parameters.required, ['path']);
  assert.equal(read.parameters.properties.offset.type, 'number');
  const todo = first.tools.find((tool) => tool.function.name === 'todo').function;
  assert.equal(todo.parameters.properties.items.type, 'array', '给了 schema 的 json 参数按 schema 声明');
  assert.match(first.tools.find((tool) => tool.function.name === 'edit').function.description, /^［写入］/);

  /* 提示词：原生调用下不放格式说明与工具手册（省 token，也不诱导模型把调用写成文字）。 */
  const system = first.messages[0].content;
  assert.ok(!/【核心工具】/.test(system) && !/<action name=/.test(system) && !/tool_call/.test(system));
  assert.match(system, /直接发起函数调用/);
  assert.match(system, /【工具箱】/);
  assert.match(system, /在同一条回复中直接调用工具执行/);

  /* 第二轮请求：assistant 的 tool_calls 原样带回（思考型模型的 reasoning_content 也带回），紧跟对应的 tool 消息。 */
  const second = log.backend[1].body.messages;
  const assistant = second.at(-2);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'call_read');
  assert.equal(assistant.reasoning_content, '先读再改。');
  const tool = second.at(-1);
  assert.equal(tool.role, 'tool');
  assert.equal(tool.tool_call_id, 'call_read');
  assert.match(tool.content, /守卫队长是雷恩/);
  assert.equal(tool.name, undefined, 'tool 消息只带 tool_call_id 与 content');
  const third = log.backend[2].body.messages;
  assert.equal(third.at(-1).role, 'tool');
  assert.match(third.at(-1).content, /已修改 wb:\/设定集\/王都/);
  assert.equal(third.at(-2).reasoning_content, undefined, '对方没给思考时不带这个字段');
});

test('真机故障重放：文本协议下工具块被吞 → 提醒一次仍不行 → 如实说明；自动模式直接走原生，一次成功', async () => {
  /* 一、强制文本协议（alpha.2 的行为）：模型两次都只剩开场白。 */
  const stuck = makeHost({ settings: { toolProtocol: 'text' }, text: (config) => {
    const body = { tools: config.tools };
    return kimi(() => { throw new Error('文本协议不该带 tools'); })(body).choices[0].message.content;
  } });
  const failed = await stuck.run('帮我把这张卡的变量适配到 Reader-II，逐项告诉我结果。');
  assert.equal(failed.protocol, 'text');
  assert.equal(failed.steps.length, 0);
  assert.equal(stuck.log.text.length, 2, '提醒一次，再问一次，不无限重试');
  assert.match(stuck.log.text[1].prompts.at(-1).content, /没有发出任何工具调用/);
  assert.match(failed.answer, /测试工具调用/, '告诉用户去哪里查原因，而不是又一句「我这就去做」');
  assert.ok(stuck.log.events.some((event) => event.type === 'nudge'));
  const system = stuck.log.text[0].prompts[0].content;
  assert.match(system, /<action name="工具名">/);
  assert.ok(!/<tool_call/.test(system), '文本协议不再用会撞上模型专用记号的 tool_call 标签');

  /* 二、默认设置（自动）：同一个模型，原生调用一次就通。 */
  const fixed = makeHost({ backend: kimi((body, turn) => (turn === 1
    ? reply({ content: REAL_STALLS[1], tool_calls: [nativeCall('skill', { name: 'reader-ii' }), nativeCall('ls', { path: 'card:/' })] }, 'tool_calls')
    : reply({ content: '已核对完毕：这张卡没有需要适配的变量。' }))) });
  const ok = await fixed.run('帮我把这张卡的变量适配到 Reader-II，逐项告诉我结果。');
  assert.equal(ok.protocol, 'native');
  same(ok.steps.map((step) => step.name), ['skill', 'ls']);
  assert.equal(ok.answer, '已核对完毕：这张卡没有需要适配的变量。');
  assert.equal(fixed.log.backend.length, 2);
  const messages = fixed.log.backend[1].body.messages;
  same(messages.slice(-3).map((message) => message.role), ['assistant', 'tool', 'tool']);
  same(messages.slice(-2).map((message) => message.tool_call_id), ['call_skill', 'call_ls']);
});

test('接口不认 tools：自动退回文本协议接着做，并记住这个接口；设置为只用原生时如实报错', async () => {
  const refuse = (body) => (body.tools
    ? { status: 400, body: { error: { message: 'Unrecognized request argument supplied: tools' } } }
    : reply({ content: '不该走到这里' }));
  const text = (config, turn) => (turn % 2 === 1 ? '我看一下。\n' + textCall('read', { path: 'wb:/设定集/王都' }) : '王都在北方，人口十万。');
  const { run, log, agent } = makeHost({ backend: refuse, text });
  const first = await run('王都在哪');
  assert.equal(first.error, '');
  assert.equal(first.protocol, 'text');
  assert.equal(first.answer, '王都在北方，人口十万。');
  same(first.steps.map((step) => step.name), ['read']);
  assert.equal(log.backend.length, 1, '原生只试一次');
  assert.ok(log.events.some((event) => event.type === 'protocol' && event.mode === 'text'));
  assert.match(log.text[0].prompts[0].content, /【核心工具】/, '退回文本协议后，系统提示换成带格式说明与手册的那一版');
  assert.equal(log.text[0].custom_api.model, PRESET.model);
  assert.match(log.text[1].prompts.at(-1).content, /<action_result name="read" status="ok">/);
  assert.equal(agent.toolStatus().mode, 'text');

  await run('再说一遍');
  assert.equal(log.backend.length, 1, '同一个接口记住了，不再每次先撞一回');
  agent.saveSettings({ temperature: 0.5 });
  assert.equal(agent.toolStatus().mode, 'native', '改过设置后重新试');

  const strict = makeHost({ backend: refuse, settings: { toolProtocol: 'native' } });
  const failed = await strict.run('王都在哪');
  assert.match(failed.error, /不接受原生函数调用/);
  assert.equal(strict.log.text.length, 0);
});

test('模型无视 tools、只说不做：提醒一次 → 仍不动 → 换文本协议；往来记录改写成文本的样子', async () => {
  const { run, log } = makeHost({
    backend: (body, turn) => reply({ content: REAL_STALLS[turn] }),
    text: (config, turn) => (turn === 1 ? textCall('ls', { path: 'wb:/' }) : '世界书里只有「设定集」一本。'),
  });
  const result = await run('看看有哪些世界书');
  assert.equal(result.error, '');
  assert.equal(log.backend.length, 2);
  assert.equal(log.backend[1].body.messages.at(-1).role, 'user');
  assert.match(log.backend[1].body.messages.at(-1).content, /没有发出任何工具调用/);
  assert.equal(result.protocol, 'text');
  same(result.steps.map((step) => step.name), ['ls']);
  assert.equal(result.answer, '世界书里只有「设定集」一本。');
  assert.ok(!/测试工具调用/.test(result.answer));
  same(log.events.filter((event) => ['nudge', 'protocol'].includes(event.type)).map((event) => event.type), ['nudge', 'protocol']);

  /* 正常的回答、向用户提问、已经调用过工具之后的收尾，都不触发提醒。 */
  const calm = makeHost({ backend: () => reply({ content: '需要我现在就开始修改吗？' }) });
  const asked = await calm.run('你打算怎么改');
  assert.equal(calm.log.backend.length, 1);
  assert.equal(asked.answer, '需要我现在就开始修改吗？');
  const done = makeHost({ backend: (body, turn) => (turn === 1
    ? reply({ content: '', tool_calls: [nativeCall('ls', { path: 'wb:/' })] })
    : reply({ content: '现在开始您可以直接使用了。' })) });
  const finished = await done.run('列一下');
  assert.equal(done.log.backend.length, 2);
  assert.equal(finished.answer, '现在开始您可以直接使用了。');
});

test('工具参数被宿主压成正文：保留上轮已执行的操作，切到文本协议重问当前一步', async () => {
  const flattened = '我这就检查。\n[object Object],[object Object],[object Object]\n\nreader-ii\n\ncard:/\n100';
  let writes = 0;
  const { agent, run, log } = makeHost({
    backend: (_, turn) => turn === 1
      ? reply({ tool_calls: [nativeCall('mark_card', {})] })
      : reply({ content: flattened }),
    text: (_, turn) => turn === 1 ? textCall('read', { path: 'wb:/设定集/王都' }) : '王都的守卫队长是雷恩。',
  });
  agent.registerTool({ name: 'mark_card', toolset: 'core', summary: '做标记', params: [], effect: 'write', scope: 'card',
    run: () => { writes++; return '已标记'; } });
  const result = await run('做标记并核对守卫队长。');
  assert.equal(result.answer, '王都的守卫队长是雷恩。');
  same(result.steps.map((step) => step.name), ['mark_card', 'read']);
  assert.equal(writes, 1);
  assert.equal(log.backend.length, 2);
  assert.match(log.text[0].prompts.at(-1).content, /action_result name="mark_card" status="ok"/);
  assert.match(log.text[1].prompts.at(-1).content, /守卫队长是雷恩/);
  for (const transcript of [log.text, log.events, agent.getHistory()]) {
    assert.ok(!JSON.stringify(transcript).includes('[object Object]'));
  }
});

test('结构缺失时严格模式报告本批未执行，普通正文仍可解释对象字符串', async () => {
  const strict = makeHost({ settings: { toolProtocol: 'native' }, backend: () => reply({ content: 'card:/\n100' }, 'tool_calls') });
  const result = await strict.run('列出这张卡。');
  assert.match(result.error, /本批工具未执行/);
  assert.equal(result.steps.length, 0);
  assert.equal(strict.log.backend.length, 1);
  assert.equal(strict.log.text.length, 0);

  const flattened = '[object Object],[object Object],[object Object]\n\nreader-ii';
  const broken = makeHost({ backend: () => reply({ content: flattened }), text: () => flattened });
  const failure = await broken.run('查看资料。');
  assert.match(failure.error, /本批工具未执行/);
  assert.equal(broken.log.text.length, 1);
  assert.equal(broken.agent.getHistory().length, 0);

  const explanation = '数组转成字符串会显示 [object Object],[object Object]。';
  const chat = makeHost({ backend: () => reply({ content: explanation }) });
  assert.equal((await chat.run('为什么显示对象字符串？')).answer, explanation);
  assert.equal(chat.log.text.length, 0);
});

test('原生调用下的边角：正文里夹带工具块、坏参数、未知工具、步数上限', async () => {
  /* 正文里夹带文本块：这一步按文本协议处理，结果放进 user 消息。 */
  const inline = makeHost({ backend: (body, turn) => (turn === 1
    ? reply({ content: '我查一下。\n' + textCall('read', { path: 'wb:/设定集/王都' }) })
    : reply({ content: '查到了。' })) });
  const first = await inline.run('查王都');
  same(first.steps.map((step) => step.name), ['read']);
  const back = inline.log.backend[1].body.messages.at(-1);
  assert.equal(back.role, 'user');
  assert.match(back.content, /<action_result name="read" status="ok">/);
  assert.equal(first.answer, '查到了。');

  /* 坏参数与未知工具：每个 tool_call 都要有对应的 tool 消息，内容说明原因。 */
  const broken = makeHost({ backend: (body, turn) => (turn === 1
    ? reply({ content: '', tool_calls: [nativeCall('read', '{"path": "wb:/设定', 'c1'), nativeCall('nope', {}, 'c2'), nativeCall('read', {}, 'c3')] })
    : reply({ content: '抱歉，刚才的调用有误。' })) });
  const second = await broken.run('查王都');
  same(second.steps.map((step) => step.ok), [false, false, false]);
  const tools = broken.log.backend[1].body.messages.filter((message) => message.role === 'tool');
  same(tools.map((message) => message.tool_call_id), ['c1', 'c2', 'c3']);
  assert.match(tools[0].content, /^［失败］工具参数不是合法的 JSON/);
  assert.match(tools[1].content, /没有名为 nope 的工具/);
  assert.match(tools[2].content, /缺少必填参数 path/);

  /* 步数上限：最后一次请求 tool_choice 为 none，说明并在最后一条工具结果里。 */
  const limited = makeHost({ settings: { maxSteps: 2 }, backend: (body, turn) => (body.tool_choice === 'none'
    ? reply({ content: '先到这里。' })
    : reply({ content: '', tool_calls: [nativeCall('ls', { path: 'wb:/', offset: turn }, 'c' + turn)] })) });
  const third = await limited.run('一直列');
  assert.equal(third.answer, '先到这里。');
  const last = limited.log.backend.at(-1).body;
  assert.equal(last.tool_choice, 'none');
  assert.match(last.messages.at(-1).content, /已到本次请求的工具步数上限/);
  assert.equal(last.messages.at(-1).role, 'tool');
});

test('酒馆预设消费展示用的 tool_calls 时，助手按原始响应执行三个工具并回传对应结果', async () => {
  const calls = [
    nativeCall('todo', { items: ['读卡', '查知识', '核对'].map(text => ({ text, status: 'pending' })) }),
    nativeCall('skill', { name: 'reader-ii' }),
    nativeCall('ls', { path: 'card:/', limit: 100 }),
  ];
  function wrapResponse(response) {
    const readJson = response.json.bind(response);
    Object.defineProperty(response, 'json', { value: async () => {
      const data = await readJson();
      const choice = data.choices[0];
      if (choice.message.tool_calls) {
        choice.message.content = choice.message.tool_calls.map(call =>
          Object.values(JSON.parse(call.function.arguments)).map(String).join('\n')).join('\n\n');
        delete choice.message.tool_calls;
        choice.finish_reason = 'stop';
      }
      return data;
    } });
    return response;
  }
  const raw = reply({ content: '', tool_calls: calls }, 'tool_calls');
  const displayed = await wrapResponse(Response.json(raw)).json();
  assert.equal(displayed.choices[0].message.content, '[object Object],[object Object],[object Object]\n\nreader-ii\n\ncard:/\n100');
  const settings = { chat_completion_source: 'openai', temperature: 0.35, extensions: { SPreset: {
    OutputPreprocessing: { enabled: true, consumeToolCalls: true },
  } } };
  for (const via of ['backend', 'openai']) {
    const { run, log, eventSource } = makeHost({
      preset: via === 'openai' ? null : PRESET,
      openaiBuilder: {
        oai_settings: settings,
        getChatCompletionModel: () => 'fixture-model',
        createGenerationParameters: async (active, model, type, messages) => ({
          generate_data: { ...active, model, type, messages, stream: false },
        }),
      },
      backend: (_body, turn) => turn === 1 ? raw : reply({ content: '已核对工具结果。' }),
      wrapResponse,
    });
    eventSource.on('chat_completion_settings_ready', data => { data.preset_hook = 'applied'; });
    const result = await run('读取这张卡并核对结果');
    assert.equal(result.error, '', via);
    assert.equal(result.answer, '已核对工具结果。', via);
    assert.equal(result.protocol, 'native');
    same(result.steps.map(step => [step.name, step.ok]), [['todo', true], ['skill', true], ['ls', true]]);
    assert.equal(log.backend.length, 2);
    assert.equal(log.text.length, 0);
    const transcript = log.backend[1].body.messages;
    same(transcript.find(msg => msg.role === 'assistant').tool_calls, calls);
    same(transcript.filter(msg => msg.role === 'tool').map(msg => msg.tool_call_id), calls.map(call => call.id));
    if (via === 'openai') {
      assert.equal(log.backend[0].body.preset_hook, undefined);
      assert.equal(log.backend[0].body.model, 'fixture-model');
      assert.equal(log.backend[0].body.temperature, settings.temperature);
    }
  }
});

test('预设工具和格式化脚本与助手原生调用、文本回退和适配 JSON 请求隔离', async () => {
  for (const source of ['custom', 'main']) {
    const bodies = [];
    let presetHooks = 0;
    let nativeAllowed = true;
    const fixture = makeHost({
      preset: source === 'main' ? null : PRESET,
      openaiBuilder: {
        oai_settings: { chat_completion_source: 'openai', extensions: { SPreset: {} } },
        getChatCompletionModel: () => 'main-connection',
        createGenerationParameters: async (_settings, model, type, messages) => ({
          generate_data: { type, model, messages, stream: true, tools: [nativeCall('soliumbra_reply', {})], tool_choice: 'required' },
        }),
      },
      text: () => '<think_nya>internal reasoning</think_nya>',
    });
    fixture.eventSource.on('chat_completion_settings_ready', data => {
      presetHooks++;
      data.tools = [nativeCall('soliumbra_reply', {})];
    });
    fixture.host.__TAURITAVERN__ = { invoke: { safeInvoke: async (command, { dto }) => {
      assert.equal(command, 'generate_chat_completion');
      bodies.push(clone(dto));
      if (dto.json_schema) return reply({ content: '{"valid":true}' });
      if (dto.tools) {
        assert.ok(dto.tools.some(t => t.function.name === 'read'));
        if (!nativeAllowed) return { error: { message: 'Unsupported tools' } };
        return dto.messages.at(-1).role === 'tool' ? reply({ content: '读回成功。' })
          : reply({ content: '', tool_calls: [nativeCall('read', { path: 'wb:/设定集/王都' })] });
      }
      assert.equal(dto.tool_choice, undefined);
      return reply({ content: dto.messages.some(m => m.content?.includes('<action_result name="read"'))
        ? '文本读回成功。' : textCall('read', { path: 'wb:/设定集/王都' }) });
    } } };
    const first = await fixture.run('请核对世界书', { remember: false });
    assert.equal(first.answer, '读回成功。', source);
    same(first.steps.map(step => step.name), ['read']);
    nativeAllowed = false;
    const second = await fixture.run('继续核对', { remember: false });
    assert.equal(second.answer, '文本读回成功。', source);
    assert.equal(second.protocol, 'text');
    same(second.steps.map(step => step.name), ['read']);
    const schema = { name: 'mapping', strict: true, value: { type: 'object' } };
    const compiled = await fixture.llm.generate({ system: 'Return JSON', userInput: 'fixture', route: 'adapt', jsonSchema: schema });
    assert.deepEqual(JSON.parse(compiled), { valid: true });
    assert.equal(presetHooks, 0);
    assert.equal(fixture.log.text.length, 0);
    assert.equal(fixture.log.backend.length, 0);
    assert.equal(bodies.length, 6);
    assert.ok(bodies.every(b => b.stream === false && !JSON.stringify(b).includes('soliumbra_reply')));
    same(bodies.at(-1).json_schema, schema);
  }
});

test('使用预设取得原始响应时尊重服务端拒答和截断，写工具不会执行或再次发送', async () => {
  const settings = { extensions: { SPreset: { OutputPreprocessing: { enabled: true, consumeToolCalls: true } } } };
  for (const reason of ['refusal', 'length']) {
    const { run, log } = makeHost({
      preset: null,
      openaiBuilder: {
        oai_settings: settings,
        getChatCompletionModel: () => 'fixture',
        createGenerationParameters: async (_settings, model, type, messages) => ({ generate_data: { model, type, messages } }),
      },
      backend: () => reply({ content: '', tool_calls: [nativeCall('write', { path: 'fixture', text: 'pending' })] }, reason),
    });
    const result = await run('试验中止响应');
    assert.match(result.error, new RegExp(reason));
    assert.equal(result.steps.length, 0);
    assert.equal(log.backend.length, 1);
    assert.equal(log.text.length, 0);
  }
});

test('酒馆主 API：沿用酒馆的连接与预设，只在请求发出前补上 tools；别人的请求不动', async () => {
  const { run, log, eventSource, agent } = makeHost({
    preset: null,
    openai: (data, turn) => (turn === 1
      ? reply({ content: '', tool_calls: [nativeCall('read', { path: 'wb:/设定集/王都' })] })
      : reply({ content: '王都在北方。' })),
  });
  assert.equal(agent.toolStatus().via, 'openai');
  const result = await run('王都在哪');
  assert.equal(result.error, '');
  assert.equal(result.protocol, 'native');
  assert.equal(result.answer, '王都在北方。');
  assert.equal(log.backend.length, 0);
  assert.equal(log.openai[0].type, 'quiet');
  assert.equal(log.openai[0].stream, false);
  assert.equal(log.openai[0].model, 'main-model', '模型与采样参数沿用酒馆的');
  assert.equal(log.openai[0].temperature, 1);
  assert.equal(log.openai[0].tool_choice, 'auto');
  assert.ok(log.openai[0].tools.some((tool) => tool.function.name === 'read'));
  same(log.openai[1].messages.slice(-2).map((message) => message.role), ['assistant', 'tool']);
  assert.equal(eventSource.count('chat_completion_settings_ready'), 0, '用完就摘掉监听');

  /* 同一时刻别处发出的请求（比如用户正在生成正文）：不是我们的那一份消息，就不碰。 */
  const other = { messages: [{ role: 'user', content: '正文生成' }], stream: true };
  let seen = null;
  const racing = makeHost({ preset: null, openai: async (data) => { seen = data; return reply({ content: '好的。' }); } });
  racing.eventSource.on('chat_completion_settings_ready', () => {});
  const pending = racing.run('你好');
  await racing.eventSource.emit('chat_completion_settings_ready', other);
  await pending;
  assert.equal(other.tools, undefined);
  assert.equal(other.stream, true);
  assert.ok(seen.tools.length > 0);

  /* 文本补全类的主 API 没有原生调用：直接用文本协议，不白试。 */
  const textApi = makeHost({ preset: null, openai: null, text: () => '你好，作家先生。' });
  textApi.ctx.mainApi = 'textgenerationwebui';
  assert.equal(textApi.agent.toolStatus().mode, 'text');
  assert.match(textApi.agent.toolStatus().reason, /文本补全/);
  assert.equal((await textApi.run('你好')).answer, '你好，作家先生。');
});

test('自检：两种方式各试一次，给出建议；真机那种模型的结论是「原生可用、文本被吞」', async () => {
  const { agent, log } = makeHost({
    backend: kimi(() => reply({ content: '', tool_calls: [nativeCall('ping', { text: 'ok' })] }, 'tool_calls')),
    text: () => '好的，我现在就调用。',
  });
  const report = await agent.probeTools();
  assert.equal(report.native.ok, true);
  assert.equal(report.text.ok, false);
  assert.match(report.text.detail, /没有写出工具块/);
  assert.equal(report.recommend, 'native');
  assert.equal(report.backend.model, PRESET.model);
  same(log.backend[0].body.tools.map((tool) => tool.function.name), ['ping']);
  assert.match(log.text[0].prompts[0].content, /<action name="工具名">/);

  const old = makeHost({
    backend: () => ({ status: 400, body: { error: { message: 'tools is not supported by this model' } } }),
    text: () => textCall('ping', { text: 'ok' }),
  });
  const second = await old.agent.probeTools();
  assert.equal(second.native.ok, false);
  assert.match(second.native.detail, /不接受原生函数调用/);
  assert.equal(second.text.ok, true);
  assert.equal(second.recommend, 'text');
  assert.equal(old.agent.toolStatus().mode, 'text', '自检的结论当场生效');
});

test('文本协议：新标签、CDATA、旧写法都认；「只说不做」的判断对得上真机的五句', () => {
  const { protocol } = makeHost();
  const parsed = protocol.parse('先说明一句。\n' + textCall('read', { path: 'wb:/a', limit: 20 }) + '\n' + textCall('ls', {}));
  same(parsed.calls.map((call) => [call.name, call.args]), [['read', { path: 'wb:/a', limit: '20' }], ['ls', {}]]);
  assert.equal(parsed.prose, '先说明一句。');
  assert.equal(parsed.truncated, false);

  /* 值里带结束标签：CDATA 里的 </param>、</action> 不算数。 */
  const tricky = '<action name="write">\n<param name="path">ws:/a.html</param>\n<param name="content"><![CDATA[<b>文本</b></param></action> 仍是内容]]></param>\n</action>收尾';
  const written = protocol.parse(tricky);
  same(written.calls[0].args, { path: 'ws:/a.html', content: '<b>文本</b></param></action> 仍是内容' });
  assert.equal(written.prose, '收尾');
  assert.equal(protocol.parse(protocol.callBlock('write', written.calls[0].args)).calls[0].args.content, written.calls[0].args.content, 'callBlock 写出来的能原样读回');

  /* 旧写法照样认（历史对话、别的模型的习惯）。 */
  assert.equal(protocol.parse('<tool_call name="read">\n<arg name="path">a</arg>\n</tool_call>').calls[0].args.path, 'a');
  assert.equal(protocol.parse('<invoke name="read"><parameter name="path">b</parameter></invoke>').calls[0].args.path, 'b');
  assert.equal(protocol.parse('<tool_call>{"name":"read","arguments":{"path":"c"}}</tool_call>').calls[0].name, 'read');
  const open = protocol.parse('先说一句\n<action name="write"><param name="path">ws:/a</param><param name="content">没写完');
  assert.equal(open.truncated, true);
  assert.equal(open.calls.length, 0);
  assert.equal(open.prose, '先说一句');
  assert.equal(protocol.parse('<action_result name="x" status="ok">泄漏的结果标签</action_result>正文').prose, '泄漏的结果标签正文');

  for (const line of REAL_STALLS) assert.equal(protocol.stalled(line, ''), true, line);
  assert.equal(protocol.stalled('好的。', 'I should call the tool. Then tool.'), true, '思考里说要调用、正文里却没有');
  for (const line of ['改好了，作家先生：王都的人口现在是三十万。', '王都位于北方，守卫队长是雷恩。', '需要我现在就开始修改吗？', '晚安，作家先生。', '']) {
    assert.equal(protocol.stalled(line, ''), false, line);
  }
  assert.equal(protocol.stalled('我会先核对。' + '很长的说明'.repeat(100), ''), false, '长篇的回答不算');
});

test('工具定义 → JSON Schema；各家的响应规整成同一种形状', () => {
  const { protocol, llm } = makeHost();
  const schema = protocol.toolSchema({
    name: 'demo', summary: '演示', effect: 'danger',
    params: [{ name: 'a', type: 'string', required: true, desc: '甲' }, { name: 'n', type: 'number' }, { name: 'on', type: 'boolean' }, { name: 'list', type: 'json', desc: '清单' },
      { name: 'items', type: 'json', schema: { type: 'array', items: { type: 'string' } } }],
  });
  same(schema, { type: 'function', function: { name: 'demo', description: '［危险］演示', parameters: {
    type: 'object',
    properties: { a: { type: 'string', description: '甲' }, n: { type: 'number' }, on: { type: 'boolean' }, list: { type: 'string', description: '清单；写成 JSON 文本' }, items: { type: 'array', items: { type: 'string' } } },
    required: ['a'],
  } } });
  same(protocol.nativeArgs('{"a":1}'), { args: { a: 1 } });
  same(protocol.nativeArgs(''), { args: {} });
  assert.match(protocol.nativeArgs('{"a":').error, /不是合法的 JSON/);
  assert.match(protocol.nativeArgs('[1]').error, /JSON 对象/);

  const openai = llm.parseToolResponse(reply({ content: '好', reasoning_content: '想', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' }, signature: 'sig' }] }, 'tool_calls'));
  same(openai.toolCalls, [{ id: 'x', name: 'read', arguments: '{"path":"a"}' }]);
  assert.equal(openai.finish, 'tool_calls');
  same(openai.message, { role: 'assistant', content: '好', tool_calls: [{ id: 'x', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' }, signature: 'sig' }], reasoning_content: '想' });
  same(llm.parseToolResponse(reply({ content: '只有正文', reasoning_content: '想' })).message, { role: 'assistant', content: '只有正文' });
  same(llm.parseToolResponse(reply({ content: null, function_call: { name: 'ls', arguments: '{}' } })).toolCalls.map((call) => call.name), ['ls']);
  same(llm.parseToolResponse(reply({ content: [{ type: 'text', text: '分' }, { type: 'text', text: '段' }] })).text, '分段');

  const claude = llm.parseToolResponse({ content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }], stop_reason: 'tool_use' });
  assert.equal(claude.text, '我查一下');
  same(claude.toolCalls, [{ id: 'toolu_1', name: 'read', arguments: '{"path":"a"}' }]);
  const gemini = llm.parseToolResponse({ choices: [{ message: { content: '' } }], responseContent: { parts: [{ functionCall: { name: 'ls', args: { path: 'wb:/' } }, thoughtSignature: 'ts' }] } });
  assert.equal(gemini.toolCalls[0].name, 'ls');
  assert.equal(gemini.message.tool_calls[0].signature, 'ts');
  assert.match(gemini.toolCalls[0].id, /^call_/);
});
