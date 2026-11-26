import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = vm.createContext({ setTimeout, clearTimeout, AbortController });
for (const path of ['reader-env.js', 'reader-llm-gateway.js']) {
  vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), scope);
}
const gateway = scope.__ReaderIIModules.createLlmGateway({});

test('文本补全沿用连接和采样，生成助手回复和记忆时不运行正文参数构造器或预设宏', async () => {
  const requests = [];
  const settings = Object.freeze({
    type: 'llamacpp', llamacpp_model: 'fixture', temp: 0.45, top_p: 0.92,
    grammar_string: 'STORY', negative_prompt: '{{setvar::story::1}}',
    dry_sequence_breakers: '["{{setvar::story::2}}"]', json_schema: { title: 'STORY' }
  });
  const ctx = { mainApi: 'textgenerationwebui', getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) };
  const env = {
    host: { SillyTavern: { getContext: () => ctx }, fetch: async (url, options) => {
      assert.equal(url, '/api/backends/text-completions/generate');
      assert.equal(options.headers['X-CSRF-Token'], 'test');
      requests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ text: '完成' }] });
    } },
    hostImport: async name => name === '/script.js'
      ? { amount_gen: 256, max_context: 8192, extractMessageFromData: data => data.choices[0].text }
      : { textgenerationwebui_settings: settings, getTextGenModel: s => s.llamacpp_model,
        getTextGenServer: type => 'http://fixture.test/' + type,
        createTextGenGenerationData: () => assert.fail('宿主构造器会解析正文停止词与负面提示中的宏') },
    generateRaw: () => assert.fail('不应触发正文预设脚本')
  };
  const local = scope.__ReaderIIModules.createLlmGateway(env);
  for (const route of ['agent', 'memory']) assert.equal(await local.generate({ route, userInput: '{{literal}}', usePreset: true }), '完成');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.api_server, 'http://fixture.test/llamacpp');
    assert.equal(body.model, 'fixture');
    assert.equal(body.temperature, 0.45);
    assert.equal(body.top_p, 0.92);
    assert.equal(body.n_predict, 256);
    assert.equal(body.num_ctx, 8192);
    assert.ok(body.prompt.includes('{{literal}}'));
    assert.doesNotMatch(JSON.stringify(body), /STORY|setvar|negative_prompt|stopping_strings|dry_sequence_breakers|grammar|json_schema/);
    /* 只用固定的轮次边界当停止词：模型写完这一轮就停，不替 user / system 往下编 */
    assert.deepEqual(body.stop, ['\n\nuser:', '\n\nsystem:']);
    assert.equal(body.stop_sequence, undefined, 'koboldcpp 以外不带 stop_sequence');
  }
  const schema = { name: 'result', value: { properties: { result: { type: 'string' } } } };
  await local.generate({ route: 'adapt', userInput: '返回 JSON', jsonSchema: schema });
  assert.deepEqual(requests.at(-1).json_schema, schema.value);
});

test('助手的聊天补全沿用连接头，正文预设的停止词不会截断回复', async () => {
  let body;
  const ctx = { mainApi: 'openai', getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }) };
  const local = scope.__ReaderIIModules.createLlmGateway({
    host: { SillyTavern: { getContext: () => ctx }, fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    } },
    hostImport: async () => ({
      oai_settings: { chat_completion_source: 'custom', custom_include_headers: 'Authorization: Bearer fixture' },
      getChatCompletionModel: () => 'fixture-model',
      createGenerationParameters: async (settings, model, type, messages) => {
        assert.equal(type, 'quiet');
        return { generate_data: { ...settings, model, messages, stop: ['正文停在这里'] } };
      }
    })
  });
  assert.equal(await local.chat({ route: 'agent', messages: [{ role: 'user', content: 'OK?' }] }), 'OK');
  assert.equal(body.custom_include_headers, 'Authorization: Bearer fixture');
  assert.equal(body.model, 'fixture-model');
  assert.equal(body.stop, undefined);
});

test('服务端将思考写到正文时只展示正文，思考内的动作不起作用', () => {
  const privateText = '<think_nya><action name="write"></action></think_nya><!--</think>-->';
  assert.equal(gateway.parseToolResponse(privateText).text, '');
  assert.equal(gateway.parseToolResponse({ choices: [{ message: { content: privateText + '已核对。' } }] }).text, '已核对。');
  assert.equal(gateway.visibleText('示例：' + privateText), '示例：' + privateText);
});

