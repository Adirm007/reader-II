/* 只装扩展的假酒馆：保留酒馆助手/MVU 边界；?native=1 时两者都不提供。
 * 正则来自 extensionSettings.regex，不导入旧脚本或世界书 JSON。
 */
(() => {
  const params = new URLSearchParams(location.search);
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const native = params.get('native') === '1';

  /* 自动场景每次从空的扩展偏好开始；不注入旧脚本、API 方案或界面偏好。 */
  if (params.get('auto') === '1') {
    try {
      Object.keys(localStorage).filter((key) => /^(reader_ii_|dream_)/.test(key)).forEach((key) => localStorage.removeItem(key));
    } catch (error) { console.error('[smoke] 准备本机存储失败', error); }
  }

  const statData = () => ({
    READER: { 地点: '', 关系列表: {}, 任务列表: {}, 主角: { 技能: {}, 状态效果: {} }, 命运点数: 12000 },
    世界: { 时间: '第一夜', 地点: '旧书店' },
    主角: { 姓名: '作家', 金币: 320, 背包: { 旧钢笔: { 数量: 1, 描述: '笔尖有点歪' } }, 状态: {} },
  });

  const state = window.__mock = {
    chatId: 'card-smoke-1',
    chat: [
      { name: '夜梦', is_user: false, mes: '夜色里，旧书店的门铃响了一声。\n<dream>「欢迎回来，作家先生。今晚也写一点吧。」</dream>', swipe_id: 0, variables: [{ stat_data: statData() }] },
      { name: '作家', is_user: true, mes: '我推开门，向柜台后的少女点头。', swipe_id: 0, variables: [{ stat_data: statData() }] },
      { name: '夜梦', is_user: false, beautify: true, mes: '少女合上书，抬头微笑。\n<READER_TASK_EVENT>冒烟用的事件块，显示时应被正则藏起来</READER_TASK_EVENT>\n<dream>「今天的故事，从这一页开始。」</dream>', swipe_id: 0, variables: [{ stat_data: statData() }] },
    ],
    chatVars: {}, globalVars: {}, charVars: {}, presetVars: {}, scriptVars: {},
    worldbooks: {
      设定集: [{ uid: 0, name: '王都', enabled: true, content: '王都位于北方。\n人口十万。\n守卫队长是雷恩。', strategy: { type: 'selective', keys: ['王都'], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' }, position: { type: 'before_character_definition', role: 'system', depth: 4, order: 100 }, probability: 100, extra: {} }],
    },
    charBooks: { primary: '设定集', additional: ['设定集'] },
    globalBooks: [], chatBook: null,
    regexScripts: { global: [], character: [] },
    scripts: { global: [], character: [], preset: [] },
    preset: { settings: {}, prompts: [{ id: 'main', name: '主提示词', enabled: true, role: 'system', content: '写一段故事。' }], prompts_unused: [], extensions: {} },
    replies: [], llmCalls: [], prompts: {}, slash: [], slashRuns: [], toasts: [], posts: [], saves: 0,
    helperMissing: new Set(), mvuMissing: new Set(), globals: {},
    appReady: false, native,
  };

  /* ---------- 事件源（酒馆的 eventSource：逐个 await，单个监听出错只记 console.error） ---------- */
  const listeners = {};
  const eventSource = {
    on(event, handler) { (listeners[event] = listeners[event] || []).push(handler); },
    makeFirst(event, handler) { (listeners[event] = listeners[event] || []).unshift(handler); },
    makeLast(event, handler) { eventSource.on(event, handler); },
    once(event, handler) {
      const wrapped = (...args) => { eventSource.removeListener(event, wrapped); return handler(...args); };
      eventSource.on(event, wrapped);
      if (event === eventTypes.APP_READY && state.appReady) queueMicrotask(() => wrapped());   /* 酒馆对 APP_READY 会补发 */
    },
    removeListener(event, handler) { listeners[event] = (listeners[event] || []).filter((item) => item !== handler); },
    async emit(event, ...args) {
      for (const handler of (listeners[event] || []).slice()) {
        try { await handler(...args); } catch (error) { console.error('[假酒馆] 事件监听出错', event, error); }
      }
    },
    listenerCount(event) { return (listeners[event] || []).length; },
  };
  const eventTypes = {
    APP_READY: 'app_ready', MESSAGE_SWIPED: 'message_swiped', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated', CHAT_CHANGED: 'chat_id_changed',
    CHAT_CREATED: 'chat_created', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended', SETTINGS_UPDATED: 'settings_updated',
    WORLDINFO_UPDATED: 'worldinfo_updated', CHARACTER_EDITED: 'character_edited', USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', STREAM_TOKEN_RECEIVED: 'stream_token_received',
    GENERATE_AFTER_DATA: 'generate_after_data', WORLD_INFO_ACTIVATED: 'world_info_activated', CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  };

  function nextReply(messages) {
    state.llmCalls.push(clone(messages));
    const next = state.replies.shift();
    if (next === undefined) return '（假酒馆：没有预设回复。可以在控制台往 __mock.replies 里放几句。）';
    return typeof next === 'function' ? next(messages) : next;
  }

  /* ---------- 世界书：酒馆助手格式存放，原生格式按需转换 ---------- */
  const POSITIONS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages'];
  const ROLES = ['system', 'user', 'assistant'];
  function entryFromNative(entry) {
    return {
      uid: entry.uid, name: entry.comment || '', enabled: !entry.disable,
      strategy: { type: entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'selective', keys: (entry.key || []).slice(), keys_secondary: { logic: 'and_any', keys: (entry.keysecondary || []).slice() }, scan_depth: entry.scanDepth == null ? 'same_as_global' : entry.scanDepth },
      position: { type: POSITIONS[entry.position] || 'at_depth', role: ROLES[entry.role || 0] || 'system', depth: entry.depth == null ? 4 : entry.depth, order: entry.order == null ? 100 : entry.order },
      content: entry.content || '', probability: entry.probability == null ? 100 : entry.probability,
      recursion: { prevent_incoming: !!entry.excludeRecursion, prevent_outgoing: !!entry.preventRecursion, delay_until: null },
      effect: { sticky: entry.sticky == null ? null : entry.sticky, cooldown: entry.cooldown == null ? null : entry.cooldown, delay: entry.delay == null ? null : entry.delay },
      extra: {},
    };
  }
  function entryToNative(entry) {
    const strategy = entry.strategy || {}, position = entry.position || {};
    return {
      uid: entry.uid, key: (strategy.keys || []).slice(), keysecondary: ((strategy.keys_secondary || {}).keys || []).slice(), comment: entry.name || '', content: entry.content || '',
      constant: strategy.type === 'constant', vectorized: strategy.type === 'vectorized', selective: true, selectiveLogic: 0,
      order: position.order == null ? 100 : position.order, position: Math.max(0, POSITIONS.indexOf(position.type || 'at_depth')), disable: entry.enabled === false,
      depth: position.depth == null ? 4 : position.depth, role: Math.max(0, ROLES.indexOf(position.role || 'system')), probability: entry.probability == null ? 100 : entry.probability,
    };
  }
  function normalizeEntry(entry, uid) {
    const base = entryFromNative({ uid, comment: '', content: '' });
    return { ...base, ...clone(entry), uid: entry.uid == null ? uid : entry.uid, strategy: { ...base.strategy, ...(entry.strategy || {}) }, position: { ...base.position, ...(entry.position || {}) } };
  }
  function bookOf(name) {
    if (!Object.prototype.hasOwnProperty.call(state.worldbooks, name)) throw new Error(`世界书 '${name}' 不存在`);
    return state.worldbooks[name];
  }
  function nextUid(name) { return state.worldbooks[name].reduce((max, entry) => Math.max(max, Number(entry.uid) || 0), -1) + 1; }
  function nativeBook(name) {
    if (!Object.prototype.hasOwnProperty.call(state.worldbooks, name)) return null;
    const entries = {};
    state.worldbooks[name].forEach((entry) => { entries[entry.uid] = entryToNative(entry); });
    return { entries };
  }
  function lorebookEntry(entry, index) {
    const native = entryToNative(entry);
    return { uid: entry.uid, display_index: index, comment: entry.name, enabled: entry.enabled !== false, type: native.constant ? 'constant' : 'selective', position: entry.position.type, depth: native.depth, order: native.order, probability: native.probability, keys: native.key, logic: 'and_any', filters: native.keysecondary, content: entry.content };
  }

  /* ---------- 正则：酒馆原生格式存放；显示时照酒馆的规则跑（仅显示、按楼层深度、$1 与 {{match}}） ---------- */
  function regexFromString(text) {
    const match = /^\/([\s\S]*)\/([a-z]*)$/.exec(String(text));
    return match ? new RegExp(match[1], match[2]) : new RegExp(String(text), 'g');
  }
  function runRegex(script, text) {
    return text.replace(regexFromString(script.findRegex), (...args) => {
      const groups = args.slice(1, -2);
      if (typeof args[args.length - 1] === 'object') groups.pop();
      let out = String(script.replaceString || '').replace(/\{\{match\}\}/gi, args[0]).replace(/\$(\d+)/g, (_, n) => (groups[Number(n) - 1] == null ? '' : groups[Number(n) - 1]));
      (script.trimStrings || []).forEach((trim) => { if (trim) out = out.split(trim).join(''); });
      return out;
    });
  }
  function displayRegex(text, isUser, depth) {
    let out = String(text || '');
    [...ctx.extensionSettings.regex, ...state.regexScripts.character].forEach((script) => {
      if (script.disabled || (script.promptOnly && !script.markdownOnly)) return;
      if (!(script.placement || []).includes(isUser ? 1 : 2)) return;
      if (script.minDepth != null && depth < script.minDepth) return;
      if (script.maxDepth != null && depth > script.maxDepth) return;
      out = runRegex(script, out);
    });
    return out;
  }
  function regexToHelper(script, scope) {
    const placement = script.placement || [];
    return {
      id: script.id, script_name: script.scriptName, enabled: !script.disabled, run_on_edit: !!script.runOnEdit, scope,
      find_regex: script.findRegex, replace_string: script.replaceString, trim_strings: (script.trimStrings || []).join('\n'),
      source: { user_input: placement.includes(1), ai_output: placement.includes(2), slash_command: placement.includes(3), world_info: placement.includes(5) },
      destination: { display: !script.promptOnly, prompt: !script.markdownOnly }, min_depth: script.minDepth == null ? null : script.minDepth, max_depth: script.maxDepth == null ? null : script.maxDepth,
    };
  }
  function regexFromHelper(item) {
    const placement = [];
    if (item.source && item.source.user_input) placement.push(1);
    if (item.source && item.source.ai_output) placement.push(2);
    if (item.source && item.source.slash_command) placement.push(3);
    if (item.source && item.source.world_info) placement.push(5);
    const display = !item.destination || item.destination.display !== false, prompt = !item.destination || item.destination.prompt !== false;
    return {
      id: item.id || 'smoke-' + Math.random().toString(36).slice(2, 10), scriptName: item.script_name || '', findRegex: item.find_regex || '', replaceString: item.replace_string || '',
      trimStrings: String(item.trim_strings || '').split('\n').filter(Boolean), placement, disabled: item.enabled === false, markdownOnly: display && !prompt, promptOnly: prompt && !display,
      runOnEdit: !!item.run_on_edit, substituteRegex: 0, minDepth: item.min_depth == null ? null : item.min_depth, maxDepth: item.max_depth == null ? null : item.max_depth,
    };
  }

  /* ---------- 变量 ---------- */
  function messageIndex(id) {
    if (id === undefined || id === null || id === 'latest') return state.chat.length - 1;
    const number = Number(id);
    if (!Number.isInteger(number)) throw new Error('楼层号无效：' + id);
    return number < 0 ? state.chat.length + number : number;
  }
  function messageVars(id) {
    const message = state.chat[messageIndex(id)];
    if (!message) throw new Error('没有这一楼：' + id);
    message.variables = message.variables || [];
    const swipe = message.swipe_id || 0;
    if (!message.variables[swipe]) message.variables[swipe] = {};
    return message.variables[swipe];
  }
  function varsOf(option) {
    const opt = option || {};
    switch (opt.type || 'chat') {
      case 'chat': return ctx.chatMetadata.variables;
      case 'global': return ctx.extensionSettings.variables.global;
      case 'character': return state.charVars;
      case 'preset': return state.presetVars;
      case 'script': return state.scriptVars[opt.script_id || 'default'] = state.scriptVars[opt.script_id || 'default'] || {};
      case 'message': return messageVars(opt.message_id);
      default: throw new Error('变量类型无效：' + opt.type);
    }
  }
  function setVars(option, value) {
    const opt = option || {};
    switch (opt.type || 'chat') {
      case 'chat': ctx.chatMetadata.variables = value; state.chatVars = value; break;
      case 'global': ctx.extensionSettings.variables.global = value; break;
      case 'character': state.charVars = value; break;
      case 'preset': state.presetVars = value; break;
      case 'script': state.scriptVars[opt.script_id || 'default'] = value; break;
      case 'message': { const message = state.chat[messageIndex(opt.message_id)]; message.variables = message.variables || []; message.variables[message.swipe_id || 0] = value; break; }
      default: throw new Error('变量类型无效：' + opt.type);
    }
  }
  function merge(target, source) {
    Object.keys(source || {}).forEach((key) => {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
      else target[key] = clone(value);
    });
    return target;
  }

  /* ---------- 楼层 ---------- */
  function parseRange(range) {
    const last = state.chat.length - 1;
    const text = String(range == null ? last : range).replace(/\{\{lastMessageId\}\}/g, String(last)).trim();
    let match = /^(-?\d+)$/.exec(text);
    if (match) { let n = Number(match[1]); if (n < 0) n += state.chat.length; return [n, n]; }
    match = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text);
    if (match) {
      let a = Number(match[1]), b = Number(match[2]);
      if (a < 0) a += state.chat.length; if (b < 0) b += state.chat.length;
      return [Math.max(0, Math.min(a, b)), Math.min(last, Math.max(a, b))];
    }
    throw new Error('楼层范围无效：' + range);
  }
  function helperMessage(message, index) {
    return { message_id: index, name: message.name, role: message.is_system ? 'system' : message.is_user ? 'user' : 'assistant', is_hidden: !!message.is_system, message: message.mes, data: clone(messageVars(index)), extra: clone(message.extra || {}), swipe_id: message.swipe_id || 0, swipes: [message.mes] };
  }

  /* ---------- 酒馆助手 ---------- */
  const H = {
    getTavernHelperVersion: () => '4.0.0-smoke',
    getVariables: (option) => clone(varsOf(option)),
    replaceVariables: async (value, option) => { setVars(option, clone(value)); },
    updateVariablesWith: async (updater, option) => { const next = await updater(clone(varsOf(option))); setVars(option, clone(next)); return clone(next); },
    insertOrAssignVariables: async (value, option) => { const next = merge(clone(varsOf(option)), value); setVars(option, next); return clone(next); },
    insertVariables: async (value, option) => {
      const current = clone(varsOf(option));
      const add = (target, source) => Object.keys(source).forEach((key) => { if (!(key in target)) target[key] = clone(source[key]); else if (target[key] && typeof target[key] === 'object' && source[key] && typeof source[key] === 'object') add(target[key], source[key]); });
      add(current, value); setVars(option, current); return clone(current);
    },
    deleteVariable: async (path, option) => {
      const current = clone(varsOf(option)), keys = String(path).split('.');
      let owner = current;
      for (const key of keys.slice(0, -1)) { owner = owner && owner[key]; }
      const existed = !!owner && keys[keys.length - 1] in owner;
      if (existed) delete owner[keys[keys.length - 1]];
      setVars(option, current);
      return { variables: clone(current), delete_occurred: existed };
    },
    getAllVariables: () => merge(merge(merge(clone(ctx.extensionSettings.variables.global), state.charVars), ctx.chatMetadata.variables), messageVars('latest')),
    getLastMessageId: () => state.chat.length - 1,
    getChatMessages: (range, option) => {
      const opt = option || {};
      const [from, to] = parseRange(range);
      let list = [];
      for (let index = from; index <= to; index += 1) if (state.chat[index]) list.push(helperMessage(state.chat[index], index));
      if (opt.role && opt.role !== 'all') list = list.filter((item) => item.role === opt.role);
      if (opt.hide_state === 'hidden') list = list.filter((item) => item.is_hidden);
      if (opt.hide_state === 'unhidden') list = list.filter((item) => !item.is_hidden);
      return list;
    },
    setChatMessages: async (list, option) => {
      list.forEach((item) => {
        const message = state.chat[messageIndex(item.message_id)];
        if (item.message !== undefined) message.mes = item.message;
        if (item.name !== undefined) message.name = item.name;
        if (item.data !== undefined) { message.variables = message.variables || []; message.variables[message.swipe_id || 0] = clone(item.data); }
      });
      if (!option || option.refresh !== 'none') list.forEach((item) => renderMessage(messageIndex(item.message_id)));
    },
    createChatMessages: async (list) => {
      list.forEach((item) => state.chat.push({ name: item.name || (item.role === 'user' ? ctx.name1 : ctx.name2), is_user: item.role === 'user', mes: item.message || '', swipe_id: 0, variables: [clone(item.data || messageVars('latest'))] }));
      renderChat();
    },
    deleteChatMessages: async (ids) => { ids.map(messageIndex).sort((a, b) => b - a).forEach((index) => state.chat.splice(index, 1)); renderChat(); },
    getCharData: () => clone(ctx.characters[0]),
    getCharAvatarPath: () => '',
    substitudeMacros: (text) => String(text).replace(/\{\{user\}\}/gi, ctx.name1).replace(/\{\{char\}\}/gi, ctx.name2),
    triggerSlash: async (command) => { state.slashRuns.push(String(command)); return ''; },
    generate: async (config) => nextReply(config && (config.ordered_prompts || config.user_input || config)),
    generateRaw: async (config) => nextReply(config && (config.ordered_prompts || config.user_input || config)),
    stopGenerationById: () => true,
    stopAllGeneration: () => true,
    getModelList: async () => ['smoke-model'],
    injectPrompts: async (prompts) => { prompts.forEach((prompt) => { state.prompts[prompt.id] = clone(prompt); }); },
    uninjectPrompts: async (ids) => { ids.forEach((id) => { delete state.prompts[id]; }); },
    getWorldbookNames: () => Object.keys(state.worldbooks),
    getGlobalWorldbookNames: () => state.globalBooks.slice(),
    rebindGlobalWorldbooks: async (names) => { state.globalBooks = names.slice(); },
    getCharWorldbookNames: () => clone(state.charBooks),
    rebindCharWorldbooks: async (_name, books) => { state.charBooks = { primary: books.primary || null, additional: (books.additional || []).slice() }; },
    getChatWorldbookName: () => state.chatBook,
    rebindChatWorldbook: async (_name, book) => { state.chatBook = book; },
    getOrCreateChatWorldbook: async () => { if (!state.chatBook) { state.chatBook = 'smoke-chat-book'; state.worldbooks[state.chatBook] = []; } return state.chatBook; },
    getWorldbook: async (name) => clone(bookOf(name)),
    createWorldbook: async (name, entries) => { if (state.worldbooks[name]) return false; state.worldbooks[name] = (entries || []).map((entry, index) => normalizeEntry(entry, index)); return true; },
    createOrReplaceWorldbook: async (name, entries) => { state.worldbooks[name] = (entries || []).map((entry, index) => normalizeEntry(entry, index)); return true; },
    deleteWorldbook: async (name) => { const had = name in state.worldbooks; delete state.worldbooks[name]; return had; },
    replaceWorldbook: async (name, entries) => { bookOf(name); state.worldbooks[name] = (entries || []).map((entry, index) => normalizeEntry(entry, index)); },
    updateWorldbookWith: async (name, updater) => {
      const next = await updater(clone(bookOf(name)));
      state.worldbooks[name] = (next || []).map((entry, index) => normalizeEntry(entry, index));
      return clone(state.worldbooks[name]);
    },
    createWorldbookEntries: async (name, entries) => {
      bookOf(name);
      const made = entries.map((entry, index) => normalizeEntry({ ...entry, uid: undefined }, nextUid(name) + index));
      state.worldbooks[name].push(...made);
      return { worldbook: clone(state.worldbooks[name]), new_entries: clone(made) };
    },
    deleteWorldbookEntries: async (name, predicate) => {
      const kept = [], deleted = [];
      bookOf(name).forEach((entry) => (predicate(clone(entry)) ? deleted : kept).push(entry));
      state.worldbooks[name] = kept;
      return { worldbook: clone(kept), deleted_entries: clone(deleted) };
    },
    getLorebooks: () => Object.keys(state.worldbooks),
    getCharLorebooks: () => clone(state.charBooks),
    getCurrentCharPrimaryLorebook: () => state.charBooks.primary,
    setCurrentCharLorebooks: async (books) => { state.charBooks = { primary: books.primary === undefined ? state.charBooks.primary : books.primary, additional: books.additional === undefined ? state.charBooks.additional : books.additional.slice() }; },
    getLorebookEntries: async (name) => bookOf(name).map(lorebookEntry),
    getTavernRegexes: (option) => {
      const scope = option && option.scope || 'all';
      const list = scope === 'all' ? [...state.regexScripts.global.map((item) => regexToHelper(item, 'global')), ...state.regexScripts.character.map((item) => regexToHelper(item, 'character'))]
        : (state.regexScripts[scope] || []).map((item) => regexToHelper(item, scope));
      return clone(list);
    },
    replaceTavernRegexes: async (list, option) => { state.regexScripts[option.scope] = list.map(regexFromHelper); renderChat(); },
    updateTavernRegexesWith: async (updater, option) => {
      const scope = option && option.scope || 'global';
      const next = await updater(clone(state.regexScripts[scope].map((item) => regexToHelper(item, scope))));
      state.regexScripts[scope] = next.map(regexFromHelper);
      renderChat();
      return clone(next);
    },
    isCharacterTavernRegexesEnabled: () => true,
    formatAsTavernRegexedString: (text, source, destination, option) => (source === 'ai_output' && destination === 'display' ? displayRegex(text, false, option && option.depth || 0) : String(text)),
    getScriptTrees: (option) => clone(state.scripts[option && option.type || 'global']),
    replaceScriptTrees: async (trees, option) => { state.scripts[option && option.type || 'global'] = clone(trees); },
    updateScriptTreesWith: async (updater, option) => { const type = option && option.type || 'global'; state.scripts[type] = clone(await updater(clone(state.scripts[type]))); return clone(state.scripts[type]); },
    getPresetNames: () => ['in_use'],
    getPreset: () => clone(state.preset),
    replacePreset: async (_name, preset) => { state.preset = clone(preset); },
    updatePresetWith: async (_name, updater) => { state.preset = clone(await updater(clone(state.preset))); return clone(state.preset); },
    errorCatched: (fn) => fn,
  };
  window.__helperImpl = H;
  const IGNORED = new Set(['then', 'toJSON', 'constructor', 'prototype', 'length', 'name', 'call', 'apply', 'bind', 'nodeType', 'tagName', '$$typeof', 'asymmetricMatch']);
  const recorder = (target, missing) => new Proxy(target, {
    get(object, key) {
      if (typeof key === 'string' && !(key in object) && !IGNORED.has(key)) missing.add(key);
      return object[key];
    },
  });
  if (!native) window.TavernHelper = recorder(H, state.helperMissing);

  /* ---------- MVU ---------- */
  const MVU_EVENTS = {
    VARIABLE_INITIALIZED: 'mag_variable_initialized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    COMMAND_PARSED: 'mag_command_parsed', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
  };
  const readPath = (data, path) => String(path).split('.').reduce((value, key) => (value == null ? undefined : value[key]), data);
  if (!native) window.Mvu = recorder({
    events: MVU_EVENTS,
    getMvuData: (option) => clone(varsOf({ type: 'message', ...(option || {}) })),
    replaceMvuData: async (data, option) => { setVars({ type: 'message', ...(option || {}) }, clone(data)); },
    parseMessage: async (_text, old) => clone(old),
    getMvuVariable: (data, path, option) => {
      const value = readPath(data && data.stat_data, path);
      return value === undefined ? option && option.default_value : value;
    },
    setMvuVariable: async (data, path, value) => {
      const keys = String(path).split('.');
      let owner = data.stat_data = data.stat_data || {};
      for (const key of keys.slice(0, -1)) owner = owner[key] = owner[key] && typeof owner[key] === 'object' ? owner[key] : {};
      owner[keys[keys.length - 1]] = value;
      return true;
    },
  }, state.mvuMissing);

  /* ---------- 酒馆上下文 ---------- */
  const ctx = {
    chat: state.chat, characterId: 0, groupId: null, name1: '作家', name2: '夜梦', chatId: state.chatId,
    characters: [{
      name: '夜梦', avatar: 'yume.png', description: '旧书店的店主，总在柜台后面看书。', personality: '安静', scenario: '深夜的旧书店', first_mes: state.chat[0].mes, mes_example: '',
      data: { name: '夜梦', description: '旧书店的店主，总在柜台后面看书。', first_mes: state.chat[0].mes, alternate_greetings: [], extensions: { world: '设定集', regex_scripts: [] } },
    }],
    chatMetadata: { variables: state.chatVars },
    extensionSettings: { variables: { global: state.globalVars }, regex: [] },
    eventSource, eventTypes, event_types: eventTypes,
    onlineStatus: 'connected', mainApi: 'openai', maxContext: 8192,
    getCurrentChatId: () => ctx.chatId,
    saveMetadata: async () => { state.saves += 1; }, saveMetadataDebounced: () => { state.saves += 1; },
    saveSettingsDebounced: () => {}, saveChat: async () => {}, saveChatConditional: async () => {},
    reloadCurrentChat: async () => renderChat(),
    updateMessageBlock: (id) => renderMessage(Number(id)),
    writeExtensionField: async (_id, key, value) => { ctx.characters[0].data.extensions[key] = clone(value); },
    setExtensionPrompt: (id, text, position, depth) => { state.prompts[id] = { text, position, depth }; },
    extensionPrompts: {},
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    loadWorldInfo: async (name) => clone(nativeBook(name)),
    saveWorldInfo: async (name, data) => { state.worldbooks[name] = Object.values(data.entries || {}).map(entryFromNative); },
    generateRaw: async (option) => nextReply(option && option.prompt),
    generateQuietPrompt: async (option) => nextReply(option && (option.quietPrompt || option)),
    getTokenCountAsync: async (text) => Math.ceil(String(text || '').length / 2),
    substituteParams: (text) => H.substitudeMacros(text),
    executeSlashCommandsWithOptions: async (text) => { state.slashRuns.push(String(text)); return { pipe: '' }; },
    SlashCommandParser: { addCommandObject: (command) => state.slash.push(command) },
    SlashCommand: { fromProps: (props) => props },
  };
  window.SillyTavern = { getContext: () => ctx, libs: {} };
  window.toastr = {
    error: (message) => state.toasts.push(['error', String(message)]), warning: (message) => state.toasts.push(['warning', String(message)]),
    info: (message) => state.toasts.push(['info', String(message)]), success: (message) => state.toasts.push(['success', String(message)]),
    clear() {}, remove() {},
  };

  /* 静态服务器不认识酒馆的 /api/：在这里接住。 */
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('/api/') || url.startsWith(location.origin + '/api/')) {
      let body = null;
      try { body = init && init.body ? JSON.parse(init.body) : null; } catch (error) { body = String(init.body); }
      state.posts.push({ url, body });
      const reply = /\/api\/extensions\/discover$/.test(url) ? [{ type: 'local', name: 'third-party/reader-II' }]
        : /\/chat-completions\/status$/.test(url) && body?.reverse_proxy === 'https://ui-model-smoke.invalid/v1'
          ? { data: [{ id: 'catalog-writer', context_length: 20000 }, { id: 'catalog-film' }] } : {};
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };

  /* ---------- 聊天 DOM ---------- */
  function displayHtml(index) {
    const message = state.chat[index];
    return displayRegex(message.mes, !!message.is_user, state.chat.length - 1 - index).replace(/\n/g, '<br>');
  }
  function buildMessage(index) {
    const message = state.chat[index];
    const node = document.createElement('div');
    node.className = 'mes';
    node.setAttribute('mesid', String(index));
    node.setAttribute('is_user', String(!!message.is_user));
    node.setAttribute('ch_name', message.name);
    const block = document.createElement('div');
    block.className = 'mes_block';
    const name = document.createElement('div');
    name.className = 'ch_name';
    name.textContent = `#${index} ${message.name}`;
    const text = document.createElement('div');
    text.className = 'mes_text';
    if (message.beautify) {
      const frame = document.createElement('iframe');
      frame.className = 'smoke-render';
      frame.style.cssText = 'width:100%;border:0;min-height:80px;display:block';
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;color:#d8dce6;font:14px/1.6 system-ui">' + displayHtml(index) + '</body></html>';
      text.appendChild(frame);
    } else {
      text.innerHTML = displayHtml(index);
    }
    block.append(name, text);
    node.appendChild(block);
    return node;
  }
  function renderMessage(index) {
    const chat = document.getElementById('chat');
    const old = chat.querySelector(`.mes[mesid="${index}"]`);
    const node = buildMessage(index);
    if (old) old.replaceWith(node); else chat.appendChild(node);
  }
  function renderChat() {
    const chat = document.getElementById('chat');
    chat.replaceChildren();
    state.chat.forEach((_, index) => chat.appendChild(buildMessage(index)));
  }

  /* 换一个聊天（同一张卡）：酒馆助手的角色脚本不重启，只发 CHAT_CHANGED。 */
  state.switchChat = async (id, messages) => {
    ctx.chatId = id;
    state.chatId = id;
    state.chat.splice(0, state.chat.length, ...messages.map((message) => ({ swipe_id: 0, variables: [{ stat_data: statData() }], ...message })));
    state.chatVars = {};
    ctx.chatMetadata = { variables: state.chatVars };
    renderChat();
    await eventSource.emit(eventTypes.CHAT_CHANGED, id);
  };
  /* 模拟流式输出：每隔 interval 毫秒改一次最后一楼并重画。 */
  state.stream = async (chunks, interval) => {
    state.chat.push({ name: ctx.name2, is_user: false, mes: '', swipe_id: 0, variables: [{ stat_data: statData() }] });
    const index = state.chat.length - 1;
    renderMessage(index);
    await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    for (const chunk of chunks) {
      state.chat[index].mes = chunk;
      renderMessage(index);
      await eventSource.emit(eventTypes.STREAM_TOKEN_RECEIVED, chunk);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    await eventSource.emit(eventTypes.MESSAGE_RECEIVED, index, 'normal');
    await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, index, 'normal');
    await eventSource.emit(eventTypes.GENERATION_ENDED, index);
    return index;
  };
  /* 模拟一轮生成：生成前钩子，再收到一条回复（楼层变量照 MVU 的做法从上一楼抄过来）。 */
  state.receive = async (text) => {
    await eventSource.emit(eventTypes.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
    const previous = messageVars('latest');
    state.chat.push({ name: ctx.name2, is_user: false, mes: text, swipe_id: 0, variables: [clone(previous)] });
    const index = state.chat.length - 1;
    renderMessage(index);
    await eventSource.emit(eventTypes.MESSAGE_RECEIVED, index, 'normal');
    await eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, index, 'normal');
    await eventSource.emit(eventTypes.GENERATION_ENDED, index);
    return index;
  };
  state.renderChat = renderChat;
  state.renderMessage = renderMessage;
  state.ctx = ctx;
  state.eventSource = eventSource;

  state.booted = (async () => {
    renderChat();
    state.appReady = true;
    await eventSource.emit(eventTypes.APP_READY);
    return true;
  })();
})();
