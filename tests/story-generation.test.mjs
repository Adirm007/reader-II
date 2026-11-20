import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const names = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'WORLDINFO_ENTRIES_LOADED', 'GENERATE_AFTER_DATA',
  'CHAT_COMPLETION_SETTINGS_READY', 'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_COMBINE_PROMPTS',
  'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED'];
const example = '<READER_FP_EVENT>{"event_id":"example"}</READER_FP_EVENT>';
function story(config = {}, { legacy = false } = {}) {
  const sandbox = vm.createContext({ setTimeout, clearTimeout, console });
  for (const name of ['reader-prompt-placement', 'reader-prompt']) {
    vm.runInContext(readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8'), sandbox);
  }
  const modules = sandbox.__ReaderIIModules;
  modules.READER_PROMPT_TEMPLATES = {
    core: (host) => '夜梦开场。上条正文=' + host.getChatMessage(-1, 'assistant') + '；本轮=' + host.getChatMessage(-1, 'user') + '\n' + example,
    rules: () => '专用更新规则', list: () => '专用变量列表',
  };
  const listeners = new Map();
  const eventSource = {
    on(name, handler) { listeners.set(name, [...(listeners.get(name) || []), handler]); },
    makeLast(name, handler) { this.on(name, handler); },
    removeListener(name, handler) { listeners.set(name, (listeners.get(name) || []).filter(fn => fn !== handler)); },
    async emit(name, ...args) { for (const fn of listeners.get(name) || []) await fn(...args); },
  };
  const prompts = {};
  const ctx = {
    chat: [{ mes: '第一楼' }, { mes: '用户输入', is_user: true }, { mes: '不要的旧回答' }],
    chatId: 'A', chatMetadata: {}, extensionSettings: { reader_ii: { storyPromptPlacement: config } },
    mainApi: 'openai', setExtensionPrompt(id, text) { prompts[id] = text; },
    eventSource, eventTypes: Object.fromEntries(names.filter(n => !legacy || n !== 'WORLDINFO_ENTRIES_LOADED').map(name => [name, name])),
  };
  const api = { kit: { chatKey: () => ctx.chatId }, isEnabled: () => true };
  const runtime = modules.createPromptRuntime(api, { context: () => ctx, host: {}, getVariables: () => ({}) });
  return { ctx, api, prompts, runtime, emit: eventSource.emit.bind(eventSource), on: eventSource.on.bind(eventSource) };
}

test('正文钩子内的后台总结与试算各自组装，完成后原重掷继续，结束后无残留', async () => {
  for (const quietRaisesEnd of [true, false]) {
    const h = story();
    try {
      await h.emit('GENERATION_AFTER_COMMANDS', 'swipe', {}, false);
      await h.emit('GENERATION_STARTED', 'quiet', {}, false);
      await h.emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false);
      // A token-count preview inside the quiet request finishes without GENERATION_ENDED.
      await h.emit('GENERATION_STARTED', 'normal', {}, true);
      await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true);
      for (const dryRun of [true, false]) {
        const auxLore = { characterLore: [] };
        await h.emit('WORLDINFO_ENTRIES_LOADED', auxLore);
        assert.equal(auxLore.characterLore.length, 0);
        const data = { prompt: '辅助请求' };
        await h.emit('GENERATE_AFTER_DATA', data, dryRun);
        assert.equal(data.prompt, '辅助请求');
      }
      const quiet = { type: 'quiet', messages: [] };
      await h.emit('CHAT_COMPLETION_SETTINGS_READY', quiet);
      assert.equal(quiet.messages.length, 0);
      if (quietRaisesEnd) await h.emit('GENERATION_ENDED', h.ctx.chat.length);

      const storyLore = { characterLore: [] };
      await h.emit('WORLDINFO_ENTRIES_LOADED', storyLore);
      assert.equal(storyLore.characterLore.length, 3);
      assert.deepEqual(Array.from(storyLore.characterLore[0].triggers), ['swipe']);
      const storyData = { type: 'swipe', prompt: [] };
      await h.emit('GENERATE_AFTER_DATA', storyData, false);
      assert.match(storyData.prompt.map(x => x.content).join('\n'), /上条正文=第一楼/);
      await h.emit('GENERATION_ENDED');
      const after = { type: 'swipe', messages: [] };
      await h.emit('CHAT_COMPLETION_SETTINGS_READY', after);
      assert.equal(after.messages.length, 0);
    } finally { h.runtime.dispose(); }
  }
});

