import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('文本接口按宿主字段补入缺段，保留 Erato 起始标记和最后一行预填充', async () => {
  const sandbox = vm.createContext({ console, setTimeout, clearTimeout });
  for (const name of ['reader-prompt-placement', 'reader-prompt']) {
    const file = new URL('../src/' + name + '.js', import.meta.url);
    vm.runInContext(readFileSync(file, 'utf8'), sandbox);
  }
  const modules = sandbox.__ReaderIIModules;
  modules.READER_PROMPT_TEMPLATES = { core: () => '来自夜梦的提示词' };
  const handlers = new Map();
  const source = {
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    removeListener(event, fn) { handlers.set(event, handlers.get(event).filter(item => item !== fn)); },
    async emit(event, ...args) { for (const fn of handlers.get(event) || []) await fn(...args); },
  };
  const events = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_AFTER_DATA', 'GENERATION_ENDED', 'WORLDINFO_ENTRIES_LOADED'];
  const ctx = { eventTypes: Object.fromEntries(events.map(event => [event, event])), eventSource: source, chat: [], extensionSettings: {} };
  const api = { kit: { chatKey: () => 'text-provider' }, isEnabled: () => true };
  const runtime = modules.createPromptRuntime(api, { host: {}, context: () => ctx, getVariables: () => ({}) });
  const start = '<|startoftext|><|reserved_special_token81|>';
  const story = '城门刚开。\n叙述者：';
  try {
    await source.emit('GENERATION_STARTED', 'normal', {}, false);
    await source.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    for (const [field, prefix] of [['input', start], ['input', ''], ['prompt', '']]) {
      const body = { [field]: prefix + story, model: 'test' };
      await source.emit('GENERATE_AFTER_DATA', body, true);
      assert.equal(body[field], prefix + story);
      await source.emit('GENERATE_AFTER_DATA', body, false);
      await source.emit('GENERATE_AFTER_DATA', body, false);
      assert.deepEqual(body, { [field]: prefix + '来自夜梦的提示词\n\n' + story, model: 'test' });
    }
    ctx.powerUserSettings = { instruct: { enabled: true, story_string_prefix: '<turn:{{name}}>', wrap: true } };
    const instruct = { prompt: '<turn:System>\n' + story + '</turn>\n<turn:assistant>' };
    await source.emit('GENERATE_AFTER_DATA', instruct, false);
    assert.equal(instruct.prompt, '<turn:System>\n来自夜梦的提示词\n\n' + story + '</turn>\n<turn:assistant>');
    await source.emit('GENERATION_ENDED');
    const independent = { input: start + story };
    await source.emit('GENERATE_AFTER_DATA', independent, false);
    assert.equal(independent.input, start + story);
  } finally {
    runtime.dispose();
  }
});
