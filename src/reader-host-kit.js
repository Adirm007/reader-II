(function (root) {
  'use strict';

  /*
   * 宿主工具箱：Agent 与记忆共用的酒馆 / 酒馆助手访问层。
   * 每个函数都在调用时解析宿主接口（脚本先于酒馆助手就绪、或接口后来才出现时仍可用），
   * 并把不同版本的返回形状归一。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function createHostKit(env) {
    function fn(name) {
      var resolved = env && typeof env.resolveFunction === 'function' ? env.resolveFunction(name) : null;
      if (typeof resolved === 'function') return resolved;
      return env && typeof env[name] === 'function' ? env[name] : null;
    }

    function need(name) {
      var found = fn(name);
      if (!found) throw new Error('当前酒馆助手没有提供 ' + name + ' 接口');
      return found;
    }

    function context() {
      try {
        var tavern = env && env.host && env.host.SillyTavern;
        return tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
      } catch (error) { return null; }
    }

    function chatKey() {
      var ctx = context();
      if (!ctx) return '';
      var chat = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      return String(ctx.characterId == null ? '' : ctx.characterId) + '|' + String(chat == null ? '' : chat);
    }

    function names() {
      var ctx = context() || {};
      var character = ctx.characters && ctx.characters[ctx.characterId];
      return {
        user: String(ctx.name1 || '用户'),
        char: String(ctx.name2 || character && character.name || '角色'),
        chat: String((typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId) || '')
      };
    }

    /* ---------- 聊天 ---------- */
    function rawChat() {
      var ctx = context();
      return ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
    }

    function messageRole(message) {
      if (!message) return 'system';
      if (message.is_user === true) return 'user';
      if (message.is_system === true) return 'system';
      return 'assistant';
    }

    /* [{id, role, name, text}]；隐藏楼层（is_system）默认跳过。 */
    function readChat(from, to, options) {
      var chat = rawChat();
      var start = Math.max(0, Math.trunc(Number(from) || 0));
      var end = Math.min(chat.length, to === undefined || to === null ? chat.length : Math.trunc(Number(to)));
      var includeHidden = options && options.includeHidden === true;
      var output = [];
      for (var index = start; index < end; index += 1) {
        var message = chat[index];
        if (!message) continue;
        var role = messageRole(message);
        if (role === 'system' && !includeHidden) continue;
        output.push({ id: index, role: role, name: String(message.name || ''), text: String(message.mes == null ? '' : message.mes) });
      }
      return output;
    }

    function chatLength() { return rawChat().length; }

    /* 改一楼的正文并保存、重绘。 */
    async function setMessageText(id, text) {
      var set = fn('setChatMessages');
      if (set) { await set([{ message_id: id, message: String(text) }], { refresh: 'affected' }); return; }
      var ctx = context();
      var message = rawChat()[id];
      if (!message) throw new Error('没有第 ' + id + ' 楼');
      message.mes = String(text);
      if (Array.isArray(message.swipes) && message.swipe_id != null) message.swipes[message.swipe_id] = String(text);
      if (ctx && typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(id, message);
      if (ctx && typeof ctx.saveChat === 'function') await ctx.saveChat();
    }

    /* 去掉思维链、变量更新块、Reader 事件、代码块与标签，得到可读正文。 */
    function cleanText(input) {
      return String(input == null ? '' : input)
        .replace(/<(thinking|think|reasoning|thought)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, ' ')
        .replace(/<READER_(?:FP|TASK|ACTION)_EVENT>[\s\S]*?<\/READER_(?:FP|TASK|ACTION)_EVENT>/gi, ' ')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<dream>/gi, '【夜梦来信】').replace(/<\/dream>/gi, '【来信结束】')
        .replace(/<\/?[A-Za-z_][^<>]{0,200}>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t　]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    /* ---------- 变量 ---------- */
    function chatVariables() {
      var ctx = context();
      if (ctx && ctx.chatMetadata) {
        if (!modules.isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
        return ctx.chatMetadata.variables;
      }
      return null;
    }

    function readChatValue(key) {
      var vars = chatVariables();
      var value;
      if (vars) value = vars[key];
      else {
        var getVariables = fn('getVariables');
        if (getVariables) {
          try { value = (getVariables({ type: 'chat' }) || {})[key]; } catch (error) { value = undefined; }
        }
      }
      if (typeof value === 'string') {
        /* 对象常被存成 JSON 字符串；普通字符串（如人格 id、称呼）原样返回。 */
        if (/^\s*[\[{]/.test(value)) {
          try { return JSON.parse(value); } catch (error) { return value; }
        }
        return value;
      }
      return value === undefined ? undefined : modules.clone(value);
    }

    var saveTimer = null;
    function writeChatValue(key, value) {
      var vars = chatVariables();
      if (vars) {
        if (value === undefined) delete vars[key];
        else vars[key] = modules.clone(value);
        var ctx = context();
        if (ctx && typeof ctx.saveMetadata === 'function') {
          /* 连续写入合并成一次保存。 */
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(function () {
            saveTimer = null;
            try { Promise.resolve(ctx.saveMetadata()).catch(function () {}); } catch (error) { /* best-effort */ }
          }, 150);
        }
        return true;
      }
      var insert = fn('insertOrAssignVariables');
      if (!insert) return false;
      try {
        var payload = {};
        payload[key] = modules.clone(value);
        insert(payload, { type: 'chat' });
        return true;
      } catch (error) { return false; }
    }

    function localRead(key, fallback) {
      try {
        var store = env && env.storage;
        var raw = store && store.getItem(key);
        if (!raw) return fallback;
        var value = JSON.parse(raw);
        return value === null || value === undefined ? fallback : value;
      } catch (error) { return fallback; }
    }

    function localWrite(key, value) {
      try {
        var store = env && env.storage;
        if (!store) return false;
        if (value === undefined) store.removeItem(key);
        else store.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) { return false; }
    }

    /* ---------- 世界书 ---------- */
    function list(value) { return Array.isArray(value) ? value : value && Array.isArray(value.entries) ? value.entries : []; }

    /*
     * 没有酒馆助手时走酒馆原生的世界书接口，并把条目换算成酒馆助手的形状
     * （uid / name / enabled / content / strategy / position），上层只认这一种。
     */
    var WI_POSITIONS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages'];
    var WI_LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'];
    var WI_ROLES = ['system', 'user', 'assistant'];

    /* 保留模块本身，书名、选中的全局书及角色附加书每次从宿主的当前状态读取。 */
    var worldInfo;
    var loadingWorldInfo;
    async function prepareWorldbooks() {
      if (worldInfo || fn('getWorldbookNames') && fn('getCharWorldbookNames') || !env.hostImport) return;
      if (!loadingWorldInfo) loadingWorldInfo = env.hostImport('/scripts/world-info.js')
        .then(function (module) { worldInfo = module; }, function () { /* 旧版使用原生上下文与下拉框 */ })
        .finally(function () { loadingWorldInfo = null; });
      await loadingWorldInfo;
    }

    function nativeToEntry(raw) {
      var entry = {
        uid: raw.uid, name: String(raw.comment || ''), enabled: raw.disable !== true, content: String(raw.content || ''),
        strategy: {
          type: raw.constant ? 'constant' : raw.vectorized ? 'vectorized' : 'selective',
          keys: (raw.key || []).slice(),
          keys_secondary: { logic: WI_LOGIC[raw.selectiveLogic || 0] || 'and_any', keys: (raw.keysecondary || []).slice() }
        },
        position: { type: WI_POSITIONS[raw.position || 0] || WI_POSITIONS[0], order: Number(raw.order) || 0, depth: Number(raw.depth) || 0, role: WI_ROLES[raw.role || 0] || 'system' },
        probability: raw.probability == null ? 100 : Number(raw.probability),
        recursion: { prevent_incoming: raw.excludeRecursion === true, prevent_outgoing: raw.preventRecursion === true }
      };
      /* extra 是酒馆助手给条目留的自由字段（抽卡用它给生成的角色条目做记号），原生结构里同名存放。 */
      if (modules.isObject(raw.extra)) entry.extra = modules.clone(raw.extra);
      return entry;
    }

    function entryToNative(entry, raw) {
      var target = raw || {
        key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false,
        probability: 100, useProbability: true, depth: 4, group: '', role: 0
      };
      if (entry.name !== undefined) target.comment = String(entry.name);
      if (entry.content !== undefined) target.content = String(entry.content);
      if (entry.enabled !== undefined) target.disable = entry.enabled === false;
      if (modules.isObject(entry.strategy)) {
        if (entry.strategy.type) { target.constant = entry.strategy.type === 'constant'; target.vectorized = entry.strategy.type === 'vectorized'; }
        if (Array.isArray(entry.strategy.keys)) target.key = entry.strategy.keys.map(String);
        if (modules.isObject(entry.strategy.keys_secondary)) {
          if (Array.isArray(entry.strategy.keys_secondary.keys)) target.keysecondary = entry.strategy.keys_secondary.keys.map(String);
          if (WI_LOGIC.indexOf(entry.strategy.keys_secondary.logic) >= 0) target.selectiveLogic = WI_LOGIC.indexOf(entry.strategy.keys_secondary.logic);
        }
      }
      if (modules.isObject(entry.position)) {
        if (WI_POSITIONS.indexOf(entry.position.type) >= 0) target.position = WI_POSITIONS.indexOf(entry.position.type);
        if (entry.position.order !== undefined) target.order = Number(entry.position.order) || 0;
        if (entry.position.depth !== undefined) target.depth = Number(entry.position.depth) || 0;
        if (WI_ROLES.indexOf(entry.position.role) >= 0) target.role = WI_ROLES.indexOf(entry.position.role);
      }
      if (entry.probability !== undefined) target.probability = Number(entry.probability);
      if (modules.isObject(entry.recursion)) {
        if (entry.recursion.prevent_incoming !== undefined) target.excludeRecursion = entry.recursion.prevent_incoming === true;
        if (entry.recursion.prevent_outgoing !== undefined) target.preventRecursion = entry.recursion.prevent_outgoing === true;
      }
      if (modules.isObject(entry.extra)) target.extra = modules.clone(entry.extra);
      return target;
    }

    async function nativeBook(name, optional) {
      var ctx = context();
      if (!ctx || typeof ctx.loadWorldInfo !== 'function') throw new Error('当前环境没有世界书接口');
      var data = await ctx.loadWorldInfo(String(name));
      if (!data && optional) return null;
      if (!data || !modules.isObject(data.entries)) throw new Error('读取世界书「' + name + '」失败，未修改该书');
      return data;
    }

    async function nativeSave(name, data) {
      var ctx = context();
      await ctx.saveWorldInfo(String(name), data, true);
      if (typeof ctx.reloadWorldInfoEditor === 'function') { try { ctx.reloadWorldInfoEditor(String(name)); } catch (error) { /* 编辑器没开 */ } }
    }

    function nativeEntries(data) {
      return Object.keys(data.entries).map(function (key) { return nativeToEntry(data.entries[key]); });
    }

    /* 把上层给的条目列表写回原生结构：按 uid 对应，新条目分配新 uid，列表里没有的删除。 */
    function applyNativeEntries(data, entries) {
      var next = {}, used = {};
      Object.keys(data.entries).forEach(function (key) { used[data.entries[key].uid] = data.entries[key]; });
      var maxUid = Object.keys(used).reduce(function (max, uid) { return Math.max(max, Number(uid) || 0); }, -1);
      entries.forEach(function (entry) {
        var raw = entry.uid !== undefined && used[entry.uid] ? used[entry.uid] : null;
        var uid = raw ? raw.uid : (maxUid += 1);
        next[uid] = entryToNative(entry, raw);
        next[uid].uid = uid;
      });
      data.entries = next;
    }

    function worldbookNames() {
      var get = fn('getWorldbookNames');
      try {
        if (get) return (get() || []).map(String);
        var ctx = context();
        if (ctx && typeof ctx.getWorldInfoNames === 'function') return ctx.getWorldInfoNames().map(String);
        if (worldInfo && Array.isArray(worldInfo.world_names)) return worldInfo.world_names.slice();
        /* 酒馆的世界书下拉框里有全部书名。 */
        var options = env.document ? env.document.querySelectorAll('#world_editor_select option') : [];
        return Array.prototype.filter.call(options, function (option) { return option.value !== ''; }).map(function (option) { return String(option.textContent || '').trim(); }).filter(Boolean);
      } catch (error) { return []; }
    }

    function globalWorldbooks() {
      var get = fn('getGlobalWorldbookNames');
      try {
        if (get) return (get() || []).map(String);
        if (worldInfo && Array.isArray(worldInfo.selected_world_info)) return worldInfo.selected_world_info.slice();
        /* 原生：全局启用的世界书就是 #world_info 下拉框里选中的那些。 */
        var options = env.document ? env.document.querySelectorAll('#world_info option:checked') : [];
        return Array.prototype.map.call(options, function (option) { return String(option.textContent || '').trim(); }).filter(Boolean);
      } catch (error) { return []; }
    }

    function charWorldbooks() {
      var get = fn('getCharWorldbookNames');
      try {
        if (!get) {
          var ctx = context();
          var card = ctx && ctx.characters && ctx.characters[ctx.characterId];
          var world = card && card.data && card.data.extensions && card.data.extensions.world;
          var file = card && String(card.avatar || '').replace(/\.[^./\\]+$/, '');
          var records = worldInfo && worldInfo.world_info && worldInfo.world_info.charLore;
          var record = file && Array.isArray(records) && records.find(function (item) { return item && item.name === file; });
          return { primary: world ? String(world) : null, additional: record && Array.isArray(record.extraBooks) ? record.extraBooks.map(String) : [] };
        }
        var value = get ? get('current') : null;
        return { primary: value && value.primary ? String(value.primary) : null, additional: value && Array.isArray(value.additional) ? value.additional.map(String) : [] };
      } catch (error) { return { primary: null, additional: [] }; }
    }

    function chatWorldbook() {
      var get = fn('getChatWorldbookName');
      try {
        var name;
        if (get) name = get('current');
        else { var ctx = context(); name = ctx && ctx.chatMetadata && ctx.chatMetadata.world_info; }   /* 原生：聊天绑定的世界书记在聊天元数据里 */
        return name ? String(name) : null;
      } catch (error) { return null; }
    }

    function worldbookScopes() {
      var character = charWorldbooks();
      return {
        all: worldbookNames(),
        global: globalWorldbooks(),
        character_primary: character.primary,
        character_additional: character.additional,
        chat: chatWorldbook()
      };
    }

    async function linkedWorldbooks() {
      var get = fn('getCharWorldbookNames');
      var native = !get && env.nativeHost && env.nativeHost();
      if (!get && native) get = native.getCharWorldbookNames;
      var character;
      try { character = get && await get('current'); } catch (error) { /* 可用角色卡里的主书 */ }
      if (!character) character = charWorldbooks();
      return Array.from(new Set([character.primary].concat(character.additional || [], [chatWorldbook()]).filter(Boolean)));
    }

    function isWorldbookActive(name) {
      var scopes = worldbookScopes();
      return scopes.global.indexOf(name) >= 0 || scopes.character_primary === name
        || scopes.character_additional.indexOf(name) >= 0 || scopes.chat === name;
    }

    async function readWorldbook(name, options) {
      var get = fn('getWorldbook');
      if (get) return list(await get(String(name)));
      var optional = options && options.optional && worldbookNames().indexOf(name) < 0;
      var data = await nativeBook(name, optional);
      return data ? nativeEntries(data) : null;
    }

    async function createWorldbook(name) {
      var title = String(name || '').trim();
      if (!title) throw new Error('世界书名不能为空');
      await prepareWorldbooks();
      if (worldbookNames().indexOf(title) >= 0) return false;
      var create = fn('createWorldbook');
      if (create) { await create(title, []); return true; }
      /* 原生宿主的目录可能落后于正在保存的书。读取同名书，保留条目以及书级元数据。 */
      var existing = await nativeBook(title, true);
      if (existing && (Object.keys(existing.entries).length || Object.keys(existing).length > 1)) return false;
      var ctx = context();
      var hasCatalog = worldInfo && Array.isArray(worldInfo.world_names) || ctx && typeof ctx.getWorldInfoNames === 'function'
        || env.document && env.document.getElementById && env.document.getElementById('world_editor_select');
      if (!existing && !hasCatalog && !worldbookNames().length) {
        throw new Error('无法确认「' + title + '」是否已存在，请先刷新酒馆世界书目录');
      }
      await nativeSave(title, existing || { entries: {} });
      if (ctx && typeof ctx.updateWorldInfoList === 'function') { try { await ctx.updateWorldInfoList(); } catch (error) { /* 列表下次打开会刷新 */ } }
      return true;
    }

    async function addWorldbookEntries(name, entries) {
      if (!fn('createWorldbookEntries') && !fn('updateWorldbookWith')) {
        var data = await nativeBook(name);
        var before = nativeEntries(data);
        applyNativeEntries(data, before.concat(entries));
        await nativeSave(name, data);
        return nativeEntries(data).slice(before.length);
      }
      var create = fn('createWorldbookEntries');
      if (create) {
        var result = await create(String(name), entries);
        var made = result && Array.isArray(result.new_entries) ? result.new_entries : [];
        if (made.length) return made;
      } else {
        await need('updateWorldbookWith')(String(name), function (book) { return list(book).concat(entries); });
      }
      /* 旧版不回传新条目：按名称回读。 */
      var current = await readWorldbook(name);
      return entries.map(function (entry) {
        for (var index = current.length - 1; index >= 0; index -= 1) {
          if (String(current[index].name || '') === String(entry.name || '')) return current[index];
        }
        return entry;
      });
    }

    async function updateWorldbook(name, updater) {
      if (!fn('updateWorldbookWith')) {
        var data = await nativeBook(name);
        var current = nativeEntries(data);
        var changed = updater(current);
        applyNativeEntries(data, Array.isArray(changed) ? changed : current);
        await nativeSave(name, data);
        return nativeEntries(data);
      }
      return list(await need('updateWorldbookWith')(String(name), function (book) {
        var entries = list(book);
        var next = updater(entries);
        return Array.isArray(next) ? next : entries;
      }));
    }

    async function mountWorldbook(name, mode) {
      await prepareWorldbooks();
      if (mode === 'global') {
        var current = globalWorldbooks();
        if (current.indexOf(name) < 0) {
          var bindGlobal = fn('rebindGlobalWorldbooks');
          if (bindGlobal) await bindGlobal(current.concat([name]));
          else if (worldInfo && typeof worldInfo.updateWorldInfoSettings === 'function') {
            await worldInfo.updateWorldInfoSettings({}, current.concat([name]));
          } else throw new Error('此宿主没有全局世界书绑定接口，请在世界书面板启用「' + name + '」');
        }
        return 'global';
      }
      if (mode === 'character') {
        var books = charWorldbooks();
        if (books.primary !== name && books.additional.indexOf(name) < 0) {
          var bindChar = fn('rebindCharWorldbooks');
          if (!bindChar) {
            var native = env.nativeHost && env.nativeHost();
            if (!worldInfo || !worldInfo.world_info || !native) throw new Error('此宿主没有角色附加世界书绑定接口');
            bindChar = native.rebindCharWorldbooks;
          }
          await bindChar('current', { primary: books.primary, additional: books.additional.concat([name]) });
        }
        return 'character';
      }
      return 'none';
    }

    function findEntry(entries, query) {
      var target = String(query == null ? '' : query).trim();
      if (!target) return null;
      var uid = /^\d+$/.test(target) ? Number(target) : null;
      var exact = null, partial = null;
      entries.forEach(function (entry) {
        var name = String(entry.name || '');
        if (uid !== null && entry.uid === uid && !exact) exact = entry;
        if (name === target && !exact) exact = entry;
        if (!partial && name && (name.indexOf(target) >= 0 || target.indexOf(name) >= 0)) partial = entry;
      });
      return exact || partial;
    }

    /* ---------- 提示词注入 ---------- */
    async function inject(prompts) {
      var injectPrompts = fn('injectPrompts');
      if (injectPrompts) { await injectPrompts(prompts); return true; }
      /* 没有酒馆助手：用酒馆原生的扩展提示词（位置 1 = 聊天内按深度，-1 = 不注入；角色 0/1/2 = system/user/assistant）。 */
      var ctx = context();
      if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return false;
      (prompts || []).forEach(function (prompt) {
        var off = prompt.position === 'none' || !prompt.content;
        var role = prompt.role === 'user' ? 1 : prompt.role === 'assistant' ? 2 : 0;
        ctx.setExtensionPrompt(String(prompt.id), off ? '' : String(prompt.content), off ? -1 : 1, Math.max(0, Number(prompt.depth) || 0), prompt.should_scan === true, role);
      });
      return true;
    }

    async function uninject(ids) {
      var uninjectPrompts = fn('uninjectPrompts');
      if (uninjectPrompts) {
        try { await uninjectPrompts(ids); return true; } catch (error) { /* fall through */ }
      }
      /* 没有撤销接口时写入空内容。 */
      return inject(ids.map(function (id) { return { id: id, content: '', position: 'none', depth: 0, role: 'system', should_scan: false }; }));
    }

    function on(eventName, handler) {
      var events = env && env.tavern_events || {};
      var event = events[eventName];
      if (!event) return null;
      if (env && typeof env.eventOn === 'function') return env.eventOn(event, handler);
      var eventOn = fn('eventOn');
      return eventOn ? eventOn(event, handler) : null;
    }

    return {
      fn: fn,
      need: need,
      context: context,
      chatKey: chatKey,
      names: names,
      rawChat: rawChat,
      setMessageText: setMessageText,
      readChat: readChat,
      chatLength: chatLength,
      cleanText: cleanText,
      readChatValue: readChatValue,
      writeChatValue: writeChatValue,
      localRead: localRead,
      localWrite: localWrite,
      worldbookNames: worldbookNames,
      prepareWorldbooks: prepareWorldbooks,
      worldbookScopes: worldbookScopes,
      linkedWorldbooks: linkedWorldbooks,
      isWorldbookActive: isWorldbookActive,
      readWorldbook: readWorldbook,
      createWorldbook: createWorldbook,
      addWorldbookEntries: addWorldbookEntries,
      updateWorldbook: updateWorldbook,
      mountWorldbook: mountWorldbook,
      findEntry: findEntry,
      inject: inject,
      uninject: uninject,
      on: on
    };
  }

  modules.createHostKit = createHostKit;
})(typeof globalThis !== 'undefined' ? globalThis : window);
