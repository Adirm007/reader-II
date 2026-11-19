import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = vm.createContext({ setTimeout, clearTimeout });
for (const path of ['reader-env.js', 'reader-llm-gateway.js']) {
  vm.runInContext(readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'), scope);
}
const gateway = scope.__ReaderIIModules.createLlmGateway({});

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
