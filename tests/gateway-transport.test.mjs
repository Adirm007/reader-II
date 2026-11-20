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
