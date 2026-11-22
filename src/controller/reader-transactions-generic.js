/* Reader-II 通用版的状态提交。接口与上游 source/reader-transactions.js 相同（capture / read / fp / charge /
 * transact / run / merge / write / guardApi），区别只在“写到哪里”：
 *   上游固定写 stat_data.命运点数、stat_data.主角.状态效果、stat_data.主角.背包；
 *   这里经主脚本的语义路由（window.ReaderCore.tx）解析——绑定了宿主变量就写宿主路径，否则写 Reader 后备变量。
 * 一次提交仍然固定当前聊天、最新楼层与候选，用回执去重；聊天或候选变了就整笔作废。 */
(function (globals) {
  'use strict';
  function createReaderTransactions(win, options) {
    options = options || {};
    var helper = win.TavernHelper || win;
    var host = win.SillyTavern ? win : win.parent;
    var context = function () { return host.SillyTavern.getContext(); };
    var pending = new Set(), queues = new Map(), sequence = 0;
    var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
    function semantic() {
      var core = win.__ReaderIICore || host.__ReaderIICore || win.ReaderCore || host.ReaderCore;
      if (!core || !core.__reader_core_api || !core.tx) throw new Error('Reader-II 主系统尚未就绪，请稍候再试');
      return core.tx;
    }
    /* 宿主是小白X 时，楼层变量里没有宿主状态：由主脚本拼出 { kind, data, commit }（见 reader-core 的 beginTransaction）。 */
    function session(data) {
      var core = win.__ReaderIICore || host.__ReaderIICore || win.ReaderCore || host.ReaderCore;
      var tx = core && core.__reader_core_api && core.tx;
      return tx && typeof tx.begin === 'function' ? tx.begin(data) : {kind: 'mvu', data: data};
    }
    function alive() {
      if (win.__readerControllerAlive === false || options.isAlive && !options.isAlive()) {
        throw new Error('读者已关闭，旧操作已取消');
      }
    }
    function capture() {
      alive();
      var ctx = context();
      var chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      var messageId = typeof helper.getLastMessageId === 'function' ? helper.getLastMessageId() : ctx.chat.length - 1;
      if (chatId == null || chatId === '' || !Number.isSafeInteger(messageId) || messageId < 0) {
        throw new Error('请先打开有角色资料的聊天');
      }
      var native = ctx.chat && ctx.chat[messageId];
      return {chatId: String(chatId), characterId: String(ctx.characterId), messageId: messageId,
        native: native, swipeId: native && native.swipe_id, metadata: ctx.chatMetadata,
        id: 'reader-' + Date.now().toString(36) + '-' + (++sequence).toString(36)};
    }
    function assertCurrent(token) {
      alive();
      var ctx = context(), chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
      var last = typeof helper.getLastMessageId === 'function' ? helper.getLastMessageId() : ctx.chat.length - 1;
      if (!token || String(chatId) !== token.chatId || String(ctx.characterId) !== token.characterId ||
          last !== token.messageId || token.native && (ctx.chat[token.messageId] !== token.native || token.native.swipe_id !== token.swipeId)) {
        throw new Error('聊天或候选已变化，旧操作已取消，请在当前页面重试');
      }
      return ctx;
    }
    function read(token) {
      assertCurrent(token);
      if (typeof helper.getVariables !== 'function') throw new Error('缺少酒馆助手变量接口');
      return session(clone(helper.getVariables({type: 'message', message_id: token.messageId}) || {})).data;
    }
    function keepReceipts(next, id, result) {
      var receipts = next.dream_reader_receipts || {}, keys = Object.keys(receipts).slice(-127), kept = {};
      keys.forEach(function (name) { kept[name] = receipts[name]; });
      kept[id] = {value: result === undefined ? null : result};
      next.dream_reader_receipts = kept;
      return next;
    }
    /* 小白X 宿主：先在拼好的数据上改，宿主部分经 applyText 交给小白X，再把 READER 与回执写回楼层变量。 */
    async function transactLwb(token, id, mutate, current, lwb) {
      var receipts = current.dream_reader_receipts || {};
      if (Object.prototype.hasOwnProperty.call(receipts, id)) return {result: receipts[id].value, applied: false};
      var result = mutate(lwb.data);
      if (result && typeof result.then === 'function') throw new Error('状态提交内不能执行异步任务');
      assertCurrent(token);
      var mergeInto = await lwb.commit();
      var applied = false;
      await helper.updateVariablesWith(function (latest) {
        applied = true;
        return keepReceipts(mergeInto(latest || {}), id, result);
      }, {type: 'message', message_id: token.messageId});
      return {result: result, applied: applied};
    }
    /* 当前余额：货币槽绑定了宿主数值就读它，否则读 Reader 后备的命运点数。 */
    function fp(data) {
      var value = semantic().currencyRead(data);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('还没有读到有效的 FP 余额，请等待角色资料就绪');
      return value;
    }
    function setFp(data, value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('无效的FP余额');
      return semantic().currencyWrite(data, value);
    }
    function requireFp(token, cost) {
      var value = fp(read(token));
      if (!Number.isFinite(cost) || cost < 0) throw new Error('无效的FP费用');
      if (value < cost) throw new Error('FP不足，当前仅有 ' + value + 'FP');
      return value;
    }
    async function transact(token, id, mutate) {
      assertCurrent(token);
      if (typeof helper.updateVariablesWith !== 'function') throw new Error('缺少酒馆助手安全变量更新接口');
      var key = 'reader-write:' + token.characterId + ':' + token.chatId + ':' + token.messageId;
      var execute = async function () {
        assertCurrent(token);
        var result, applied = false;
        var current = typeof helper.getVariables === 'function' ? clone(helper.getVariables({type: 'message', message_id: token.messageId}) || {}) : {};
        var lwb = session(current);
        if (lwb.kind === 'lwb') {
          var done = await transactLwb(token, id, mutate, current, lwb);
          result = done.result;
          applied = done.applied;
        } else await helper.updateVariablesWith(function (current) {
          assertCurrent(token);
          var next = clone(current || {}), receipts = next.dream_reader_receipts || {};
          if (Object.prototype.hasOwnProperty.call(receipts, id)) { result = receipts[id].value; return current; }
          result = mutate(next);
          if (result && typeof result.then === 'function') throw new Error('状态提交内不能执行异步任务');
          keepReceipts(next, id, result);
          applied = true;
          return next;
        }, {type: 'message', message_id: token.messageId});
        if (options.onCommit && applied) options.onCommit(token);
        if (applied) { try { (win.__ReaderIICore || host.__ReaderIICore || win.ReaderCore || host.ReaderCore).notifyChanged('reader_transaction'); } catch (_) {} }
        return result;
      };
      var before = queues.get(key) || Promise.resolve();
      var job = before.catch(function () {}).then(function () {
        var locks = win.navigator && win.navigator.locks;
        return locks && typeof locks.request === 'function' ? locks.request(key, execute) : execute();
      });
      queues.set(key, job);
      try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
    }
    function charge(data, cost) {
      var value = fp(data);
      if (!Number.isFinite(cost) || cost < 0) throw new Error('无效的FP费用');
      if (value < cost) throw new Error('FP不足，当前仅有 ' + value + 'FP');
      setFp(data, value - cost);
      return value - cost;
    }
    function credit(data, amount) {
      if (!Number.isFinite(amount) || amount < 0) throw new Error('无效的FP数额');
      var value = fp(data) + amount;
      setFp(data, value);
      return value;
    }
    async function run(key, action) {
      if (pending.has(key)) throw new Error('这项操作正在进行，请稍候');
      var token = capture();
      pending.add(key);
      if (key === 'paid-action') win.ReaderActiveTaskToken = token;
      try { return await action(token); } finally {
        pending.delete(key);
        if (win.ReaderActiveTaskToken === token) win.ReaderActiveTaskToken = null;
      }
    }
    function merge(target, patch) {
      Object.keys(patch).forEach(function (key) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('无效的变量字段');
        var value = patch[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
          merge(target[key], value);
        } else target[key] = clone(value);
      });
      return target;
    }
    function guardApi(api, token) {
      if (!token) return api;
      return new Proxy(api, {get: function (target, key) {
        var value = target[key];
        if (typeof value !== 'function') return value;
        return function () {
          assertCurrent(token);
          var args = Array.prototype.slice.call(arguments).map(function (arg) {
            if (typeof arg !== 'function') return arg;
            return function () { assertCurrent(token); return arg.apply(this, arguments); };
          });
          var result = value.apply(target, args);
          if (result && typeof result.then === 'function') return result.then(function (data) { assertCurrent(token); return data; });
          return result;
        };
      }});
    }
    return {capture: capture, assertCurrent: assertCurrent, read: read, fp: fp, setFp: setFp, requireFp: requireFp, guardApi: guardApi,
      transact: transact, charge: charge, credit: credit, run: run, merge: merge,
      /* 主角状态：[{name, effect, duration, source}]；setStatus 同名时覆盖语义字段。 */
      statuses: function (data) { return semantic().statusList(data); },
      setStatus: function (data, status) { return semantic().statusSet(data, status); },
      /* 主角背包（命运抽卡入包与回收）。 */
      inventory: function (data) { return semantic().inventoryList(data); },
      inventoryAdd: function (data, item, extra) { return semantic().inventoryAdd(data, item, extra); },
      inventoryRemove: function (data, name, count) { return semantic().inventoryRemove(data, name, count); },
      inventoryShape: function () { return semantic().inventoryShape(); },
      write: function (token, patch, suffix) { return transact(token, token.id + ':' + (suffix || 'write'), function (data) { merge(data, patch); }); }};
  }
  globals.createReaderTransactions = createReaderTransactions;
  globals.ReaderTransactions = createReaderTransactions(globals);
})(window);