test('顶层助手消息与 OpenAI 信封保留同一组工具、嵌套参数和调用 ID', () => {
  const toolCalls = [
    { id: 'todo-1', type: 'function', function: { name: 'todo', arguments: '{"items":[{"text":"读卡","status":"doing"}]}' } },
    { id: 'skill-2', type: 'function', function: { name: 'skill', arguments: '{"name":"reader-ii"}' } },
    { id: 'list-3', type: 'function', function: { name: 'ls', arguments: '{"path":"card:/","limit":100}' }, thought_signature: 'fixture-signature' },
  ];
  const message = { content: '先读卡。', tool_calls: toolCalls };
  const expected = gateway.parseToolResponse({ choices: [{ message }] });
  assert.equal(expected.toolCalls.length, 3);
  const actual = gateway.parseToolResponse(message);
  assert.deepEqual(actual.toolCalls, expected.toolCalls);
  assert.deepEqual(actual.message, expected.message);
  assert.deepEqual(JSON.parse(JSON.stringify(actual.message.tool_calls)), toolCalls);
});

test('只从文本块提取文字，结构和未知内容类型不会变成对象占位符', () => {
  const content = [{ type: 'image_url', image_url: { url: 'example' } }, { type: 'text', text: '读' }, { type: 'output_text', text: '卡' }];
  assert.equal(gateway.responseText({ choices: [{ message: { content } }] }), '读卡');
  assert.equal(gateway.responseText({ content }), '读卡');
  assert.equal(gateway.responseText({ content: [{ type: 'image' }], choices: [{ message: { content: '文字' } }] }), '文字');
  const unknown = { choices: [{ message: { content: [{ type: 'unknown' }] } }] };
  assert.equal(gateway.parseToolResponse(unknown).text, '');
});

test('带工具调用结束原因的空响应只发送一次，保留结束原因供助手恢复', async () => {
  let requests = 0;
  const local = scope.__ReaderIIModules.createLlmGateway({
    storage: { getItem: key => key === 'reader_ii_llm_settings_v1'
      ? JSON.stringify({ enabled: true, apiurl: 'https://fixture.test/v1', model: 'fixture' }) : null },
    host: { fetch: async () => {
      requests++;
      return Response.json({ choices: [{ message: { content: null }, finish_reason: 'tool_calls' }] });
    } },
  });
  const reply = await local.chatTools({ messages: [{ role: 'user', content: '读卡' }], retries: 0 });
  assert.equal(requests, 1);
  assert.equal(reply.finish, 'tool_calls');
  assert.equal(reply.toolCalls.length, 0);
});

function proxyGateway(handler, ctx) {
  let preset = { enabled: true, apiurl: 'https://example.test/secret-route/v1', key: 'fixture-key', model: 'alias', source: 'openai' };
  const requests = [];
  const local = scope.__ReaderIIModules.createLlmGateway({
    storage: { getItem: key => key === 'reader_ii_llm_settings_v1' ? JSON.stringify(preset) : null },
    host: { SillyTavern: ctx && { getContext: () => ctx }, fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body, options });
      return Response.json(await handler(url, body, options));
    } },
  });
  return { local, requests, select: update => { preset = { ...preset, ...update }; } };
}

const ask = { route: 'agent', messages: [{ role: 'user', content: '画一只鲸鱼' }], retries: 0 };

