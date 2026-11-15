(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var MVU_BUNDLE_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
  /* 夜梦助手与记忆在 ① 酒馆扩展里（host.ReaderII）。没装扩展时，从这里按需加载同一份扩展包到酒馆主窗口。 */
  var EXT_BASE = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';
  var EXT_WAIT_MS = 20000;
  var EXT_AUTOLOAD_DELAY_MS = 6000;
  var EXT_AUTOLOAD_KEY = 'reader_ii_ext_autoload';
  var HOST_KIND_KEY = 'reader_ii_host_kind';
  var LATEST = { type: 'message', message_id: 'latest' };

  if (typeof modules.createEnv !== 'function') throw new Error('Reader-II 主系统缺少 reader-env 模块，请重新导入完整的脚本');
  var env = modules.createEnv(root);
  var host = env.host;
  var find = env.find;
  var subscriptions = [];

  async function resolveMvu() {
    var existing = find('Mvu');
    if (existing && typeof existing.getMvuData === 'function') return existing;
    if (typeof env.waitGlobalInitialized === 'function') {
      try {
        var waited = await Promise.race([
          env.waitGlobalInitialized('Mvu'),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('等待宿主MVU超时')); }, 1200);
          })
        ]);
        existing = waited || find('Mvu');
        if (existing && typeof existing.getMvuData === 'function') return existing;
      } catch (error) {
        /* no host MVU: load Reader's bundled dependency */
      }
    }
    if (root.__READER_DISABLE_MVU_IMPORT__ !== true) {
      try {
        var dynamicImport = Function('url', 'return import(url)');
        await dynamicImport(MVU_BUNDLE_URL);
      } catch (error) {
        env.console.warn('[ReaderCore] Reader携带的MVU主系统加载失败', error);
      }
    }
    for (var attempt = 0; attempt < 80; attempt += 1) {
      existing = find('Mvu');
      if (existing && typeof existing.getMvuData === 'function') return existing;
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    throw new Error('Reader无法取得MVU主系统；请检查网络或脚本加载顺序');
  }

  var mvu = null;
  var runtimeStore = modules.createRuntimeStore(env);
  var guard = modules.createMvuGuard(env, runtimeStore);
  var lwbHost = typeof modules.createLwbHost === 'function' ? modules.createLwbHost(env) : null;
  var queue = Promise.resolve();
  var hostTreeEventsInstalled = false;
  var lastHostKind = 'mvu';

  function readMvuData() {
    var data = mvu.getMvuData(LATEST);
    if (!modules.isObject(data)) data = {};
    return data;
  }

  /* ---------- 变量宿主：MVU（含 Reader 自带的 MVU）或小白X ---------- */
  function chatVariables() {
    var ctx = env.context();
    if (ctx && modules.isObject(ctx.chatMetadata)) return modules.isObject(ctx.chatMetadata.variables) ? ctx.chatMetadata.variables : {};
    if (typeof env.getVariables === 'function') {
      try { var vars = env.getVariables({ type: 'chat' }); return modules.isObject(vars) ? vars : {}; }
      catch (error) { /* 没有聊天 */ }
    }
    return {};
  }

  function hostKindOverride() {
    var value = chatVariables()[HOST_KIND_KEY];
    return value === 'mvu' || value === 'lwb' ? value : 'auto';
  }

  /* MVU 里有宿主变量就用 MVU；否则这个聊天在用小白X 变量 2.0 时用小白X。聊天变量 reader_ii_host_kind 可强制指定。 */
  function hostKind(message) {
    if (!lwbHost || !lwbHost.available()) return 'mvu';
    var forced = hostKindOverride();
    if (forced !== 'auto') return forced;
    var statData = message && modules.isObject(message.stat_data) ? message.stat_data : {};
    if (Object.keys(statData).some(function (key) { return key !== 'READER'; })) return 'mvu';
    return lwbHost.inUse() ? 'lwb' : 'mvu';
  }

  /* 语义层看到的楼层数据。MVU 宿主时就是 MVU 楼层变量；小白X 宿主时 stat_data 换成它的聊天变量，READER 仍取自 MVU。 */
  function readData() {
    var message = readMvuData();
    lastHostKind = hostKind(message);
    if (lastHostKind !== 'lwb') return message;
    var data = lwbHost.compose(message);
    Object.defineProperty(data, '__readerHostBefore', { value: lwbHost.hostPart(data.stat_data) });
    return data;
  }

  async function writeData(data) {
    if (!data || !data.__readerHostBefore) {
      await mvu.replaceMvuData(data, LATEST);
      return;
    }
    await lwbHost.apply(data.__readerHostBefore, lwbHost.hostPart(data.stat_data));
    await mvu.replaceMvuData(lwbHost.merge(readMvuData(), data), LATEST);
  }

  /*
   * 给控制器里的 ReaderTransactions 用：传入一份楼层变量（酒馆助手 getVariables 读出的副本），返回 { kind, data, commit }。
   * MVU 宿主时 data 就是传入的楼层变量。小白X 宿主时 data.stat_data 换成它的聊天变量（加楼层里的 READER），
   * commit() 先把宿主部分的改动经 applyText 交给小白X，再返回 merge(latest)：把 READER 与其余顶层键合回最新的楼层变量。
   */
  function beginTransaction(messageData) {
    var message = modules.isObject(messageData) ? messageData : {};
    var kind = hostKind(message);
    lastHostKind = kind;
    if (kind !== 'lwb') {
      return { kind: 'mvu', data: message, commit: function () { return Promise.resolve(function () { return message; }); } };
    }
    var data = lwbHost.compose(message);
    var before = lwbHost.hostPart(data.stat_data);
    return {
      kind: 'lwb',
      data: data,
      commit: async function () {
        await lwbHost.apply(before, lwbHost.hostPart(data.stat_data));
        return function (latest) { return lwbHost.merge(latest === undefined ? message : latest, data); };
      }
    };
  }

  function currentHostKind() {
    if (!mvu) return lwbHost && lwbHost.available() && hostKindOverride() !== 'mvu' && lwbHost.inUse() ? 'lwb' : 'mvu';
    lastHostKind = hostKind(readMvuData());
    return lastHostKind;
  }

  function setHostKind(kind) {
    var value = kind === 'mvu' || kind === 'lwb' ? kind : 'auto';
    var ctx = env.context();
    if (ctx && modules.isObject(ctx.chatMetadata)) {
      if (!modules.isObject(ctx.chatMetadata.variables)) ctx.chatMetadata.variables = {};
      if (value === 'auto') delete ctx.chatMetadata.variables[HOST_KIND_KEY];
      else ctx.chatMetadata.variables[HOST_KIND_KEY] = value;
      if (typeof ctx.saveMetadata === 'function') { try { ctx.saveMetadata(); } catch (error) { /* best-effort */ } }
    } else if (typeof env.insertOrAssignVariables === 'function') {
      var payload = {};
      payload[HOST_KIND_KEY] = value;
      env.insertOrAssignVariables(payload, { type: 'chat' });
    }
    notify('host_kind_changed', null);
    return value;
  }

  async function ensureNamespace() {
    var data = readData();
    guard.guard(data);
    guard.remember(data);
    await writeData(data);
    markChat();
    return { data: data, reader: data.stat_data.READER };
  }

  /*
   * 给用了 Reader-II 的聊天留下标记：聊天变量 reader_ii_runtime（① 的记忆默认只在有它或 dream_persona 的聊天里自动整理与注入）。
   * 运行时状态平时只在有改动时才写，新聊天里一直没有，记忆就会把这张卡自己的聊天当成无关聊天（7.G 冒烟查出）。
   * 只在还没有时写一次，内容就是当前的运行时状态。
   */
  function markChat() {
    try {
      if (chatVariables()[runtimeStore.key] !== undefined) return;
      runtimeStore.mutate(function () {});
    } catch (error) {
      env.console.warn('[ReaderCore] 写聊天标记失败', error);
    }
  }

  /* reader-core-changed 在脚本窗口与酒馆主窗口上都派发（自定义人格的宿主变量目录监听的是主窗口）。 */
  function notify(reason, reader) {
    [root, host].forEach(function (target, index, list) {
      if (!target || list.indexOf(target) !== index) return;
      try {
        var EventType = target.CustomEvent || root.CustomEvent;
        if (typeof target.dispatchEvent !== 'function' || typeof EventType !== 'function') return;
        target.dispatchEvent(new EventType('reader-core-changed', {
          detail: { reason: reason, reader: modules.clone(reader) }
        }));
      } catch (error) {
        /* event notification is best-effort */
      }
    });
  }

  function installHostTreeEvents() {
    if (hostTreeEventsInstalled || !mvu || !mvu.events || typeof env.eventOn !== 'function') return;
    hostTreeEventsInstalled = true;
    function refresh(variables) {
      var reader = variables && variables.stat_data && variables.stat_data.READER;
      notify('host_tree_updated', reader || modules.createDefaultReaderState());
    }
    if (mvu.events.VARIABLE_INITIALIZED) env.eventOn(mvu.events.VARIABLE_INITIALIZED, refresh);
    if (mvu.events.VARIABLE_UPDATE_ENDED) env.eventOn(mvu.events.VARIABLE_UPDATE_ENDED, refresh);
  }

  var ready = (async function () {
    mvu = await resolveMvu();
    guard.install(mvu);
    installHostTreeEvents();
    return ensureNamespace();
  })();

  var controller = {
    snapshot: async function () {
      await ready;
      var data = readData();
      guard.guard(data);
      return { data: data, reader: data.stat_data.READER || {} };
    },
    mutate: function (reason, updater) {
      var operation = queue.then(async function () {
        await ready;
        var data = readData();
        guard.guard(data);
        var result = await updater(data, data.stat_data.READER || {});
        guard.guard(data);
        await writeData(data);
        notify(reason, data.stat_data.READER || {});
        return result;
      });
      queue = operation.catch(function () {});
      return operation;
    }
  };

  var economy = modules.createEconomy(controller, runtimeStore);
  var adapter = modules.createHostAdapter(controller, env, economy);
  var semanticRouter = modules.createSemanticRouter(controller, runtimeStore, economy);
  var characterKeywordScanner = modules.createCharacterKeywordScanner(semanticRouter, env);
  var llmGateway = modules.createLlmGateway(env);
  var adaptationLlm = modules.createAdaptationLlm(adapter, semanticRouter, runtimeStore, llmGateway);

  function compare(actual, operator, expected) {
    if (operator === 'exists') return actual !== undefined && actual !== null;
    if (operator === 'not_exists') return actual === undefined || actual === null;
    if (operator === 'gt') return Number(actual) > Number(expected);
    if (operator === 'gte') return Number(actual) >= Number(expected);
    if (operator === 'lt') return Number(actual) < Number(expected);
    if (operator === 'lte') return Number(actual) <= Number(expected);
    if (operator === 'contains') return String(actual == null ? '' : actual).includes(String(expected));
    if (operator === 'not_contains') return !String(actual == null ? '' : actual).includes(String(expected));
    if (operator === 'includes') return Array.isArray(actual) && actual.indexOf(expected) >= 0;
    if (operator === 'not_includes') return !Array.isArray(actual) || actual.indexOf(expected) < 0;
    if (operator === 'regex') {
      try { return new RegExp(String(expected || ''), 'i').test(String(actual == null ? '' : actual)); }
      catch (error) { return false; }
    }
    if (operator === 'neq') return String(actual) !== String(expected);
    return actual === expected || String(actual) === String(expected);
  }

  function readCustomPersona() {
    if (typeof env.getVariables !== 'function') return null;
    try {
      var variables = env.getVariables({ type: 'chat' }) || {};
      if (variables.dream_persona !== 'custom') return null;
      var raw = variables.dream_custom_persona;
      if (typeof raw === 'string') raw = JSON.parse(raw);
      return modules.isObject(raw) ? raw : null;
    } catch (error) {
      return null;
    }
  }

  function messageContext(messageId) {
    var context = { user_input: '', last_ai: '', recent_chat: '', turn_count: 0 };
    if (typeof env.getChatMessages !== 'function') return context;
    try {
      var messages = env.getChatMessages('0-' + Number(messageId)) || [];
      context.turn_count = messages.length;
      messages.forEach(function (message) {
        if (Number(message.message_id) === Number(messageId) && message.role === 'user') {
          context.user_input = String(message.message || '');
        }
      });
      var before = messages.filter(function (message) {
        return Number(message.message_id) < Number(messageId);
      });
      var assistants = before.filter(function (message) { return message.role === 'assistant'; });
      if (assistants.length) context.last_ai = String(assistants[assistants.length - 1].message || '');
      context.recent_chat = before.slice(-4).map(function (message) { return String(message.message || ''); }).join('\n');
    } catch (error) {
      env.console.warn('[ReaderCore] 自定义条件上下文读取失败', error);
    }
    return context;
  }

  async function conditionValue(condition, context, snapshot) {
    var source = String(condition.source || '');
    if (Object.prototype.hasOwnProperty.call(context, source)) return context[source];
    if (condition.variable === 'fp') return economy.getFpBalance();
    if (condition.variable === 'reader_effect' || condition.variable === 'hero_status') {
      var effectName = String(condition.name || String(condition.path || '').split('.').pop() || '');
      return semanticRouter.findStatus(effectName);
    }
    if (condition.variable === 'chapter_task') {
      var taskName = String(condition.name || String(condition.path || '').split('.').pop() || '');
      return (await semanticRouter.listTaskNames()).indexOf(taskName) >= 0 ? taskName : undefined;
    }
    if (source === 'reader') return economy.getPath(snapshot.reader, condition.path, undefined);
    if (source === 'host' || source === 'mvu') {
      if (condition.variable === 'fp') return economy.getFpBalance();
      var reference = condition.ref || condition.segments || condition.path;
      if (reference) return adapter.readHostRef(reference, undefined);
    }
    return undefined;
  }

  async function prepareCustomConditionTransaction(messageId, text) {
    var messageKey = String(messageId);
    var nextSignature = modules.hashText(String(text || ''));
    var runtime = runtimeStore.read();
    var transactions = runtime.customConditions.transactions;
    var old = transactions[messageKey];
    if (old && old.signature === nextSignature) return { duplicate: true, signature: nextSignature };
    if (old) {
      await controller.mutate('rollback_custom_conditions:' + messageKey, function (data) {
        (old.hostValues || []).slice().reverse().forEach(function (item) {
          var segments = economy.normalizeHostRef(item);
          if (!segments) return;
          if (item.existed === false) {
            try { economy.deleteHostValue(data, segments); } catch (error) { /* already absent */ }
          } else economy.setHostValue(data, segments, modules.clone(item.value));
        });
      });
      var oldOperations = Array.isArray(old.operations) ? old.operations.slice().reverse() : [];
      for (var oldIndex = 0; oldIndex < oldOperations.length; oldIndex += 1) {
        var oldOperation = oldOperations[oldIndex];
        if (oldOperation.kind === 'currency') {
          /* 若同一叶节点已由显式hostref快照恢复，避免重复逆转。 */
          var targetRef = oldOperation.entry && oldOperation.entry.target && oldOperation.entry.target.ref;
          var covered = targetRef && (old.hostValues || []).some(function (item) { return item.ref === targetRef; });
          if (!covered) await economy.rollbackCurrencyEntry(oldOperation.entry);
          if (oldOperation.entry && oldOperation.entry.id) delete runtime.settledEvents[oldOperation.entry.id];
        } else if (oldOperation.kind === 'status_insert') {
          await semanticRouter.rollbackStatusInsertion(oldOperation);
        }
      }
      runtime.customConditions.personas = modules.safeRecord(old.beforePersonas);
      delete transactions[messageKey];
      runtimeStore.persist(runtime);
    }
    var snapshot = await controller.snapshot();
    runtime = runtimeStore.read();
    transactions = runtime.customConditions.transactions;
    transactions[messageKey] = {
      signature: nextSignature,
      beforeReader: modules.clone(snapshot.reader),
      beforePersonas: modules.clone(runtime.customConditions.personas),
      hostValues: [],
      operations: []
    };
    var keys = Object.keys(transactions);
    if (keys.length > 30) {
      keys.sort(function (left, right) { return Number(left) - Number(right); });
      keys.slice(0, keys.length - 30).forEach(function (key) { delete transactions[key]; });
    }
    runtimeStore.persist(runtime);
    return { duplicate: false, signature: nextSignature };
  }

  async function recordCustomHostSnapshot(messageId, input) {
    var messageKey = String(messageId);
    var segments = economy.normalizeHostRef(input);
    if (!segments) throw new Error('自定义条件宿主路径引用无效');
    var ref = economy.createHostRef(segments);
    var snapshot = await controller.snapshot();
    var missing = {};
    var value = economy.getHostValue(snapshot.data, segments, missing);
    runtimeStore.mutate(function (runtime) {
      var transaction = runtime.customConditions.transactions[messageKey];
      if (!transaction) throw new Error('自定义条件事务尚未准备');
      if (transaction.hostValues.some(function (item) { return item.ref === ref; })) return;
      transaction.hostValues.push({
        ref: ref,
        segments: segments,
        path: economy.hostDisplayPath(segments),
        existed: value !== missing,
        value: value === missing ? undefined : modules.clone(value)
      });
    });
  }

  function recordCustomOperation(messageId, operation) {
    runtimeStore.mutate(function (runtime) {
      var transaction = runtime.customConditions.transactions[String(messageId)];
      if (transaction) transaction.operations.push(modules.clone(operation));
    });
  }

  async function applyCustomAction(action, actionKey, messageId) {
    var variable = String(action && action.variable || '');
    var operation = String(action && action.operation || 'set');
    if (variable.indexOf('host::') === 0 || action && action.source === 'host') {
      var hostReference = action.ref || action.segments || action.path;
      await recordCustomHostSnapshot(messageId, hostReference);
      return adapter.writeHostRef(hostReference, operation, action.value);
    }
    if (variable === 'fp' || variable === 'hero_money') {
      var target = Number(action.value);
      if (!Number.isFinite(target)) throw new Error('自定义条件FP动作不是有效数值');
      var delta = operation === 'delta' ? Math.trunc(target) : Math.trunc(target - await economy.getFpBalance());
      var currencyResult;
      if (delta > 0) currencyResult = await economy.creditFp(delta, 'custom_condition', actionKey);
      else if (delta < 0) currencyResult = await economy.spendFp(Math.abs(delta), 'custom_condition', actionKey);
      if (currencyResult && currencyResult.entry && !currencyResult.duplicate) {
        recordCustomOperation(messageId, { kind: 'currency', entry: currencyResult.entry });
      }
      if (currencyResult) return currencyResult;
      return { skipped: true };
    }
    if (variable === 'reader_effect' || variable === 'hero_status') {
      var effectName = String(action.name || '').trim().slice(0, 80);
      if (!effectName || /[.\[\]{}<>"';\r\n]/.test(effectName)) throw new Error('自定义条件效果名无效');
      if (operation === 'remove') throw new Error('普通语义状态不提供脚本删除；请使用明确的hostref高级动作');
      if (!modules.isObject(action.value)) throw new Error('自定义条件效果必须是对象');
      var statusResult = await semanticRouter.insertStatusIfAbsent({
        name: effectName,
        effect: String(action.value.效果 || action.value.effect || ''),
        duration: String(action.value.剩余时间 || action.value.duration || ''),
        source: String(action.value.来源 || action.value.source || '自定义人格')
      });
      if (statusResult.inserted) recordCustomOperation(messageId, {
        kind: 'status_insert',
        target: statusResult.target,
        entry: statusResult.entry
      });
      return statusResult;
    }
    throw new Error('此自定义条件动作不属于Reader通用白名单');
  }

  async function processCustomConditions(messageId) {
    var context = messageContext(messageId);
    var persona = readCustomPersona();
    var rules = persona && persona.conditionalEnabled === 'on' && Array.isArray(persona.conditionalMechanisms)
      ? persona.conditionalMechanisms.slice(0, 12)
      : [];
    if (!rules.length) {
      runtimeStore.setActivePrompts([]);
      return [];
    }
    var prepared = await prepareCustomConditionTransaction(messageId, context.user_input);
    if (prepared.duplicate) return runtimeStore.getActivePrompts();
    var snapshot = await controller.snapshot();
    var runtime = runtimeStore.read();
    var prompts = [];
    var actions = [];
    var personaId = String(persona && persona.id || 'custom');
    var personaState = modules.clone(runtime.customConditions.personas[personaId] || {
      turn: 0,
      rules: {}
    });
    personaState.turn = Math.max(0, Number(personaState.turn) || 0) + 1;
    if (!modules.isObject(personaState.rules)) personaState.rules = {};
    for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
      var rule = rules[ruleIndex];
      if (!rule || rule.enabled === false || !Array.isArray(rule.conditions)) continue;
      var outcomes = [];
      for (var conditionIndex = 0; conditionIndex < rule.conditions.length; conditionIndex += 1) {
        var condition = rule.conditions[conditionIndex];
        outcomes.push(compare(
          await conditionValue(condition, context, snapshot),
          condition.operator || 'eq',
          condition.value
        ));
      }
      var matched = rule.matchMode === 'any' ? outcomes.some(Boolean) : outcomes.every(Boolean);
      var ruleId = String(rule.id || 'rule_' + ruleIndex);
      var ruleState = personaState.rules[ruleId] || {
        lastResult: false,
        lastTriggeredTurn: 0,
        done: false
      };
      var triggerMode = String(rule.triggerMode || 'always');
      var shouldFire = false;
      if (triggerMode === 'enter') shouldFire = matched && !ruleState.lastResult;
      else if (triggerMode === 'cooldown') {
        var cooldown = Math.max(1, Math.trunc(Number(rule.cooldownTurns) || 1));
        shouldFire = matched && (!ruleState.lastTriggeredTurn
          || personaState.turn - ruleState.lastTriggeredTurn >= cooldown);
      } else if (triggerMode === 'once') shouldFire = matched && !ruleState.done;
      else shouldFire = matched;
      ruleState.lastResult = matched;
      if (shouldFire) {
        ruleState.lastTriggeredTurn = personaState.turn;
        if (triggerMode === 'once') ruleState.done = true;
        var effectMode = ['prompt', 'variables', 'both'].indexOf(rule.effectMode) >= 0
          ? rule.effectMode
          : 'prompt';
        if ((effectMode === 'prompt' || effectMode === 'both') && rule.prompt) {
          prompts.push(String(rule.prompt).slice(0, 1600));
        }
        if ((effectMode === 'variables' || effectMode === 'both') && Array.isArray(rule.actions)) {
          rule.actions.slice(0, 8).forEach(function (action, actionIndex) {
            actions.push({
              action: action,
              key: 'custom:' + personaId + ':' + ruleId + ':' + messageId + ':' + prepared.signature + ':' + actionIndex
            });
          });
        }
      }
      personaState.rules[ruleId] = ruleState;
    }
    runtimeStore.mutate(function (state) { state.customConditions.personas[personaId] = personaState; });
    runtimeStore.setActivePrompts(prompts);
    for (var actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      try {
        await applyCustomAction(actions[actionIndex].action, actions[actionIndex].key, messageId);
      } catch (error) {
        env.console.warn('[ReaderCore] 自定义条件动作未执行', error);
      }
    }
    return prompts;
  }

  var API = {
    __reader_core_api: true,
    version: modules.BUILD_VERSION || modules.VERSION,
    ready: function () {
      return ready.then(function (result) {
        return Promise.resolve(characterKeywordScanner.install(mvu, root)).then(function () { return result; });
      });
    },
    getState: async function () { return modules.clone((await controller.snapshot()).reader); },
    getSnapshot: async function () { return modules.clone((await controller.snapshot()).data); },
    getFpBalance: economy.getFpBalance,
    getCurrencyBalance: economy.getFpBalance,
    creditFp: economy.creditFp,
    spendFp: economy.spendFp,
    refundFp: economy.refundFp,
    grantFp: economy.creditFp,
    adjustFp: function (amount, reason, key, metadata) {
      return Number(amount) >= 0
        ? economy.creditFp(amount, reason, key, metadata)
        : economy.spendFp(Math.abs(Number(amount)), reason, key, metadata);
    },
    adjustCurrency: function (amount, transactionInfo) {
      var info = modules.isObject(transactionInfo) ? transactionInfo : {};
      return Number(amount) >= 0
        ? economy.creditFp(amount, info.reason || 'semantic_currency', info.idempotencyKey, info.metadata)
        : economy.spendFp(Math.abs(Number(amount)), info.reason || 'semantic_currency', info.idempotencyKey, info.metadata);
    },
    settleReaderEvent: economy.settleReaderEvent,
    createChapterTask: economy.createChapterTask,
    settleChapterTask: economy.settleChapterTask,
    listHostVariables: adapter.listHostVariables,
    listHostChildren: adapter.listHostChildren,
    getHostTreeSummary: adapter.getHostTreeSummary,
    createHostRef: adapter.createHostRef,
    readHostRef: adapter.readHostRef,
    writeHostRef: adapter.writeHostRef,
    readHostPath: adapter.readHostPath,
    writeHostPath: adapter.writeHostPath,
    getSemanticRouting: function () { return runtimeStore.read().routing; },
    selectSemanticRoot: semanticRouter.selectRoot,
    confirmSemanticBinding: semanticRouter.confirmBinding,
    unbindSemanticSlot: semanticRouter.unbind,
    validateSemanticMappingDraft: semanticRouter.validateMappingDraft,
    validateSemanticMappingBatchDraft: semanticRouter.validateMappingBatchDraft,
    analyzeSemanticMapping: adaptationLlm.analyze,
    analyzeLockedSemanticMappings: adaptationLlm.analyzeBatch,
    analyzeAllSemanticMappings: adaptationLlm.analyzeBatch,
    getSemanticMappingPreview: adaptationLlm.getPreview,
    getSemanticAdaptationRequest: adaptationLlm.buildRequest,
    getSemanticBatchAdaptationRequest: adaptationLlm.buildBatchRequest,
    getLocation: semanticRouter.getLocation,
    listImportantCharacters: semanticRouter.listImportantCharacters,
    listCharacterNames: semanticRouter.listCharacterNames,
    refreshCharacterKeywordScan: characterKeywordScanner.refresh,
    listTaskNames: semanticRouter.listTaskNames,
    hasSkill: semanticRouter.hasSkill,
    listStatuses: semanticRouter.listStatuses,
    findStatus: semanticRouter.findStatus,
    insertStatusIfAbsent: semanticRouter.insertStatusIfAbsent,
    getLlmSettings: llmGateway.getSettings,
    saveLlmSettings: llmGateway.saveSettings,
    getLlmBackendSummary: llmGateway.getBackendSummary,
    listLlmModels: llmGateway.listModels,
    generateLlm: llmGateway.generate,
    getProgress: async function () {
      var reader = (await controller.snapshot()).reader;
      return Math.max(0, Math.trunc(Number(reader.进度) || 0));
    },
    incrementKuromakuProgress: function () {
      return controller.mutate('increment_kuromaku_progress', function (data, reader) {
        if (!reader || !Object.prototype.hasOwnProperty.call(reader, '进度')) throw new Error('只有哀怜人格可维护Reader进度');
        reader.进度 = Math.max(0, Math.trunc(Number(reader.进度) || 0)) + 1;
        return reader.进度;
      });
    },
    addEffect: function (key, effect) {
      var source = modules.isObject(effect) ? effect : {};
      return semanticRouter.insertStatusIfAbsent({
        name: String(key || ''),
        effect: String(source.效果 || source.effect || ''),
        duration: String(source.剩余时间 || source.duration || ''),
        source: String(source.来源 || source.source || '九十九夜梦')
      });
    },
    processCustomConditions: processCustomConditions
  };

  /* ---------- 控制器事务（ReaderTransactions 经 window.ReaderCore.tx 落到宿主路径或 Reader 后备） ---------- */
  API.tx = Object.assign({}, semanticRouter.sync, {
    inventoryShape: semanticRouter.inventoryShape,
    hostKind: currentHostKind,
    begin: beginTransaction
  });
  API.listInventory = semanticRouter.listInventory;
  API.notifyChanged = function (reason) {
    notify(String(reason || 'external'), null);
    return true;
  };
  API.getHostKind = currentHostKind;
  API.setHostKind = setHostKind;
  API.kit = typeof modules.createHostKit === 'function' ? modules.createHostKit(env) : null;
  var autoAdapt = modules.createAutoAdapt(API, llmGateway);
  API.autoAdapt = autoAdapt.run;

  /* ---------- 夜梦助手与记忆：用 ①（host.ReaderII），没有就按需加载扩展包 ---------- */
  var readerIILoading = null;
  var readerIICancel = null;
  var autoloadTimer = null;

  function currentReaderII() {
    var api = null;
    try { api = host.ReaderII; } catch (error) { api = null; }
    return api && api.ready === true && api.agent && typeof api.agent.open === 'function' ? api : null;
  }

  /* 装了扩展时 index.js 会先写下 __ReaderIIBase，并在空闲时自己加载主包，这里只等它就绪。 */
  function extensionInstalled() {
    try { return !!host.__ReaderIIBase && host.__ReaderIICdn !== true; } catch (error) { return false; }
  }

  function ensureReaderII() {
    var existing = currentReaderII();
    if (existing) return Promise.resolve(existing);
    if (readerIILoading) return readerIILoading;
    if (root.__READER_DISABLE_EXT_IMPORT__ === true && !extensionInstalled()) {
      return Promise.reject(new Error('夜梦助手没有安装：请安装 Reader-II 酒馆扩展'));
    }
    readerIILoading = new Promise(function (resolve, reject) {
      var settled = false;
      var poll = null;
      var timer = null;
      function finish(error) {
        if (settled) return;
        var api = currentReaderII();
        if (!error && !api) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        try { host.removeEventListener('reader-ii:ready', check); } catch (removeError) { /* ignore */ }
        readerIICancel = null;
        if (error) reject(error);
        else resolve(api);
      }
      function check() { finish(null); }
      readerIICancel = function () { finish(new Error('Reader 已卸载')); };
      try { host.addEventListener('reader-ii:ready', check); } catch (listenError) { /* 轮询兜底 */ }
      poll = setInterval(check, 250);
      timer = setTimeout(function () {
        finish(new Error('夜梦助手加载超时：请检查网络，或安装 Reader-II 酒馆扩展'));
      }, EXT_WAIT_MS);
      if (extensionInstalled()) return;
      var doc = env.document;
      if (!doc || !doc.head || typeof doc.createElement !== 'function') {
        finish(new Error('无法访问酒馆页面，夜梦助手加载失败'));
        return;
      }
      if (typeof doc.querySelector === 'function' && doc.querySelector('script[data-reader-ii]')) return;
      var base = String(root.__READER_II_EXT_BASE__ || EXT_BASE);
      try {
        host.__ReaderIICdn = true;
        if (!host.__ReaderIIBase) host.__ReaderIIBase = base;
      } catch (markError) { /* ignore */ }
      var script = doc.createElement('script');
      script.src = base + 'dist/reader-ii.ext.js';
      script.setAttribute('data-reader-ii', 'cdn');
      script.onerror = function () {
        try { if (script.parentNode) script.parentNode.removeChild(script); } catch (removeError) { /* ignore */ }
        finish(new Error('夜梦助手扩展包加载失败：' + script.src));
      };
      doc.head.appendChild(script);
    });
    readerIILoading.then(function () { readerIILoading = null; }, function () { readerIILoading = null; });
    return readerIILoading;
  }

  function openAgent(tab) {
    return ensureReaderII().then(function (api) {
      api.agent.open(tab || 'chat');
      return true;
    }).catch(function (error) {
      env.console.warn('[ReaderCore] 夜梦助手打开失败', error);
      if (env.toastr && typeof env.toastr.warning === 'function') env.toastr.warning(error.message || String(error), '夜梦助手');
      return false;
    });
  }

  /* 控制器里的 dreamOpenAgent 调 window.parent.ReaderAgent.open(tab)。① 还没加载时先放一个占位，点了再加载；① 启动后会覆盖它。 */
  function installAgentPlaceholder() {
    try {
      if (host.ReaderAgent && !host.ReaderAgent.__readerCorePlaceholder) return;
      host.ReaderAgent = { __readerCorePlaceholder: true, open: openAgent, close: function () {} };
    } catch (error) { /* ignore */ }
  }

  /* 没装扩展时，空闲后在后台加载 ①，记忆注入才会在这张卡的聊天里工作。localStorage reader_ii_ext_autoload=off 可关。 */
  function scheduleAutoload() {
    if (root.__READER_DISABLE_EXT_IMPORT__ === true || !env.document || currentReaderII()) return;
    try { if (env.storage && env.storage.getItem(EXT_AUTOLOAD_KEY) === 'off') return; } catch (error) { /* ignore */ }
    autoloadTimer = setTimeout(function () {
      autoloadTimer = null;
      ensureReaderII().catch(function (error) {
        env.console.warn('[ReaderCore] 夜梦助手（记忆）未能加载', error);
      });
    }, EXT_AUTOLOAD_DELAY_MS);
  }

  API.getReaderII = currentReaderII;
  API.loadReaderII = ensureReaderII;
  API.openAgent = openAgent;
  installAgentPlaceholder();

  var ui = modules.createUiBridge(API, env);
  API.openPanel = ui.openPanel;
  if (typeof env.getButtonEvent === 'function') {
    subscriptions.push(env.eventOn(env.getButtonEvent('Reader Core'), function () {
      Promise.resolve(API.openPanel()).catch(function (error) {
        env.console.warn('[ReaderCore] 面板打开失败', error);
      });
    }));
    subscriptions.push(env.eventOn(env.getButtonEvent('夜梦助手'), function () { openAgent('chat'); }));
  }
  var parser = modules.createEventParser(controller, env, economy, runtimeStore, semanticRouter);
  API.processMessageEvents = parser.processMessage;
  API.parseFpEvents = parser.parseFpEvents;
  API.parseTaskEvents = parser.parseTaskEvents;
  API.parseActionEvents = parser.parseActionEvents;
  parser.install();

  root.ReaderCore = API;
  if (root.window) root.window.ReaderCore = API;
  try { host.ReaderCore = API; } catch (error) { /* same-origin is expected */ }
  if (typeof env.initializeGlobal === 'function') {
    try { env.initializeGlobal('ReaderCore', API); } catch (error) { /* already initialized */ }
  }
  /* 常驻壳 host.ReaderShell（reader-shell.js，取代旧的 reader-render-mount）：控制器 iframe、轻信挂载与登记，经 API.kit 订阅酒馆事件。 */
  var shell = null;
  if (typeof modules.createShell === 'function') {
    try { shell = modules.createShell(API, env); } catch (error) { env.console.error('[ReaderCore] 常驻壳启动失败', error); }
  } else {
    env.console.warn('[ReaderCore] 缺少 reader-shell 模块：轻信与读者菜单不会出现，请重新导入完整的脚本');
  }
  API.mountDreamSlots = shell ? shell.scan : function () { return 0; };

  var events = env.tavern_events || {};
  if (events.MESSAGE_SENT) {
    subscriptions.push(env.eventOn(events.MESSAGE_SENT, function (messageId) {
      Promise.resolve(processCustomConditions(messageId)).catch(function (error) {
        env.console.warn('[ReaderCore] 自定义条件执行失败', error);
      });
    }));
  }
  if (events.CHAT_CHANGED) {
    subscriptions.push(env.eventOn(events.CHAT_CHANGED, function () {
      ready = ensureNamespace();
      ready.then(function () { return characterKeywordScanner.refresh(); }).catch(function (error) {
        env.console.warn('[ReaderCore] 切换聊天后的角色关键词刷新失败', error);
      });
    }));
  }
  /* 小白X 在收到、重掷、删除、编辑楼层时改它的变量；MVU 有自己的事件（installHostTreeEvents），这里只管小白X。 */
  ['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED'].forEach(function (name) {
    if (!lwbHost || !events[name]) return;
    subscriptions.push(env.eventOn(events[name], function () {
      if (lastHostKind !== 'lwb') return;
      setTimeout(function () { notify('host_tree_updated', null); }, 300);
    }));
  });

  function dispose() {
    clearTimeout(autoloadTimer);
    if (readerIICancel) readerIICancel();
    if (shell) {
      try { shell.stop(); } catch (error) { env.console.warn('[ReaderCore] 常驻壳停止失败', error); }
    }
    subscriptions.splice(0).forEach(function (handle) {
      try { if (handle && typeof handle.stop === 'function') handle.stop(); } catch (error) { /* ignore */ }
    });
    try { if (host.ReaderAgent && host.ReaderAgent.__readerCorePlaceholder) delete host.ReaderAgent; } catch (error) { /* ignore */ }
  }
  API.dispose = dispose;
  try {
    if (host !== root && typeof root.addEventListener === 'function') root.addEventListener('pagehide', dispose, { once: true });
  } catch (error) { /* ignore */ }

  ready.then(function () {
    return characterKeywordScanner.install(mvu, root);
  }).then(function () {
    scheduleAutoload();
    env.console.info('[ReaderCore] initialized', modules.BUILD_VERSION || modules.VERSION);
  }).catch(function (error) {
    env.console.error('[ReaderCore] initialization failed', error);
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
