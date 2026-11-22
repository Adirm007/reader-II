import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extBundle } from '../build.mjs';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundleCode = extBundle('4.1.0-test');

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}

function createCoexistWorld({
  nativeReaderRuntime = false,
  chatVariables = {},
  statData = {},
  messages = [],
  mvuEvents = null,
} = {}) {
  const listeners = new Map();
  const docListeners = new Map();
  const hostListeners = new Map();
  const prompts = {};
  const injected = new Map();
  const storage = new Map();
  const domNodes = new Map([
    ['dfb', { id: 'dfb', removed: false, remove() { this.removed = true; } }],
    ['dlb-overlay', { id: 'dlb-overlay', removed: false, remove() { this.removed = true; } }],
    ['bs-overlay', { id: 'bs-overlay', removed: false, remove() { this.removed = true; } }],
  ]);
  const nativeOpens = [];
  const nativeReader = {
    isAlive: true,
    canOwnEnvelope: true,
    open(page) { nativeOpens.push(page); return true; },
    stop() { throw new Error('native ReaderCore.stop() must NEVER be called by reader-II'); },
  };
  let mvuData = { stat_data: structuredClone(statData) };
  const chat = messages.length ? structuredClone(messages) : [
    { is_user: false, mes: '<dream>原版读者的来信</dream>', swipe_id: 0 },
    { is_user: true, mes: '继续。', swipe_id: 0 },
  ];
  const eventTypes = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    WORLDINFO_UPDATED: 'worldinfo_updated',
  };
  const eventSource = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    makeFirst(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).unshift(fn);
    },
    makeLast(name, fn) { this.on(name, fn); },
    removeListener(name, fn) {
      const list = listeners.get(name);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    async emit(name, ...args) {
      for (const fn of [...(listeners.get(name) || [])]) await fn(...args);
    },
  };
  const chatMetadata = { variables: structuredClone(chatVariables) };
  const card = { name: '命定之诗', avatar: 'destiny.png', data: { extensions: {} } };
  const tavernContext = {
    chat,
    chatMetadata,
    saveMetadata() {},
    saveChat: async () => {},
    getCurrentChatId: () => 'chat-coexist-1',
    characterId: '0',
    characters: [card],
    name1: '作家',
    name2: '命定之诗',
    eventSource,
    eventTypes,
    extensionSettings: {},
    saveSettingsDebounced() {},
    setExtensionPrompt(id, text, position, depth) { prompts[id] = { text, position, depth }; },
    substituteParams: (t) => String(t).replace(/<user>/g, '作家'),
  };
  const document = {
    documentElement: { getAttribute: () => 'cafe' },
    body: { appendChild() {}, querySelectorAll: () => [] },
    head: { appendChild() {} },
    getElementById: (id) => domNodes.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {} }),
    addEventListener(name, fn) {
      if (!docListeners.has(name)) docListeners.set(name, []);
      docListeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const list = docListeners.get(name);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      for (const fn of [...(docListeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
  };
  const host = {
    document,
    SillyTavern: { getContext: () => tavernContext },
    CustomEvent: FakeEvent,
    Event: FakeEvent,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    addEventListener(name, fn) {
      if (!hostListeners.has(name)) hostListeners.set(name, []);
      hostListeners.get(name).push(fn);
    },
    removeEventListener(name, fn) {
      const list = hostListeners.get(name);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      for (const fn of [...(hostListeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    URL,
    Blob,
    Response,
    TextEncoder,
    TextDecoder,
    DecompressionStream,
    atob,
    btoa,
    structuredClone,
  };
  if (nativeReaderRuntime) host.ReaderCore = nativeReader;
  if (mvuEvents) {
    host.Mvu = {
      events: mvuEvents,
      getMvuData: () => structuredClone(mvuData),
      replaceMvuData: async (next) => { mvuData = structuredClone(next); },
    };
  }
  host.TavernHelper = {
    getVariables: (opts) => {
      if (opts && opts.type === 'chat') return chatMetadata.variables;
      if (opts && opts.type === 'global') return {};
      return structuredClone(mvuData);
    },
    replaceVariables: async (next) => { mvuData = structuredClone(next); },
    getChatMessages: (range) => {
      const idx = Number(range);
      if (Number.isInteger(idx) && chat[idx]) {
        return [{ message_id: idx, role: chat[idx].is_user ? 'user' : 'assistant', message: chat[idx].mes }];
      }
      return chat.map((m, i) => ({ message_id: i, role: m.is_user ? 'user' : 'assistant', message: m.mes }));
    },
    injectPrompts: async (list) => {
      for (const item of list) injected.set(item.id, item);
    },
    uninjectPrompts: async (ids) => {
      for (const id of ids) injected.delete(id);
    },
  };
  host.window = host;
  host.parent = host;
  host.globalThis = host;
  const ctx = vm.createContext(host);
  vm.runInContext(bundleCode, ctx, { filename: 'dist/reader-ii.ext.js' });
  return {
    host,
    ctx,
    eventSource,
    eventTypes,
    domNodes,
    nativeReader,
    nativeOpens,
    prompts,
    injected,
    chat,
    chatMetadata,
    getMvuData: () => mvuData,
  };
}

test('reader + reader-II coexistence: yields prompt/DOM/MVU to native reader while keeping Agent & memory.unify active', async () => {
  const mvuEvents = {
    VARIABLE_INITIALIZED: 'mvu_init',
    VARIABLE_UPDATE_STARTED: 'mvu_start',
    VARIABLE_UPDATE_ENDED: 'mvu_end',
    BEFORE_MESSAGE_UPDATE: 'mvu_before',
  };
  const world = createCoexistWorld({
    nativeReaderRuntime: true,
    chatVariables: { 系统核心: '九十九夜梦', dream_persona: 'reader' },
    statData: { 事件: { 进度: 2 }, 命运点数: 500 },
    mvuEvents,
  });

  const core = world.host.__ReaderIICore;
  const api = world.host.ReaderII;
  assert.ok(core && core.__reader_core_api === true, '__ReaderIICore exposed');
  assert.equal(world.host.ReaderCore, world.nativeReader, 'native host.ReaderCore must NOT be clobbered');
  assert.equal(core.isCoexisting(), true, 'coexistence detected');
  assert.equal(core.isEnabled(), false, 'reader-II story core yields when coexisting');

  // Native reader DOM elements must stay completely untouched
  for (const id of ['dfb', 'dlb-overlay', 'bs-overlay']) {
    assert.equal(world.domNodes.get(id).removed, false, `native DOM #${id} must not be deleted`);
  }

  // MVU guard must NOT inject stat_data.READER into Destined-Poem-Card's stat_data
  const cardVars = { stat_data: { 事件: { 进度: 2 }, 命运点数: 500 } };
  await world.eventSource.emit(mvuEvents.VARIABLE_INITIALIZED, cardVars);
  assert.equal(cardVars.stat_data.READER, undefined, 'reader-II MVU guard must not pollute native card stat_data');

  // Prompt runtime must NOT inject duplicate prompts or rewrite native <dream> tags
  const rendered = await core.prompt.render('normal');
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)), { core: '', rules: '', list: '' });
  const rawDream = '<dream>原版信件</dream>';
  assert.equal(core.prompt.formatForDisplay(rawDream, { messageId: 0 }), rawDream);

  // Lobby helper in coexistence mode delegates back to native reader's eggs page
  assert.equal(api.lobby.isCoexisting(), true);
  assert.equal(api.lobby.hasNativeLobby(), true);
  assert.equal(api.lobby.openNativeLobby('eggs'), true);
  assert.deepEqual(world.nativeOpens, ['eggs']);

  // 「助手夜梦 = 正文夜梦」 (memory.unify) MUST STILL WORK in coexistence mode!
  await api.memory.add({
    type: 'fact',
    title: '约定的红茶',
    content: '用户在助手聊天里提到最喜欢伯爵红茶。',
    pinned: true,
    enabled: true,
    store: 'chat',
  });
  api.memory.saveSettings({ enabled: true, unify: true });
  const memBlock = await api.memory.refreshInjection('随便聊聊');
  assert.match(memBlock.text, /<夜之洋的记忆>/, 'memory.unify injects into story in coexistence mode');
  assert.match(memBlock.text, /约定的红茶/);
  const memId = api.memory.injectId;
  const injectedMem = world.prompts[memId]?.text || world.injected.get(memId)?.content || '';
  assert.match(injectedMem, /<夜之洋的记忆>/, 'reader-ii-memory prompt injected via host kit');

  core.dispose();
  await api.dispose();
});

test('reader-II passively detects native DREAM_WORLDBOOK via WORLDINFO_ENTRIES_LOADED before injecting', async () => {
  const world = createCoexistWorld({
    nativeReaderRuntime: false,
    chatVariables: {},
    statData: { 命运点数: 100 },
  });
  const core = world.host.__ReaderIICore;
  assert.equal(core.isCoexisting(), false);
  assert.equal(core.isEnabled(), true);

  await world.eventSource.emit(world.eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
  const payload = {
    globalLore: [],
    characterLore: [
      { comment: '读者核心本体', content: '<%_ /* DREAM_WORLDBOOK reader-core v2026.11.22.1 */ _%>...', disable: false },
    ],
  };
  await world.eventSource.emit(world.eventTypes.WORLDINFO_ENTRIES_LOADED, payload);
  assert.equal(core.isCoexisting(), true, 'detected DREAM_WORLDBOOK from loaded worldinfo');
  assert.equal(core.isEnabled(), false, 'immediately yielded before reader-prompt injected');
  assert.equal(payload.characterLore.length, 1, 'reader-II did NOT append duplicate core/rules/list entries');

  core.dispose();
  await world.host.ReaderII.dispose();
});

test('reader-II Black Author events: kuromaku_kill (+1 once/turn), kuromaku_ending (killed removes 祝福, confessed keeps 祝福), and rollback', async () => {
  const world = createCoexistWorld({
    nativeReaderRuntime: false,
    chatVariables: { dream_persona: 'kuromaku' },
    statData: {
      READER: {
        地点: '旅店',
        关系列表: {},
        任务列表: {},
        主角: {
          技能: { '间章:小憩': {}, 故事的主人: {} },
          状态效果: {
            祝福: { 类型: '特殊', 效果: '造成的最终伤害+45%，受到的全类型伤害-45%，经验获取+45%', 层数: 1, 剩余时间: '永久', 来源: '少女的祝福' },
          },
        },
        命运点数: 200,
        进度: 8,
      },
    },
    messages: [
      { is_user: true, mes: '继续。', swipe_id: 0 },
      {
        is_user: false,
        mes: '悲剧降临。<READER_ACTION_EVENT>{"event_id":"k1","action":"kuromaku_kill"}</READER_ACTION_EVENT><READER_ACTION_EVENT>{"event_id":"k2","action":"kuromaku_kill"}</READER_ACTION_EVENT>',
        swipe_id: 0,
      },
    ],
  });
  const core = world.host.__ReaderIICore;
  await core.ready();

  // Two kuromaku_kill tags in one turn only advance progress by +1
  await core.processMessageEvents(1);
  let state = await core.getState();
  assert.equal(state.进度, 9, 'progress increments only +1 per kill turn');
  assert.equal(state.黑幕已点杀, true, '黑幕已点杀 marked true');

  // Edit message 1 to remove kill event -> cleanly rolls back progress & 黑幕已点杀
  world.chat[1].mes = '改成普通回合。';
  await core.processMessageEvents(1);
  state = await core.getState();
  assert.equal(state.进度, 8, 'rollback restores progress to 8');
  assert.equal(state.黑幕已点杀, undefined, 'rollback restores 黑幕已点杀');

  // Re-apply kill to reach 9, then apply killed ending -> removes 祝福!
  world.chat[1].mes = '点杀。<READER_ACTION_EVENT>{"event_id":"k3","action":"kuromaku_kill"}</READER_ACTION_EVENT>';
  await core.processMessageEvents(1);
  world.chat.push({
    is_user: false,
    mes: '「是啊，就是会这样嘛…」<READER_ACTION_EVENT>{"event_id":"end1","action":"kuromaku_ending","ending":"killed"}</READER_ACTION_EVENT>',
    swipe_id: 0,
  });
  await core.processMessageEvents(2);
  state = await core.getState();
  assert.equal(state.黑幕结局, 'killed');
  assert.equal(state.主角.状态效果.祝福, undefined, 'killed ending removes 祝福 status');

  // After killed ending, resurrection grants +200FP without advancing 进度
  world.chat.push({
    is_user: false,
    mes: '复活。<READER_FP_EVENT>{"event_id":"rev1","source":"reader_owned","category":"resurrection","persona":"kuromaku","evidence":"复活"}</READER_FP_EVENT>',
    swipe_id: 0,
  });
  await core.processMessageEvents(3);
  state = await core.getState();
  assert.equal(state.命运点数, 400);
  assert.equal(state.进度, 9, 'resurrection after ending does not advance 进度');

  // Edit message 2 from killed to confessed -> rolls back killed (restoring 祝福!) and sets confessed!
  world.chat[2].mes = '折断匕首。<READER_ACTION_EVENT>{"event_id":"end2","action":"kuromaku_ending","ending":"confessed"}</READER_ACTION_EVENT>';
  await core.processMessageEvents(2);
  state = await core.getState();
  assert.equal(state.黑幕结局, 'confessed');
  assert.ok(state.主角.状态效果.祝福, 'rolling back killed ending restores 祝福 and confessed keeps it');

  core.dispose();
  await world.host.ReaderII.dispose();
});