test('根据所选端点、模型和代理提供的元数据选择窗口；不继承其他模型的设置或密钥', async () => {
  const { local, select, requests } = proxyGateway(() => ({ data: [
    { id: 'alias', context_length: 20000 }, { id: 'large', context_window: 1000000 },
    { id: 'gpt-4.1', context_length: 32000 }, { id: 'mystery' },
  ] }));
  const small = await local.resolveModelCapabilities('agent');
  assert.equal(small.contextWindow, 20000);
  assert.equal(small.origin, 'metadata');
  assert.doesNotMatch(JSON.stringify(small), /secret-route|fixture-key/);
  assert.equal((await local.resolveModelCapabilities('agent')).contextWindow, 20000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.test/secret-route/v1/models');
  select({ model: 'large' });
  const large = await local.resolveModelCapabilities('agent');
  assert.equal(large.contextWindow, 1000000);
  assert.notEqual(small.profileKey, large.profileKey);
  assert.equal((await local.resolveModelCapabilities('agent', { contextWindow: 65536 })).contextWindow, 65536);
  select({ model: 'gpt-4.1' });
  assert.equal(local.getModelCapabilities('agent').origin, 'catalog');
  assert.equal((await local.resolveModelCapabilities('agent')).contextWindow, 32000);
  select({ model: 'mystery' });
  assert.equal((await local.resolveModelCapabilities('agent')).origin, 'fallback');
});

test('主连接使用实际模型列表，路由切换后不复用别的窗口', async () => {
  const settings = { chat_completion_source: 'custom', custom_model: 'a', openai_max_context: 4000 };
  const local = scope.__ReaderIIModules.createLlmGateway({
    host: { SillyTavern: { getContext: () => ({ mainApi: 'openai', chatCompletionSettings: settings }) } },
    hostImport: async () => ({ model_list: [{ id: 'a', context_length: 20000 }, { id: 'b', inputTokenLimit: 1048576 }],
      getChatCompletionModel: s => s.custom_model }),
  });
  assert.equal((await local.resolveModelCapabilities('agent')).contextWindow, 20000);
  settings.custom_model = 'b';
  assert.equal((await local.resolveModelCapabilities('agent')).contextWindow, 1048576);
  settings.custom_model = 'unknown';
  assert.equal(local.getModelCapabilities('agent').contextWindow, 4000);
});

test('独立 OpenAI 兼容方案的思考档和代理参数能穿过酒馆 custom body 转发；默认请求不加字段', async () => {
  const ctx = { getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) };
  const { local, requests } = proxyGateway(() => ({ choices: [{ message: { content: 'ok' } }] }), ctx);
  await local.chatTools({ ...ask, reasoningEffort: 'xhigh', modelParameters: { proxy_feature: true } });
  const wire = requests[0].body;
  assert.equal(wire.chat_completion_source, 'custom');
  assert.equal(wire.custom_url, 'https://example.test/secret-route/v1');
  assert.deepEqual(JSON.parse(wire.custom_include_body), { reasoning_effort: 'xhigh', proxy_feature: true });
  assert.match(wire.custom_include_headers, /fixture-key/);
  await local.chatReply(ask);
  assert.equal(requests[1].body.custom_include_body, undefined);
  assert.equal(requests[1].body.reasoning_effort, undefined);
  assert.equal(requests[1].body.chat_completion_source, 'openai');
  await assert.rejects(local.chatReply({ ...ask, modelParameters: { messages: [] } }), /不能覆盖/);
  assert.equal(requests.length, 2);
});

test('原生 Claude / Gemini 请求使用酒馆后端支持的档位；Gemini 图片走原生 response modalities', async () => {
  const { local, requests, select } = proxyGateway(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YQ==' } }] } }] }),
    { getRequestHeaders: () => ({}) });
  select({ source: 'makersuite', model: 'gemini-2.5-flash-image' });
  const image = await local.chatReply({ ...ask, reasoningEffort: 'minimal' });
  assert.equal(image.images[0].url, 'data:image/png;base64,YQ==');
  assert.equal(requests[0].body.request_images, true);
  assert.equal(requests[0].body.reasoning_effort, 'min');
  select({ source: 'claude', model: 'claude-opus-4-6' });
  await local.chatReply({ ...ask, reasoningEffort: 'max' });
  assert.equal(requests[1].body.chat_completion_source, 'claude');
  assert.equal(requests[1].body.reasoning_effort, 'max');
  assert.equal(requests[1].body.request_images, undefined);
});

test('生成图片专用端点只发用户提示，返回 URL/b64 图片；只含图的聊天响应无需重试', async () => {
  const { local, requests, select } = proxyGateway((url) => url.endsWith('/images/generations')
    ? { data: [{ url: 'https://images.test/whale.png' }, { b64_json: 'YQ==' }] }
    : { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'https://images.test/whale.png' } }] } }] });
  select({ model: 'gpt-image-1' });
  const images = await local.chatTools({ ...ask, messages: [{ role: 'system', content: 'secret context' }, ...ask.messages], tools: [{}] });
  assert.equal(images.images.length, 2);
  assert.equal(images.images[1].url, 'data:image/png;base64,YQ==');
  assert.deepEqual(requests[0].body, { model: 'gpt-image-1', prompt: '画一只鲸鱼', n: 1 });
  select({ model: 'alias' });
  const multimodal = await local.chatReply({ ...ask, imageMode: 'chat', reasoningEffort: 'high' });
  assert.equal(multimodal.images.length, 1);
  assert.deepEqual(requests[1].body.modalities, ['image', 'text']);
  assert.equal(requests[1].body.reasoning_effort, 'high');
  const none = local.parseToolResponse({ choices: [{ message: { images: [
    { image_url: 'javascript:alert(1)' }, { image_url: 'data:image/svg+xml;base64,YQ==' },
  ] } }] });
  assert.equal(none.images.length, 0);
});

