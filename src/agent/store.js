(function (root) {
  'use strict';

  /*
   * 本地存储与运行日志。
   *
   * createStore  IndexedDB 的最小封装（键值形式）；没有 IndexedDB 时退回内存，功能不变、只是不持久。
   * createJournal 每轮运行的记录 + 写入前镜像。撤销 = 把镜像按相反顺序写回去；
   *               写回前比对「当时写完的内容」与「现在的内容」的哈希，被别处改过就算冲突，不强行覆盖。
   *
   * 大数据都放这里，不进聊天文件，也不进 settings.json。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var DB_NAME = 'reader_ii_agent_v1';
  var STORES = ['runs', 'changes', 'files', 'kv'];
  var KEEP_RUNS = 30;
  var MAX_IMAGE = 4 * 1024 * 1024;

  function createStore(env, name) {
    var memory = {};
    var opening = null;
    var broken = false;
    STORES.forEach(function (store) { memory[store] = new Map(); });

    function open() {
      if (broken) return Promise.resolve(null);
      if (opening) return opening;
      opening = new Promise(function (resolve) {
        var factory = null;
        try { factory = env && env.host && env.host.indexedDB; } catch (error) { factory = null; }
        if (!factory) { broken = true; resolve(null); return; }
        var request;
        try { request = factory.open(name || DB_NAME, 1); } catch (error) { broken = true; resolve(null); return; }
        request.onupgradeneeded = function () {
          STORES.forEach(function (store) { if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store); });
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = request.onblocked = function () { broken = true; resolve(null); };
      });
      return opening;
    }

    /* 以 prefix 开头的字符串键的范围；宿主没有 IDBKeyRange 时返回 null（调用方退回全量再筛）。 */
    function prefixRange(prefix) {
      if (!prefix) return null;
      var Range = null;
      try { Range = env && env.host && env.host.IDBKeyRange || root.IDBKeyRange || null; } catch (error) { Range = null; }
      if (!Range || typeof Range.bound !== 'function') return null;
      try { return Range.bound(prefix, prefix + '￿'); } catch (error) { return null; }
    }
    function startsWith(key, prefix) { return !prefix || String(key).indexOf(prefix) === 0; }

    function run(store, mode, work) {
      return open().then(function (db) {
        if (!db) return work(null, memory[store]);
        return new Promise(function (resolve, reject) {
          var tx, result;
          try { tx = db.transaction(store, mode); } catch (error) { reject(error); return; }
          var request = work(tx.objectStore(store), null);
          if (request) request.onsuccess = function () { result = request.result; };
          tx.oncomplete = function () { resolve(result); };
          tx.onerror = tx.onabort = function () { reject(tx.error || new Error('本地存储写入失败')); };
        });
      });
    }

    return {
      /* 对话目录和正文一起提交。先在同一事务内读取目录，供多个标签页比较修订号。 */
      update: async function (store, key, work) {
        var db = await open();
        if (!db) {
          var map = memory[store], writes = [], deletes = [];
          var value = work(modules.clone(map.get(key)), {
            put: function (k, v) { writes.push([k, v]); }, del: function (k) { deletes.push(k); }
          });
          writes.forEach(function (pair) { map.set(pair[0], pair[1]); });
          deletes.forEach(function (k) { map.delete(k); });
          return value;
        }
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
          var read = os.get(key), answer, failed;
          read.onsuccess = function () {
            try { answer = work(read.result, { put: function (k, v) { os.put(v, k); }, del: function (k) { os.delete(k); } }); }
            catch (error) { failed = error; tx.abort(); }
          };
          tx.oncomplete = function () { resolve(answer); };
          tx.onerror = tx.onabort = function () { reject(failed || tx.error || new Error('保存助手对话失败')); };
        });
      },
      get: function (store, key) { return run(store, 'readonly', function (os, map) { return os ? os.get(key) : map.get(key); }); },
      put: function (store, key, value) { return run(store, 'readwrite', function (os, map) { if (os) return os.put(value, key); map.set(key, value); }); },
      del: function (store, key) { return run(store, 'readwrite', function (os, map) { if (os) return os.delete(key); map.delete(key); }); },
      /* prefix：只要以它开头的键（工作区列一个目录、取一轮运行的镜像时，不必把整张表搬出来）。 */
      keys: function (store, prefix) {
        var range = prefixRange(prefix);
        return run(store, 'readonly', function (os, map) { return os ? (range ? os.getAllKeys(range) : os.getAllKeys()) : Array.from(map.keys()); })
          .then(function (keys) { return prefix ? (keys || []).filter(function (key) { return startsWith(key, prefix); }) : keys; });
      },
      all: function (store, prefix) {
        if (!prefix) return run(store, 'readonly', function (os, map) { return os ? os.getAll() : Array.from(map.values()); });
        var range = prefixRange(prefix);
        return open().then(function (db) {
          if (!db) return Array.from(memory[store].entries()).filter(function (pair) { return startsWith(pair[0], prefix); }).map(function (pair) { return pair[1]; });
          if (range) return run(store, 'readonly', function (os) { return os.getAll(range); });
          /* 没有键范围：先取键再逐条取值，免得把无关的大镜像都读进来。 */
          return run(store, 'readonly', function (os) { return os.getAllKeys(); }).then(function (keys) {
            return Promise.all((keys || []).filter(function (key) { return startsWith(key, prefix); }).map(function (key) {
              return run(store, 'readonly', function (os) { return os.get(key); });
            }));
          });
        });
      },
      persistent: function () { return open().then(function (db) { return !!db; }); }
    };
  }

  function createJournal(store) {
    var sequence = 0;

    function begin(info) {
      var now = Date.now();
      var run = {
        id: now.toString(36) + '-' + (++sequence).toString(36) + Math.random().toString(36).slice(2, 6),
        chat: String(info && info.chat || ''), title: String(info && info.title || '').slice(0, 120),
        startedAt: now, endedAt: 0, status: 'running', changes: 0, notes: [], seen: {}
      };
      return run;
    }

    function persist(run) {
      var record = { id: run.id, chat: run.chat, title: run.title, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status, changes: run.changes, notes: run.notes.slice(0, 40), undone: run.undone === true };
      return store.put('runs', run.id, record);
    }

    /* 写入前调用：同一轮里同一路径只留第一份镜像，撤销回到这一轮开始前的样子。 */
    async function capture(run, path, before) {
      if (!run || run.seen[path]) return;
      var index = run.changes;
      run.seen[path] = run.id + ':' + String(index).padStart(4, '0');
      run.changes += 1;
      var tooLarge = typeof before === 'string' && before.length > MAX_IMAGE;
      await store.put('changes', run.seen[path], {
        runId: run.id, seq: index, path: path, existed: before !== null && before !== undefined,
        before: tooLarge ? null : before, tooLarge: tooLarge, afterHash: null, at: Date.now()
      });
      if (index === 0) await persist(run);
    }

    /* 写入后调用：记下写完的内容哈希，撤销时用来判断有没有被别处改过。 */
    async function settle(run, path, after) {
      if (!run || !run.seen[path]) return;
      var record = await store.get('changes', run.seen[path]);
      if (!record) return;
      record.afterHash = after === null || after === undefined ? '' : modules.hashText(after);
      await store.put('changes', run.seen[path], record);
    }

    function note(run, text) {
      if (run && run.notes.length < 40) run.notes.push(String(text).slice(0, 200));
    }

    async function end(run, status) {
      if (!run) return;
      run.status = status || 'done';
      run.endedAt = Date.now();
      if (run.changes || run.notes.length) { await persist(run); await prune(); }
    }

    async function list(limit, chat) {
      var runs = (await store.all('runs')) || [];
      if (chat !== undefined) runs = runs.filter(function (run) { return run.chat === chat; });
      runs.sort(function (left, right) { return right.startedAt - left.startedAt; });
      return runs.slice(0, limit || KEEP_RUNS);
    }

    async function changes(runId) {
      var rows = (await store.all('changes', runId + ':')) || [];
      return rows.filter(function (row) { return row && row.runId === runId; }).sort(function (left, right) { return left.seq - right.seq; });
    }

    async function prune() {
      var runs = await list(1000);
      var drop = runs.slice(KEEP_RUNS);
      if (!drop.length) return;
      var keys = (await store.keys('changes')) || [];
      for (var index = 0; index < drop.length; index += 1) {
        var prefix = drop[index].id + ':';
        for (var k = 0; k < keys.length; k += 1) if (String(keys[k]).indexOf(prefix) === 0) await store.del('changes', keys[k]);
        await store.del('runs', drop[index].id);
      }
    }

    /*
     * io: { chat, read(path) → string|null, restore(path, before|null) }
     * 返回 { restored: [path], conflicts: [{path, reason}], notes: [不可自动撤销的操作] }
     */
    async function undo(runId, io, options) {
      var force = options && options.force === true;
      var record = await store.get('runs', runId);
      if (!record) throw new Error('找不到这轮改动的运行记录');
      if (io.chat !== undefined && record.chat !== io.chat) throw new Error('这轮改动属于另一个聊天，请回到原聊天撤销');
      var items = (await changes(runId)).reverse();
      var report = { restored: [], conflicts: [], notes: record && record.notes || [] };
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        try {
          if (item.tooLarge) { report.conflicts.push({ path: item.path, reason: '原内容太大，没有保存镜像' }); continue; }
          var current = await io.read(item.path);
          var currentHash = current === null || current === undefined ? '' : modules.hashText(current);
          if (!force && item.afterHash !== null && currentHash !== item.afterHash) {
            report.conflicts.push({ path: item.path, reason: '这之后内容又被改过' });
            continue;
          }
          await io.restore(item.path, item.existed ? item.before : null);
          report.restored.push(item.path);
        } catch (error) {
          report.conflicts.push({ path: item.path, reason: String(error && error.message || error).slice(0, 160) });
        }
      }
      record.undone = items.length > 0 && report.conflicts.length === 0;
      await store.put('runs', runId, record);
      return report;
    }

    return { begin: begin, capture: capture, settle: settle, note: note, end: end, list: list, changes: changes, undo: undo };
  }

  /*
   * 只载入目录及当前线程正文。账号独享数据库，角色以 avatar + 酒馆聊天 ID 标识；
   * 未打开卡的对话归属为空。切换宿主聊天时同步使旧缓存失效。
   */
  function createThreadHistory(env, kit, storeFactory) {
    var databases = new Map(), state = null;
    var ephemeralAccount = null;
    var host = env.host || {};
    function id() {
      return host.crypto && host.crypto.randomUUID ? host.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
    function account(ctx) {
      var prefs = ctx.extensionSettings;
      if (!prefs) return ephemeralAccount || (ephemeralAccount = id());
      var bag = prefs.reader_ii || (prefs.reader_ii = {});
      if (!bag.threadVault) {
        bag.threadVault = id();
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
      }
      return bag.threadVault;
    }
    function hostOwner(ctx) {
      var chat = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      var group = ctx.groupId != null && ctx.groupId !== '';
      var card = ctx.characters && ctx.characters[ctx.characterId];
      var noCharacter = ctx.characterId == null || ctx.characterId === '' || String(ctx.characterId) === '-1';
      if (chat == null || chat === '' || (!group && noCharacter)) return { key: '', label: '无卡' };
      var owner = group ? 'group:' + ctx.groupId : 'card:' + (card && card.avatar || ctx.characterId);
      var name = group ? ((ctx.groups || []).find(function (item) { return String(item.id) === String(ctx.groupId); }) || {}).name || '群聊 ' + ctx.groupId : card && card.name || ctx.name2 || '角色卡';
      return { key: JSON.stringify([owner, String(chat)]), label: String(name) + ' / ' + chat };
    }
    function scope() {
      var ctx = kit.context() || {}, vault = account(ctx), owner = hostOwner(ctx);
      if (state && state.vault === vault && state.owner.key === owner.key) return state;
      if (!databases.has(vault)) databases.set(vault, (storeFactory || createStore)(env, 'reader_ii_threads_' + vault));
      state = { vault: vault, owner: owner, db: databases.get(vault), rows: [], active: null, data: null, loading: null, remembered: false };
      return state;
    }
    function same(s) {
      if (scope() !== s) throw new Error('聊天或账号已切换，请重试');
    }
    function fresh() { return { turns: [], extracted: 0 }; }
    function makeRow(owner, title, parent) {
      return { id: id(), owner: owner, title: title || '', parentId: parent || '', updated: Date.now(), revision: 0 };
    }
    function key(row) { return 'thread:' + row.id; }
    function mutate(s, change) {
      return s.db.update('kv', 'directory', function (raw, write) {
        same(s);
        var directory = raw || { rows: [], selected: {} };
        var answer = change(directory, write);
        write.put('directory', directory);
        return { directory: directory, value: answer };
      });
    }
    function choose(directory, owner, write) {
      var selected = directory.selected[owner.key];
      var row = directory.rows.find(function (item) { return item.id === selected && item.owner.key === owner.key; })
        || directory.rows.find(function (item) { return item.owner.key === owner.key; });
      if (!row) {
        row = makeRow(owner);
        directory.rows.unshift(row);
        write.put(key(row), fresh());
      }
      directory.selected[owner.key] = row.id;
      return row;
    }
    async function install(s, result, data) {
      var row = result.value;
      var body = data || await s.db.get('kv', key(row));
      same(s);
      if (!body) throw new Error('找不到这条对话，可能已被其他标签页删除');
      s.active = row;
      s.data = body;
      s.rows = result.directory.rows;
      return row.id;
    }
    async function load(s) {
      var result = await mutate(s, function (directory, write) { return choose(directory, s.owner, write); });
      await install(s, result);
      s.remembered = await s.db.persistent();
    }
    function ready() {
      var s = scope();
      if (!s.loading) s.loading = load(s).catch(function (error) { s.loading = null; throw error; });
      return s.loading;
    }
    function currentId() { var row = scope().active; return row ? row.id : ''; }
    function canRun() { var s = scope(); return !!s.active && s.active.owner.key === s.owner.key; }
    function isUnbound() { var row = scope().active; return !row || !row.owner.key; }
    function read() {
      var s = scope();
      return Object.assign({}, modules.clone(s.data || fresh()), { threadId: currentId(), revision: s.active ? s.active.revision : 0 });
    }
    async function write(next) {
      var s = scope(), expectedId = next.threadId || currentId();
      await ready();
      same(s);
      var row = s.active, revision = next.revision == null ? row.revision : next.revision;
      if ((expectedId && expectedId !== row.id) || !canRun()) throw new Error('对话已切换，请重新操作');
      var data = { turns: modules.clone(next.turns), extracted: Number(next.extracted) || 0 };
      if (next.checkpoint && next.checkpoint.text) data.checkpoint = modules.clone(next.checkpoint);
      var result = await mutate(s, function (directory, writer) {
        var live = directory.rows.find(function (item) { return item.id === row.id; });
        if (!live || live.revision !== revision) throw new Error('对话已被其他操作修改，请重新打开对话');
        var first = data.turns.find(function (turn) { return turn.role === 'user'; });
        if (!live.title && first) live.title = first.text.trim().slice(0, 40);
        live.updated = Date.now();
        live.revision++;
        writer.put(key(live), data);
        return live;
      });
      same(s);
      if (currentId() === row.id) await install(s, result, data);
      return true;
    }
    async function create(options) {
      var s = scope();
      await ready(); same(s);
      var opts = options || {}, data = fresh(), owner = s.owner;
      if (opts.fromId) {
        if (currentId() !== opts.fromId || !canRun()) throw new Error('交接来源已切换，请重试');
        data.checkpoint = { text: opts.summary, throughId: '', task: String(opts.input || '') };
      }
      var title = opts.fromId ? '交接 · ' + String(opts.input || s.active.title || '继续任务').slice(0, 35) : '';
      var row = makeRow(owner, title, opts.fromId);
      var parentData = opts.fromId ? modules.clone(s.data) : null;
      if (parentData && opts.input) parentData.turns.push({ id: id(), role: 'user', text: String(opts.input), at: Date.now() });
      var result = await mutate(s, function (directory, writer) {
        if (opts.fromId) {
          var parent = directory.rows.find(function (item) { return item.id === opts.fromId; });
          if (!parent || parent.revision !== s.active.revision) throw new Error('交接来源已经变更');
          parent.nextId = row.id;
          parent.updated = row.updated;
          parent.revision++;
          if (!parent.title && opts.input) parent.title = String(opts.input).slice(0, 40);
          writer.put(key(parent), parentData);
        }
        directory.rows.unshift(row);
        directory.selected[owner.key] = row.id;
        writer.put(key(row), data);
        return row;
      });
      return install(s, result, data);
    }
    async function select(threadId) {
      var s = scope();
      await ready(); same(s);
      var result = await mutate(s, function (directory) {
        var row = directory.rows.find(function (item) { return item.id === threadId; });
        if (!row) throw new Error('找不到这条对话');
        if (row.owner.key === s.owner.key) directory.selected[s.owner.key] = row.id;
        return row;
      });
      return install(s, result);
    }
    async function refresh() {
      var s = scope();
      if (!s.active) return ready();
      var result = await mutate(s, function (directory, writer) {
        return directory.rows.find(function (item) { return item.id === s.active.id; }) || choose(directory, s.owner, writer);
      });
      return install(s, result);
    }
    async function remove(threadId) {
      var s = scope();
      await ready(); same(s);
      var result = await mutate(s, function (directory, writer) {
        var index = directory.rows.findIndex(function (item) { return item.id === threadId; });
        if (index >= 0) {
          var row = directory.rows.splice(index, 1)[0];
          writer.del(key(row));
          if (directory.selected[row.owner.key] === row.id) delete directory.selected[row.owner.key];
        }
        var active = directory.rows.find(function (item) { return item.id === s.active.id; });
        return active || choose(directory, s.owner, writer);
      });
      return install(s, result);
    }
    /* IndexedDB 的目录事务和正文读取之间可插入别的操作。排队到缓存安装完毕，
       避免旧刷新最后返回，盖过较新的选择或已写入的消息。 */
    function queued(action) {
      return function (value) {
        var s = scope();
        var run = (s.pending || Promise.resolve()).then(function () { same(s); return action(value); });
        s.pending = run.catch(function () {});
        return run;
      };
    }
    function whenReady() {
      var s = scope();
      return s.pending ? s.pending.then(function () { same(s); return ready(); }) : ready();
    }
    var newThread = queued(create);
    return {
      ready: whenReady, refresh: queued(refresh), read: read, write: queued(write), turnId: id, currentId: currentId, canRun: canRun, isUnbound: isUnbound,
      checkpoint: function () { var data = scope().data; return data && modules.clone(data.checkpoint); },
      list: function () { return modules.clone(scope().rows).sort(function (a, b) { return b.updated - a.updated; }); },
      persistent: function () { return scope().remembered; },
      create: newThread, select: queued(select), remove: queued(remove), handoff: newThread
    };
  }

  modules.createThreadHistory = createThreadHistory;
  modules.createStore = createStore;
  modules.createJournal = createJournal;
})(typeof globalThis !== 'undefined' ? globalThis : window);