test('旧宿主在实际删楼、写入新用户输入后更新扩展提示词，后台总结暂时移除旧式注入', async () => {
  const h = story({ list: { position: 5 } }, { legacy: true });
  try {
    await h.emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    h.ctx.chat.pop();
    await h.emit('MESSAGE_DELETED', h.ctx.chat.length);
    assert.match(h.prompts.reader_ii_core, /上条正文=第一楼/);
    assert.doesNotMatch(h.prompts.reader_ii_core, /不要的旧回答/);
    assert.equal(h.prompts.reader_ii_list, '', '旧扩展位置无法表达示例之前，留给最终聊天定位');
    const data = { type: 'regenerate', messages: [{ role: 'system', name: 'example_user', content: '示例' }, { role: 'user', content: '正文' }] };
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    assert.ok(data.messages.findIndex(x => x.content === '专用变量列表') < data.messages.findIndex(x => x.content === '示例'));
    await h.emit('GENERATION_ENDED');
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    h.ctx.chat.push({ is_user: true, mes: '新的用户输入' });
    await h.emit('MESSAGE_SENT', h.ctx.chat.length - 1);
    const latest = h.prompts.reader_ii_core;
    assert.match(latest, /本轮=新的用户输入/);
    await h.emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false);
    assert.equal(h.prompts.reader_ii_core, '');
    await h.emit('GENERATION_ENDED');
    assert.equal(h.prompts.reader_ii_core, latest);
    await h.emit('GENERATION_ENDED');
    assert.equal(h.prompts.reader_ii_core, '');
  } finally { h.runtime.dispose(); }
});

test('后台请求异常提前返回或在正文流式输出期间结束，正文最终请求和清理均正确', async () => {
  const h = story();
  try {
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false);
    // The host can return early when a provider is offline, without a quiet ENDED event.
    const story = { type: 'normal', messages: [] };
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', story);
    assert.ok(story.messages.some(x => x.content.includes('夜梦开场')));
    // Conversely, the streaming host may suppress a successful nested quiet request's ENDED.
    await h.emit('GENERATION_AFTER_COMMANDS', 'quiet', {}, false);
    await h.emit('GENERATE_AFTER_DATA', { prompt: [] }, false);
    await h.emit('GENERATION_ENDED');
    const after = { type: 'normal', messages: [] };
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', after);
    assert.equal(after.messages.length, 0);
  } finally { h.runtime.dispose(); }
});