test('目录只匹配已知规格，可识别代理的图像别名；模型切换不会误发上一次的参数', async () => {
  const { local, requests, select } = proxyGateway(url => url.endsWith('/models')
    ? { data: [{ id: 'artist', architecture: { output_modalities: ['image'] } }] }
    : { choices: [{ message: { content: '![画作](https://images.test/art.png)' } }] });
  for (const [model, size] of [
    ['gpt-5.4', 1050000], ['gpt-5.4-mini', 400000], ['gpt-5.3-codex', 400000],
    ['claude-opus-4-6', 1000000], ['claude-sonnet-4-5-20250929', 200000], ['gemini-3.1-pro-preview', 1048576],
  ]) {
    select({ model });
    assert.equal(local.getModelCapabilities('agent').contextWindow, size);
  }
  select({ model: 'artist' });
  const artist = await local.resolveModelCapabilities('agent');
  assert.equal(artist.imageChatModel, true);
  const art = await local.chatReply({ ...ask, profileKey: artist.profileKey });
  assert.deepEqual(requests.at(-1).body.modalities, ['image']);
  assert.equal(art.text, '');
  assert.equal(art.images[0].url, 'https://images.test/art.png');
  select({ model: 'other' });
  const before = requests.length;
  await assert.rejects(local.chatReply({ ...ask, profileKey: artist.profileKey, modelParameters: { onlyArtist: true } }), { code: 'model_changed' });
  assert.equal(requests.length, before);
});

test('无卡切换助手连接只改 agent 路由；专用方案密钥不回显、换地址不沿用', () => {
  const key = 'reader_ii_independent_api_v2';
  const shared = { id: 'shared', name: '计划', model: 'alias', apiurl: 'https://other.test/v1', key: 'other-key', custom: { preserve: true } };
  const storage = new Map([[key, JSON.stringify({ version: 2, presets: [shared], defaultId: 'shared', routes: { memory: 'shared', adapt: 'tavern' } })]]);
  const local = scope.__ReaderIIModules.createLlmGateway({ storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
  assert.equal(JSON.stringify(local.getAgentConnection().presets), JSON.stringify([{ id: 'shared', name: '计划', model: 'alias' }]));
  const dedicated = { apiurl: 'https://artist.test/v1/', model: 'artist', source: 'openai', key: 'private-key' };
  const result = local.saveAgentConnection({ dedicated });
  assert.equal(result.selected, result.dedicatedId);
  assert.equal(result.dedicated.hasKey, true);
  assert.doesNotMatch(JSON.stringify(result), /private-key|other-key/);
  assert.equal(local.resolveApi('agent').key, 'private-key');
  assert.equal(local.resolveApi('memory').key, 'other-key');
  local.saveAgentConnection({ dedicated: { ...dedicated, model: 'artist2', key: '' } });
  assert.equal(local.resolveApi('agent').key, 'private-key');
  local.saveAgentConnection({ dedicated: { ...dedicated, apiurl: 'https://other-host.test/v1', key: '' } });
  assert.equal(local.resolveApi('agent').key, undefined);
  for (const selected of ['tavern', 'shared', 'default']) {
    local.saveAgentConnection({ selected });
    assert.equal(local.resolveApi('agent')?.model, selected === 'tavern' ? undefined : 'alias');
  }
  const current = JSON.parse(storage.get(key));
  assert.equal(current.defaultId, 'shared');
  assert.deepEqual(current.presets[0], shared);
  assert.equal(current.routes.adapt, 'tavern');
  assert.equal(current.routes.memory, 'shared');
  assert.throws(() => local.saveAgentConnection({ selected: 'removed' }), /不存在/);
});

test('无卡首次保存助手设置保留旧单方案；其他任务开始共享助手方案后新建独立副本', () => {
  const v2 = 'reader_ii_independent_api_v2', storage = new Map([
    ['reader_ii_llm_settings_v1', JSON.stringify({ enabled: true, apiurl: 'https://old.test/v1', model: 'old', key: 'old-key' })],
  ]);
  const local = scope.__ReaderIIModules.createLlmGateway({ storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
  const first = local.saveAgentConnection({ dedicated: { apiurl: 'https://first.test/v1', model: 'first' } });
  assert.equal(local.resolveApi('memory').model, 'old');
  const state = JSON.parse(storage.get(v2));
  state.routes.memory = first.selected;
  storage.set(v2, JSON.stringify(state));
  const second = local.saveAgentConnection({ dedicated: { apiurl: 'https://second.test/v1', model: 'second' } });
  assert.notEqual(first.selected, second.selected);
  assert.equal(local.resolveApi('memory').model, 'first');
  assert.equal(local.resolveApi('adapt').model, 'old');
});

test('跟随模型时不泄露酒馆预设的 min/auto 思考档，并清理 custom_include_body 里的宿主内部值', async () => {
  const sent = [];
  const settings = {
    chat_completion_source: 'custom', custom_model: 'gemini-4-neon',
    custom_include_body: JSON.stringify({ reasoning_effort: 'auto', keep: 1 }),
  };
  const ctx = { mainApi: 'openai', chatCompletionSettings: settings, getRequestHeaders: () => ({ 'X-CSRF-Token': 'x' }) };
  const local = scope.__ReaderIIModules.createLlmGateway({
    host: {
      SillyTavern: { getContext: () => ctx },
      __TAURITAVERN__: { invoke: { safeInvoke: async (_cmd, args) => { sent.push(args.dto); return { choices: [{ message: { content: 'OK' } }] }; } } },
      fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'OK' } }] }); },
    },
    hostImport: async () => ({
      oai_settings: settings,
      getChatCompletionModel: s => s.custom_model || s.google_model,
      createGenerationParameters: async (s, model, _type, messages) => ({
        generate_data: { ...s, model, messages, reasoning_effort: 'min' },
      }),
    }),
  });
  await local.chatTools({ ...ask, reasoningEffort: 'auto' });
  assert.equal(sent[0].reasoning_effort, undefined);
  assert.deepEqual(JSON.parse(sent[0].custom_include_body), { keep: 1 });
  delete settings.custom_include_body;
  await local.chatTools({ ...ask, reasoningEffort: 'auto' });
  assert.equal(sent[1].reasoning_effort, undefined);
  settings.custom_include_body = JSON.stringify({ reasoning_effort: 'min', keep: 2 });
  await local.chatTools({ ...ask, reasoningEffort: 'auto' });
  assert.equal(sent[2].reasoning_effort, undefined);
  assert.deepEqual(JSON.parse(sent[2].custom_include_body), { reasoning_effort: 'low', keep: 2 });
  settings.chat_completion_source = 'makersuite';
  settings.google_model = 'gemini-4-neon';
  delete settings.custom_model;
  delete settings.custom_include_body;
  await local.chatTools({ ...ask, reasoningEffort: 'auto' });
  assert.equal(sent[3].reasoning_effort, undefined);
  await local.chatTools({ ...ask, reasoningEffort: 'xhigh' });
  assert.equal(sent[4].reasoning_effort, 'xhigh');
});

