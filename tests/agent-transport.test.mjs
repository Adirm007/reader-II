import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope = vm.createContext({ setTimeout, clearTimeout });
const source = readFileSync(new URL('../src/reader-agent-transport.js', import.meta.url), 'utf8');
vm.runInContext(source, scope);
const send = scope.__ReaderIIModules.sendAgentCompletion;
const body = { type: 'quiet', model: 'test', tools: [], messages: [{ role: 'user', content: 'test' }] };
const completion = { choices: [{ message: { tool_calls: [{ id: 'one', type: 'function', function: { name: 'ls', arguments: '{}' } }] } }] };

test('酒馆原生传输沿用后台鉴权、身份和取消接口，跳过展示用 fetch', async () => {
  const calls = [];
  const env = { host: {
    __TAURITAVERN__: {
      invoke: { safeInvoke: async (name, args) => { calls.push({ name, args }); return completion; } },
      api: { chat: { current: { handle: () => ({ stableId: async () => 'fixture-chat' }) } } },
    },
    navigator: { language: 'zh-CN' }, fetch: () => assert.fail('调用了展示用 fetch'),
  } };
  const dto = { ...body, chat_completion_source: 'opencode' };
  assert.deepEqual(await send(env, dto), completion);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'generate_chat_completion');
  assert.equal(calls[0].args.locale, 'zh-cn');
  assert.equal(calls[0].args.dto._tauritavern_stable_chat_id, 'fixture-chat');
  assert.equal(calls[0].args.dto.messages, body.messages);
  assert.ok(calls[0].args.requestId);
  assert.ok(!Object.hasOwn(dto, '_tauritavern_stable_chat_id'));
});

test('取消和超时只取消本次原生请求，拒绝过期结果', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const calls = [];
    let finish, indicateStart;
    const started = new Promise(resolve => { indicateStart = resolve; });
    const env = { host: { __TAURITAVERN__: { invoke: { safeInvoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'cancel_chat_completion_generation') return;
      indicateStart();
      return new Promise(resolve => { finish = resolve; });
    } } } } };
    const pending = send(env, body, controller.signal, timeout ? 20 : 0);
    await started;
    if (!timeout) controller.abort();
    await assert.rejects(pending, timeout ? /超时/ : { name: 'AbortError' });
    finish(completion);
    assert.deepEqual(calls.map(call => call.name), ['generate_chat_completion', 'cancel_chat_completion_generation']);
    assert.equal(calls[0].args.requestId, calls[1].args.requestId);
    await assert.rejects(send(env, body, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(calls.length, 2);
  }
});

test('Tauri safeInvoke 的拒绝保留命令错误的状态，授权取消直接结束', async () => {
  const envFor = cause => ({ host: { __TAURITAVERN__: { invoke: { safeInvoke: async () => {
    throw Object.assign(new Error(Object.values(cause)[0]), { cause });
  } } } } });
  await assert.rejects(send(envFor({ BadRequest: 'unknown parameter tools' }), body),
    err => err.status === 400 && /unknown parameter tools/.test(err.message));
  await assert.rejects(send(envFor({ Cancelled: 'Endpoint authorization cancelled by user' }), body), { name: 'AbortError' });
});

function makeBrowser(handle) {
  const sends = [];
  const host = { SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }) }) },
    fetch: () => assert.fail('调用了展示用 fetch'),
    XMLHttpRequest: class {
      constructor() { this.headers = {}; }
      open(method, url, async) { Object.assign(this, { method, url, async }); }
      setRequestHeader(key, value) { this.headers[key] = value; }
      send(text) { this.body = JSON.parse(text); sends.push(this); handle(this); }
      abort() { this.aborted = true; this.onabort?.(); }
    },
  };
  return { env: { host }, sends };
}

test('浏览器使用同源 XHR、酒馆请求头和原始 JSON 响应', async () => {
  const { env, sends } = makeBrowser(xhr => {
    xhr.status = 200; xhr.responseText = JSON.stringify(completion); xhr.onload();
  });
  assert.equal(JSON.stringify(await send(env, body)), JSON.stringify(completion));
  assert.equal(sends.length, 1);
  const [xhr] = sends;
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/backends/chat-completions/generate');
  assert.equal(xhr.headers['X-CSRF-Token'], 'fixture');
  assert.deepEqual(xhr.body, body);
});

test('HTTP 错误保留状态和提供方消息，普通请求可取消，无隔离通道返回 null', async () => {
  const rejected = makeBrowser(xhr => {
    xhr.status = 422; xhr.responseText = '{"error":{"message":"unknown parameter tools"}}'; xhr.onload();
  });
  await assert.rejects(send(rejected.env, body), err => err.status === 422 && /unknown parameter tools/.test(err.message));
  assert.equal(rejected.sends.length, 1);
  const controller = new AbortController();
  let indicateStart;
  const started = new Promise(resolve => { indicateStart = resolve; });
  const hanging = makeBrowser(() => indicateStart());
  const pending = send(hanging.env, body, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(hanging.sends[0].aborted);
  assert.equal(send({ host: { fetch() {} } }, body), null);
});
