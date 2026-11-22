(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var FIXED_NARRATIVE_REWARDS = {
    chapter_D: 50,
    chapter_C: 100,
    chapter_B: 500,
    chapter_A: 1000,
    chapter_S: 10000,
    emotional_interaction: 100,
    highlight_moment: 1500
  };

  var DANGEROUS_SEGMENTS = { __proto__: true, prototype: true, constructor: true };

  function safePath(path) {
    if (typeof path !== 'string') return '';
    var value = path.trim();
    if (!/^stat_data\.(?!READER(?:\.|$))/.test(value)) return '';
    if (/[<>{}\[\]'"`;\r\n]/.test(value)) return '';
    if (/(^|\.)(__proto__|prototype|constructor)(\.|$)/.test(value)) return '';
    return value;
  }

  function getPath(object, path, fallback) {
    var parts = String(path || '').split('.').filter(Boolean);
    var value = object;
    for (var index = 0; index < parts.length; index += 1) {
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, parts[index])) return fallback;
      value = value[parts[index]];
    }
    return value === undefined ? fallback : value;
  }

  function setPath(object, path, value) {
    var parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) throw new Error('空路径不可写入');
    var cursor = object;
    for (var index = 0; index < parts.length - 1; index += 1) {
      var key = parts[index];
      if (!modules.isObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function normalizeHostRef(input) {
    var raw = input;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (Array.isArray(raw.segments)) raw = raw.segments;
      else if (raw.ref !== undefined) raw = raw.ref;
      else if (raw.path !== undefined) raw = raw.path;
    }
    if (typeof raw === 'string' && raw.indexOf('hostref:') === 0) {
      try { raw = JSON.parse(decodeURIComponent(raw.slice(8))); }
      catch (error) { return null; }
    } else if (typeof raw === 'string') {
      var safe = safePath(raw);
      if (!safe) return null;
      raw = safe.split('.').filter(Boolean);
    }
    if (!Array.isArray(raw) || raw.length < 2 || raw[0] !== 'stat_data' || raw[1] === 'READER') return null;
    var segments = [];
    for (var index = 0; index < raw.length; index += 1) {
      var segment = raw[index];
      if (typeof segment === 'number') {
        if (!Number.isInteger(segment) || segment < 0) return null;
      } else if (typeof segment === 'string') {
        if (!segment || DANGEROUS_SEGMENTS[segment]) return null;
      } else return null;
      segments.push(segment);
    }
    return segments;
  }

  function createHostRef(input) {
    var segments = normalizeHostRef(input);
    return segments ? 'hostref:' + encodeURIComponent(JSON.stringify(segments)) : '';
  }

  function hostDisplayPath(input) {
    var segments = normalizeHostRef(input);
    if (!segments) return '';
    var output = 'stat_data';
    for (var index = 1; index < segments.length; index += 1) {
      var segment = segments[index];
      if (typeof segment === 'number') output += '[' + segment + ']';
      else if (/^[^.[\]]+$/.test(segment)) output += '.' + segment;
      else output += '[' + JSON.stringify(segment) + ']';
    }
    return output;
  }

  function getHostValue(object, input, fallback) {
    var segments = normalizeHostRef(input);
    if (!segments) return fallback;
    var cursor = object;
    for (var index = 0; index < segments.length; index += 1) {
      var key = segments[index];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, key)) return fallback;
      cursor = cursor[key];
    }
    return cursor === undefined ? fallback : cursor;
  }

  function setHostValue(object, input, value) {
    var segments = normalizeHostRef(input);
    if (!segments) throw new Error('宿主路径引用无效');
    var cursor = object;
    for (var index = 0; index < segments.length - 1; index += 1) {
      var key = segments[index];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, key)) {
        throw new Error('宿主路径当前不存在：' + hostDisplayPath(segments.slice(0, index + 1)));
      }
      cursor = cursor[key];
    }
    cursor[segments[segments.length - 1]] = value;
  }

  function deleteHostValue(object, input) {
    var segments = normalizeHostRef(input);
    if (!segments || segments.length <= 2) throw new Error('不能删除宿主顶层根节点');
    var parent = getHostValue(object, segments.slice(0, -1), undefined);
    if (!parent || typeof parent !== 'object') return false;
    var key = segments[segments.length - 1];
    if (Array.isArray(parent) && typeof key === 'number') {
      if (key < 0 || key >= parent.length) return false;
      parent.splice(key, 1);
      return true;
    }
    if (!Object.prototype.hasOwnProperty.call(parent, key)) return false;
    delete parent[key];
    return true;
  }

  function createEconomy(controller, runtimeStore) {
    function assertReaderTasksEnabled() {
      var route = runtimeStore.read().routing.tasks;
      if (route.status === 'active' || route.status === 'broken') {
        throw new Error('宿主任务已接管完整生命周期，Reader不得创建、结算或删除任务');
      }
    }
    function readBalanceFrom(reader) {
      var value = Number(reader && reader.命运点数);
      return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
    }

    function currencyRoute() {
      var runtime = runtimeStore.read();
      return runtime.routing && runtime.routing.currency || { status: 'unbound', rootRef: '' };
    }

    function markCurrencyBroken(message) {
      runtimeStore.mutate(function (runtime) {
        var route = runtime.routing && runtime.routing.currency;
        if (!route || (route.status !== 'active' && route.status !== 'broken')) return;
        route.status = 'broken';
        route.brokenReason = String(message || '宿主货币绑定已失效').slice(0, 500);
      });
    }

    function resolveBalanceTarget(data, reader) {
      var route = currencyRoute();
      if (route.status === 'broken') throw new Error(route.brokenReason || '宿主货币绑定已损坏，请重新绑定');
      if (route.status !== 'active') {
        return {
          value: readBalanceFrom(reader),
          target: { kind: 'reader', path: ['stat_data', 'READER', '命运点数'] },
          write: function (next) { reader.命运点数 = next; }
        };
      }
      var segments = normalizeHostRef(route.rootRef);
      var missing = {};
      var raw = segments ? getHostValue(data, segments, missing) : missing;
      if (raw === missing || typeof raw !== 'number' || !Number.isFinite(raw)) {
        var reason = raw === missing ? '宿主货币路径已失效，请重新绑定' : '宿主货币不再是有限数值，请重新绑定';
        markCurrencyBroken(reason);
        throw new Error(reason);
      }
      return {
        value: raw,
        target: { kind: 'host', ref: createHostRef(segments), segments: segments },
        write: function (next) { setHostValue(data, segments, next); }
      };
    }

    async function getFpBalance() {
      var snapshot = await controller.snapshot();
      return resolveBalanceTarget(snapshot.data, snapshot.reader).value;
    }

    async function transact(delta, reason, idempotencyKey, metadata) {
      var amount = Math.trunc(Number(delta));
      if (!Number.isFinite(amount) || amount === 0) throw new Error('FP变动必须是非零整数');
      var eventKey = idempotencyKey ? String(idempotencyKey) : '';
      var runtime = runtimeStore.read();
      if (eventKey && runtime.settledEvents[eventKey]) {
        return { balance: await getFpBalance(), duplicate: true, entry: modules.clone(runtime.settledEvents[eventKey]) };
      }
      var result = await controller.mutate('economy:' + String(reason || 'unspecified'), function (data, reader) {
        var target = resolveBalanceTarget(data, reader);
        var before = target.value;
        var after = before + amount;
        if (after < 0) throw new Error('FP不足，当前仅有 ' + before + ' FP');
        target.write(after);
        return {
          balance: after,
          duplicate: false,
          entry: {
            id: eventKey || ('runtime:' + Date.now() + ':' + Math.random().toString(36).slice(2)),
            reason: String(reason || 'unspecified'),
            amount: amount,
            before: before,
            after: after,
            target: modules.clone(target.target),
            metadata: modules.clone(metadata || {}),
            at: new Date().toISOString()
          }
        };
      });
      if (eventKey) runtimeStore.mutate(function (state) { state.settledEvents[eventKey] = modules.clone(result.entry); });
      return result;
    }

    function creditFp(amount, reason, idempotencyKey, metadata) {
      return transact(Math.abs(Math.trunc(Number(amount))), reason, idempotencyKey, metadata);
    }

    function spendFp(cost, reason, idempotencyKey, metadata) {
      return transact(-Math.abs(Math.trunc(Number(cost))), reason, idempotencyKey, metadata);
    }

    function refundFp(amount, reason, idempotencyKey, metadata) {
      return creditFp(amount, reason || 'refund', idempotencyKey, metadata);
    }

    async function rollbackCurrencyEntry(entry) {
      var amount = Math.trunc(Number(entry && entry.amount));
      var target = entry && entry.target;
      if (!Number.isFinite(amount) || !target) throw new Error('货币回滚记录无效');
      return controller.mutate('rollback_currency_entry', function (data, reader) {
        var current;
        if (target.kind === 'host') {
          var segments = normalizeHostRef(target.ref || target.segments);
          var missing = {};
          current = segments ? getHostValue(data, segments, missing) : missing;
          if (current === missing || typeof current !== 'number' || !Number.isFinite(current)) throw new Error('原宿主货币目标不可回滚');
          var hostAfter = current - amount;
          if (!Number.isFinite(hostAfter) || hostAfter < 0) throw new Error('宿主货币回滚会产生非法余额');
          setHostValue(data, segments, hostAfter);
          return hostAfter;
        }
        current = Number(reader && reader.命运点数);
        if (!Number.isFinite(current)) throw new Error('原Reader货币目标不可回滚');
        var readerAfter = current - amount;
        if (!Number.isFinite(readerAfter) || readerAfter < 0) throw new Error('Reader货币回滚会产生非法余额');
        reader.命运点数 = readerAfter;
        return readerAfter;
      });
    }

    function validateRange(amount, minimum, maximum, label) {
      var value = Math.trunc(Number(amount));
      if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(label + '奖励必须在 ' + minimum + ' 至 ' + maximum + ' FP 之间');
      }
      return value;
    }

    async function settleReaderEvent(event, context) {
      if (!event || typeof event !== 'object') throw new Error('Reader事件格式无效');
      var source = String(event.source || '');
      var category = String(event.category || '');
      var messageId = context && context.messageId !== undefined ? context.messageId : 'latest';
      var eventId = String(event.event_id || event.id || category || 'event');
      var key = 'message:' + messageId + ':reader_event:' + eventId;
      var amount;
      if (source === 'reader_owned' && category === 'resurrection') amount = 200;
      else if (source === 'reader_owned' && category === 'chess_hard') amount = validateRange(event.amount, 1, 9999, '认真难度国际象棋');
      else if (source === 'reader_owned' && category === 'chess_friendly') amount = validateRange(event.amount, 1, 999, '友谊赛国际象棋');
      else if (source === 'narrative') {
        if (Object.prototype.hasOwnProperty.call(FIXED_NARRATIVE_REWARDS, category)) amount = FIXED_NARRATIVE_REWARDS[category];
        else if (category === 'fate_achievement') amount = validateRange(event.amount, 5000, 50000, '命运成就');
        else if (category === 'adversity') amount = validateRange(event.amount, 1000, 50000, '逆境克服');
        else throw new Error('未知剧情FP类别: ' + category);
      } else throw new Error('未知Reader事件来源: ' + source + '/' + category);

      var result = await creditFp(amount, source + ':' + category, key, {
        evidence: String(event.evidence || ''),
        message_id: messageId
      });
      if (source === 'reader_owned' && category === 'resurrection' && !result.duplicate && String(event.persona || '') === 'kuromaku') {
        var incremented = false;
        await controller.mutate('record_resurrection', function (data, reader) {
          if (reader.黑幕结局 === 'killed' || reader.黑幕结局 === 'confessed') return;
          reader.进度 = Math.max(0, Math.trunc(Number(reader.进度) || 0)) + 1;
          incremented = true;
        });
        if (incremented) result.progressDelta = 1;
      }
      return result;
    }

    function taskRewardText(reward, treasure) {
      var parts = [];
      if (reward > 0) parts.push('FP ' + reward);
      if (treasure) parts.push(String(treasure));
      return parts.join('；') || '完成时按章节说明结算';
    }

    async function createChapterTask(task, context) {
      assertReaderTasksEnabled();
      if (!task || typeof task !== 'object') throw new Error('章节任务格式无效');
      var type = String(task.type || '');
      if (['史诗之章', '成长之章', '前进之章'].indexOf(type) < 0) throw new Error('未知章节任务');
      var taskId = String(task.task_id || task.id || task.title || type);
      var reward = validateRange(task.reward_fp, 1500, 50000, '章节任务“大量FP”');
      return controller.mutate('create_chapter_task', function (data, reader) {
        if (reader.任务列表[taskId]) return modules.clone(reader.任务列表[taskId]);
        reader.任务列表[taskId] = {
          状态: '进行中',
          详情: 'Reader章节任务；类型：' + type + '；委托方：' + String(task.issuer || '九十九夜梦'),
          目标: String(task.goal || ''),
          奖励: taskRewardText(reward, task.treasure)
        };
        return modules.clone(reader.任务列表[taskId]);
      });
    }

    async function settleChapterTask(taskId, context) {
      assertReaderTasksEnabled();
      var id = String(taskId || '');
      var messageId = context && context.messageId !== undefined ? context.messageId : 'latest';
      var snapshot = await controller.snapshot();
      var task = snapshot.reader.任务列表[id];
      if (!task) throw new Error('章节任务不存在: ' + id);
      var match = String(task.奖励 || '').match(/FP\s*(\d+)/i);
      var reward = match ? Math.max(0, Math.trunc(Number(match[1]) || 0)) : 0;
      var result = reward > 0
        ? await creditFp(reward, 'chapter_task', 'chapter_task:' + id + ':message:' + messageId, { message_id: messageId })
        : { balance: await getFpBalance(), skipped: true };
      await controller.mutate('settle_chapter_task', function (data, reader) { delete reader.任务列表[id]; });
      result.task = modules.clone(task);
      return result;
    }

    return {
      getFpBalance: getFpBalance,
      creditFp: creditFp,
      spendFp: spendFp,
      refundFp: refundFp,
      rollbackCurrencyEntry: rollbackCurrencyEntry,
      settleReaderEvent: settleReaderEvent,
      createChapterTask: createChapterTask,
      settleChapterTask: settleChapterTask,
      readBalanceFrom: readBalanceFrom,
      safeHostPath: safePath,
      getPath: getPath,
      setPath: setPath,
      normalizeHostRef: normalizeHostRef,
      createHostRef: createHostRef,
      hostDisplayPath: hostDisplayPath,
      getHostValue: getHostValue,
      setHostValue: setHostValue,
      deleteHostValue: deleteHostValue
    };
  }

  modules.FIXED_NARRATIVE_REWARDS = FIXED_NARRATIVE_REWARDS;
  modules.normalizeHostRef = normalizeHostRef;
  modules.createHostRef = createHostRef;
  modules.hostDisplayPath = hostDisplayPath;
  modules.createEconomy = createEconomy;
})(typeof globalThis !== 'undefined' ? globalThis : window);