test('删除/换预设后重新渲染；原生世界书、合并消息、最终工具协议均只收到一份', async () => {
  const h = story();
  try {
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const first = { characterLore: [] };
    await h.emit('WORLDINFO_ENTRIES_LOADED', first);
    assert.match(first.characterLore[0].content, /不要的旧回答/);
    await h.emit('GENERATION_ENDED');
    // Register two different preset processors *after* Reader has loaded.
    const prefill = { role: 'assistant', content: '正文：' };
    const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 'request', type: 'function', function: { name: 'context', arguments: '{}' } }] };
    const toolReply = { role: 'tool', tool_call_id: 'request', content: '格式保持 ' + example };
    h.on('GENERATE_AFTER_DATA', data => { data.prompt = [{ role: 'user', content: '重排后的正文槽' }, toolCall, toolReply, prefill]; });
    h.on('CHAT_COMPLETION_SETTINGS_READY', data => {
      if (data.type === 'regenerate') data.messages = data.messages.filter(msg => msg.content !== '专用更新规则');
    });
    await h.emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    // ST deletes the rejected answer between these two events.
    h.ctx.chat.pop();
    const current = { characterLore: [{ world: '角色卡', uid: 0, content: '既有条目' }] };
    await h.emit('WORLDINFO_ENTRIES_LOADED', current);
    await h.emit('WORLDINFO_ENTRIES_LOADED', current);
    assert.equal(current.characterLore.length, 4);
    const output = current.characterLore.slice(1).map(entry => entry.content);
    assert.match(output[0], /上条正文=第一楼；本轮=用户输入/);
    const native = [{ role: 'system', content: output.join('\n') }, { role: 'assistant', content: '原正文' + example }, toolReply];
    await h.emit('CHAT_COMPLETION_PROMPT_READY', { chat: native });
    assert.equal(native[0].content, output.join('\n'));
    assert.equal(native[1].content, '原正文');
    assert.equal(toolReply.content, '格式保持 ' + example);

    const shaped = { prompt: native };
    await h.emit('GENERATE_AFTER_DATA', shaped, false);
    const request = { type: 'regenerate', messages: shaped.prompt, tools: [{ function: { name: 'context' } }] };
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', request);
    const all = request.messages.map(x => x.content).join('\n');
    for (const section of output) assert.equal(all.split(section).length, 2);
    assert.equal(request.messages.at(-1), prefill);
    assert.equal(request.messages[request.messages.indexOf(toolCall) + 1], toolReply);
    assert.equal(request.tools[0].function.name, 'context');
  } finally { h.runtime.dispose(); }
});

test('swipe 按有效历史取值；深度角色、已关闭条目及无出口的条目遵守设置', async () => {
  const h = story({ core: { position: 4, depth: 1, role: 1 }, list: { enabled: false }, rules: { position: 7, outletName: 'reader' } });
  try {
    await h.emit('GENERATION_AFTER_COMMANDS', 'swipe', {}, false);
    const lore = { characterLore: [] };
    await h.emit('WORLDINFO_ENTRIES_LOADED', lore);
    assert.equal(lore.characterLore.length, 2);
    assert.match(lore.characterLore[0].content, /上条正文=第一楼/);
    const data = { type: 'swipe', messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '提问' }] };
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', data);
    assert.deepEqual(data.messages.map(m => m.role), ['system','user','user']);
    assert.equal(data.messages[1].content, lore.characterLore[0].content);
    const txt = { prompt: '系统和正文\n助手：' };
    await h.emit('GENERATE_AFTER_DATA', txt, false);
    assert.equal(txt.prompt, lore.characterLore[0].content + '\n\n系统和正文\n助手：');
  } finally { h.runtime.dispose(); }
});

test('quiet/raw 请求、试算、生成结束或停用、切换聊天均不回补旧正文', async () => {
  const h = story();
  try {
    const raw = { messages: [{ role: 'user', content: '单独助手' }], type: 'quiet' };
    await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', raw);
    assert.equal(raw.messages.length, 1);
    const request = { prompt: '独立请求' };
    await h.emit('GENERATE_AFTER_DATA', request, true);
    assert.equal(request.prompt, '独立请求');
    h.ctx.chatId = 'B';
    await h.emit('GENERATE_AFTER_DATA', request, false);
    assert.equal(request.prompt, '独立请求');
    h.api.isEnabled = () => false;
    await h.emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    await h.emit('GENERATE_AFTER_DATA', request, false);
    assert.equal(request.prompt, '独立请求');
    h.api.isEnabled = () => true;
    for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'GENERATION_ENDED']) {
      await h.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
      await h.emit(name);
      await h.emit('GENERATE_AFTER_DATA', request, false);
      assert.equal(request.prompt, '独立请求');
    }
  } finally { h.runtime.dispose(); }
});