test('Gemini 各代在 OpenAI 兼容反代、自定义原生格式与原生连接下按模型支持的档位映射', async () => {
  const ctx = { getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }) };
  const { local, requests, select } = proxyGateway(() => ({ choices: [{ message: { content: 'ok' } }] }), ctx);
  for (const [model, effort, expected] of [
    ['gemini-4-neon', 'max', 'xhigh'],
    ['gemini-4-neon', 'xhigh', 'xhigh'],
    ['gemini-4-neon', 'minimal', 'low'],
    ['gemini-4-argon', 'xhigh', 'high'],
    ['gemini-4-argon', 'max', 'high'],
    ['google/gemini-3.1-pro-preview', 'minimal', 'low'],
    ['google/gemini-3.1-pro-preview', 'max', 'high'],
    ['gemini-3-pro-preview', 'medium', 'low'],
    ['gemini-3-flash-preview', 'minimal', 'minimal'],
    ['gemini-3-flash-preview', 'xhigh', 'high'],
    ['gemini-3.7-flash', 'minimal', 'low'],
    ['gemini-2.5-pro', 'max', 'high'],
    ['gemini-2.5-flash', 'none', 'none'],
    ['gemini-2.5-flash', 'max', 'high'],
  ]) {
    select({ source: 'custom', model });
    await local.chatTools({ ...ask, reasoningEffort: effort });
    assert.equal(JSON.parse(requests.at(-1).body.custom_include_body).reasoning_effort, expected, `${model} ${effort}`);
    assert.equal(requests.at(-1).body.reasoning_effort, undefined);
  }
  for (const model of ['gemini-4-neon', 'gemini-3.1-pro-preview', 'gemini-2.5-pro']) {
    select({ source: 'custom', model });
    await assert.rejects(local.chatTools({ ...ask, reasoningEffort: 'none' }), /不支持关闭思考/);
    assert.equal(local.getModelCapabilities('agent').contextWindow, 1048576);
  }
  select({ source: 'makersuite', model: 'gemini-2.5-flash' });
  await local.chatReply({ ...ask, reasoningEffort: 'auto' });
  assert.equal(requests.at(-1).body.reasoning_effort, 'auto');
  await local.chatReply({ ...ask, reasoningEffort: 'none' });
  assert.equal(requests.at(-1).body.reasoning_effort, 'min');
  assert.equal(requests.at(-1).body.include_reasoning, false);
  const customNative = [];
  const customSettings = { chat_completion_source: 'custom', custom_api_format: 'gemini_generate_content', custom_model: 'gemini-4-neon' };
  const customHost = scope.__ReaderIIModules.createLlmGateway({
    host: {
      SillyTavern: { getContext: () => ({ mainApi: 'openai', chatCompletionSettings: customSettings, getRequestHeaders: () => ({}) }) },
      fetch: async (_url, options) => { customNative.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'ok' } }] }); },
    },
    hostImport: async () => ({
      oai_settings: customSettings,
      getChatCompletionModel: s => s.custom_model,
      createGenerationParameters: async (s, model, _type, messages) => ({ generate_data: { ...s, model, messages, reasoning_effort: 'min' } }),
    }),
  });
  await customHost.chatTools({ ...ask, reasoningEffort: 'auto' });
  assert.equal(customNative[0].reasoning_effort, undefined);
  assert.equal(customNative[0].custom_include_body, undefined);
  await customHost.chatTools({ ...ask, reasoningEffort: 'max', modelParameters: { extra_flag: true } });
  assert.equal(customNative[1].reasoning_effort, 'xhigh');
  assert.deepEqual(JSON.parse(customNative[1].custom_include_body), { extra_flag: true });
  customSettings.custom_api_format = 'gemini_interactions';
  await customHost.chatTools({ ...ask, reasoningEffort: 'minimal' });
  assert.equal(customNative[2].reasoning_effort, 'low');
  assert.equal(customNative[2].custom_include_body, undefined);
});

