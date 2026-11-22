(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var FP_PATTERN = /<READER_FP_EVENT>\s*([\s\S]*?)\s*<\/READER_FP_EVENT>/gi;
  var TASK_PATTERN = /<READER_TASK_EVENT>\s*([\s\S]*?)\s*<\/READER_TASK_EVENT>/gi;
  var ACTION_PATTERN = /<READER_ACTION_EVENT>\s*([\s\S]*?)\s*<\/READER_ACTION_EVENT>/gi;

  function parseTaggedJson(text, pattern) {
    var output = [];
    var match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      try {
        var value = JSON.parse(match[1]);
        if (value && typeof value === 'object' && !Array.isArray(value)) output.push(value);
      } catch (error) {
        /* malformed events are ignored rather than executed */
      }
    }
    return output;
  }

  function signature(text) {
    return modules.hashText ? modules.hashText(String(text || '')) : String(text || '').length + '';
  }

  function createEventParser(controller, env, economy, runtimeStore, semanticRouter, options) {
    var enabledCheck = options && typeof options.isEnabled === 'function' ? options.isEnabled : null;
    function active() {
      if (!enabledCheck) return true;
      try { return enabledCheck() === true; } catch (error) { return false; }
    }
    function getMessage(messageId) {
      if (typeof env.getChatMessages !== 'function') return null;
      try {
        var messages = env.getChatMessages(messageId, { include_swipes: false });
        return messages && messages[0] ? messages[0] : null;
      } catch (error) {
        return null;
      }
    }

    function sameValue(left, right) {
      var stringify = modules.stableStringify || JSON.stringify;
      return stringify(left) === stringify(right);
    }

    async function rollbackStatusOperation(operation) {
      if (!operation || !operation.target) return false;
      return controller.mutate('rollback_status_insert', function (data, reader) {
        var target = operation.target;
        if (target.kind === 'reader_status') {
          var effects = reader && reader.主角 && reader.主角.状态效果;
          if (modules.isObject(effects) && sameValue(effects[target.key], operation.entry)) {
            delete effects[target.key];
            return true;
          }
          return false;
        }
        if (target.kind !== 'host_status') return false;
        var container = economy.getHostValue(data, target.rootRef, undefined);
        if (Array.isArray(container)) {
          var locatorIndex = target.locator && target.locator.index;
          if (Number.isInteger(locatorIndex) && sameValue(container[locatorIndex], operation.entry)) {
            container.splice(locatorIndex, 1);
            return true;
          }
          var exactIndex = container.findIndex(function (item) { return sameValue(item, operation.entry); });
          if (exactIndex >= 0) {
            container.splice(exactIndex, 1);
            return true;
          }
          return false;
        }
        if (modules.isObject(container)) {
          var key = target.locator && target.locator.key;
          if (key && sameValue(container[key], operation.entry)) {
            delete container[key];
            return true;
          }
        }
        return false;
      });
    }

    async function rollbackTaskOperation(operation) {
      return controller.mutate('rollback_reader_task_operation', function (data, reader) {
        var tasks = reader && reader.任务列表;
        if (!modules.isObject(tasks) || !operation || !operation.taskId) return false;
        if (operation.kind === 'task_insert') {
          if (sameValue(tasks[operation.taskId], operation.entry)) {
            delete tasks[operation.taskId];
            return true;
          }
          return false;
        }
        if (operation.kind === 'task_remove' && !Object.prototype.hasOwnProperty.call(tasks, operation.taskId)) {
          tasks[operation.taskId] = modules.clone(operation.entry);
          return true;
        }
        return false;
      });
    }

    async function rollbackProgressOperation(operation) {
      var amount = Math.max(0, Math.trunc(Number(operation && operation.amount) || 0));
      if (!amount) return false;
      return controller.mutate('rollback_kuromaku_progress', function (data, reader) {
        if (!reader || !Object.prototype.hasOwnProperty.call(reader, '进度')) return false;
        reader.进度 = Math.max(0, Math.trunc(Number(reader.进度) || 0) - amount);
        return true;
      });
    }

    async function rollbackKuromakuKillOperation(operation) {
      return controller.mutate('rollback_kuromaku_kill', function (data, reader) {
        if (!reader) return false;
        if (typeof operation.beforeProgress === 'number') reader.进度 = Math.max(0, Math.trunc(operation.beforeProgress));
        if (operation.beforeKilledOnce === undefined) delete reader.黑幕已点杀;
        else reader.黑幕已点杀 = operation.beforeKilledOnce;
        return true;
      });
    }

    async function rollbackKuromakuEndingOperation(operation) {
      if (operation && operation.removedBlessing && typeof semanticRouter.rollbackStatusRemoval === 'function') {
        await semanticRouter.rollbackStatusRemoval(operation.removedBlessing);
      }
      return controller.mutate('rollback_kuromaku_ending', function (data, reader) {
        if (!reader) return false;
        if (operation.beforeEnding === undefined || operation.beforeEnding === '') delete reader.黑幕结局;
        else reader.黑幕结局 = operation.beforeEnding;
        return true;
      });
    }

    async function rollbackMessageTransaction(messageKey, transaction, runtime) {
      if (!transaction) return false;
      var operations = Array.isArray(transaction.operations) ? transaction.operations.slice().reverse() : [];
      for (var index = 0; index < operations.length; index += 1) {
        var operation = operations[index];
        if (operation.kind === 'currency') await economy.rollbackCurrencyEntry(operation.entry);
        else if (operation.kind === 'status_insert') await rollbackStatusOperation(operation);
        else if (operation.kind === 'task_insert' || operation.kind === 'task_remove') await rollbackTaskOperation(operation);
        else if (operation.kind === 'progress_delta') await rollbackProgressOperation(operation);
        else if (operation.kind === 'kuromaku_kill') await rollbackKuromakuKillOperation(operation);
        else if (operation.kind === 'kuromaku_ending') await rollbackKuromakuEndingOperation(operation);
        if (operation.settledId) delete runtime.settledEvents[operation.settledId];
      }
      delete runtime.assistantTransactions[messageKey];
      runtimeStore.persist(runtime);
      return true;
    }

    async function prepareMessageTransaction(messageId, text) {
      var messageKey = String(messageId);
      var nextSignature = signature(text);
      var runtime = runtimeStore.read();
      var oldTransaction = runtime.assistantTransactions[messageKey];
      if (oldTransaction && oldTransaction.signature === nextSignature) {
        return { duplicate: true, signature: nextSignature };
      }
      if (oldTransaction) await rollbackMessageTransaction(messageKey, oldTransaction, runtime);
      runtime = runtimeStore.read();
      runtime.assistantTransactions[messageKey] = {
        signature: nextSignature,
        operations: []
      };
      var keys = Object.keys(runtime.assistantTransactions);
      if (keys.length > 40) {
        keys.sort(function (a, b) { return Number(a) - Number(b); });
        keys.slice(0, keys.length - 40).forEach(function (key) { delete runtime.assistantTransactions[key]; });
      }
      runtimeStore.persist(runtime);
      return { duplicate: false, signature: nextSignature };
    }

    function recordOperation(messageId, operation) {
      runtimeStore.mutate(function (runtime) {
        var transaction = runtime.assistantTransactions[String(messageId)];
        if (transaction) transaction.operations.push(modules.clone(operation));
      });
    }

    function recordCurrency(messageId, result) {
      if (!result || result.duplicate || !result.entry) return;
      recordOperation(messageId, {
        kind: 'currency',
        entry: result.entry,
        settledId: result.entry.id
      });
    }

    function recordStatus(messageId, result) {
      if (!result || !result.inserted || !result.target) return;
      recordOperation(messageId, {
        kind: 'status_insert',
        target: result.target,
        entry: result.entry
      });
    }

    async function processMessage(messageId) {
      if (!active()) return { skipped: true, reason: 'disabled' };
      var message = getMessage(messageId);
      if (!message || message.role !== 'assistant') return { skipped: true, reason: 'not_assistant' };
      var text = String(message.message || '');
      var fpEvents = parseTaggedJson(text, FP_PATTERN);
      var taskEvents = parseTaggedJson(text, TASK_PATTERN);
      var actionEvents = parseTaggedJson(text, ACTION_PATTERN);
      if (!fpEvents.length && !taskEvents.length && !actionEvents.length) {
        var emptyRuntime = runtimeStore.read();
        var previous = emptyRuntime.assistantTransactions[String(messageId)];
        if (previous && previous.signature !== signature(text)) {
          await rollbackMessageTransaction(String(messageId), previous, emptyRuntime);
        }
        return { processed: true, reason: 'no_reader_events' };
      }
      var prepared = await prepareMessageTransaction(messageId, text);
      if (prepared.duplicate) return { duplicate: true };
      var results = [];
      for (var fpIndex = 0; fpIndex < fpEvents.length; fpIndex += 1) {
        try {
          var fpResult = await economy.settleReaderEvent(fpEvents[fpIndex], { messageId: messageId });
          results.push(fpResult);
          recordCurrency(messageId, fpResult);
          if (fpResult && fpResult.progressDelta) recordOperation(messageId, { kind: 'progress_delta', amount: fpResult.progressDelta });
        } catch (error) {
          results.push({ error: error.message || String(error), event: fpEvents[fpIndex] });
        }
      }
      for (var taskIndex = 0; taskIndex < taskEvents.length; taskIndex += 1) {
        var taskEvent = taskEvents[taskIndex];
        try {
          if (taskEvent.action === 'create') {
            var taskId = String(taskEvent.task_id || taskEvent.id || taskEvent.title || taskEvent.type || '');
            var namesBefore = await semanticRouter.listTaskNames();
            var createdTask = await economy.createChapterTask(taskEvent, { messageId: messageId });
            results.push(createdTask);
            if (namesBefore.indexOf(taskId) < 0) recordOperation(messageId, { kind: 'task_insert', taskId: taskId, entry: createdTask });
          } else if (taskEvent.action === 'complete') {
            var completedId = String(taskEvent.task_id || taskEvent.id || '');
            var completedTask = await economy.settleChapterTask(completedId, { messageId: messageId });
            results.push(completedTask);
            recordCurrency(messageId, completedTask);
            if (completedTask.task) recordOperation(messageId, { kind: 'task_remove', taskId: completedId, entry: completedTask.task });
          }
        } catch (error) {
          results.push({ error: error.message || String(error), event: taskEvent });
        }
      }
      var kuromakuKillApplied = false;
      for (var actionIndex = 0; actionIndex < actionEvents.length; actionIndex += 1) {
        var action = actionEvents[actionIndex];
        var actionId = String(action.event_id || action.id || action.action || actionIndex);
        try {
          if (action.action === 'tone_apply') {
            var title = String(action.title || '').trim().slice(0, 120);
            if (!title) throw new Error('定调作品名为空');
            var tonePayment = await economy.spendFp(1000, 'tone_apply', 'message:' + messageId + ':action:' + actionId);
            try {
              var toneStatus = await semanticRouter.insertStatusIfAbsent({
                name: '定调',
                effect: '将故事基调和行文风格转变为近似《' + title + '》的风格；解除时由当前状态系统同步处理相关主题。',
                duration: '永久，直至用户要求解除',
                source: '定调'
              });
              if (!toneStatus.inserted) throw new Error('已存在同名定调状态');
              recordCurrency(messageId, tonePayment);
              recordStatus(messageId, toneStatus);
            } catch (toneError) {
              await economy.refundFp(1000, 'tone_apply_refund', 'message:' + messageId + ':action_refund:' + actionId);
              throw toneError;
            }
            results.push({ action: 'tone_apply', title: title });
          } else if (action.action === 'theme_write') {
            var work = String(action.title || '').trim().slice(0, 120);
            var description = String(action.description || '').trim().slice(0, 1200);
            if (!work || !description) throw new Error('主题写入信息不完整');
            var themePayment = await economy.spendFp(9999, 'theme_write', 'message:' + messageId + ':action:' + actionId);
            try {
              var themeStatus = await semanticRouter.insertStatusIfAbsent({
                name: '主题:' + work,
                effect: '《' + work + '》主题已写入世界，' + description + '。与定调绑定，定调解除时由当前状态系统同步移除主题。',
                duration: '至定调解除',
                source: '九十九夜梦'
              });
              if (!themeStatus.inserted) throw new Error('已存在同名主题状态');
              recordCurrency(messageId, themePayment);
              recordStatus(messageId, themeStatus);
            } catch (themeError) {
              await economy.refundFp(9999, 'theme_write_refund', 'message:' + messageId + ':action_refund:' + actionId);
              throw themeError;
            }
            results.push({ action: 'theme_write', title: work });
          } else if (action.action === 'entity_manifest') {
            var manifestPayment = await economy.spendFp(100, 'entity_manifest', 'message:' + messageId + ':action:' + actionId);
            try {
              var manifestStatus = await semanticRouter.insertStatusIfAbsent({
                name: '实体化',
                effect: '九十九夜梦已临时实体化；具体能力服从宿主世界规则，不因实体化获得额外设定优势',
                duration: '故事时间24小时，可由当前状态系统提前解除',
                source: 'Reader实体化'
              });
              if (!manifestStatus.inserted) throw new Error('已存在实体化状态');
              recordCurrency(messageId, manifestPayment);
              recordStatus(messageId, manifestStatus);
            } catch (manifestError) {
              await economy.refundFp(100, 'entity_manifest_refund', 'message:' + messageId + ':action_refund:' + actionId);
              throw manifestError;
            }
            results.push({ action: 'entity_manifest' });
          } else if (action.action === 'kuromaku_kill') {
            if (kuromakuKillApplied) {
              results.push({ action: 'kuromaku_kill', skipped: true, reason: 'once_per_turn' });
              continue;
            }
            kuromakuKillApplied = true;
            var killBefore = { progress: 0, killedOnce: undefined };
            var killProgress = await controller.mutate('kuromaku_kill', function (data, reader) {
              if (!reader || !Object.prototype.hasOwnProperty.call(reader, '进度')) throw new Error('只有黑幕人格可记录点杀进度');
              if (reader.黑幕结局 === 'killed' || reader.黑幕结局 === 'confessed') return reader.进度;
              killBefore.progress = Math.max(0, Math.trunc(Number(reader.进度) || 0));
              killBefore.killedOnce = Object.prototype.hasOwnProperty.call(reader, '黑幕已点杀') ? reader.黑幕已点杀 : undefined;
              reader.进度 = killBefore.progress + 1;
              reader.黑幕已点杀 = true;
              return reader.进度;
            });
            recordOperation(messageId, {
              kind: 'kuromaku_kill',
              beforeProgress: killBefore.progress,
              beforeKilledOnce: killBefore.killedOnce
            });
            results.push({ action: 'kuromaku_kill', progress: killProgress });
          } else if (action.action === 'kuromaku_ending') {
            var ending = String(action.ending || '').trim();
            if (ending !== 'killed' && ending !== 'confessed') throw new Error('未知黑幕结局: ' + ending);
            var endingBefore = undefined;
            await controller.mutate('kuromaku_ending:' + ending, function (data, reader) {
              if (!reader || !Object.prototype.hasOwnProperty.call(reader, '进度')) throw new Error('只有黑幕人格可记录结局');
              endingBefore = Object.prototype.hasOwnProperty.call(reader, '黑幕结局') ? reader.黑幕结局 : undefined;
              reader.黑幕结局 = ending;
            });
            var removedBlessing = null;
            if (ending === 'killed' && typeof semanticRouter.removeStatus === 'function') {
              try {
                var removed = await semanticRouter.removeStatus('祝福');
                if (removed && removed.removed) removedBlessing = removed;
              } catch (removeErr) { /* best-effort */ }
            }
            recordOperation(messageId, {
              kind: 'kuromaku_ending',
              beforeEnding: endingBefore,
              removedBlessing: removedBlessing
            });
            results.push({ action: 'kuromaku_ending', ending: ending, removedBlessing: !!removedBlessing });
          }
        } catch (error) {
          results.push({ error: error.message || String(error), event: action });
        }
      }
      return { processed: true, results: results };
    }

    function install() {
      if (typeof env.eventOn !== 'function' || !env.tavern_events) return;
      var events = env.tavern_events;
      [events.MESSAGE_RECEIVED, events.MESSAGE_UPDATED, events.MESSAGE_EDITED, events.MESSAGE_SWIPED]
        .filter(Boolean)
        .forEach(function (eventName) {
          env.eventOn(eventName, function (messageId) {
            Promise.resolve(processMessage(messageId)).catch(function (error) {
              if (env.console && env.console.warn) env.console.warn('[Reader-II] Reader事件处理失败', error);
            });
          });
        });
    }

    return {
      install: install,
      processMessage: processMessage,
      parseFpEvents: function (text) { return parseTaggedJson(text, FP_PATTERN); },
      parseTaskEvents: function (text) { return parseTaggedJson(text, TASK_PATTERN); },
      parseActionEvents: function (text) { return parseTaggedJson(text, ACTION_PATTERN); }
    };
  }

  modules.READER_FP_PATTERN = FP_PATTERN;
  modules.READER_TASK_PATTERN = TASK_PATTERN;
  modules.READER_ACTION_PATTERN = ACTION_PATTERN;
  modules.createEventParser = createEventParser;
})(typeof globalThis !== 'undefined' ? globalThis : window);
