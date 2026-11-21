(function (root) {
  'use strict';

  /*
   * 内置挂载点：把酒馆里的东西接到 VFS 上。
   * 优先走酒馆助手的接口（跨版本最稳）；没装酒馆助手时，聊天、聊天变量、世界书、角色卡走酒馆原生接口，
   * 正则只读，脚本与预设不可用（它们本来就是酒馆助手的概念 / 接口）。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var enc = modules.vfsEnc;

  var CARD_FIELDS = {
    'description.md': 'description', 'personality.md': 'personality', 'scenario.md': 'scenario',
    'first_mes.md': 'first_mes', 'mes_example.md': 'mes_example', 'system_prompt.md': 'system_prompt',
    'post_history_instructions.md': 'post_history_instructions', 'creator_notes.md': 'creator_notes'
  };
  var CARD_TOP = { description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', creator_notes: 'creatorcomment' };

  function preview(text, limit) {
    var flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
  }

  function page(items, options) {
    var offset = Math.max(0, Math.trunc(Number(options && options.offset) || 0));
    var limit = Math.max(1, Math.trunc(Number(options && options.limit) || 100));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  /* 同名条目加 #标识 区分；段里带 #标识 时按标识找。 */
  function uniqueNames(items, nameOf, idOf) {
    var count = {};
    items.forEach(function (item) { var name = nameOf(item) || ''; count[name] = (count[name] || 0) + 1; });
    return items.map(function (item) {
      var name = nameOf(item) || '';
      return !name || count[name] > 1 ? (name || '') + '#' + idOf(item) : name;
    });
  }

  function pick(items, segment, nameOf, idOf) {
    var hash = segment.lastIndexOf('#');
    if (hash >= 0) {
      var id = segment.slice(hash + 1);
      for (var index = 0; index < items.length; index += 1) if (String(idOf(items[index])) === id) return items[index];
    }
    for (var i = 0; i < items.length; i += 1) if (nameOf(items[i]) === segment) return items[i];
    return null;
  }

  function need(kit, name, what) {
    var found = kit.fn(name);
    if (!found) throw new Error(what + '需要酒馆助手（当前环境没有 ' + name + ' 接口）');
    return found;
  }

  /* 页面探针：记下报错与警告，供 page:/errors 读取。每次调用只做常数时间的事。 */
  function installPageProbe(env) {
    var host = env.host;
    if (!host || host.__readerIIProbe) return host && host.__readerIIProbe || { errors: [], logs: [] };
    var probe = { errors: [], logs: [] };
    function push(list, kind, parts) {
      var text;
      try {
        text = Array.prototype.map.call(parts, function (part) {
          if (part instanceof Error) return part.stack || part.message;
          if (typeof part === 'string') return part;
          try { return JSON.stringify(part); } catch (error) { return String(part); }
        }).join(' ');
      } catch (error) { text = '(无法序列化)'; }
      list.push({ at: Date.now(), kind: kind, text: String(text).slice(0, 1200) });
      if (list.length > 200) list.splice(0, list.length - 200);
    }
    try {
      host.addEventListener('error', function (event) {
        push(probe.errors, 'error', [(event.message || '') + (event.filename ? ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno : ''), event.error || '']);
      });
      host.addEventListener('unhandledrejection', function (event) { push(probe.errors, 'rejection', [event.reason || '']); });
      ['error', 'warn'].forEach(function (level) {
        var original = host.console[level];
        if (typeof original !== 'function') return;
        host.console[level] = function () {
          try { push(level === 'error' ? probe.errors : probe.logs, level, arguments); } catch (error) { /* 探针不能影响页面 */ }
          return original.apply(this, arguments);
        };
      });
      if (host.toastr && typeof host.toastr.error === 'function') {
        var toast = host.toastr.error;
        host.toastr.error = function (message, title) {
          try { push(probe.errors, 'toast', [String(title || '') + ' ' + String(message || '')]); } catch (error) { /* ignore */ }
          return toast.apply(this, arguments);
        };
      }
    } catch (error) { /* 装不上就算了 */ }
    host.__readerIIProbe = probe;
    return probe;
  }

  function installBuiltinProviders(vfs, env, kit, deps) {
    var store = deps.store;
    var probe = deps.probe || { errors: [], logs: [] };
    var ctx = function () { return kit.context() || {}; };

    /* ---------- chat:/ ---------- */
    vfs.mount({
      id: 'chat', title: '当前聊天的楼层正文', hint: 'chat:/<楼层号>，楼层从 0 起；<楼层号>.json 是该楼的属性（只读）',
      scope: function () { return 'chat'; },
      list: function (segs, options) {
        var chat = kit.rawChat();
        var offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
        var limit = Math.max(1, Math.trunc(Number(options.limit) || 100));
        var items = [];
        for (var index = offset; index < Math.min(chat.length, offset + limit); index += 1) {
          var message = chat[index] || {};
          items.push({ name: String(index), size: String(message.mes || '').length, note: (message.is_user ? '用户' : message.is_system ? '隐藏' : 'AI') + ' ' + String(message.name || '') + '：' + preview(kit.cleanText(message.mes), 40) });
        }
        return { items: items, total: chat.length };
      },
      read: async function (segs) {
        if (!segs.length) return null;
        var chat = kit.rawChat();
        var json = /\.json$/.test(segs[0]);
        var id = Number(segs[0].replace(/\.json$/, ''));
        if (segs[0] === 'latest' || segs[0] === 'latest.json') id = chat.length - 1;
        var message = chat[id];
        if (!Number.isInteger(id) || !message) return null;
        if (!json) return String(message.mes == null ? '' : message.mes);
        return JSON.stringify({ id: id, name: message.name, role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant', hidden: message.is_system === true, send_date: message.send_date, swipe_id: message.swipe_id, swipes: Array.isArray(message.swipes) ? message.swipes.length : 0, extra_keys: Object.keys(message.extra || {}) }, null, 1);
      },
      write: async function (segs, text) {
        var id = segs[0] === 'latest' ? kit.rawChat().length - 1 : Number(segs[0]);
        if (!Number.isInteger(id) || !kit.rawChat()[id]) throw new Error('没有第 ' + segs[0] + ' 楼；新增楼层请用 tavern 工具箱');
        await kit.setMessageText(id, text);
      },
      bulk: async function (segs) {
        if (segs.length) return null;
        return kit.rawChat().map(function (message, index) { return { path: 'chat:/' + index, text: String(message && message.mes || '') }; });
      }
    });

    /* ---------- card:/ ---------- */
    function character() {
      var context = ctx();
      var card = context.characters && context.characters[context.characterId];
      if (!card) throw new Error('当前没有打开角色卡（群聊里请先指定角色）');
      return card;
    }

    function cardValue(card, field) {
      var data = card.data || {};
      if (data[field] !== undefined && data[field] !== null) return String(data[field]);
      var top = CARD_TOP[field];
      return top && card[top] !== undefined && card[top] !== null ? String(card[top]) : '';
    }

    async function mergeCard(card, patch, id) {
      var context = ctx();
      var body = { avatar: card.avatar, data: {} };
      Object.keys(patch).forEach(function (field) {
        body.data[field] = patch[field];
        if (CARD_TOP[field]) body[CARD_TOP[field]] = patch[field];
      });
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
      var response = await env.host.fetch('/api/characters/merge-attributes', { method: 'POST', headers: headers, body: JSON.stringify(body) });
      if (!response.ok) throw new Error('角色卡保存失败（HTTP ' + response.status + '）');
      Object.keys(patch).forEach(function (field) {
        card.data = card.data || {};
        card.data[field] = patch[field];
        if (CARD_TOP[field]) card[CARD_TOP[field]] = patch[field];
      });
      try {
        var types = context.eventTypes || context.event_types || {};
        if (context.eventSource && types.CHARACTER_EDITED) await context.eventSource.emit(types.CHARACTER_EDITED, { detail: { id: id === undefined ? context.characterId : id, character: card } });
      } catch (error) { /* 通知失败不算保存失败 */ }
    }

    /* 角色卡目录（card:/ 与 cards:/<卡>/ 共用）：字段文件、greetings/、meta.json。 */
    function cardList(card, segs, options) {
      if (segs[0] === 'greetings') {
        var greetings = card.data && Array.isArray(card.data.alternate_greetings) ? card.data.alternate_greetings : [];
        return page(greetings.map(function (text, index) { return { name: (index + 1) + '.md', size: String(text).length, note: preview(text, 40) }; }), options);
      }
      var items = Object.keys(CARD_FIELDS).map(function (file) { return { name: file, size: cardValue(card, CARD_FIELDS[file]).length }; });
      items.push({ name: 'greetings', dir: true, note: '备选开场白' }, { name: 'meta.json', note: '名称、作者、版本、绑定世界书等（只读）' });
      return page(items, options);
    }

    function cardRead(card, segs) {
      if (segs[0] === 'greetings') {
        var list = card.data && card.data.alternate_greetings || [];
        var index = Number(String(segs[1] || '').replace(/\.md$/, '')) - 1;
        return list[index] === undefined ? null : String(list[index]);
      }
      if (segs[0] === 'meta.json') {
        var data = card.data || {}, extensions = data.extensions || {};
        return JSON.stringify({ name: card.name, avatar: card.avatar, creator: data.creator, version: data.character_version, tags: data.tags, worldbook: extensions.world || null, regex_scripts: (extensions.regex_scripts || []).length, alternate_greetings: (data.alternate_greetings || []).length }, null, 1);
      }
      return CARD_FIELDS[segs[0]] ? cardValue(card, CARD_FIELDS[segs[0]]) : null;
    }

    function cardWrite(card, id, segs, text) {
      if (segs[0] === 'greetings') {
        var list = (card.data && card.data.alternate_greetings || []).slice();
        var index = Number(String(segs[1] || '').replace(/\.md$/, '')) - 1;
        if (!Number.isInteger(index) || index < 0 || index > list.length) throw new Error('备选开场白的编号要连续：现在有 ' + list.length + ' 条');
        list[index] = text;
        return mergeCard(card, { alternate_greetings: list }, id);
      }
      if (!CARD_FIELDS[segs[0]]) throw new Error('角色卡里没有这个字段：' + segs[0]);
      var patch = {}; patch[CARD_FIELDS[segs[0]]] = text;
      return mergeCard(card, patch, id);
    }

    vfs.mount({
      id: 'card', title: '当前角色卡的字段', hint: '改完即保存；绑定的世界书在 wb:/，卡内正则与脚本在 regex:/card、script:/card；别的卡在 cards:/',
      scope: function () { return 'card'; },
      list: function (segs, options) { return cardList(character(), segs, options); },
      read: async function (segs) { return cardRead(character(), segs); },
      write: async function (segs, text) { return cardWrite(character(), undefined, segs, text); }
    });

    /* ---------- cards:/ 酒馆里的全部角色卡 ---------- */
    var cardName = function (card) { return String(card && card.name || ''); };
    var cardId = function (card) { return String(card && card.avatar || ''); };

    function allCards() {
      var list = ctx().characters;
      return Array.isArray(list) ? list : [];
    }

    function locateCard(segment) {
      var list = allCards();
      var card = segment ? pick(list, String(segment), cardName, cardId) : null;
      if (!card) return null;
      var index = list.indexOf(card);
      return { card: card, index: index, current: String(index) === String(ctx().characterId) };
    }

    /* 新版酒馆只把列表里的卡加载成“浅卡”（没有描述等长字段）；读写前补全。 */
    async function fullCard(hit) {
      if (!hit.card.shallow) return hit.card;
      var context = ctx();
      if (typeof context.unshallowCharacter === 'function') {
        await context.unshallowCharacter(hit.index);
        return allCards()[hit.index] || hit.card;
      }
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : { 'Content-Type': 'application/json' };
      var response = await env.host.fetch('/api/characters/get', { method: 'POST', headers: headers, body: JSON.stringify({ avatar_url: hit.card.avatar }) });
      if (!response.ok) throw new Error('读取角色卡失败（HTTP ' + response.status + '）');
      return await response.json();
    }

    vfs.mount({
      id: 'cards', title: '酒馆里的全部角色卡',
      hint: 'cards:/<卡名>/ 下的结构同 card:/；同名的卡写成 <卡名>#<头像文件>。改当前卡算单卡范围，改别的卡要酒馆全权；新建、删除角色卡请在酒馆里操作',
      scope: function (segs) {
        var hit = segs[0] ? locateCard(segs[0]) : null;
        return hit && hit.current ? 'card' : 'tavern';
      },
      list: async function (segs, options) {
        if (!segs.length) {
          var list = allCards();
          var names = uniqueNames(list, cardName, cardId);
          return page(list.map(function (card, index) {
            var data = card.data || {};
            return { name: names[index], dir: true, note: (String(index) === String(ctx().characterId) ? '[当前] ' : '') + (data.creator ? '作者 ' + data.creator : '') };
          }), options);
        }
        var hit = locateCard(segs[0]);
        if (!hit) throw new Error('没有这张角色卡：' + segs[0] + '（先 ls cards:/ 看准名字）');
        return cardList(await fullCard(hit), segs.slice(1), options);
      },
      read: async function (segs) {
        var hit = locateCard(segs[0]);
        if (!hit || segs.length < 2) return null;
        return cardRead(await fullCard(hit), segs.slice(1));
      },
      write: async function (segs, text) {
        var hit = locateCard(segs[0]);
        if (!hit) throw new Error('没有这张角色卡：' + segs[0] + '（新建角色卡请在酒馆里操作）');
        if (segs.length < 2) throw new Error('要写到具体字段，例如 cards:/' + segs[0] + '/description.md');
        var card = await fullCard(hit);
        return cardWrite(card, hit.index, segs.slice(1), text);
      },
      /* 检索全部卡时只看已经加载的字段（浅卡的长字段要先 read 一次）；指定一张卡时会先补全。 */
      bulk: async function (segs) {
        var list = allCards(), names = uniqueNames(list, cardName, cardId), output = [];
        var only = segs[0] ? locateCard(segs[0]) : null;
        if (segs[0] && !only) return [];
        for (var index = 0; index < list.length; index += 1) {
          if (only && index !== only.index) continue;
          var card = only ? await fullCard(only) : list[index];
          Object.keys(CARD_FIELDS).forEach(function (file) {
            var text = cardValue(card, CARD_FIELDS[file]);
            if (text) output.push({ path: 'cards:/' + enc(names[index]) + '/' + file, text: text });
          });
        }
        return output;
      }
    });

    /* ---------- wb:/ ---------- */
    var entryName = function (entry) { return String(entry.name || ''); };
    var entryId = function (entry) { return entry.uid; };

    function entryNote(entry) {
      var strategy = entry.strategy || {};
      var keys = Array.isArray(strategy.keys) ? strategy.keys.map(String).slice(0, 4).join('、') : '';
      return (entry.enabled === false ? '[关] ' : '') + (strategy.type === 'constant' ? '常驻' : strategy.type === 'vectorized' ? '向量' : '关键词') + (keys ? '：' + keys : '');
    }

    async function locateEntry(segs, optional) {
      var entries = await kit.readWorldbook(segs[0], { optional: optional === true });
      if (!entries) return null;
      var meta = /\.meta\.json$/.test(segs[1]);
      var entry = pick(entries, segs[1].replace(/\.meta\.json$/, ''), entryName, entryId);
      return { entries: entries, entry: entry, meta: meta, name: segs[1].replace(/\.meta\.json$/, '') };
    }

    vfs.mount({
      id: 'wb', title: '世界书', hint: 'wb:/<书>/<条目> 是条目正文；<条目>.meta.json 是开关、触发词、位置等',
      scope: function (segs) {
        if (!segs.length) return 'tavern';
        var scopes = kit.worldbookScopes();
        return scopes.character_primary === segs[0] || scopes.character_additional.indexOf(segs[0]) >= 0 || scopes.chat === segs[0] ? 'card' : 'tavern';
      },
      list: async function (segs, options) {
        if (!segs.length) {
          await kit.prepareWorldbooks();
          var scopes = kit.worldbookScopes();
          return page(scopes.all.map(function (name) {
            var marks = [];
            if (scopes.character_primary === name || scopes.character_additional.indexOf(name) >= 0) marks.push('当前卡');
            if (scopes.chat === name) marks.push('当前聊天');
            if (scopes.global.indexOf(name) >= 0) marks.push('全局启用');
            return { name: name, dir: true, note: marks.join('、') };
          }), options);
        }
        var entries = await kit.readWorldbook(segs[0]);
        var names = uniqueNames(entries, entryName, entryId);
        return page(entries.map(function (entry, index) { return { name: names[index], size: String(entry.content || '').length, note: entryNote(entry) }; }), options);
      },
      read: async function (segs) {
        if (segs.length < 2) return null;
        /* 插件能直接确认书名。原生目录可能尚未刷新，按文件名读取已存在的书。 */
        if (kit.fn('getWorldbookNames') && kit.worldbookNames().indexOf(segs[0]) < 0) return null;
        var found = await locateEntry(segs, true);
        if (!found || !found.entry) return null;
        if (!found.meta) return String(found.entry.content || '');
        var meta = modules.clone(found.entry);
        delete meta.content;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 2) throw new Error('要写到 wb:/<书>/<条目>');
        await kit.prepareWorldbooks();
        if (kit.worldbookNames().indexOf(segs[0]) < 0) await kit.createWorldbook(segs[0]);
        var found = await locateEntry(segs);
        if (!found.entry) {
          if (found.meta) throw new Error('条目还不存在：先写正文（wb:/<书>/<条目>），再改 .meta.json');
          await kit.addWorldbookEntries(segs[0], [{ name: found.name.replace(/#.*$/, ''), content: text, enabled: true }]);
          return;
        }
        var uid = found.entry.uid;
        var patch = null;
        if (found.meta) {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('.meta.json 需要合法的 JSON'); }
          if (!modules.isObject(patch)) throw new Error('.meta.json 需要一个对象');
          delete patch.content; delete patch.uid;
        }
        await kit.updateWorldbook(segs[0], function (entries) {
          return entries.map(function (entry) {
            if (entry.uid !== uid) return entry;
            return found.meta ? Object.assign({}, entry, patch) : Object.assign({}, entry, { content: text });
          });
        });
      },
      remove: async function (segs) {
        if (segs.length < 2) throw new Error('这里只能删除条目；删整本书请在酒馆里操作');
        var found = await locateEntry(segs);
        if (!found.entry) throw new Error('没有这个条目');
        var uid = found.entry.uid;
        await kit.updateWorldbook(segs[0], function (entries) { return entries.filter(function (entry) { return entry.uid !== uid; }); });
      },
      bulk: async function (segs) {
        if (segs.length > 1) return null;
        await kit.prepareWorldbooks();
        var books = segs.length ? [segs[0]] : kit.worldbookNames();
        var output = [];
        for (var index = 0; index < books.length; index += 1) {
          var entries;
          try { entries = await kit.readWorldbook(books[index]); } catch (error) { continue; }
          var names = uniqueNames(entries, entryName, entryId);
          entries.forEach(function (entry, at) { output.push({ path: 'wb:/' + enc(books[index]) + '/' + enc(names[at]), text: String(entry.content || '') }); });
        }
        return output;
      }
    });

    /* ---------- regex:/ ---------- */
    var REGEX_SCOPE = { global: 'global', card: 'character' };
    var regexName = function (item) { return String(item.script_name || ''); };
    var regexId = function (item) { return item.id; };

    function readRegexes(scopeName) {
      var get = kit.fn('getTavernRegexes');
      /* 当前版本的选项是 { type }；scope / enable_state 是 3.x 的写法，一并传上兼容旧版。 */
      if (get) return (get({ type: REGEX_SCOPE[scopeName], scope: REGEX_SCOPE[scopeName], enable_state: 'all' }) || []).slice();
      /* 没有酒馆助手：读酒馆自己的结构，只读。 */
      var context = ctx();
      var rawList = scopeName === 'global' ? context.extensionSettings && context.extensionSettings.regex
        : (function () { try { return character().data.extensions.regex_scripts; } catch (error) { return []; } })();
      return (rawList || []).map(function (raw) {
        return { id: raw.id, script_name: raw.scriptName, enabled: raw.disabled !== true, find_regex: raw.findRegex, replace_string: raw.replaceString, run_on_edit: raw.runOnEdit === true, min_depth: raw.minDepth, max_depth: raw.maxDepth };
      });
    }

    async function writeRegexes(scopeName, updater) {
      await need(kit, 'updateTavernRegexesWith', '修改正则')(function (list) { return updater((list || []).slice()); }, { type: REGEX_SCOPE[scopeName], scope: REGEX_SCOPE[scopeName] });
    }

    vfs.mount({
      id: 'regex', title: '酒馆正则', hint: 'regex:/global|card/<名>/find.txt · replace.html · meta.json',
      scope: function (segs) { return segs[0] === 'card' ? 'card' : 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page([{ name: 'global', dir: true, note: '全局正则' }, { name: 'card', dir: true, note: '当前角色卡的局部正则' }], options);
        if (!REGEX_SCOPE[segs[0]]) return page([], options);
        var list = readRegexes(segs[0]);
        if (segs.length === 1) {
          var names = uniqueNames(list, regexName, regexId);
          return page(list.map(function (item, index) { return { name: names[index], dir: true, note: (item.enabled === false ? '[关] ' : '') + preview(item.find_regex, 50) }; }), options);
        }
        var item = pick(list, segs[1], regexName, regexId);
        if (!item) return page([], options);
        return page([{ name: 'find.txt', size: String(item.find_regex || '').length }, { name: 'replace.html', size: String(item.replace_string || '').length }, { name: 'meta.json' }], options);
      },
      read: async function (segs) {
        if (segs.length < 3 || !REGEX_SCOPE[segs[0]]) return null;
        var item = pick(readRegexes(segs[0]), segs[1], regexName, regexId);
        if (!item) return null;
        if (segs[2] === 'find.txt') return String(item.find_regex || '');
        if (segs[2] === 'replace.html') return String(item.replace_string || '');
        if (segs[2] !== 'meta.json') return null;
        var meta = modules.clone(item);
        delete meta.find_regex; delete meta.replace_string;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 3 || !REGEX_SCOPE[segs[0]]) throw new Error('要写到 regex:/global|card/<名>/find.txt、replace.html 或 meta.json');
        var field = segs[2] === 'find.txt' ? 'find_regex' : segs[2] === 'replace.html' ? 'replace_string' : segs[2] === 'meta.json' ? null : undefined;
        if (field === undefined) throw new Error('正则只有 find.txt、replace.html、meta.json 三个文件');
        var patch = {};
        if (field) patch[field] = text;
        else {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('meta.json 需要合法的 JSON'); }
          delete patch.find_regex; delete patch.replace_string; delete patch.id;
        }
        await writeRegexes(segs[0], function (list) {
          var item = pick(list, segs[1], regexName, regexId);
          if (item) { Object.assign(item, patch); return list; }
          var uuid = env.host.crypto && typeof env.host.crypto.randomUUID === 'function' ? env.host.crypto.randomUUID() : 'reader-' + Date.now().toString(36);
          list.push(Object.assign({
            id: uuid, script_name: segs[1].replace(/#.*$/, ''), enabled: true, run_on_edit: false, scope: REGEX_SCOPE[segs[0]],
            find_regex: '', replace_string: '', trim_strings: [], source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: false },
            destination: { display: true, prompt: false }, min_depth: null, max_depth: null
          }, patch));
          return list;
        });
      },
      remove: async function (segs) {
        if (segs.length !== 2) throw new Error('删除正则请指到 regex:/global|card/<名>');
        await writeRegexes(segs[0], function (list) {
          var item = pick(list, segs[1], regexName, regexId);
          return item ? list.filter(function (other) { return other !== item; }) : list;
        });
      },
      bulk: async function (segs) {
        var scopes = segs.length ? [segs[0]] : ['global', 'card'];
        var output = [];
        scopes.forEach(function (scopeName) {
          if (!REGEX_SCOPE[scopeName]) return;
          var list; try { list = readRegexes(scopeName); } catch (error) { return; }
          var names = uniqueNames(list, regexName, regexId);
          list.forEach(function (item, index) {
            if (segs[1] && names[index] !== segs[1]) return;
            var base = 'regex:/' + scopeName + '/' + enc(names[index]);
            if (!segs[2] || segs[2] === 'find.txt') output.push({ path: base + '/find.txt', text: String(item.find_regex || '') });
            if (!segs[2] || segs[2] === 'replace.html') output.push({ path: base + '/replace.html', text: String(item.replace_string || '') });
          });
        });
        return output;
      }
    });

    /* ---------- script:/（酒馆助手脚本） ---------- */
    var SCRIPT_SCOPE = { global: 'global', card: 'character', preset: 'preset' };
    var scriptName = function (item) { return String(item.name || ''); };
    var scriptId = function (item) { return item.id; };

    function flattenScripts(trees) {
      var output = [];
      (trees || []).forEach(function (node) {
        if (node && node.type === 'folder') (node.scripts || []).forEach(function (child) { output.push(child); });
        else if (node) output.push(node);
      });
      return output;
    }

    function readScripts(scopeName) {
      return flattenScripts(need(kit, 'getScriptTrees', '读取酒馆助手脚本')({ type: SCRIPT_SCOPE[scopeName] }));
    }

    vfs.mount({
      id: 'script', title: '酒馆助手脚本', hint: 'script:/global|card|preset/<名>/content.js · info.md · meta.json',
      scope: function (segs) { return segs[0] === 'card' ? 'card' : 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page(Object.keys(SCRIPT_SCOPE).map(function (name) { return { name: name, dir: true }; }), options);
        if (!SCRIPT_SCOPE[segs[0]]) return page([], options);
        var list = readScripts(segs[0]);
        if (segs.length === 1) {
          var names = uniqueNames(list, scriptName, scriptId);
          return page(list.map(function (item, index) { return { name: names[index], dir: true, note: (item.enabled === false ? '[关] ' : '') + String(item.content || '').length + ' 字' }; }), options);
        }
        var item = pick(list, segs[1], scriptName, scriptId);
        return page(item ? [{ name: 'content.js', size: String(item.content || '').length }, { name: 'info.md', size: String(item.info || '').length }, { name: 'meta.json' }] : [], options);
      },
      read: async function (segs) {
        if (segs.length < 3 || !SCRIPT_SCOPE[segs[0]]) return null;
        var item = pick(readScripts(segs[0]), segs[1], scriptName, scriptId);
        if (!item) return null;
        if (segs[2] === 'content.js') return String(item.content || '');
        if (segs[2] === 'info.md') return String(item.info || '');
        if (segs[2] !== 'meta.json') return null;
        var meta = modules.clone(item);
        delete meta.content; delete meta.info;
        return JSON.stringify(meta, null, 1);
      },
      write: async function (segs, text) {
        if (segs.length < 3 || !SCRIPT_SCOPE[segs[0]]) throw new Error('要写到 script:/global|card|preset/<名>/content.js、info.md 或 meta.json');
        var field = segs[2] === 'content.js' ? 'content' : segs[2] === 'info.md' ? 'info' : segs[2] === 'meta.json' ? null : undefined;
        if (field === undefined) throw new Error('脚本只有 content.js、info.md、meta.json 三个文件');
        var patch = {};
        if (field) patch[field] = text;
        else {
          try { patch = JSON.parse(text); } catch (error) { throw new Error('meta.json 需要合法的 JSON'); }
          delete patch.content; delete patch.info; delete patch.id; delete patch.type;
        }
        await need(kit, 'updateScriptTreesWith', '修改酒馆助手脚本')(function (trees) {
          var list = (trees || []).slice();
          var item = pick(flattenScripts(list), segs[1], scriptName, scriptId);
          if (item) { Object.assign(item, patch); return list; }
          var uuid = env.host.crypto && typeof env.host.crypto.randomUUID === 'function' ? env.host.crypto.randomUUID() : 'reader-' + Date.now().toString(36);
          list.push(Object.assign({ type: 'script', enabled: false, name: segs[1].replace(/#.*$/, ''), id: uuid, content: '', info: '', button: { enabled: true, buttons: [] }, data: {} }, patch));
          return list;
        }, { type: SCRIPT_SCOPE[segs[0]] });
      },
      bulk: async function (segs) {
        var scopes = segs.length ? [segs[0]] : Object.keys(SCRIPT_SCOPE);
        var output = [];
        scopes.forEach(function (scopeName) {
          if (!SCRIPT_SCOPE[scopeName]) return;
          var list; try { list = readScripts(scopeName); } catch (error) { return; }
          var names = uniqueNames(list, scriptName, scriptId);
          list.forEach(function (item, index) {
            if (segs[1] && names[index] !== segs[1]) return;
            if (!segs[2] || segs[2] === 'content.js') output.push({ path: 'script:/' + scopeName + '/' + enc(names[index]) + '/content.js', text: String(item.content || '') });
          });
        });
        return output;
      }
    });

    /* ---------- preset:/（当前预设） ---------- */
    var promptName = function (item) { return String(item.name || item.id || ''); };
    var promptId = function (item) { return item.id; };

    function readPreset() { return need(kit, 'getPreset', '读取预设')('in_use') || {}; }

    vfs.mount({
      id: 'preset', title: '正在使用的预设', hint: 'preset:/prompts/<提示词名>.md 与 settings.json',
      scope: function () { return 'tavern'; },
      list: function (segs, options) {
        if (!segs.length) return page([{ name: 'prompts', dir: true, note: '提示词条目' }, { name: 'settings.json', note: '采样与上下文参数（只读）' }], options);
        var prompts = readPreset().prompts || [];
        var names = uniqueNames(prompts, promptName, promptId);
        return page(prompts.map(function (item, index) { return { name: names[index] + '.md', size: String(item.content || '').length, note: (item.enabled === false ? '[关] ' : '') + String(item.role || '') }; }), options);
      },
      read: async function (segs) {
        var preset = readPreset();
        if (segs[0] === 'settings.json') return JSON.stringify(preset.settings || {}, null, 1);
        if (segs[0] !== 'prompts' || !segs[1]) return null;
        var item = pick(preset.prompts || [], segs[1].replace(/\.md$/, ''), promptName, promptId);
        return item ? String(item.content == null ? '' : item.content) : null;
      },
      write: async function (segs, text) {
        if (segs[0] !== 'prompts' || !segs[1]) throw new Error('预设里只能改 prompts/<提示词名>.md 的内容');
        var target = segs[1].replace(/\.md$/, '');
        await need(kit, 'updatePresetWith', '修改预设')('in_use', function (preset) {
          var item = pick(preset.prompts || [], target, promptName, promptId);
          if (!item) throw new Error('预设里没有这个提示词条目：' + target);
          item.content = text;
          return preset;
        });
      }
    });

    /* ---------- var:/ ---------- */
    function varOption(segs) {
      if (segs[0] === 'chat.json') return { type: 'chat' };
      if (segs[0] === 'global.json') return { type: 'global' };
      if (segs[0] === 'character.json') return { type: 'character' };
      if (segs[0] === 'mvu.json') return { type: 'message', message_id: 'latest' };
      if (segs[0] === 'message' && segs[1]) {
        var id = segs[1].replace(/\.json$/, '');
        return { type: 'message', message_id: id === 'latest' ? 'latest' : Number(id) };
      }
      return null;
    }

    function readVars(option) {
      var get = kit.fn('getVariables');
      if (get) return get(option) || {};
      var context = ctx();
      if (option.type === 'chat') return context.chatMetadata && context.chatMetadata.variables || {};
      if (option.type === 'global') return context.extensionSettings && context.extensionSettings.variables && context.extensionSettings.variables.global || {};
      throw new Error('读取这类变量需要酒馆助手');
    }

    async function writeVars(option, value) {
      var replace = kit.fn('replaceVariables');
      if (replace) { await replace(value, option); return; }
      var context = ctx();
      if (option.type === 'chat' && context.chatMetadata) {
        context.chatMetadata.variables = value;
        if (typeof context.saveMetadata === 'function') await context.saveMetadata();
        return;
      }
      if (option.type === 'global' && context.extensionSettings) {
        context.extensionSettings.variables = context.extensionSettings.variables || {};
        context.extensionSettings.variables.global = value;
        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
        return;
      }
      throw new Error('写入这类变量需要酒馆助手');
    }

    vfs.mount({
      id: 'var', title: '变量', hint: 'var:/chat.json · global.json · character.json · message/<楼层|latest>.json · mvu.json（最新楼的 MVU 变量）；用 #/路径 取子树，如 var:/mvu.json#/stat_data/主角',
      scope: function (segs) { return segs[0] === 'global.json' ? 'tavern' : segs[0] === 'character.json' ? 'card' : 'chat'; },
      list: function (segs, options) {
        if (segs[0] === 'message') {
          var total = kit.chatLength();
          return page([{ name: 'latest.json', note: '最新一楼' }].concat(total ? [{ name: (total - 1) + '.json', note: '楼层号从 0 到 ' + (total - 1) }] : []), options);
        }
        return page([
          { name: 'chat.json', note: '聊天变量（小白X 的变量也在这里）' }, { name: 'message', dir: true, note: '楼层变量' },
          { name: 'mvu.json', note: '最新楼的 MVU 变量（stat_data 等）' }, { name: 'character.json', note: '角色卡变量' }, { name: 'global.json', note: '全局变量' }
        ], options);
      },
      read: async function (segs) {
        var option = varOption(segs);
        if (!option) return null;
        return JSON.stringify(readVars(option), null, 1);
      },
      write: async function (segs, text) {
        var option = varOption(segs);
        if (!option) throw new Error('没有这个变量文件');
        var value;
        try { value = JSON.parse(text); } catch (error) { throw new Error('变量文件需要合法的 JSON'); }
        if (!modules.isObject(value)) throw new Error('变量文件的顶层必须是对象');
        await writeVars(option, value);
      }
    });

    /* ---------- ext:/（已安装扩展的源码，只读） ---------- */
    var extensionNames = null;

    function extensionRequest(url, options) {
      var signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
      return env.host.fetch(url, Object.assign({ signal: signal }, options));
    }

    async function discoverExtensions(refresh) {
      if (extensionNames && !refresh) return extensionNames;
      var context = ctx();
      var headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
      var response = await extensionRequest('/api/extensions/discover', { method: 'GET', headers: headers });
      if (!response.ok) throw new Error('无法读取酒馆的已安装扩展列表（HTTP ' + response.status + '）');
      var list = await response.json();
      if (!Array.isArray(list)) throw new Error('酒馆返回的扩展列表格式无法识别');
      extensionNames = list.map(function (item) { return String(item && item.name || item || ''); })
        .filter(function (name) { return name.indexOf('third-party/') === 0; }).map(function (name) { return name.slice('third-party/'.length); });
      return extensionNames;
    }

    async function fetchExtensionFile(segs) {
      var url = '/scripts/extensions/third-party/' + segs.map(encodeURIComponent).join('/');
      var response = await extensionRequest(url, { cache: 'no-cache' });
      if (!response.ok) return null;
      var type = String(response.headers && response.headers.get && response.headers.get('content-type') || '');
      if (/^(?:image|audio|video|font)\//.test(type)) return '（二进制文件，' + type + '）';
      var text = await response.text();
      return text.length > 3000000 ? text.slice(0, 3000000) : text;
    }

    vfs.mount({
      id: 'ext', title: '已安装的第三方扩展源码（只读）', hint: '目录无法整体列出：从 manifest.json 找到入口文件，再顺着 import 逐个读',
      readonly: true,
      scope: function () { return 'tavern'; },
      list: async function (segs, options) {
        if (!segs.length) return page((await discoverExtensions(options.refresh)).map(function (name) { return { name: name, dir: true }; }), options);
        if (segs.length > 1) return page([], options);
        var items = [{ name: 'manifest.json' }];
        try {
          var manifest = JSON.parse(await fetchExtensionFile([segs[0], 'manifest.json']));
          if (manifest.js) items.push({ name: String(manifest.js), note: '入口脚本' });
          if (manifest.css) items.push({ name: String(manifest.css), note: '样式' });
        } catch (error) { /* 只有 manifest */ }
        return page(items, options);
      },
      read: async function (segs) { return segs.length < 2 ? null : fetchExtensionFile(segs); }
    });

    /* ---------- page:/（正在运行的页面，只读） ---------- */
    function dump(list) {
      return list.slice(-80).map(function (item) { return new Date(item.at).toLocaleTimeString() + ' [' + item.kind + '] ' + item.text; }).join('\n') || '（暂无记录）';
    }

    vfs.mount({
      id: 'page', title: '正在运行的酒馆页面（只读）', hint: 'page:/errors 最近的报错与红色提示 · page:/console 警告 · page:/env.json 版本与已装组件',
      readonly: true,
      scope: function () { return 'tavern'; },
      list: function (segs, options) {
        return page([{ name: 'errors', note: probe.errors.length + ' 条' }, { name: 'console', note: probe.logs.length + ' 条警告' }, { name: 'env.json' }], options);
      },
      read: async function (segs) {
        if (segs[0] === 'errors') return dump(probe.errors);
        if (segs[0] === 'console') return dump(probe.logs);
        if (segs[0] !== 'env.json') return null;
        return JSON.stringify(typeof deps.describeEnv === 'function' ? deps.describeEnv() : {}, null, 1);
      }
    });

    /* ---------- ws:/（她的工作区） ---------- */
    vfs.mount({
      id: 'ws', title: '你的工作区（草稿、计划、工作流、自写插件；不随聊天变化，更新扩展也不会动）', hint: '任何权限档位下都可以读写',
      scope: function () { return 'workspace'; },
      list: async function (segs, options) {
        var prefix = segs.length ? segs.join('/') + '/' : '';
        var keys = ((await store.keys('files')) || []).map(String).filter(function (key) { return key.indexOf(prefix) === 0; });
        var seen = {}, items = [];
        keys.sort().forEach(function (key) {
          var rest = key.slice(prefix.length), slash = rest.indexOf('/');
          var name = slash >= 0 ? rest.slice(0, slash) : rest;
          if (seen[name]) return;
          seen[name] = true;
          items.push({ name: name, dir: slash >= 0 });
        });
        return page(items, options);
      },
      read: async function (segs) {
        if (!segs.length) return null;
        var record = await store.get('files', segs.join('/'));
        return record ? String(record.text) : null;
      },
      write: async function (segs, text) {
        if (!segs.length) throw new Error('要给文件起个名字，例如 ws:/notes/想法.md');
        await store.put('files', segs.join('/'), { text: text, at: Date.now() });
      },
      remove: async function (segs) { await store.del('files', segs.join('/')); }
    });

    /* ---------- mem:/ 记忆 ---------- */
    /*
     * mem:/chat/ 当前聊天的记忆 · mem:/ocean/ 《夜之洋》 · mem:/settings.json 记忆设置（只读）
     * 每条记忆：<标题>.md 是正文，<标题>.meta.json 是类型、触发词、重要度、常驻和开关。写一个不存在的 <标题>.md 就是新建。
     * 与 memory 工具箱读写的是同一份数据；范围按 chat 算，和 memory_save 一致。
     */
    var memory = deps.memory;
    var memTitle = function (record) { return record.title; };
    var memId = function (record) { return record.id; };
    var MEM_META = ['type', 'keys', 'importance', 'pinned', 'enabled', 'owner'];

    function memoryApi() {
      if (!memory) throw new Error('记忆系统没有启动');
      return memory;
    }

    async function memRecords(storeName) {
      return memoryApi().list({ store: storeName, fresh: true }).then(function (list) {
        return list.filter(function (record) { return record.store === storeName; });
      });
    }

    async function locateMemory(segs) {
      if (segs[0] !== 'chat' && segs[0] !== 'ocean') return null;
      var file = String(segs[1] || '');
      var isMeta = /\.meta\.json$/.test(file);
      var base = file.replace(/\.meta\.json$/, '').replace(/\.md$/, '');
      if (!base) return null;
      var records = await memRecords(segs[0]);
      return { store: segs[0], isMeta: isMeta, base: base, record: pick(records, base, memTitle, memId) };
    }

    function memMeta(record) {
      var output = {};
      MEM_META.forEach(function (key) { output[key] = record[key]; });
      output.id = record.id;
      output.store = record.store;
      output.source = record.source;
      output.updatedAt = new Date(record.updatedAt).toISOString();
      return JSON.stringify(output, null, 1);
    }

    vfs.mount({
      id: 'mem', title: '记忆（夜之洋）',
      hint: 'mem:/chat|ocean/<标题>.md 用户与助手的交流记忆 · <标题>.meta.json 类型、触发词、重要度、常驻；写一个新标题保存一条交流记忆',
      scope: function () { return 'chat'; },
      list: async function (segs, options) {
        if (!segs.length) {
          var status = await memoryApi().status();
          return page([
            { name: 'chat', dir: true, note: '当前聊天的记忆 ' + status.chatCount + ' 条' },
            { name: 'ocean', dir: true, note: '《' + status.oceanBook + '》' + status.oceanCount + ' 条（跨存档）' },
            { name: 'settings.json', note: '记忆设置（只读；改设置请让用户在面板里改）' }
          ], options);
        }
        if (segs[0] !== 'chat' && segs[0] !== 'ocean') throw new Error('mem:/ 下只有 chat/、ocean/、settings.json');
        var records = await memRecords(segs[0]);
        var names = uniqueNames(records, memTitle, memId);
        var items = [];
        records.forEach(function (record, index) {
          var tag = '[' + (memoryApi().TYPE_SHORT[record.type] || record.type) + (record.owner === 'agent' ? '·你自己的' : '') + (record.pinned ? '·常驻' : '') + (record.enabled ? '' : '·停用') + '] ';
          items.push({ name: names[index] + '.md', size: record.content.length, note: tag + preview(record.content, 40) });
        });
        return page(items, options);
      },
      read: async function (segs) {
        if (segs[0] === 'settings.json' && segs.length === 1) return JSON.stringify(memoryApi().getSettings(), null, 1);
        var hit = await locateMemory(segs);
        if (!hit || !hit.record) return null;
        return hit.isMeta ? memMeta(hit.record) : hit.record.content;
      },
      write: async function (segs, text) {
        var api = memoryApi();
        if (segs[0] === 'settings.json') throw new Error('记忆设置是只读的：请用户在面板的设置页里改');
        var hit = await locateMemory(segs);
        if (!hit) throw new Error('路径要写成 mem:/chat/<标题>.md 或 mem:/ocean/<标题>.md');
        if (hit.isMeta) {
          if (!hit.record) throw new Error('没有这条记忆：' + hit.base + '（先写 ' + hit.base + '.md 新建）');
          var meta;
          try { meta = JSON.parse(text); } catch (error) { throw new Error('meta.json 不是合法的 JSON：' + error.message); }
          var patch = {};
          MEM_META.forEach(function (key) { if (meta && meta[key] !== undefined) patch[key] = meta[key]; });
          await api.update(hit.record.id, patch);
          return;
        }
        if (hit.record) { await api.update(hit.record.id, { content: text }); return; }
        if (hit.base.indexOf('#') >= 0) throw new Error('没有这条记忆：' + hit.base);
        await api.add({ type: 'fact', title: hit.base, content: text, source: 'agent', owner: 'agent' }, { store: hit.store });
      },
      remove: async function (segs) {
        var hit = await locateMemory(segs);
        if (!hit || !hit.record || hit.isMeta) throw new Error('只能删除 mem:/chat|ocean/<标题>.md（会连同它的 meta 一起删）');
        await memoryApi().remove(hit.record.id);
      },
      bulk: async function (segs) {
        var stores = segs[0] === 'chat' || segs[0] === 'ocean' ? [segs[0]] : ['chat', 'ocean'];
        var output = [];
        for (var index = 0; index < stores.length; index += 1) {
          var records = await memRecords(stores[index]);
          var names = uniqueNames(records, memTitle, memId);
          records.forEach(function (record, at) { output.push({ path: 'mem:/' + stores[index] + '/' + enc(names[at]) + '.md', text: record.content }); });
        }
        return output;
      }
    });
  }

  modules.installPageProbe = installPageProbe;
  modules.installBuiltinProviders = installBuiltinProviders;
})(typeof globalThis !== 'undefined' ? globalThis : window);
