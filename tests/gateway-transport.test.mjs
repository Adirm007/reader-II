import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = vm.createContext({ setTimeout, clearTimeout });
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
