(function (root) {
  'use strict';

  /*
   * Reader-II 记忆系统（夜之洋）。
   *
   *   对话 ──整理（一次 LLM 调用，输出 add / update 操作）──▶ 记忆库 ──召回──▶ 正文提示词 / 助手
   *
   * 两个存放位置，新记忆写到用户选的那个，读取时两边都看：
   *   chat   当前聊天：聊天变量 reader_ii_memory，随存档走，换聊天互不相干。
   *   ocean  《夜之洋》世界书：每条记忆是一个世界书条目，跨存档；挂载后由酒馆按关键词原生触发。
   *
   * 召回不使用向量：关键词命中 + 字二元组重合 + 重要度 + 新近度打分。
   * 聊天库的记忆、以及未挂载时的《夜之洋》记忆由脚本注入正文；已挂载的《夜之洋》交给酒馆原生触发，避免重复。
   *
   * 来源标记 owner（与 source「怎么来的」分开）：story 正文的记忆 | agent 助手自己的记忆（与助手的对话沉淀、助手自己记下的）。
   * 设置 unify（助手夜梦 = 正文夜梦，默认关）：
   *   关  agent 记忆不进正文：脚本注入时跳过；在《夜之洋》里对应条目保持停用（真实开关存在元数据 off 里），酒馆不会原生触发。
   *   开  agent 记忆一并参与正文召回（功能记忆除外，那是戏外的做法），注入块里加一句「你与助手是同一人，不主动超游」。
   *   两种情况都只走召回、受条数与字数预算约束；注入用自己的 id、不触发别的世界书条目，不碰其他记忆插件的注入。
   * 助手那边任何时候都能读到正文的记忆。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_KEY = 'reader_ii_memory_settings_v1';
  var CHAT_KEY = 'reader_ii_memory';
  var INJECT_ID = 'reader-ii-memory';
  var TYPES = { episode: '剧情记忆', fact: '设定记忆', bond: '情感记忆', howto: '功能记忆' };
  var TYPE_SHORT = { episode: '剧情', fact: '设定', bond: '情感', howto: '功能' };
  var TYPE_KEYS = Object.keys(TYPES);
  var LEGACY_TYPES = { emotion: 'bond', 'function': 'howto', story: 'episode', setting: 'fact' };
  var META_PATTERN = /^\s*<!--yzy\s+(\{[\s\S]*?\})\s*-->[ \t]*\n?/;
  var NOTE_PATTERN = /^\s*>\s*记录于[^\n]*\n?/;
  var NAME_PATTERN = /^(剧情记忆|设定记忆|情感记忆|功能记忆)\s*[-·:：]\s*(.+)$/;
  var UNIFY_LINE = '你与夜梦助手是同一个人：标着“助手那边”的记忆也是你的经历。正文里不主动超游（不提助手、工具、面板等戏外之事），除非用户先这样做。';

  var DEFAULTS = {
    enabled: true,
    scope: 'reader',          /* 自动整理与带入正文的范围：reader 只在用了 Reader-II 的聊天里 | all 所有聊天 */
    store: 'chat',            /* 新记忆写到哪里：chat | ocean */
    autoExtract: true,
    everyTurns: 8,            /* 攒够多少条 AI 回复后自动整理；0 = 不按条数 */
    everyChars: 9000,         /* 或攒够多少字；0 = 不按字数。两个都为 0 = 只手动 */
    keepRecent: 2,            /* 最近几条先不整理（还可能重掷、编辑） */
    windowChars: 24000,       /* 一次请求最多送入多少字的对话 */
    maxPerRun: 10,            /* 一次整理最多写入几条 */
    inject: true,
    injectDepth: 2,
    injectMax: 6,
    injectBudget: 1500,
    injectSummary: true,
    oceanBook: '夜之洋',
    oceanMount: 'global',     /* global | character | none */
    agentExtract: true,
    unify: false              /* 助手夜梦 = 正文夜梦：助手自己的记忆也带进正文 */
  };

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function normalizeSettings(input) {
    var source = modules.isObject(input) ? input : {};
    var output = {};
    output.enabled = source.enabled !== false;
    output.scope = source.scope === 'all' ? 'all' : 'reader';
    output.store = source.store === 'ocean' ? 'ocean' : 'chat';
    output.autoExtract = source.autoExtract !== false;
    output.everyTurns = clampInt(source.everyTurns, 0, 200, DEFAULTS.everyTurns);
    output.everyChars = clampInt(source.everyChars, 0, 400000, DEFAULTS.everyChars);
    output.keepRecent = clampInt(source.keepRecent, 0, 20, DEFAULTS.keepRecent);
    output.windowChars = clampInt(source.windowChars, 2000, 400000, DEFAULTS.windowChars);
    output.maxPerRun = clampInt(source.maxPerRun, 1, 40, DEFAULTS.maxPerRun);
    output.inject = source.inject !== false;
    output.injectDepth = clampInt(source.injectDepth, 0, 40, DEFAULTS.injectDepth);
    output.injectMax = clampInt(source.injectMax, 1, 30, DEFAULTS.injectMax);
    output.injectBudget = clampInt(source.injectBudget, 200, 20000, DEFAULTS.injectBudget);
    output.injectSummary = source.injectSummary !== false;
    output.oceanBook = String(source.oceanBook || DEFAULTS.oceanBook).replace(/[\r\n]/g, ' ').trim().slice(0, 60) || DEFAULTS.oceanBook;
    output.oceanMount = ['global', 'character', 'none'].indexOf(source.oceanMount) >= 0 ? source.oceanMount : DEFAULTS.oceanMount;
    output.agentExtract = source.agentExtract !== false;
    output.unify = source.unify === true;
    return output;
  }

  function normalizeType(value) {
    var text = String(value || '').trim().toLowerCase();
    if (TYPES[text]) return text;
    if (LEGACY_TYPES[text]) return LEGACY_TYPES[text];
    for (var index = 0; index < TYPE_KEYS.length; index += 1) {
      var key = TYPE_KEYS[index];
      if (text === TYPES[key] || text === TYPE_SHORT[key]) return key;
    }
    return '';
  }

  function cleanKeys(input) {
    var seen = Object.create(null);
    var source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、;；\n]+/) : [];
    return source.map(function (item) {
      return typeof item === 'string' ? item.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : '';
    }).filter(function (item) {
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    }).slice(0, 8);
  }

  /* 来源标记：没写明时按 source 推断（旧数据里与助手对话沉淀的记忆 source 是 agent）。 */
  function ownerOf(input) {
    return input.owner === 'agent' || input.owner === 'story' ? input.owner : input.source === 'agent' ? 'agent' : 'story';
  }

  function newId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizeRecord(input, fallbackStore) {
    var source = modules.isObject(input) ? input : {};
    var type = normalizeType(source.type) || 'episode';
    var title = String(source.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    var content = String(source.content || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    if (!content) return null;
    if (!title) title = content.replace(/\s+/g, ' ').slice(0, 16);
    var now = Date.now();
    var created = Number(source.createdAt);
    var updated = Number(source.updatedAt);
    var record = {
      id: /^[A-Za-z0-9_-]{1,48}$/.test(String(source.id || '')) ? String(source.id) : newId(),
      type: type,
      title: title,
      content: content,
      keys: cleanKeys(source.keys),
      importance: clampInt(source.importance, 1, 5, 3),
      pinned: source.pinned === true,
      enabled: source.enabled !== false,
      createdAt: Number.isFinite(created) && created > 0 ? created : now,
      updatedAt: Number.isFinite(updated) && updated > 0 ? updated : now,
      origin: String(source.origin || '').slice(0, 120),
      source: ['story', 'agent', 'manual', 'import'].indexOf(source.source) >= 0 ? source.source : 'manual',
      owner: ownerOf(source),
      store: source.store === 'ocean' || source.store === 'chat' ? source.store : (fallbackStore || 'chat')
    };
    if (source.uid !== undefined) record.uid = source.uid;
    return record;
  }

  /* ---------- 文本相似度（无向量） ---------- */
  /* 虚词不参与重合度：否则任意两段中文都会有一成多的“相似”。 */
  var STOP_CHARS = '的了是在有不我你他她它这那就也都和与及或而且但一个上下着过吗呢吧啊么之其被把让给对从到为以于很更最还又再才只们来去说';
  function gramSet(text) {
    var set = Object.create(null);
    var count = 0;
    var source = String(text || '').toLowerCase();
    var pattern = /[㐀-鿿぀-ヿ가-힯]+|[a-z0-9_]{2,}/g;
    var match;
    while ((match = pattern.exec(source)) !== null) {
      var token = match[0];
      if (/^[a-z0-9_]+$/.test(token)) {
        if (!set[token]) { set[token] = true; count += 1; }
        continue;
      }
      if (token.length === 1) continue;
      for (var index = 0; index < token.length - 1; index += 1) {
        var gram = token.slice(index, index + 2);
        if (STOP_CHARS.indexOf(gram[0]) >= 0 || STOP_CHARS.indexOf(gram[1]) >= 0) continue;
        if (!set[gram]) { set[gram] = true; count += 1; }
      }
    }
    return { set: set, size: count };
  }

  function overlap(queryGrams, text) {
    if (!queryGrams.size) return 0;
    var target = gramSet(text);
    if (!target.size) return 0;
    var hit = 0;
    Object.keys(target.set).forEach(function (gram) { if (queryGrams.set[gram]) hit += 1; });
    /* 以较短一方为分母：短查询命中长记忆、长上下文命中短记忆都算数。 */
    return hit / Math.min(queryGrams.size, target.size);
  }

  function scoreRecord(record, queryText, queryGrams, now) {
    var lower = queryText.toLowerCase();
    var keyHits = 0;
    record.keys.forEach(function (key) { if (key && lower.indexOf(key.toLowerCase()) >= 0) keyHits += 1; });
    var titleHit = record.title && lower.indexOf(record.title.toLowerCase()) >= 0 ? 1 : 0;
    var similarity = overlap(queryGrams, record.title + ' ' + record.content);
    var relevance = keyHits * 3 + titleHit * 2 + similarity * 6;
    if (relevance <= 0) return { score: 0, relevance: 0, keyHits: 0, similarity: 0 };
    var ageDays = Math.max(0, (now - (record.updatedAt || record.createdAt || now)) / 86400000);
    var score = relevance + record.importance * 0.3 + Math.exp(-ageDays / 60) * 0.5;
    return { score: score, relevance: relevance, keyHits: keyHits, similarity: similarity };
  }

  /* ---------- 模型输出解析 ---------- */
  function balancedObjects(text) {
    var output = [];
    var depth = 0, start = -1, quote = '', escaped = false;
    for (var index = 0; index < text.length; index += 1) {
      var ch = text[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"') { quote = ch; continue; }
      if (ch === '{') { if (depth === 0) start = index; depth += 1; }
      else if (ch === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) { output.push(text.slice(start, index + 1)); start = -1; }
      }
    }
    return output;
  }

  function looseJson(text) {
    try { return JSON.parse(text); } catch (error) { /* try repairs */ }
    try { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')); } catch (error) { return undefined; }
  }

  /* 返回 { summary, ops }；整段解析不了时逐条抢救 memories 里的对象（回复被截断也能取出完整的几条）。 */
  function parseExtraction(text) {
    var source = String(text || '').replace(/```(?:json)?/gi, '').trim();
    var first = source.indexOf('{');
    var result = { summary: null, ops: [] };
    if (first < 0) return result;
    var whole = looseJson(source.slice(first, source.lastIndexOf('}') + 1));
    var items = [];
    if (modules.isObject(whole)) {
      if (typeof whole.summary === 'string') result.summary = whole.summary.trim().slice(0, 1200);
      items = Array.isArray(whole.memories) ? whole.memories : Array.isArray(whole.ops) ? whole.ops : [];
    } else if (Array.isArray(whole)) items = whole;
    else {
      var summaryMatch = source.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (summaryMatch) { try { result.summary = JSON.parse('"' + summaryMatch[1] + '"').trim().slice(0, 1200); } catch (error) { /* ignore */ } }
      var arrayStart = source.indexOf('[', source.indexOf('"memories"'));
      if (arrayStart >= 0) balancedObjects(source.slice(arrayStart + 1)).forEach(function (chunk) {
        var parsed = looseJson(chunk);
        if (modules.isObject(parsed)) items.push(parsed);
      });
    }
    items.forEach(function (item) {
      if (!modules.isObject(item)) return;
      var op = String(item.op || (item.id ? 'update' : 'add')).toLowerCase();
      if (op !== 'add' && op !== 'update') return;
      result.ops.push({
        op: op,
        id: typeof item.id === 'string' ? item.id.trim() : '',
        type: normalizeType(item.type),
        title: typeof item.title === 'string' ? item.title : '',
        content: typeof item.content === 'string' ? item.content : '',
        keys: cleanKeys(item.keys),
        importance: item.importance
      });
    });
    return result;
  }

  var EXTRACT_SYSTEM = [
    '你是「夜之洋」记忆整理器，负责把一段对话沉淀为日后可检索的长期记忆。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。',
    '',
    '记忆类型（type）：',
    '- episode 剧情：已经发生的关键事件、转折、约定、尚未回收的伏笔。写清人物、地点、起因与结果。',
    '- fact 设定：较稳定的事实——人物身份、关系、能力，世界规则，物品归属，用户明确表达过的偏好。',
    '- bond 情感：用户与角色（或九十九夜梦）之间值得铭记的情感时刻与关系变化。',
    '- howto 功能：可复用的做法、踩过的坑与结论（多见于用户与助手的对话）。',
    '',
    '要求：',
    '1. 宁缺毋滥：闲聊、重复、已有记忆已经覆盖的内容不要再记；这一段没有值得记的内容就返回空数组。',
    '2. 每条独立成文，脱离上下文也能读懂；第三人称客观陈述，不写“本段对话中”。content 控制在 40～220 字。',
    '3. keys 给 2～5 个将来对话里可能原样出现的触发词（人名、地名、物品、专有名词），不用“事件”“约定”这类泛词。',
    '4. importance 取 1～5：5 表示影响主线或长期关系，1 表示细枝末节。',
    '5. 已有记忆需要补充或修正时用 op=update，带上它的 id，并给出合并后的完整 content；不要为同一件事新建条目。',
    '6. summary：把【此前梗概】与这一段合并成不超过 300 字的最新梗概；没有可写的就给空字符串。',
    '',
    '输出格式：',
    '{"summary":"…","memories":[{"op":"add","type":"episode","title":"不超过18字","content":"…","keys":["…"],"importance":3},{"op":"update","id":"已有记忆的id","content":"…","keys":["…"],"importance":4}]}'
  ].join('\n');

  function createMemorySystem(env, llm, kit) {
    var settings = normalizeSettings(kit.localRead(SETTINGS_KEY, {}));
    var oceanCache = { key: '', at: 0, records: null, book: '' };
    var running = null;
    var generating = false;
    var autoTimer = null;
    var listeners = [];
    var lastInjection = { key: '', text: '' };

    function log() {
      if (env.console && typeof env.console.warn === 'function') env.console.warn.apply(env.console, ['[Reader记忆]'].concat(Array.prototype.slice.call(arguments)));
    }

    function emit(reason) {
      listeners.slice().forEach(function (listener) {
        try { listener(reason); } catch (error) { /* a UI listener must not break memory */ }
      });
    }

    /* ---------- 设置 ---------- */
    function getSettings() { return modules.clone(settings); }

    function saveSettings(patch) {
      var before = settings;
      settings = normalizeSettings(Object.assign({}, settings, modules.isObject(patch) ? patch : {}));
      kit.localWrite(SETTINGS_KEY, settings);
      oceanCache.records = null;
      if (before.unify !== settings.unify || before.oceanBook !== settings.oceanBook) {
        syncOceanVisibility().catch(function (error) { log('同步《夜之洋》里助手记忆的开关失败', error); });
      }
      refreshInjection().catch(function () {});
      emit('settings');
      return getSettings();
    }

    /* ---------- 聊天库 ---------- */
    function emptyChatData() {
      return { v: 1, items: {}, cursor: { index: 0 }, summary: { text: '', upto: 0, at: 0 }, cfg: {}, last: null };
    }

    function readChatData() {
      var raw = kit.readChatValue(CHAT_KEY);
      var data = emptyChatData();
      if (!modules.isObject(raw)) return data;
      if (modules.isObject(raw.items)) Object.keys(raw.items).slice(0, 2000).forEach(function (id) {
        var record = normalizeRecord(Object.assign({}, raw.items[id], { id: id, store: 'chat' }), 'chat');
        if (record) data.items[record.id] = record;
      });
      if (modules.isObject(raw.cursor)) data.cursor.index = clampInt(raw.cursor.index, 0, 10000000, 0);
      if (modules.isObject(raw.summary)) {
        data.summary = {
          text: String(raw.summary.text || '').slice(0, 1200),
          upto: clampInt(raw.summary.upto, 0, 10000000, 0),
          at: Number(raw.summary.at) || 0
        };
      }
      if (modules.isObject(raw.cfg)) data.cfg = { store: raw.cfg.store === 'ocean' || raw.cfg.store === 'chat' ? raw.cfg.store : '' };
      if (modules.isObject(raw.last)) data.last = modules.clone(raw.last);
      return data;
    }

    function writeChatData(data) {
      var stored = { v: 1, items: {}, cursor: data.cursor, summary: data.summary, cfg: data.cfg, last: data.last };
      Object.keys(data.items).forEach(function (id) {
        var record = Object.assign({}, data.items[id]);
        delete record.store;
        delete record.id;
        stored.items[id] = record;
      });
      if (!kit.writeChatValue(CHAT_KEY, stored)) throw new Error('当前聊天不可写入记忆（没有打开聊天？）');
    }

    /* 新记忆写到哪里：本聊天单独指定优先，否则用全局设置。 */
    function targetStore() {
      var override = readChatData().cfg.store;
      return override || settings.store;
    }

    function setChatStoreOverride(store) {
      var data = readChatData();
      data.cfg.store = store === 'ocean' || store === 'chat' ? store : '';
      writeChatData(data);
      emit('settings');
      return targetStore();
    }

    /* ---------- 《夜之洋》世界书 ---------- */
    function normalizedBookName(name) { return String(name || '').replace(/[《》\s]/g, ''); }

    function findOceanBook() {
      var names = kit.worldbookNames();
      if (names.indexOf(settings.oceanBook) >= 0) return settings.oceanBook;
      var wanted = normalizedBookName(settings.oceanBook);
      for (var index = 0; index < names.length; index += 1) {
        if (normalizedBookName(names[index]) === wanted) return names[index];
      }
      return '';
    }

    async function ensureOceanBook() {
      var name = findOceanBook();
      if (!name) {
        name = settings.oceanBook;
        await kit.createWorldbook(name);
        oceanCache.records = null;
      }
      if (settings.oceanMount !== 'none' && !kit.isWorldbookActive(name)) {
        try { await kit.mountWorldbook(name, settings.oceanMount); }
        catch (error) { log('《' + name + '》挂载失败，记忆仍会保存，召回改由脚本完成', error); }
      }
      return name;
    }

    function oceanNative() {
      var name = findOceanBook();
      return !!name && kit.isWorldbookActive(name);
    }

    function parseMeta(content) {
      var match = String(content || '').match(META_PATTERN);
      if (!match) return null;
      try { var value = JSON.parse(match[1]); return modules.isObject(value) ? value : null; } catch (error) { return null; }
    }

    function entryBody(content) {
      return String(content || '').replace(META_PATTERN, '').replace(NOTE_PATTERN, '').trim();
    }

    function entryToRecord(entry) {
      if (!entry || typeof entry !== 'object') return null;
      var name = String(entry.name || '');
      var meta = parseMeta(entry.content);
      var named = name.match(NAME_PATTERN);
      if (!meta && !named) return null;
      meta = meta || {};
      var strategy = entry.strategy || {};
      var owner = ownerOf({ owner: meta.o, source: meta.src });
      /* 新写法的 agent 条目：世界书里的开关由 unify 决定，真实开关在 meta.off。 */
      var enabled = owner === 'agent' && meta.o === 'agent' ? !meta.off : entry.enabled !== false;
      return normalizeRecord({
        id: typeof meta.id === 'string' && meta.id ? meta.id : 'o' + String(entry.uid),
        type: normalizeType(meta.t || meta.type) || (named ? normalizeType(named[1]) : '') || 'bond',
        title: named ? named[2] : (meta.title || name),
        content: entryBody(entry.content),
        keys: (Array.isArray(strategy.keys) ? strategy.keys : []).filter(function (key) { return typeof key === 'string'; }),
        importance: meta.imp !== undefined ? meta.imp : meta.intensity,
        pinned: strategy.type === 'constant',
        enabled: enabled,
        createdAt: meta.c || meta.start,
        updatedAt: meta.u || meta.end || meta.c || meta.start,
        origin: meta.origin || meta.chat || '',
        source: meta.src,
        owner: owner,
        uid: entry.uid,
        store: 'ocean'
      }, 'ocean');
    }

    function stamp(time) {
      try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch (error) { return String(time); }
    }

    function recordToEntry(record, existing) {
      var meta = { id: record.id, t: record.type, imp: record.importance, c: record.createdAt, u: record.updatedAt };
      if (record.origin) meta.origin = record.origin;
      if (record.source) meta.src = record.source;
      meta.o = record.owner;
      if (record.owner === 'agent' && record.enabled === false) meta.off = 1;
      var entry = existing ? existing : {};
      entry.name = TYPES[record.type] + '-' + record.title;
      entry.content = '<!--yzy ' + JSON.stringify(meta) + ' -->\n> 记录于 ' + stamp(record.createdAt) + ' ｜ ' + TYPES[record.type] + '\n' + record.content;
      entry.enabled = record.enabled !== false && storyVisible(record);
      entry.strategy = modules.isObject(entry.strategy) ? entry.strategy : {};
      entry.strategy.type = record.pinned ? 'constant' : 'selective';
      entry.strategy.keys = record.keys.slice();
      if (!existing) entry.position = { type: 'at_depth', role: 'system', depth: 4, order: 100 };
      return entry;
    }

    /* 这条记忆能不能进正文（脚本注入或酒馆原生触发）。 */
    function storyVisible(record) {
      return record.owner !== 'agent' || (settings.unify && record.type !== 'howto');
    }

    /* 让《夜之洋》里 agent 条目的世界书开关符合 unify；没有要改的就不写。返回改了几条。 */
    async function syncOceanVisibility() {
      var book = findOceanBook();
      if (!book) return 0;
      var stale = function (entry) {
        var record = entryToRecord(entry);
        return !!record && record.owner === 'agent' && ((entry.enabled !== false) !== (record.enabled && storyVisible(record)) || !parseMeta(entry.content) || parseMeta(entry.content).o !== 'agent');
      };
      if (!(await kit.readWorldbook(book)).some(stale)) return 0;
      var changed = 0;
      await kit.updateWorldbook(book, function (entries) {
        entries.forEach(function (entry) {
          if (!stale(entry)) return;
          recordToEntry(entryToRecord(entry), entry);
          changed += 1;
        });
        return entries;
      });
      oceanCache.records = null;
      return changed;
    }

    async function oceanRecords(force) {
      var book = findOceanBook();
      if (!book) { oceanCache.records = []; oceanCache.book = ''; return []; }
      var key = kit.chatKey();
      if (!force && oceanCache.records && oceanCache.book === book && Date.now() - oceanCache.at < 15000) return oceanCache.records;
      var entries = await kit.readWorldbook(book);
      var records = [];
      entries.forEach(function (entry) {
        var record = entryToRecord(entry);
        if (record) records.push(record);
      });
      oceanCache = { key: key, at: Date.now(), records: records, book: book };
      return records;
    }

    async function oceanPut(record) {
      var book = await ensureOceanBook();
      var current = await oceanRecords(true);
      var existing = null;
      current.forEach(function (item) { if (item.id === record.id) existing = item; });
      if (existing) {
        var found = false;
        await kit.updateWorldbook(book, function (entries) {
          entries.forEach(function (entry) {
            if (found || entry.uid !== existing.uid) return;
            found = true;
            recordToEntry(record, entry);
          });
          return entries;
        });
        if (!found) throw new Error('《' + book + '》里找不到这条记忆，可能已被删除');
        record.uid = existing.uid;
      } else {
        var made = await kit.addWorldbookEntries(book, [recordToEntry(record, null)]);
        if (made[0] && made[0].uid !== undefined) record.uid = made[0].uid;
      }
      record.store = 'ocean';
      oceanCache.records = null;
      /* 回读确认：写入必须真的落在世界书里。 */
      var verify = await oceanRecords(true);
      if (!verify.some(function (item) { return item.id === record.id; })) throw new Error('写入《' + book + '》后回读不到这条记忆');
      return record;
    }

    async function oceanRemove(id) {
      var book = findOceanBook();
      if (!book) return false;
      var current = await oceanRecords(true);
      var target = null;
      current.forEach(function (item) { if (item.id === id) target = item; });
      if (!target) return false;
      await kit.updateWorldbook(book, function (entries) {
        return entries.filter(function (entry) { return entry.uid !== target.uid; });
      });
      oceanCache.records = null;
      return true;
    }

    /* ---------- 统一读写 ---------- */
    async function listAll(options) {
      var data = readChatData();
      var chatItems = Object.keys(data.items).map(function (id) { return data.items[id]; });
      var ocean = [];
      if (!options || options.store !== 'chat') {
        try { ocean = await oceanRecords(options && options.fresh === true); }
        catch (error) { log('读取《夜之洋》失败', error); ocean = []; }
      }
      var output = (options && options.store === 'ocean' ? [] : chatItems).concat(ocean);
      if (options && options.type) output = output.filter(function (record) { return record.type === options.type; });
      if (options && options.query) {
        var query = String(options.query).toLowerCase();
        output = output.filter(function (record) {
          return (record.title + '\n' + record.content + '\n' + record.keys.join(' ')).toLowerCase().indexOf(query) >= 0;
        });
      }
      return output.sort(function (left, right) {
        return (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0) || right.updatedAt - left.updatedAt;
      }).map(function (record) { return modules.clone(record); });
    }

    async function find(id) {
      var all = await listAll({ fresh: false });
      var target = String(id || '').trim();
      var hit = null;
      all.forEach(function (record) { if (!hit && record.id === target) hit = record; });
      if (hit) return hit;
      /* 助手可能给的是标题。 */
      all.forEach(function (record) { if (!hit && record.title === target) hit = record; });
      all.forEach(function (record) { if (!hit && target && record.title.indexOf(target) >= 0) hit = record; });
      return hit;
    }

    async function put(record) {
      if (record.store === 'ocean') {
        await oceanPut(record);
      } else {
        var data = readChatData();
        record.store = 'chat';
        data.items[record.id] = record;
        writeChatData(data);
      }
      return record;
    }

    function originLabel() {
      var names = kit.names();
      return names.char + (names.chat ? ' · ' + names.chat : '');
    }

    async function add(input, options) {
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      var record = normalizeRecord(Object.assign({}, input, { id: undefined, store: store }), store);
      if (!record) throw new Error('记忆内容不能为空');
      if (!record.origin) record.origin = originLabel();
      await put(record);
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(record);
    }

    async function update(id, patch) {
      var current = await find(id);
      if (!current) throw new Error('没有这条记忆：' + id);
      var source = modules.isObject(patch) ? patch : {};
      var next = normalizeRecord(Object.assign({}, current, {
        type: source.type !== undefined ? source.type : current.type,
        title: source.title !== undefined ? source.title : current.title,
        content: source.content !== undefined ? source.content : current.content,
        keys: source.keys !== undefined ? source.keys : current.keys,
        importance: source.importance !== undefined ? source.importance : current.importance,
        pinned: source.pinned !== undefined ? source.pinned === true : current.pinned,
        enabled: source.enabled !== undefined ? source.enabled !== false : current.enabled,
        owner: source.owner === 'agent' || source.owner === 'story' ? source.owner : current.owner,
        updatedAt: Date.now()
      }), current.store);
      if (!next) throw new Error('记忆内容不能为空');
      await put(next);
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(next);
    }

    async function remove(id) {
      var current = await find(id);
      if (!current) return false;
      if (current.store === 'ocean') await oceanRemove(current.id);
      else {
        var data = readChatData();
        delete data.items[current.id];
        writeChatData(data);
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return true;
    }

    /* 在聊天与《夜之洋》之间搬动一条记忆：先写入目标并确认，再删除原件。 */
    async function move(id, store) {
      var target = store === 'ocean' ? 'ocean' : 'chat';
      var current = await find(id);
      if (!current) throw new Error('没有这条记忆：' + id);
      if (current.store === target) return current;
      var copy = normalizeRecord(Object.assign({}, current, { store: target, uid: undefined, updatedAt: Date.now() }), target);
      await put(copy);
      if (current.store === 'ocean') await oceanRemove(current.id);
      else {
        var data = readChatData();
        delete data.items[current.id];
        writeChatData(data);
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(copy);
    }

    /* ---------- 召回 ---------- */
    async function search(query, options) {
      var text = String(query || '').trim();
      var limit = clampInt(options && options.limit, 1, 30, 6);
      var all = (await listAll({ store: options && options.store, type: options && options.type })).filter(function (record) { return record.enabled; });
      if (!text) return all.slice(0, limit).map(function (record) { return Object.assign(record, { score: 0 }); });
      var grams = gramSet(text);
      var now = Date.now();
      var scored = [];
      all.forEach(function (record) {
        var result = scoreRecord(record, text, grams, now);
        if (result.relevance >= 0.6) scored.push(Object.assign(record, { score: Math.round(result.score * 100) / 100 }));
      });
      scored.sort(function (left, right) { return right.score - left.score; });
      return scored.slice(0, limit);
    }

    function recentContext(maxChars) {
      var length = kit.chatLength();
      var messages = kit.readChat(Math.max(0, length - 3), length);
      return messages.map(function (message) { return kit.cleanText(message.text); }).join('\n').slice(-(maxChars || 1500));
    }

    function formatLine(record) {
      return '- [' + TYPE_SHORT[record.type] + (record.owner === 'agent' ? '·助手那边' : '') + '] ' + record.title + '：' + record.content.replace(/\s*\n\s*/g, ' ');
    }

    /* 生成注入正文的记忆块；candidates 已排除由酒馆原生触发的部分。 */
    async function buildInjection(contextText) {
      if (!settings.enabled || !settings.inject) return { text: '', items: [] };
      var data = readChatData();
      var candidates = Object.keys(data.items).map(function (id) { return data.items[id]; });
      if (!oceanNative()) {
        try { candidates = candidates.concat(await oceanRecords(false)); } catch (error) { /* 世界书读不到时只用聊天库 */ }
      }
      candidates = candidates.filter(function (record) { return record.enabled && storyVisible(record); });
      var text = String(contextText === undefined ? recentContext(1500) : contextText);
      var grams = gramSet(text);
      var now = Date.now();
      var picked = [];
      var budget = settings.injectBudget;
      var summary = settings.injectSummary && data.summary.text ? data.summary.text : '';
      if (summary) budget -= summary.length;
      if (settings.unify) budget -= UNIFY_LINE.length;
      /* 打开 unify 后，助手那边的记忆最多占一半名额，免得挤掉正文的记忆。 */
      var agentCap = Math.max(1, Math.ceil(settings.injectMax / 2));
      var agentPicked = 0;
      candidates.filter(function (record) { return record.pinned; }).forEach(function (record) {
        var line = formatLine(record);
        if (picked.length < settings.injectMax && budget - line.length >= 0) { picked.push(record); budget -= line.length; }
      });
      candidates.filter(function (record) { return !record.pinned; }).map(function (record) {
        return { record: record, result: scoreRecord(record, text, grams, now) };
      }).filter(function (item) {
        /* 需要实打实的相关：命中触发词，或字面重合足够高。 */
        return item.result.keyHits > 0 || item.result.similarity >= 0.18;
      }).sort(function (left, right) { return right.result.score - left.result.score; }).forEach(function (item) {
        var line = formatLine(item.record);
        if (item.record.owner === 'agent' && agentPicked >= agentCap) return;
        if (picked.length < settings.injectMax && budget - line.length >= 0) {
          picked.push(item.record);
          budget -= line.length;
          if (item.record.owner === 'agent') agentPicked += 1;
        }
      });
      if (!picked.length && !summary && !settings.unify) return { text: '', items: [] };
      var lines = ['<夜之洋的记忆>'];
      if (settings.unify) lines.push(UNIFY_LINE);
      if (picked.length || summary) lines.push('以下是此前对话沉淀的记忆，只用于保持前后连贯；不要逐条复述，也不要提到“记忆”本身。');
      if (summary) lines.push('【前情梗概】' + summary);
      picked.forEach(function (record) { lines.push(formatLine(record)); });
      lines.push('</夜之洋的记忆>');
      return { text: lines.join('\n'), items: picked.map(function (record) { return record.id; }) };
    }

    async function refreshInjection(contextText) {
      var key = kit.chatKey();
      var block;
      try { block = autoAllowed() ? await buildInjection(contextText) : { text: '', items: [] }; }
      catch (error) { log('生成记忆注入失败', error); block = { text: '', items: [] }; }
      if (key !== kit.chatKey()) return block;
      if (lastInjection.key === key && lastInjection.text === block.text) return block;
      lastInjection = { key: key, text: block.text };
      try {
        if (!block.text) await kit.uninject([INJECT_ID]);
        else await kit.inject([{ id: INJECT_ID, position: 'in_chat', depth: settings.injectDepth, role: 'system', content: block.text, should_scan: false }]);
      } catch (error) { log('写入记忆注入失败', error); }
      return block;
    }

    /* ---------- 整理 ---------- */
    function pendingWindow(data, force) {
      var length = kit.chatLength();
      var from = Math.min(data.cursor.index, length);
      var upto = Math.max(from, force ? length : length - settings.keepRecent);
      var messages = kit.readChat(from, upto).map(function (message) {
        return { id: message.id, role: message.role, name: message.name, text: kit.cleanText(message.text) };
      }).filter(function (message) { return message.text; });
      var turns = 0, chars = 0;
      messages.forEach(function (message) { if (message.role === 'assistant') turns += 1; chars += message.text.length; });
      return { from: from, upto: upto, messages: messages, turns: turns, chars: chars, length: length };
    }

    function shorten(text, limit) {
      if (text.length <= limit) return text;
      var head = Math.floor(limit * 0.65);
      return text.slice(0, head) + '\n……（中间略）……\n' + text.slice(text.length - (limit - head));
    }

    function buildBatches(messages, names) {
      var batches = [];
      var current = { lines: [], chars: 0, end: 0 };
      messages.forEach(function (message) {
        var speaker = message.name || (message.role === 'user' ? names.user : names.char);
        var line = '#' + message.id + ' ' + speaker + ': ' + shorten(message.text, 2400);
        if (current.lines.length && current.chars + line.length > settings.windowChars) {
          batches.push(current);
          current = { lines: [], chars: 0, end: 0 };
        }
        current.lines.push(line);
        current.chars += line.length;
        current.end = message.id + 1;
      });
      if (current.lines.length) batches.push(current);
      return batches;
    }

    function existingDigest(records, text) {
      var grams = gramSet(text);
      var now = Date.now();
      return records.map(function (record) {
        return { record: record, score: scoreRecord(record, text, grams, now).score + (record.pinned ? 5 : 0) };
      }).sort(function (left, right) { return right.score - left.score || right.record.updatedAt - left.record.updatedAt; })
        .slice(0, 40).map(function (item) {
          var record = item.record;
          return record.id + '｜' + TYPE_SHORT[record.type] + '｜' + record.title + '｜' + record.content.replace(/\s+/g, ' ').slice(0, 70);
        });
    }

    /* unify 关时，正文整理与助手对话整理各管各的记忆：互相看不到，也不会改到对方那边。 */
    function sameSide(source) {
      var owner = source === 'agent' ? 'agent' : 'story';
      return function (record) { return settings.unify || record.owner === owner; };
    }

    async function applyOps(ops, source, report) {
      var store = targetStore();
      var all = (await listAll({ fresh: true })).filter(sameSide(source));
      var written = 0;
      for (var index = 0; index < ops.length; index += 1) {
        var op = ops[index];
        if (written >= settings.maxPerRun) { report.skipped += 1; continue; }
        try {
          var target = null;
          if (op.op === 'update' && op.id) all.forEach(function (record) { if (!target && record.id === op.id) target = record; });
          if (!target && op.title) {
            /* 同类型同标题视为同一件事，更新而不是新建。 */
            var normalizedTitle = op.title.replace(/\s+/g, '');
            all.forEach(function (record) {
              if (!target && record.title.replace(/\s+/g, '') === normalizedTitle && (!op.type || record.type === op.type)) target = record;
            });
          }
          if (target) {
            if (!op.content.trim()) { report.skipped += 1; continue; }
            var updated = await update(target.id, {
              content: op.content,
              keys: op.keys.length ? cleanKeys(target.keys.concat(op.keys)) : target.keys,
              importance: op.importance !== undefined ? op.importance : target.importance
            });
            report.updated.push(updated.title);
            written += 1;
            continue;
          }
          if (op.op === 'update') { report.skipped += 1; continue; }
          var record = normalizeRecord({ type: op.type || 'episode', title: op.title, content: op.content, keys: op.keys, importance: op.importance, source: source, origin: originLabel(), store: store }, store);
          if (!record) { report.skipped += 1; continue; }
          await put(record);
          all.push(record);
          report.added.push(record.title);
          written += 1;
        } catch (error) {
          report.errors.push((op.title || op.id || '记忆') + '：' + String(error && error.message || error).slice(0, 160));
        }
      }
    }

    async function extractOnce(header, body, summary, source, report, signal) {
      var existing = existingDigest((await listAll({ fresh: false })).filter(sameSide(source)), body);
      var user = [
        '【此前梗概】' + (summary || '无'),
        '【已有记忆】（id｜类型｜标题｜摘要）',
        existing.length ? existing.join('\n') : '（无）',
        header,
        body
      ].join('\n');
      var text = await llm.chat({
        messages: [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: user }],
        route: 'memory',
        temperature: 0.2,
        maxTokens: 3000,
        timeoutMs: 240000,
        retries: 1,
        signal: signal,
        generationId: 'reader-memory'
      });
      var parsed = parseExtraction(text);
      report.proposed += parsed.ops.length;
      return parsed;
    }

    /*
     * 整理当前聊天里尚未处理的对话。options: { reason, force（连最近几条一起整理）, signal }
     * 同一时刻只运行一份；中途切换聊天则丢弃结果，不会写进别的存档。
     */
    function consolidate(options) {
      if (running) return running;
      var job = (async function () {
        var opts = options || {};
        var report = { ok: true, reason: opts.reason || 'manual', at: Date.now(), store: targetStore(), proposed: 0, added: [], updated: [], skipped: 0, errors: [], window: 0 };
        var key = kit.chatKey();
        try {
          if (!settings.enabled) throw new Error('记忆系统已关闭');
          var data = readChatData();
          var pending = pendingWindow(data, opts.force === true);
          if (!pending.messages.length) {
            if (pending.upto > data.cursor.index) { data.cursor.index = pending.upto; writeChatData(data); }
            report.note = '没有新的对话需要整理';
            return report;
          }
          var names = kit.names();
          var allBatches = buildBatches(pending.messages, names);
          var batches = allBatches.slice(0, 3);
          for (var index = 0; index < batches.length; index += 1) {
            var batch = batches[index];
            var parsed = await extractOnce('【待整理对话】（#楼层 发言者: 内容）', batch.lines.join('\n'), data.summary.text, 'story', report, opts.signal);
            if (kit.chatKey() !== key) throw new Error('聊天已切换，这次整理的结果没有写入');
            await applyOps(parsed.ops, 'story', report);
            data = readChatData();
            data.cursor.index = index === allBatches.length - 1 ? pending.upto : batch.end;
            if (parsed.summary !== null && parsed.summary) data.summary = { text: parsed.summary, upto: data.cursor.index, at: Date.now() };
            report.window += batch.lines.length;
            writeChatData(data);
          }
          if (kit.chatLength() - settings.keepRecent > readChatData().cursor.index) report.note = '对话较长，剩余部分下次继续整理';
        } catch (error) {
          report.ok = false;
          report.error = String(error && error.message || error).slice(0, 300);
          if (error && error.name === 'AbortError') report.error = '已取消';
        }
        try {
          if (kit.chatKey() === key) {
            var latest = readChatData();
            latest.last = { at: report.at, reason: report.reason, ok: report.ok, added: report.added.length, updated: report.updated.length, error: report.error || '', note: report.note || '' };
            writeChatData(latest);
          }
        } catch (error) { /* 状态记录失败不影响结果 */ }
        refreshInjection().catch(function () {});
        emit('consolidated');
        return report;
      })();
      running = job;
      job.then(function () { if (running === job) running = null; }, function () { if (running === job) running = null; });
      return job;
    }

    /* 把一段助手对话沉淀为记忆（情感 / 功能 / 用户偏好）。turns: [{role, text}] */
    async function consolidateDialogue(turns, options) {
      var report = { ok: true, reason: options && options.reason || 'agent', at: Date.now(), store: targetStore(), proposed: 0, added: [], updated: [], skipped: 0, errors: [], window: 0 };
      try {
        if (!settings.enabled) throw new Error('记忆系统已关闭');
        var names = kit.names();
        var lines = (Array.isArray(turns) ? turns : []).filter(function (turn) { return turn && typeof turn.text === 'string' && turn.text.trim(); })
          .map(function (turn) { return (turn.role === 'assistant' ? '九十九夜梦' : names.user) + ': ' + shorten(turn.text.trim(), 1600); });
        if (!lines.length) { report.note = '没有可整理的助手对话'; return report; }
        var key = kit.chatKey();
        var parsed = await extractOnce('【待整理对话】这是用户与助手九十九夜梦的对话；重点留意情感时刻、用户偏好，以及可复用的做法与结论。', lines.join('\n').slice(-settings.windowChars), '', 'agent', report, options && options.signal);
        if (kit.chatKey() !== key) throw new Error('聊天已切换，这次整理的结果没有写入');
        await applyOps(parsed.ops, 'agent', report);
        report.window = lines.length;
      } catch (error) {
        report.ok = false;
        report.error = String(error && error.message || error).slice(0, 300);
      }
      emit('consolidated');
      return report;
    }

    /*
     * 记忆随扩展全局加载，但「自动整理」（要调用模型）和「带入正文」默认只在用了 Reader-II 的聊天里进行：
     * 卡内组件在聊天变量里留有 reader_ii_runtime（语义层）或 dream_persona（大厅设置）。
     * 别的卡的聊天里，记忆只在用户或助手主动读写时才动。
     */
    function autoAllowed() {
      if (settings.scope === 'all') return true;
      try { return kit.readChatValue('reader_ii_runtime') !== undefined || kit.readChatValue('dream_persona') !== undefined; }
      catch (error) { return false; }
    }

    function autoCheck() {
      if (!settings.enabled || !settings.autoExtract || running || generating || !autoAllowed()) return;
      if (settings.everyTurns <= 0 && settings.everyChars <= 0) return;
      var pending;
      try { pending = pendingWindow(readChatData(), false); } catch (error) { return; }
      var byTurns = settings.everyTurns > 0 && pending.turns >= settings.everyTurns;
      var byChars = settings.everyChars > 0 && pending.chars >= settings.everyChars;
      if (!byTurns && !byChars) return;
      consolidate({ reason: 'auto' }).then(function (report) {
        if (!report.ok) log('自动整理失败', report.error);
      });
    }

    function scheduleAuto(delayMs) {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { autoTimer = null; autoCheck(); }, delayMs);
    }

    function repairCursor() {
      try {
        var data = readChatData();
        var length = kit.chatLength();
        if (data.cursor.index > length) { data.cursor.index = length; writeChatData(data); }
      } catch (error) { /* 没有打开聊天 */ }
    }

    async function status() {
      var data = readChatData();
      var pending = pendingWindow(data, false);
      var book = findOceanBook();
      var ocean = [];
      try { ocean = await oceanRecords(false); } catch (error) { ocean = []; }
      return {
        enabled: settings.enabled,
        store: targetStore(),
        chatOverride: data.cfg.store || '',
        chatCount: Object.keys(data.items).length,
        oceanCount: ocean.length,
        oceanBook: book || settings.oceanBook,
        oceanExists: !!book,
        oceanNative: oceanNative(),
        pending: { turns: pending.turns, chars: pending.chars, from: pending.from, upto: pending.upto },
        thresholds: { turns: settings.everyTurns, chars: settings.everyChars, auto: settings.autoExtract && (settings.everyTurns > 0 || settings.everyChars > 0) },
        summary: data.summary.text,
        last: data.last,
        running: !!running
      };
    }

    async function exportAll() {
      return { v: 1, kind: 'reader-ii-memory', exportedAt: new Date().toISOString(), summary: readChatData().summary.text, items: await listAll({ fresh: true }) };
    }

    async function importAll(payload, options) {
      var source = typeof payload === 'string' ? JSON.parse(payload) : payload;
      var items = modules.isObject(source) && Array.isArray(source.items) ? source.items : Array.isArray(source) ? source : null;
      if (!items) throw new Error('导入内容不是记忆导出文件');
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      var existing = await listAll({ fresh: true });
      var report = { added: 0, skipped: 0, errors: [] };
      for (var index = 0; index < items.length && index < 2000; index += 1) {
        var record = normalizeRecord(Object.assign({}, items[index], { id: undefined, uid: undefined, store: store, source: 'import', owner: ownerOf(modules.isObject(items[index]) ? items[index] : {}) }), store);
        if (!record) { report.skipped += 1; continue; }
        var duplicate = existing.some(function (item) { return item.type === record.type && item.title === record.title && item.content === record.content; });
        if (duplicate) { report.skipped += 1; continue; }
        try { await put(record); existing.push(record); report.added += 1; }
        catch (error) { report.errors.push(record.title + '：' + String(error && error.message || error).slice(0, 120)); }
      }
      refreshInjection().catch(function () {});
      emit('changed');
      return report;
    }

    function setSummary(text) {
      var data = readChatData();
      data.summary = { text: String(text || '').trim().slice(0, 1200), upto: data.cursor.index, at: Date.now() };
      writeChatData(data);
      refreshInjection().catch(function () {});
      emit('changed');
      return data.summary.text;
    }

    function resetCursor(index) {
      var data = readChatData();
      data.cursor.index = clampInt(index, 0, kit.chatLength(), 0);
      writeChatData(data);
      emit('changed');
      return data.cursor.index;
    }

    var installed = false;
    function install() {
      if (installed) return;
      installed = true;
      kit.on('GENERATION_STARTED', function () { generating = true; });
      ['GENERATION_ENDED', 'GENERATION_STOPPED'].forEach(function (name) {
        kit.on(name, function () { generating = false; scheduleAuto(2500); });
      });
      kit.on('MESSAGE_RECEIVED', function () { scheduleAuto(4000); });
      ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED'].forEach(function (name) {
        kit.on(name, function () { repairCursor(); refreshInjection().catch(function () {}); });
      });
      kit.on('CHAT_CHANGED', function () {
        generating = false;
        oceanCache.records = null;
        lastInjection = { key: '', text: '' };
        repairCursor();
        refreshInjection().catch(function () {});
        emit('chat');
      });
      /* 酒馆会等待这个事件的监听器，注入因此赶得上本轮提示词。 */
      kit.on('GENERATION_AFTER_COMMANDS', function (type, generationOptions, dryRun) {
        if (dryRun) return undefined;
        return refreshInjection();
      });
      kit.on('WORLDINFO_UPDATED', function () { oceanCache.records = null; });
      refreshInjection().catch(function () {});
      /* 旧版写进《夜之洋》的助手记忆是启用的；按 unify 校正一次（没有要改的就不写）。 */
      setTimeout(function () {
        syncOceanVisibility().catch(function (error) { log('同步《夜之洋》里助手记忆的开关失败', error); });
      }, 3000);
    }

    async function dispose() {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
      try { await kit.uninject([INJECT_ID]); } catch (error) { /* best-effort */ }
    }

    return {
      TYPES: TYPES,
      TYPE_SHORT: TYPE_SHORT,
      injectId: INJECT_ID,
      chatKey: CHAT_KEY,
      settingsKey: SETTINGS_KEY,
      getSettings: getSettings,
      saveSettings: saveSettings,
      targetStore: targetStore,
      setChatStoreOverride: setChatStoreOverride,
      list: listAll,
      get: find,
      add: add,
      update: update,
      remove: remove,
      move: move,
      search: search,
      buildInjection: buildInjection,
      refreshInjection: refreshInjection,
      consolidate: consolidate,
      consolidateDialogue: consolidateDialogue,
      status: status,
      exportAll: exportAll,
      importAll: importAll,
      setSummary: setSummary,
      resetCursor: resetCursor,
      ensureOceanBook: ensureOceanBook,
      syncOceanVisibility: syncOceanVisibility,
      unifyLine: UNIFY_LINE,
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      },
      install: install,
      dispose: dispose
    };
  }

  modules.READER_MEMORY_TYPES = TYPES;
  modules.normalizeMemorySettings = normalizeSettings;
  modules.normalizeMemoryRecord = normalizeRecord;
  modules.parseMemoryExtraction = parseExtraction;
  modules.memoryGramSet = gramSet;
  modules.createMemorySystem = createMemorySystem;
})(typeof globalThis !== 'undefined' ? globalThis : window);
