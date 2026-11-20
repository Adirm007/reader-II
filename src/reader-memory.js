(function (root) {
  'use strict';

  /* 夜之洋只记录用户与夜梦助手的交流。正文夜梦可以只读召回这些交流，
   * 跨存档世界书条目始终停用原生触发，统一由同一人格开关控制。 */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_KEY = 'reader_ii_memory_settings_v1';
  var CHAT_KEY = 'reader_ii_assistant_memory_v2';
  var MEMORY_VERSION = 2;
  var OCEAN_SCHEMA = 'reader-ii-assistant-memory';
  var INJECT_ID = 'reader-ii-memory';
  var TYPES = { episode: '交流记忆', fact: '偏好与事实', bond: '情感记忆', howto: '功能记忆' };
  var TYPE_SHORT = { episode: '交流', fact: '事实', bond: '情感', howto: '功能' };
  var TYPE_KEYS = Object.keys(TYPES);
  var LEGACY_TYPES = { emotion: 'bond', 'function': 'howto', story: 'episode', setting: 'fact', '剧情记忆': 'episode', '设定记忆': 'fact', '剧情': 'episode', '设定': 'fact' };
  var META_PATTERN = /^\s*<!--yzy\s+(\{[\s\S]*?\})\s*-->[ \t]*\n?/;
  var NOTE_PATTERN = /^\s*>\s*记录于[^\n]*\n?/;
  var NAME_PATTERN = /^(剧情记忆|设定记忆|情感记忆|功能记忆|交流记忆|偏好与事实)\s*[-·:：]\s*(.+)$/;
  var UNIFY_LINE = '正文中的九十九夜梦与夜梦助手是同一个人。以下是她与屏幕外真实用户的私下交流。真实用户与其在正文中扮演的角色（{{user}}）身份有别。仅九十九夜梦拥有这些戏外记忆；保持故事视角，她不主动超游，其他角色与旁白不从中获知剧情事实。';

  var DEFAULTS = {
    enabled: true,
    store: 'chat',
    agentEveryTurns: 4,
    windowChars: 24000,       /* 一次请求最多送入多少字的对话 */
    maxPerRun: 10,            /* 一次整理最多写入几条 */
    injectDepth: 2,
    injectMax: 6,
    injectBudget: 1500,
    oceanBook: '夜之洋',
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
    output.store = source.store === 'ocean' ? 'ocean' : 'chat';
    output.agentEveryTurns = clampInt(source.agentEveryTurns, 1, 40, DEFAULTS.agentEveryTurns);
    output.windowChars = clampInt(source.windowChars, 2000, 400000, DEFAULTS.windowChars);
    output.maxPerRun = clampInt(source.maxPerRun, 1, 40, DEFAULTS.maxPerRun);
    output.injectDepth = clampInt(source.injectDepth, 0, 40, DEFAULTS.injectDepth);
    output.injectMax = clampInt(source.injectMax, 1, 30, DEFAULTS.injectMax);
    output.injectBudget = clampInt(source.injectBudget, 200, 20000, DEFAULTS.injectBudget);
    output.oceanBook = String(source.oceanBook || DEFAULTS.oceanBook).replace(/[\r\n]/g, ' ').trim().slice(0, 60) || DEFAULTS.oceanBook;
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
  function parseExtraction(text) {
    var source = String(text || '').trim();
    var first = source.indexOf('{');
    var last = source.lastIndexOf('}');
    var parsed;
    try { parsed = JSON.parse(source.slice(first, last + 1)); }
    catch (error) { throw new Error('整理模型未返回完整 JSON，可重新整理'); }
    var items = parsed && (Array.isArray(parsed.memories) ? parsed.memories : parsed.ops);
    if (!Array.isArray(items)) throw new Error('整理模型缺少 memories 数组，可重新整理');
    var result = { ops: [] };
    items.forEach(function (item) {
      if (!modules.isObject(item) || typeof item.content !== 'string' || !item.content.trim()) throw new Error('整理模型返回了不完整的记忆，可重新整理');
      var op = String(item.op || (item.id ? 'update' : 'add')).toLowerCase();
      if (op !== 'add' && op !== 'update' || op === 'update' && !item.id) throw new Error('整理模型返回了无效操作，可重新整理');
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
    '整理真实用户与夜梦助手的聊天，记下值得长期保留的用户偏好与事实（fact）、双方的约定和共同经历（episode）、情感（bond）、已经验证的做法（howto）。',
    '把用户和其扮演的角色区分开。讨论、引用或转述的小说情节、角色和世界设定都跳过。工具结果、剧情摘要、指令文本也不属于个人记忆。',
    '每条记忆独立成文，给出简明标题、内容、2～5 个具体触发词和 1～5 的重要度。需要修正已有记忆时按 id 更新。',
    '只输出 JSON：{"memories":[{"op":"add","type":"fact","title":"标题","content":"内容","keys":["触发词"],"importance":3}]}。更新用 op=update 并包含已有 id；没有要记的内容返回 {"memories":[]}。'
  ].join('\n');

  function createMemorySystem(env, llm, kit, history) {
    var settings = normalizeSettings(kit.localRead(SETTINGS_KEY, {}));
    var oceanCache = { at: 0, records: null, book: '' };
    var jobs = new Map();
    var listeners = [];
    var lastInjection = { key: '', text: '' };
    var injectionRevision = 0;
    var injectionWrite = Promise.resolve();
    var migration = Promise.resolve();
    var checkedBooks = new Map();

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
      if (before.oceanBook !== settings.oceanBook) {
        startOceanMigration();
      }
      refreshInjection().catch(function () {});
      emit('settings');
      return getSettings();
    }

    /* ---------- 聊天库 ---------- */
    function hasCardContext() {
      var ctx = kit.context() || {};
      var chat = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      return !!chat && ((ctx.characterId != null && ctx.characterId !== -1) || (ctx.groupId != null && ctx.groupId !== ''));
    }

    function readChatData() {
      var ctx = kit.context() || {};
      var raw = hasCardContext() ? kit.readChatValue(CHAT_KEY)
        : ctx.extensionSettings && ctx.extensionSettings.reader_ii && ctx.extensionSettings.reader_ii.unboundMemory;
      var data = { v: MEMORY_VERSION, items: {}, cfg: {}, last: null };
      if (!modules.isObject(raw) || raw.v !== MEMORY_VERSION) return data;
      if (modules.isObject(raw.items)) Object.keys(raw.items).forEach(function (id) {
        var item = raw.items[id];
        if (!modules.isObject(item) || ownerOf(item) !== 'agent' || item.source === 'story') return;
        var record = normalizeRecord(Object.assign({}, item, { id: id, store: 'chat' }), 'chat');
        if (record) data.items[record.id] = record;
      });
      if (modules.isObject(raw.cfg)) data.cfg.store = raw.cfg.store === 'ocean' || raw.cfg.store === 'chat' ? raw.cfg.store : '';
      if (modules.isObject(raw.last)) data.last = modules.clone(raw.last);
      return data;
    }

    function writeChatData(data) {
      if (!hasCardContext()) {
        var ctx = kit.context() || {};
        if (!ctx.extensionSettings || typeof ctx.saveSettingsDebounced !== 'function') throw new Error('酒馆无法保存无卡助手记忆');
        ctx.extensionSettings.reader_ii = Object.assign({}, ctx.extensionSettings.reader_ii, { unboundMemory: data });
        ctx.saveSettingsDebounced();
        return;
      }
      if (!kit.writeChatValue(CHAT_KEY, data)) throw new Error('当前聊天不可写入助手记忆');
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

    function findOceanBook(names) {
      names = names || kit.worldbookNames();
      if (names.indexOf(settings.oceanBook) >= 0) return settings.oceanBook;
      var wanted = normalizedBookName(settings.oceanBook);
      for (var index = 0; index < names.length; index += 1) {
        if (normalizedBookName(names[index]) === wanted) return names[index];
      }
      return '';
    }

    async function ensureOceanBook() {
      await kit.prepareWorldbooks();
      var name = findOceanBook();
      if (!name) {
        name = settings.oceanBook;
        await kit.createWorldbook(name);
        oceanCache.records = null;
      }
      return name;
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
      if (!meta || meta.schema !== OCEAN_SCHEMA || meta.v !== MEMORY_VERSION || meta.o !== 'agent' || !meta.id) return null;
      var named = name.match(NAME_PATTERN);
      var strategy = entry.strategy || {};
      return normalizeRecord({
        id: meta.id,
        type: meta.t,
        title: named ? named[2] : name,
        content: entryBody(entry.content),
        keys: (Array.isArray(strategy.keys) ? strategy.keys : []).filter(function (key) { return typeof key === 'string'; }),
        importance: meta.imp,
        pinned: strategy.type === 'constant',
        enabled: !meta.off,
        createdAt: meta.c,
        updatedAt: meta.u,
        origin: meta.origin,
        source: meta.src,
        owner: 'agent',
        uid: entry.uid,
        store: 'ocean'
      }, 'ocean');
    }

    function stamp(time) {
      try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch (error) { return String(time); }
    }

    function recordToEntry(record, existing) {
      var meta = { schema: OCEAN_SCHEMA, v: MEMORY_VERSION, id: record.id, t: record.type, imp: record.importance, c: record.createdAt, u: record.updatedAt };
      if (record.origin) meta.origin = record.origin;
      if (record.source) meta.src = record.source;
      meta.o = record.owner;
      if (record.owner === 'agent' && record.enabled === false) meta.off = 1;
      var entry = existing ? existing : {};
      entry.name = TYPES[record.type] + '-' + record.title;
      entry.content = '<!--yzy ' + JSON.stringify(meta) + ' -->\n> 记录于 ' + stamp(record.createdAt) + ' ｜ ' + TYPES[record.type] + '\n' + record.content;
      entry.enabled = false;
      entry.strategy = modules.isObject(entry.strategy) ? entry.strategy : {};
      entry.strategy.type = record.pinned ? 'constant' : 'selective';
      entry.strategy.keys = record.keys.slice();
      if (!existing) entry.position = { type: 'at_depth', role: 'system', depth: 4, order: 100 };
      return entry;
    }

    /* 更名不会解除旧版的全局或角色绑定。在别的书里只认 Reader 自带的 yzy 标记。 */
    async function disableReaderEntries(book, configured) {
      function activeReaderEntry(entry) {
        if (!entry || entry.enabled === false) return false;
        var meta = parseMeta(entry.content);
        if (meta) return meta.schema === OCEAN_SCHEMA || (!meta.schema &&
          ((meta.id && (['story', 'agent', 'manual', 'import'].indexOf(meta.src) >= 0 || normalizeType(meta.t))) ||
            (normalizeType(meta.type) && (meta.start || meta.end))));
        if (!configured) return false;
        var name = String(entry.name || '').match(NAME_PATTERN);
        var note = String(entry.content || '').match(/^\s*>\s*记录于\s+(?:\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?\s+\d{1,2}:\d{2}:\d{2}|\d{13})\s*｜\s*(剧情记忆|设定记忆|情感记忆|功能记忆)\s*(?:\r?\n|$)/);
        return !!(name && note && name[1] === note[1]);
      }
      if (!(await kit.readWorldbook(book)).some(activeReaderEntry)) return 0;
      var changed = 0;
      await kit.updateWorldbook(book, function (entries) {
        entries.forEach(function (entry) {
          if (!activeReaderEntry(entry)) return;
          entry.enabled = false;
          changed += 1;
        });
        return entries;
      });
      oceanCache.records = null;
      return changed;
    }

    /* 同一本书每次加载只查一次。改书、切卡后新挂载的书和未成功的读取在下一次生成前补查。 */
    function scanOceanBooks(mounted, force) {
      migration = migration.then(async function () {
        await kit.prepareWorldbooks();
        var scopes = mounted ? kit.worldbookScopes() : null;
        var selected = findOceanBook(scopes && scopes.all);
        var books = new Set(selected ? [selected] : []);
        if (mounted) scopes.global.concat(await kit.linkedWorldbooks()).forEach(function (book) { if (book) books.add(book); });
        var changed = 0;
        for (var book of books) {
          var configured = book === selected;
          if (!force && checkedBooks.has(book) && (checkedBooks.get(book) || !configured)) continue;
          try {
            changed += await disableReaderEntries(book, configured);
            checkedBooks.set(book, configured);
          } catch (error) { log('停用「' + book + '」的旧记忆触发失败', error); }
        }
        return changed;
      }).catch(function (error) { log('检查旧世界书记忆失败', error); return 0; });
      return migration;
    }

    function startOceanMigration() { return scanOceanBooks(false, false); }
    function syncOceanVisibility() { return scanOceanBooks(true, true); }

    async function oceanRecords(force) {
      var book = findOceanBook();
      if (!book) { oceanCache.records = []; oceanCache.book = ''; return []; }
      var key = kit.chatKey();
      if (!force && oceanCache.records && oceanCache.book === book && Date.now() - oceanCache.at < 15000) return oceanCache.records;
      var entries = await kit.readWorldbook(book);
      var records = [];
      entries.forEach(function (entry) {
        var record = entryToRecord(entry);
        if (record && record.owner === 'agent' && record.source !== 'story') records.push(record);
      });
      oceanCache = { key: key, at: Date.now(), records: records, book: book };
      return records;
    }

    async function oceanPut(record, assertCurrent) {
      var book = await ensureOceanBook();
      var current = await oceanRecords(true);
      var existing = null;
      current.forEach(function (item) { if (item.id === record.id) existing = item; });
      if (assertCurrent) assertCurrent();
      if (existing) {
        var found = false;
        await kit.updateWorldbook(book, function (entries) {
          if (assertCurrent) assertCurrent();
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

    async function put(record, assertCurrent) {
      if (assertCurrent) assertCurrent();
      if (record.store === 'ocean') {
        await oceanPut(record, assertCurrent);
      } else {
        var data = readChatData();
        record.store = 'chat';
        data.items[record.id] = record;
        writeChatData(data);
      }
      return record;
    }

    function originLabel() {
      if (!hasCardContext()) return '无卡助手';
      var names = kit.names();
      return names.char + (names.chat ? ' · ' + names.chat : '');
    }

    async function add(input, options) {
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      if (input && (input.owner === 'story' || input.source === 'story')) throw new Error('夜之洋只保存助手交流记忆');
      var record = normalizeRecord(Object.assign({}, input, { id: undefined, store: store, owner: 'agent' }), store);
      if (!record) throw new Error('记忆内容不能为空');
      if (!record.origin) record.origin = originLabel();
      await put(record);
      refreshInjection().catch(function () {});
      emit('changed');
      return modules.clone(record);
    }

    async function update(id, patch, assertCurrent) {
      var current = await find(id);
      if (assertCurrent) assertCurrent();
      if (!current) throw new Error('没有这条记忆：' + id);
      var source = modules.isObject(patch) ? patch : {};
      if (source.owner === 'story' || source.source === 'story') throw new Error('夜之洋只保存助手交流记忆');
      var next = normalizeRecord(Object.assign({}, current, {
        type: source.type !== undefined ? source.type : current.type,
        title: source.title !== undefined ? source.title : current.title,
        content: source.content !== undefined ? source.content : current.content,
        keys: source.keys !== undefined ? source.keys : current.keys,
        importance: source.importance !== undefined ? source.importance : current.importance,
        pinned: source.pinned !== undefined ? source.pinned === true : current.pinned,
        enabled: source.enabled !== undefined ? source.enabled !== false : current.enabled,
        owner: 'agent',
        updatedAt: Date.now()
      }), current.store);
      if (!next) throw new Error('记忆内容不能为空');
      await put(next, assertCurrent);
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
      return '- [' + TYPE_SHORT[record.type] + '] ' + record.title + '：' + record.content.replace(/\s*\n\s*/g, ' ');
    }

    async function buildInjection(contextText) {
      if (!settings.enabled || !settings.unify || !sharingAllowed()) return { text: '', items: [] };
      var candidates = (await listAll()).filter(function (record) { return record.enabled; });
      var text = String(contextText === undefined ? recentContext(1500) : contextText);
      var grams = gramSet(text);
      var now = Date.now();
      var picked = [];
      var budget = settings.injectBudget - UNIFY_LINE.length;
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
        if (picked.length < settings.injectMax && budget - line.length >= 0) {
          picked.push(item.record);
          budget -= line.length;
        }
      });
      var lines = ['<夜之洋的记忆>', UNIFY_LINE];
      picked.forEach(function (record) { lines.push(formatLine(record)); });
      lines.push('</夜之洋的记忆>');
      return { text: lines.join('\n'), items: picked.map(function (record) { return record.id; }) };
    }

    async function refreshInjection(contextText) {
      var revision = ++injectionRevision;
      var key = kit.chatKey();
      var block = { text: '', items: [] };
      try {
        block = await buildInjection(contextText);
      } catch (error) { log('生成记忆注入失败', error); }
      injectionWrite = injectionWrite.then(async function () {
        if (revision !== injectionRevision || key !== kit.chatKey()) return;
        if (lastInjection.key === key && lastInjection.text === block.text && lastInjection.depth === settings.injectDepth) return;
        if (!block.text) await kit.uninject([INJECT_ID]);
        else await kit.inject([{ id: INJECT_ID, position: 'in_chat', depth: settings.injectDepth, role: 'system', content: block.text, should_scan: false }]);
        lastInjection = { key: key, text: block.text, depth: settings.injectDepth };
      }).catch(function (error) { log('写入记忆注入失败', error); });
      await injectionWrite;
      return block;
    }

    /* ---------- 助手对话整理 ---------- */
    function shorten(text, limit) {
      if (text.length <= limit) return text;
      var head = Math.floor(limit * 0.65);
      return text.slice(0, head) + '\n……（中间略）……\n' + text.slice(text.length - (limit - head));
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

    async function applyOps(ops, report, assertCurrent) {
      var store = targetStore();
      var all = await listAll({ fresh: true });
      var written = 0;
      for (var index = 0; index < ops.length; index += 1) {
        assertCurrent();
        var op = ops[index];
        if (written >= settings.maxPerRun) { report.skipped += 1; continue; }
        try {
          var target = null;
          if (op.op === 'update' && op.id) all.forEach(function (record) { if (!target && record.id === op.id) target = record; });
          if (!target) {
            /* 与 normalizeRecord 的标题规则一致，部分写入后重试也能命中原条目。 */
            var title = op.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) || op.content.trim().replace(/\s+/g, ' ').slice(0, 16);
            var normalizedTitle = title.replace(/\s+/g, '');
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
            }, assertCurrent);
            report.updated.push(updated.title);
            written += 1;
            continue;
          }
          if (op.op === 'update') { report.skipped += 1; continue; }
          var record = normalizeRecord({ type: op.type || 'episode', title: op.title, content: op.content, keys: op.keys, importance: op.importance, source: 'agent', origin: originLabel(), store: store }, store);
          if (!record) { report.skipped += 1; continue; }
          await put(record, assertCurrent);
          all.push(record);
          report.added.push(record.title);
          written += 1;
        } catch (error) {
          report.errors.push((op.title || op.id || '记忆') + '：' + String(error && error.message || error).slice(0, 160));
          throw error;
        }
      }
    }

    async function extractOnce(body, report, signal, assertCurrent) {
      var existing = existingDigest(await listAll(), body);
      assertCurrent();
      var user = ['【已有助手记忆】', existing.join('\n') || '（无）', '【用户与助手的交流】', body].join('\n');
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

    function conversationKey() {
      return JSON.stringify([kit.chatKey(), history.currentId ? history.currentId() : '']);
    }

    async function consolidate(options) {
      var opts = options || {};
      if (history.ready) await history.ready();
      var key = conversationKey();
      if (jobs.has(key)) return jobs.get(key);
      var saved = history.read();
      var turns = saved.turns.slice(saved.extracted);
      var replies = turns.filter(function (turn) { return turn.role === 'assistant'; }).length;
      var report = { ok: true, reason: opts.automatic ? 'agent-auto' : 'agent-manual', at: Date.now(), proposed: 0, added: [], updated: [], skipped: 0, errors: [], window: 0 };
      if (history.canRun && !history.canRun()) {
        report.ok = false;
        report.error = '请在这段助手对话所属的酒馆聊天中整理记忆';
        return report;
      }
      if (!settings.enabled || !turns.some(function (turn) { return turn.role === 'user'; }) || !replies
          || (opts.automatic && (!settings.agentExtract || replies < settings.agentEveryTurns))) {
        report.note = settings.enabled ? '没有需要整理的助手交流' : '助手记忆已关闭';
        return Promise.resolve(report);
      }

      function assertCurrent() {
        if (conversationKey() !== key || !settings.enabled || (opts.automatic && !settings.agentExtract)) throw new Error('聊天或记忆设置已变更，本次整理已停止');
        if (opts.signal && opts.signal.aborted) throw new Error('已取消');
      }

      var job = (async function () {
        try {
          var index = 0;
          while (index < turns.length) {
            var start = index, batch = [], size = 0;
            do {
              var turn = turns[index];
              var line = (turn.role === 'user' ? '真实用户' : '夜梦助手') + '：' + shorten(turn.text.trim(), Math.min(1600, Math.floor(settings.windowChars / 2) - 10));
              if (size + line.length > settings.windowChars && batch.length) break;
              size += line.length + 1;
              batch.push(line);
              index += 1;
            } while (index < turns.length);

            /* 模型调用、世界书读取和写操作期间，用户都可能编辑历史或切换聊天。 */
            var batchTurns = turns.slice(start, index);
            var assertBatchCurrent = function () {
              assertCurrent();
              var latest = history.read();
              var first = latest.turns.findIndex(function (item) { return item.id === batchTurns[0].id; });
              if (first < 0 || !batchTurns.every(function (item, offset) {
                var live = latest.turns[first + offset];
                return live && live.id === item.id && live.text === item.text && live.role === item.role;
              })) throw new Error('助手对话已经变更，请重新整理');
              return { history: latest, upto: first + batchTurns.length };
            };
            var extracted = await extractOnce(batch.join('\n'), report, opts.signal, assertBatchCurrent);
            assertBatchCurrent();
            await applyOps(extracted.ops, report, assertBatchCurrent);
            var cursor = assertBatchCurrent();
            var latest = cursor.history;
            latest.extracted = Math.max(latest.extracted, cursor.upto);
            try {
              if (!await history.write(latest, { saveNow: true })) throw new Error('助手对话的整理进度保存失败');
            } catch (error) {
              /* 宿主先更新内存变量再异步存盘。失败时仅退回本批的游标，保留用户新消息。 */
              if (conversationKey() === key) {
                var live = history.read();
                var head = live.turns.findIndex(function (item) { return item.id === batchTurns[0].id; });
                if (head >= 0 && live.extracted === head + batchTurns.length) {
                  live.extracted = head;
                  await history.write(live);
                }
              }
              throw error;
            }
            report.window += batch.length;
          }
        } catch (error) {
          report.ok = false;
          report.error = String(error && error.message || error).slice(0, 300);
        }
        if (conversationKey() === key) {
          var data = readChatData();
          data.last = { at: report.at, reason: report.reason, ok: report.ok, added: report.added.length, updated: report.updated.length, error: report.error || '' };
          writeChatData(data);
        }
        return report;
      })().finally(function () { jobs.delete(key); emit('consolidated'); });
      jobs.set(key, job);
      return job;
    }

    function sharingAllowed() {
      var core = env.host && env.host.ReaderCore;
      if (core && typeof core.isEnabled === 'function') return core.isEnabled();
      return kit.readChatValue('reader_ii_runtime') !== undefined || kit.readChatValue('dream_persona') !== undefined;
    }

    async function status() {
      if (history.ready) await history.ready();
      var data = readChatData();
      var saved = history.read();
      var pending = saved.turns.slice(saved.extracted);
      var book = findOceanBook();
      var ocean = [];
      try { ocean = await oceanRecords(false); } catch (error) { /* 仍可显示聊天库 */ }
      return {
        enabled: settings.enabled, store: targetStore(), chatOverride: data.cfg.store || '',
        chatCount: Object.keys(data.items).length, oceanCount: ocean.length,
        oceanBook: book || settings.oceanBook, oceanExists: !!book,
        pending: { turns: pending.filter(function (turn) { return turn.role === 'assistant'; }).length },
        last: data.last, running: jobs.has(conversationKey())
      };
    }

    async function exportAll() {
      return { v: MEMORY_VERSION, kind: 'reader-ii-memory', exportedAt: new Date().toISOString(), items: await listAll({ fresh: true }) };
    }

    async function importAll(payload, options) {
      var source = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!modules.isObject(source) || source.kind !== 'reader-ii-memory' || source.v !== MEMORY_VERSION || !Array.isArray(source.items)) {
        throw new Error('请选择新版助手记忆导出文件（v' + MEMORY_VERSION + '）');
      }
      var items = source.items;
      var store = options && (options.store === 'ocean' || options.store === 'chat') ? options.store : targetStore();
      var existing = await listAll({ fresh: true });
      var report = { added: 0, skipped: 0, errors: [] };
      for (var index = 0; index < items.length && index < 2000; index += 1) {
        if (!modules.isObject(items[index]) || ownerOf(items[index]) !== 'agent' || items[index].source === 'story') { report.skipped += 1; continue; }
        var record = normalizeRecord(Object.assign({}, items[index], { id: undefined, uid: undefined, store: store, source: 'import', owner: 'agent' }), store);
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

    var installed = false;
    var subscriptions = [];
    function listen(event, handler) {
      var subscription = kit.on(event, handler);
      if (subscription && typeof subscription.stop === 'function') subscriptions.push(subscription);
    }

    function install() {
      if (installed) return;
      installed = true;
      startOceanMigration();
      listen('CHAT_CHANGED', function () {
        oceanCache.records = null;
        lastInjection = { key: '', text: '' };
        refreshInjection().catch(function () {});
        emit('chat');
        return scanOceanBooks(true, false);
      });
      listen('GENERATION_AFTER_COMMANDS', async function (type, generationOptions, dryRun) {
        if (dryRun) return;
        await scanOceanBooks(true, false);
        if (installed) await refreshInjection();
      });
      listen('WORLDINFO_UPDATED', function (book) {
        oceanCache.records = null;
        if (typeof book === 'string') checkedBooks.delete(book);
        else checkedBooks.clear();
      });
      refreshInjection().catch(function () {});
    }

    async function dispose() {
      installed = false;
      subscriptions.splice(0).forEach(function (subscription) { subscription.stop(); });
      ++injectionRevision;
      await injectionWrite;
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
      status: status,
      exportAll: exportAll,
      importAll: importAll,
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
