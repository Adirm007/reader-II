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
      get: function (store, key) { return run(store, 'readonly', function (os, map) { return os ? os.get(key) : map.get(key); }); },
      put: function (store, key, value) { return run(store, 'readwrite', function (os, map) { if (os) return os.put(value, key); map.set(key, value); }); },
      del: function (store, key) { return run(store, 'readwrite', function (os, map) { if (os) return os.delete(key); map.delete(key); }); },
      keys: function (store) { return run(store, 'readonly', function (os, map) { return os ? os.getAllKeys() : Array.from(map.keys()); }); },
      all: function (store) { return run(store, 'readonly', function (os, map) { return os ? os.getAll() : Array.from(map.values()); }); },
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

    async function list(limit) {
      var runs = (await store.all('runs')) || [];
      runs.sort(function (left, right) { return right.startedAt - left.startedAt; });
      return runs.slice(0, limit || KEEP_RUNS);
    }

    async function changes(runId) {
      var keys = (await store.keys('changes')) || [];
      var output = [];
      for (var index = 0; index < keys.length; index += 1) {
        if (String(keys[index]).indexOf(runId + ':') === 0) output.push(await store.get('changes', keys[index]));
      }
      return output.filter(Boolean).sort(function (left, right) { return left.seq - right.seq; });
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
     * io: { read(path) → string|null, restore(path, before|null) }
     * 返回 { restored: [path], conflicts: [{path, reason}], notes: [不可自动撤销的操作] }
     */
    async function undo(runId, io, options) {
      var force = options && options.force === true;
      var record = await store.get('runs', runId);
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
      if (record) { record.undone = report.conflicts.length === 0; await store.put('runs', runId, record); }
      return report;
    }

    return { begin: begin, capture: capture, settle: settle, note: note, end: end, list: list, changes: changes, undo: undo };
  }

  modules.createStore = createStore;
  modules.createJournal = createJournal;
})(typeof globalThis !== 'undefined' ? globalThis : window);