/* ---------- 流式接收（reader-llm-stream.js + 传输层 + 网关） ---------- */

const streamScope = vm.createContext({ setTimeout, clearTimeout, AbortController });
for (const path of ['reader-env.js', 'reader-llm-stream.js', 'reader-agent-transport.js', 'reader-llm-gateway.js']) {
  vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), streamScope);
}
const S = streamScope.__ReaderIIModules;
const streamGateway = S.createLlmGateway({});
const sse = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
const plainJson = (value) => JSON.parse(JSON.stringify(value));
const chatMessages = [{ role: 'user', content: '写大纲' }];
const lsTool = [{ type: 'function', function: { name: 'ls', description: '列目录', parameters: { type: 'object', properties: {} } } }];

test('SSE 组装：OpenAI 的正文、思考与多个工具调用按 index 拼接（附带签名原样保留），拼回与非流式同形状的响应', () => {
  const progress = [];
  const collector = S.llmStream.createCollector({ onProgress: (p) => progress.push({ phase: p.phase, toolName: p.toolName, textChars: p.textChars }), throttleMs: 0 });
  const text = [
    ': keep-alive\n\n',
    sse({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想' } }] }),
    sse({ choices: [{ index: 0, delta: { reasoning_content: '一想。' } }] }),
    sse({ choices: [{ index: 0, delta: { content: '我先查' } }] }),
    sse({ choices: [{ index: 0, delta: { content: '两条。' } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"wb:/书/甲"}' } },
      { index: 1, id: 'call_b', function: { name: 'draft_write', arguments: '' }, extra_content: { google: { thought_signature: 'sig-b' } } }] } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"file":"outline.md","content":"### 板块 A"}' } }] }, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { total_tokens: 42 } }),
    'data: [DONE]\n\n',
  ].join('').replace(/\n/g, '\r\n');
  /* 七个字一段地喂：段落边界会落在 \r 与 \n 之间、JSON 中间、多字节字符前后。 */
  for (let at = 0; at < text.length; at += 7) collector.write(text.slice(at, at + 7));
  const data = collector.finish();
  assert.equal(data.usage.total_tokens, 42);
  const reply = streamGateway.parseToolResponse(data);
  assert.equal(reply.text, '我先查两条。');
  assert.equal(reply.reasoning, '先想一想。');
  assert.equal(reply.finish, 'tool_calls');
  assert.deepEqual(plainJson(reply.toolCalls.map((call) => [call.id, call.name, JSON.parse(call.arguments)])),
    [['call_a', 'read', { path: 'wb:/书/甲' }], ['call_b', 'draft_write', { file: 'outline.md', content: '### 板块 A' }]]);
  assert.deepEqual(plainJson(reply.message.tool_calls[1].extra_content), { google: { thought_signature: 'sig-b' } });
  assert.equal(reply.message.reasoning_content, '先想一想。', '思考型模型的思考随工具调用带回');
  assert.ok(progress.some((p) => p.phase === 'thinking') && progress.some((p) => p.phase === 'tool' && p.toolName === 'draft_write'));
  assert.equal(collector.stats().done, true);
  /* 流里的 error 对象：带着状态码报错。 */
  const failing = S.llmStream.createCollector();
  failing.write(sse({ choices: [{ delta: { content: '写到一半' } }] }) + 'event: error\ndata: {"message":"overloaded","code":529}\n\n');
  assert.throws(() => failing.finish(), (error) => error.status === 529 && /overloaded/.test(error.message));
});

test('SSE 组装：Anthropic（thinking / text / tool_use 的 input_json）与 Gemini（thought / text / functionCall）拼回各自的原始形状', () => {
  const claude = S.llmStream.createCollector();
  [{ type: 'message_start', message: { id: 'msg1', model: 'claude-x', usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-c' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '好，' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '写草稿。' } },
    { type: 'ping' },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'draft_write', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file":"notes.md",' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"content":"笔记"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' }].forEach((evt) => claude.write('event: ' + evt.type + '\ndata: ' + JSON.stringify(evt) + '\n\n'));
  const claudeData = claude.finish();
  assert.deepEqual(plainJson([claudeData.stop_reason, claudeData.content[0].signature, claudeData.usage.output_tokens]), ['tool_use', 'sig-c', 9]);
  const claudeReply = streamGateway.parseToolResponse(claudeData);
  assert.equal(claudeReply.text, '好，写草稿。');
  assert.deepEqual(plainJson(claudeReply.toolCalls.map((call) => [call.id, call.name, JSON.parse(call.arguments)])), [['tu1', 'draft_write', { file: 'notes.md', content: '笔记' }]]);

  const gemini = S.llmStream.createCollector();
  [{ candidates: [{ content: { role: 'model', parts: [{ text: '先想', thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: '正文一' }] } }] },
    { candidates: [{ content: { parts: [{ text: '正文二' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'draft_read', args: { file: 'outline.md' } }, thoughtSignature: 'sig-g' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } }]
    .forEach((chunk) => gemini.write('data: ' + JSON.stringify(chunk) + '\r\n\r\n'));
  const geminiReply = streamGateway.parseToolResponse(gemini.finish());
  assert.equal(geminiReply.text, '正文一正文二');
  assert.deepEqual(plainJson(geminiReply.toolCalls.map((call) => [call.name, JSON.parse(call.arguments)])), [['draft_read', { file: 'outline.md' }]]);
  assert.equal(geminiReply.message.tool_calls[0].signature, 'sig-g', 'Gemini 的思考签名随调用带回');
});

test('浏览器酒馆的同源 XHR 用 onprogress 增量读 SSE：不走展示用 fetch、实时回报进度；默认与 Tauri 宿主保持整份 JSON', async () => {
  const sends = [], progress = [];
  const ctx = { getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }) };
  const host = {
    SillyTavern: { getContext: () => ctx },
    fetch: () => assert.fail('调用了展示用 fetch'),
    XMLHttpRequest: class {
      constructor() { this.headers = {}; this.responseText = ''; this.status = 0; }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(key, value) { this.headers[key] = value; }
      send(text) {
        this.body = JSON.parse(text);
        sends.push(this);
        if (!this.body.stream) {
          setTimeout(() => { this.status = 200; this.responseText = JSON.stringify({ choices: [{ message: { content: '整份' } }] }); this.onload(); }, 2);
          return;
        }
        const parts = [sse({ choices: [{ delta: { reasoning_content: '思考中' } }] }), sse({ choices: [{ delta: { content: '第一段，' } }] }),
          sse({ choices: [{ delta: { content: '第二段。' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'];
        let index = 0;
        const tick = () => {
          if (this.aborted) return;
          this.status = 200;
          if (index < parts.length) { this.responseText += parts[index++]; this.onprogress(); setTimeout(tick, 5); }
          else this.onload();
        };
        setTimeout(tick, 5);
      }
      abort() { this.aborted = true; if (this.onabort) this.onabort(); }
    },
  };
  const gateway = S.createLlmGateway({ host });
  const api = { apiurl: 'https://proxy.test/v1', key: 'k', model: 'm', source: 'openai' };
  const reply = await gateway.chatTools({ api, route: 'agent', messages: chatMessages, tools: lsTool, stream: true, onStream: (p) => progress.push(p), retries: 0, timeoutMs: 1000 });
  assert.equal(reply.text, '第一段，第二段。');
  assert.deepEqual([sends.length, sends[0].url, sends[0].body.stream, sends[0].headers['X-CSRF-Token']], [1, '/api/backends/chat-completions/generate', true, 'fixture']);
  assert.ok(progress.length >= 2 && progress[0].phase === 'thinking' && progress.at(-1).textChars === 8, '进度先是思考，最后是正文的字数');
  assert.equal(reply.stream.textChars, 8);
  /* 不要求流式时：同一条通道照旧整份 JSON。 */
  assert.equal((await gateway.chatTools({ api, route: 'agent', messages: chatMessages, tools: lsTool, retries: 0 })).text, '整份');
  assert.equal(sends[1].body.stream, false);
  /* TauriTavern 的 safeInvoke 一次性返回：要了流式也按非流式发。 */
  const invoked = [];
  const tauri = S.createLlmGateway({ host: { SillyTavern: { getContext: () => ctx }, fetch: () => assert.fail('调用了展示用 fetch'),
    __TAURITAVERN__: { invoke: { safeInvoke: async (name, args) => { invoked.push(args); return { choices: [{ message: { content: 'Tauri 整份' } }] }; } } } } });
  assert.equal((await tauri.chatTools({ api, route: 'agent', messages: chatMessages, tools: lsTool, stream: true, retries: 0 })).text, 'Tauri 整份');
  assert.equal(invoked[0].dto.stream, false);
});

/* 直连通道的流式假响应：每 30 毫秒吐一段；hang 为 true 时吐完不收尾（模拟上游卡住）。记下每次请求的 signal。 */
function pacedFetch(pieces, hang, log) {
  const enc = new TextEncoder();
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    log.push({ body, signal: init.signal });
    let timer = null;
    const stream = new ReadableStream({
      start(controller) {
        let index = 0;
        const next = () => {
          if (index < pieces.length) { controller.enqueue(enc.encode(pieces[index++])); timer = setTimeout(next, 30); }
          else if (!hang) controller.close();
        };
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          try { controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' })); } catch { /* 已经关了 */ }
        }, { once: true });
        next();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
}

test('流式空闲超时：持续有数据时超过 timeoutMs 的总时长也不误杀；真正静默超过 timeoutMs 才报 TimeoutError，带回 partialText 并真正中止请求', async () => {
  const api = { apiurl: 'https://direct.test/v1', key: 'k', model: 'm', source: 'openai' };
  const longLog = [];
  const pieces = Array.from({ length: 10 }, (_, i) => sse({ choices: [{ delta: { content: '第' + i + '段。' } }] })).concat(['data: [DONE]\n\n']);
  const steady = S.createLlmGateway({ host: { fetch: pacedFetch(pieces, false, longLog), TextDecoder } });
  const started = Date.now();
  const text = await steady.chat({ api, route: 'agent', messages: chatMessages, stream: true, timeoutMs: 80, retries: 0 });
  assert.ok(Date.now() - started > 250, '整段流式输出远超 timeoutMs');
  assert.equal(text, Array.from({ length: 10 }, (_, i) => '第' + i + '段。').join(''));
  assert.equal(longLog[0].body.stream, true);

  const line = '雨夜的旧港，钟楼的指针慢了七分钟。';
  const half = line.repeat(7);
  const stuckLog = [];
  const stuck = S.createLlmGateway({ host: { fetch: pacedFetch([sse({ choices: [{ delta: { reasoning_content: '想' } }] }), sse({ choices: [{ delta: { content: half } }] }), sse({ choices: [{ delta: { content: half } }] })], true, stuckLog), TextDecoder } });
  await assert.rejects(stuck.chat({ api, route: 'agent', messages: chatMessages, stream: true, timeoutMs: 80, retries: 2 }), (error) => {
    assert.equal(error.name, 'TimeoutError');
    assert.match(error.message, /没有收到新数据/);
    assert.equal(error.partialText, half + half);
    assert.deepEqual([error.hasToolCalls, error.streamed, error.streamStats.textChars, error.streamStats.reasoningChars], [false, true, half.length * 2, 1]);
    return true;
  });
  assert.equal(stuckLog.length, 1, '已经吐出实质正文的流式失败不从头重试');
  assert.equal(stuckLog[0].signal.aborted, true, '超时会真正中止在途的请求');
});

test('上游没理会 stream 直接回 JSON 时照常解析；上游拒绝 stream 参数时立刻改发非流式并按连接记住', async () => {
  const bodies = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) return Response.json({ choices: [{ message: { content: '上游直接回了 JSON' } }] });
    if (bodies.length === 2) return new Response(JSON.stringify({ error: { message: 'stream is not supported for this model' } }), { status: 400 });
    return Response.json({ choices: [{ message: { content: '非流式成功' } }] });
  };
  const gateway = S.createLlmGateway({ host: { fetch, TextDecoder } });
  assert.equal(await gateway.chat({ api: { apiurl: 'https://a.test/v1', model: 'm1', source: 'openai' }, route: 'agent', messages: chatMessages, stream: true, retries: 0 }), '上游直接回了 JSON');
  assert.equal(bodies[0].stream, true);
  const picky = { apiurl: 'https://b.test/v1', model: 'm2', source: 'openai' };
  assert.equal(await gateway.chat({ api: picky, route: 'agent', messages: chatMessages, stream: true, retries: 0 }), '非流式成功');
  assert.deepEqual([bodies[1].stream, bodies[2].stream], [true, false]);
  await gateway.chat({ api: picky, route: 'agent', messages: chatMessages, stream: true, retries: 0 });
  assert.equal(bodies[3].stream, false, '记住这条连接不接受 stream');
  await gateway.chat({ api: { apiurl: 'https://a.test/v1', model: 'm1', source: 'openai' }, route: 'agent', messages: chatMessages, retries: 0 });
  assert.equal(bodies[4].stream, false, '没要求流式就是原来的整份请求');
});
