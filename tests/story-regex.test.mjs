import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('预设改写或删除世界书段落后，最终重排保留处理结果，缺失的段落只恢复一次', async () => {
  const sandbox = vm.createContext({ console, setTimeout, clearTimeout });
  for (const file of ['reader-prompt-placement', 'reader-prompt']) {
    vm.runInContext(fs.readFileSync(new URL('../src/' + file + '.js', import.meta.url), 'utf8'), sandbox);
  }
  const sample = '<READER_FP_EVENT>{"event_id":"example"}</READER_FP_EVENT>';
  const core = '<intro>待展开角色：开场示例 ' + sample + '</intro>';
  const modules = sandbox.__ReaderIIModules;
  modules.READER_PROMPT_TEMPLATES = { core: () => core, list: () => '变量列表', rules: () => '只靠预设显示的规则' };
  const hooks = new Map();
  const names = ['GENERATION_AFTER_COMMANDS','WORLDINFO_ENTRIES_LOADED','WORLD_INFO_ACTIVATED',
    'CHAT_COMPLETION_PROMPT_READY','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY','GENERATION_ENDED'];
  const ctx = { chat: [], chatMetadata: {}, extensionSettings: {}, eventTypes: Object.fromEntries(names.map(k=>[k,k])),
    eventSource: {
      on(k,fn) { hooks.set(k, [...(hooks.get(k) || []), fn]); },
      removeListener(k,fn) { hooks.set(k,(hooks.get(k) || []).filter(x=>x!==fn)); }
    } };
  async function emit(k, ...args) { for (const fn of hooks.get(k) || []) await fn(...args); }
  const calls = [];
  function regex(text) {
    return text.replace(/<\/?intro>/g, '').replace('变量列表','列表已排版').replace('只靠预设显示的规则','');
  }
  const presetRules = [];
  const engine = { regex_placement: { WORLD_INFO: 5 }, getRegexScripts: () => presetRules,
    runRegexScript(rule, text) {
      assert.ok(!rule.replaceString.includes('{{'), '不能执行有副作用的宏');
      return text.replace(new RegExp(rule.findRegex.slice(1, -1), 'g'), rule.replaceString);
    },
    getRegexedString(text, where, options) {
      calls.push([where,options.depth,options.isMarkdown,options.isPrompt]);
      return regex(text);
    } };
  const runtime = modules.createPromptRuntime({ kit: { chatKey: () => 'A' }, isEnabled: () => true }, {
    context: () => ctx, host: {}, getVariables: () => ({}),
    hostImport: async path => { assert.equal(path, '/scripts/extensions/regex/engine.js'); return engine; },
  });
  try {
    await emit('GENERATION_AFTER_COMMANDS', 'swipe', {}, false);
    const wi = {characterLore: []};
    await emit('WORLDINFO_ENTRIES_LOADED', wi);
    const activated = wi.characterLore.map(e=>({...e, content: e.content.replace('待展开角色', '本轮角色')}));
    const nativeCore = regex(activated.find(e=>e.position===0).content);
    await emit('WORLD_INFO_ACTIVATED', activated);
    const chat = [
      {role:'system',content:nativeCore},
      {role:'assistant',content:'旧正文' + sample},
      {role:'user',content:'本轮输入'},
    ];
    await emit('CHAT_COMPLETION_PROMPT_READY', {chat});
    assert.equal(chat[0].content, nativeCore);
    assert.equal(chat[1].content, '旧正文');
    const tool={role:'tool',tool_call_id:'qa',content:'独立工具结果'};
    const shaped = {prompt:[{role:'user',content:[{type:'text',text:'折叠的正文 ' + nativeCore}]}, tool]};
    await emit('GENERATE_AFTER_DATA', shaped, false);
    const data = {messages:shaped.prompt, type:'swipe', tools:[{type:'function',function:{name:'qa'}}]};
    await emit('CHAT_COMPLETION_SETTINGS_READY',data);
    const text = JSON.stringify(data.messages);
    assert.equal(text.split('本轮角色').length, 2);
    assert.equal(text.split('列表已排版').length, 2);
    assert.doesNotMatch(text, /<intro>|待展开角色|变量列表|只靠预设显示的规则/);
    assert.ok(data.messages.includes(tool));
    assert.equal(data.tools[0].function.name,'qa');
    assert.deepEqual(calls.sort((a,b)=>(a[1]??-1)-(b[1]??-1)),[[5,null,false,true],[5,1,false,true],[5,4,false,true]]);
    // A later preset can drop the whole core. Restore the rendered variant, preserving its regex.
    data.messages = [{role:'user',content:'独立重排'},tool];
    await emit('CHAT_COMPLETION_SETTINGS_READY',data);
    assert.equal(data.messages[0].content,nativeCore);
    assert.equal(calls.length,3);

    await emit('GENERATION_ENDED');
    await emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await emit('WORLDINFO_ENTRIES_LOADED', { characterLore: [] });
    // This separate preset's replacement writes a chat variable in the native host.
    presetRules.push({ placement: [5], promptOnly: true, findRegex: '/本轮角色/', replaceString: '本轮开场' },
      { placement: [5], promptOnly: true, findRegex: '/本轮开场|只靠预设显示的规则/', replaceString: '{{incvar::count}}' });
    await emit('WORLD_INFO_ACTIVATED', activated);
    const oldEvent = '<READER_FP_EVENT>{"event_id":"old"}</READER_FP_EVENT>';
    ctx.chat = [{mes:'实际聊天' + oldEvent}];
    const nativeDynamic = [{role:'system',content:'由一次性宏得到的文本' + sample},
      {role:'system',content:'变量列表'}, {role:'user',content:'实际聊天' + oldEvent}];
    await emit('CHAT_COMPLETION_PROMPT_READY', {chat:nativeDynamic});
    assert.equal(nativeDynamic[0].content, '由一次性宏得到的文本' + sample);
    assert.equal(nativeDynamic[2].content, '实际聊天');
    const dynamicRequest = { type:'normal', messages:nativeDynamic.filter(m => m.content !== '变量列表') };
    await emit('CHAT_COMPLETION_SETTINGS_READY', dynamicRequest);
    assert.equal(dynamicRequest.messages.filter(m=>m.content === '变量列表').length,1);
    assert.equal(dynamicRequest.messages.length,3);
    assert.equal(calls.length,3,'含写入宏的世界书正则只由酒馆执行一次');

    await emit('GENERATION_ENDED');
    await emit('GENERATION_AFTER_COMMANDS', 'regenerate', {}, false);
    await emit('WORLDINFO_ENTRIES_LOADED', {characterLore: []});
    presetRules.splice(0, presetRules.length,
      {placement: [5], promptOnly: true, findRegex: '/天气/', replaceString: '{{getvar::天气}}'});
    await emit('WORLD_INFO_ACTIVATED', activated);
    const missingWorldSlot = {type: 'regenerate', messages: [{role:'user', content:'这份预设省略了角色定义前条目'}]};
    await emit('CHAT_COMPLETION_SETTINGS_READY', missingWorldSlot);
    assert.equal(missingWorldSlot.messages[0].content, core.replace('待展开角色','本轮角色'));
    assert.doesNotMatch(JSON.stringify(missingWorldSlot), /ReaderII_regex_probe|{{getvar/);
  } finally { runtime.dispose(); }
});
