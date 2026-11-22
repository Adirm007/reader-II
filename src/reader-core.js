(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var HOST_KIND_KEY = 'reader_ii_host_kind';
  /* 默认启用角色卡。用户的选择随卡保存，群聊使用聊天元数据。 */
  var CARD_FIELD = 'reader_ii';
  var CHAT_FLAG = 'reader_ii_enabled';
  var LATEST = { type: 'message', message_id: 'latest' };

  if (typeof modules.createEnv !== 'function') throw new Error('Reader-II 缺少 reader-env 模块');
  var env = modules.createEnv(root);
  var host = env.host;
  var subscriptions = [];

  /*
   * 楼层变量的读写（reader-native-host.js）。MVU 的 getMvuData / replaceMvuData 就是酒馆助手的 getVariables / replaceVariables，
   * 所以不管宿主卡有没有 MVU、有没有装酒馆助手，都从同一处读写；宿主卡的 MVU 在跑时，变量更新由它解析，我们只订它的事件。
   */
  var mvu = modules.createNativeMvu(env);
  var hookedMvu = null;
  var hostKit = modules.createHostKit(env);
  var runtimeStore = modules.createRuntimeStore(env, hostKit.chatKey);
  var guard = modules.createMvuGuard(env, runtimeStore, hostKit.chatKey, { isEnabled: function () { return isEnabled(); } });
  var lwbHost = typeof modules.createLwbHost === 'function' ? modules.createLwbHost(env) : null;
  var queue = Promise.resolve();
  var lastHostKind = 'mvu';
  var coexistByWorldbook = Object.create(null);
  var lastCoexistState = false;

  function context() {
    try { return env.context() || null; } catch (error) { return null; }
  }

  /* 有没有打开着的聊天（刚进酒馆、还在欢迎页时没有）。 */
  function hasChat() {
    var ctx = context();
    if (!ctx || !Array.isArray(ctx.chat)) return false;
    var chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
    return chatId != null && chatId !== '' && ((ctx.groupId != null && ctx.groupId !== '')
      || (ctx.characterId != null && ctx.characterId !== '' && String(ctx.characterId) !== '-1'));
  }

  function currentCard() {
    var ctx = context();
    if (!ctx || (ctx.groupId != null && ctx.groupId !== '') || ctx.characterId == null) return null;
    return ctx.characters && ctx.characters[ctx.characterId] || null;
  }

  function cardFlag() {
    var card = currentCard();
    var field = card && card.data && card.data.extensions && card.data.extensions[CARD_FIELD];
    return modules.isObject(field) && typeof field.enabled === 'boolean' ? field.enabled : undefined;
  }

  /* 宿主无法写角色文件时，把用户对这张卡的选择记在账号设置里。 */
  function cardPreferenceKey(card) { return card && card.avatar ? 'avatar/' + card.avatar : ''; }

  /* 原版读者共存检测：同开原版 reader（卡内脚本/正则/世界书/书海）与 reader-II 时，
   * reader-II 自动让位（不重复注入提示词、不抢信封/MVU），仅保留夜梦助手与记忆（含「助手夜梦 = 正文夜梦」）。 */
  function detectNativeReader() {
    try {
      if (host && host.ReaderCore && host.ReaderCore.__reader_core_api !== true) return 'runtime';
    } catch (error) { /* ignore */ }
    try {
      var doc = env.document || (host && host.document);
      if (doc && typeof doc.getElementById === 'function' && doc.getElementById('reader-core-controller')) return 'controller';
    } catch (error) { /* ignore */ }
    var card = currentCard();
    var cardRegexes = card && card.data && card.data.extensions && Array.isArray(card.data.extensions.regex_scripts)
      ? card.data.extensions.regex_scripts : null;
    if (cardRegexes && cardRegexes.some(function (rule) {
      if (!rule || rule.disabled === true) return false;
      var name = String(rule.scriptName || '');
      return !/Reader-II/i.test(name) && /读者对话渲染|普罗泰利西翁|书海/.test(name);
    })) return 'card:regex';
    var key = hostKit.chatKey();
    if (key && coexistByWorldbook[key] === true) return 'worldbook';
    // 若最近一次世界书加载已确认当前聊天没有启用原版读者条目，则忽略聊天里残留的旧变量。
    if (key && coexistByWorldbook[key] === false) return '';
    var vars = chatVariables();
    if (vars['系统核心'] === '九十九夜梦') return 'var:系统核心';
    if (vars['dream_black_author_prompt'] !== undefined && vars['dream_black_author_prompt'] !== '') return 'var:dream_black_author_prompt';
    if (vars['booksea'] !== undefined && vars['booksea'] !== null && vars['booksea'] !== '') return 'var:booksea';
    if (vars['dream_core_manager']) {
      try {
        var cm = typeof vars['dream_core_manager'] === 'string' ? JSON.parse(vars['dream_core_manager']) : vars['dream_core_manager'];
        if (cm && cm.enabled === true && (cm.primary === '九十九夜梦' || (Array.isArray(cm.activeCores) && cm.activeCores.indexOf('九十九夜梦') >= 0))) {
          return 'var:dream_core_manager';
        }
      } catch (error) { /* ignore */ }
    }
    return '';
  }

  function isCoexisting() {
    return !!detectNativeReader();
  }

  function syncHostReaderCoreBinding() {
    var coexisting = isCoexisting();
    try {
      if (coexisting) {
        if (host && host.ReaderCore === API) delete host.ReaderCore;
      } else if (host && (!host.ReaderCore || host.ReaderCore.__reader_core_api === true)) {
        host.ReaderCore = API;
      }
    } catch (error) { /* same-origin is expected */ }
    return coexisting;
  }

  function syncCoexistState() {
    var now = syncHostReaderCoreBinding();
    if (now === lastCoexistState) return now;
    lastCoexistState = now;
    if (now && prompt) {
      try { prompt.clear(); } catch (error) { /* ignore */ }
    }
    notify('enabled_changed', null);
    return now;
  }

  function inspectLoadedWorldInfo(data) {
    if (!data || typeof data !== 'object') return false;
    var lists = [data.globalLore, data.characterLore, data.chatLore, data.personaLore];
    var found = lists.some(function (entries) {
      return Array.isArray(entries) && entries.some(function (entry) {
        return entry && entry.disable !== true && entry.enabled !== false
          && typeof entry.content === 'string' && /\/\*\s*DREAM_WORLDBOOK\s+reader-core\b/.test(entry.content);
      });
    });
    var key = hostKit.chatKey();
    if (key) coexistByWorldbook[key] = found;
    syncCoexistState();
    return found;
  }

  function isEnabled() {
    if (!hasChat()) return false;
    if (isCoexisting()) return false;
    var ctx = context(), key = cardPreferenceKey(currentCard());
    var prefs = ctx.extensionSettings && ctx.extensionSettings.reader_ii;
    var savesCardPreference = key && ctx.extensionSettings && typeof ctx.saveSettingsDebounced === 'function';
    if (savesCardPreference && prefs && prefs.cardFlags && typeof prefs.cardFlags[key] === 'boolean') return prefs.cardFlags[key];
    var meta = ctx.chatMetadata;
    var card = cardFlag();
    if (card !== undefined && (typeof ctx.writeExtensionField === 'function' || savesCardPreference)) return card;
    if (meta && typeof meta[CHAT_FLAG] === 'boolean') return meta[CHAT_FLAG];
    return card !== false;
  }

  async function setEnabled(value) {
    var enabled = value !== false;
    var ctx = context();
    if (!ctx || !hasChat()) throw new Error('请先打开一个聊天');
    var card = currentCard();
    var key = cardPreferenceKey(card), prefs = ctx.extensionSettings && ctx.extensionSettings.reader_ii;
    if (card && typeof ctx.writeExtensionField === 'function') {
      var field = Object.assign({}, card.data && card.data.extensions && card.data.extensions[CARD_FIELD], { enabled: enabled });
      await ctx.writeExtensionField(ctx.characterId, CARD_FIELD, field);
      /* 酒馆只把这个字段写进卡片文件；内存里的卡要自己补上，开关才当场生效。 */
      if (!card.data) card.data = {};
      if (!modules.isObject(card.data.extensions)) card.data.extensions = {};
      card.data.extensions[CARD_FIELD] = field;
      if (key && prefs && prefs.cardFlags && Object.hasOwn(prefs.cardFlags, key)) {
        delete prefs.cardFlags[key];
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
      }
    } else if (key && ctx.extensionSettings && typeof ctx.saveSettingsDebounced === 'function') {
      prefs = ctx.extensionSettings.reader_ii || (ctx.extensionSettings.reader_ii = {});
      prefs.cardFlags = Object.assign({}, prefs.cardFlags, { [key]: enabled });
      ctx.saveSettingsDebounced();
    } else if (ctx.chatMetadata) {
      ctx.chatMetadata[CHAT_FLAG] = enabled;
      if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
    } else throw new Error('当前宿主无法保存角色卡开关');
    if (enabled) ready = ensureNamespace();
    else if (prompt) prompt.clear();
    notify('enabled_changed', null);
    try { await ready; } catch (error) { /* 调用方看 isEnabled */ }
    return isEnabled();
  }

  function readMvuData() {
    var data;
    try { data = mvu.getMvuData(LATEST); } catch (error) { data = null; }
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

  /* 没启用 Reader 的聊天里什么都不建，返回一份空的默认状态。 */
  async function ensureNamespace() {
    if (!isEnabled()) return { data: { stat_data: {} }, reader: modules.createDefaultReaderState(), dormant: true };
    if (!context().chat.length) return { data: { stat_data: {} }, reader: modules.createDefaultReaderState() };
    hookHostMvu();
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

  /* 宿主卡的 MVU 在跑时订上它的事件：变量更新前后由守卫裁剪 READER，更新后通知界面。事件名是固定的字符串，订一次就够。 */
  function hookHostMvu() {
    var real = mvu.hostMvu();
    if (!real || !real.events || hookedMvu) return;
    hookedMvu = real;
    guard.install(real);
    function refresh(variables) {
      if (!isEnabled()) return;
      var reader = variables && variables.stat_data && variables.stat_data.READER;
      notify('host_tree_updated', reader || modules.createDefaultReaderState());
    }
    if (real.events.VARIABLE_INITIALIZED) env.eventOn(real.events.VARIABLE_INITIALIZED, refresh);
    if (real.events.VARIABLE_UPDATE_ENDED) env.eventOn(real.events.VARIABLE_UPDATE_ENDED, refresh);
  }

  /*
   * 宿主卡没有在跑 MVU 时，MVU 会做的两件事由我们来做：
   *   一、新楼层沿用上一楼的变量（把读到的状态写进最后一楼，控制器的事务直接读这一楼）；
   *   二、应用回复里指向 /READER/ 的 JSONPatch（后备的地点、角色、技能、状态、背包靠它更新）。
   * 排进语义层自己的写入队列，与记账等写入不会互相覆盖。
   */
  function absorbNativeUpdate(messageId) {
    if (!isEnabled() || mvu.hostMvu()) return Promise.resolve(0);
    var plan = mvu.plan(messageId);
    if (!plan && mvu.materialized()) return Promise.resolve(0);
    return controller.mutate('native_update', function (data) {
      if (!plan) return 0;
      guard.remember(data);
      var applied = plan.operations.length ? modules.readerJsonPatch.apply(data.stat_data, plan.operations, ['READER']) : 0;
      data[mvu.MARK] = plan.signature;
      return applied;
    });
  }

  var ready = Promise.resolve().then(ensureNamespace);

  var controller = {
    chatKey: hostKit.chatKey,
    snapshot: async function () {
      await ready;
      if (!isEnabled()) return { data: { stat_data: {} }, reader: modules.createDefaultReaderState() };
      var data = readData();
      guard.guard(data);
      return { data: data, reader: data.stat_data.READER || {} };
    },
    mutate: function (reason, updater) {
      var operation = queue.then(async function () {
        await ready;
        if (!isEnabled()) throw new Error('这张卡还没有启用 Reader-II');
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
  var adaptationLlm = modules.createAdaptationLlm(adapter, semanticRouter, runtimeStore, llmGateway, hostKit);

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
    listSkillNames: semanticRouter.listSkillNames,
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
  API.kit = hostKit;
  var autoAdapt = modules.createAutoAdapt(API, llmGateway, adaptationLlm, semanticRouter);
  API.autoAdapt = autoAdapt.run;

  /* ---------- 夜梦助手与记忆：同一个扩展包里的 host.ReaderII（agent/boot.js 装配，排在本模块之后） ---------- */
  function currentReaderII() {
    var api = null;
    try { api = host.ReaderII; } catch (error) { api = null; }
    return api && api.ready === true && api.agent && typeof api.agent.open === 'function' ? api : null;
  }

  async function loadReaderII() {
    var api = currentReaderII();
    if (api) return api;
    if (typeof modules.bootReaderII !== 'function') throw new Error('扩展缺少夜梦助手启动模块，请更新 Reader-II 后刷新酒馆');
    return modules.bootReaderII();
  }

  async function openAgent(tab) {
    try {
      var api = await loadReaderII();
      api.agent.open(tab || 'chat');
      return true;
    } catch (error) {
      var message = '夜梦助手打开失败：' + (error && error.message || error);
      if (env.toastr && typeof env.toastr.warning === 'function') env.toastr.warning(message, 'Reader-II');
      env.console.warn('[ReaderCore]', message);
      return false;
    }
  }

  API.getReaderII = currentReaderII;
  API.loadReaderII = loadReaderII;
  API.openAgent = openAgent;
  API.isEnabled = isEnabled;
  API.isCoexisting = isCoexisting;
  API.detectNativeReader = detectNativeReader;
  API.setEnabled = setEnabled;
  API.hasChat = hasChat;
  API.absorbNativeUpdate = absorbNativeUpdate;
  API.hostMvu = function () { return mvu.hostMvu(); };
  /* 最后一楼的变量（还没有时是往前找到的那一份）：提示词模板的 getvar 读它。 */
  API.readFloor = readMvuData;

  var ui = modules.createUiBridge(API, env);
  API.openPanel = ui.openPanel;
  var parser = modules.createEventParser(controller, env, economy, runtimeStore, semanticRouter, { isEnabled: isEnabled });
  API.processMessageEvents = parser.processMessage;
  API.parseFpEvents = parser.parseFpEvents;
  API.parseTaskEvents = parser.parseTaskEvents;
  API.parseActionEvents = parser.parseActionEvents;
  parser.install();

  root.__ReaderIICore = API;
  if (root.window) root.window.__ReaderIICore = API;
  try { host.__ReaderIICore = API; } catch (error) { /* same-origin is expected */ }
  lastCoexistState = isCoexisting();
  if (!lastCoexistState) {
    if (!root.ReaderCore || root.ReaderCore.__reader_core_api === true) root.ReaderCore = API;
    if (root.window && (!root.window.ReaderCore || root.window.ReaderCore.__reader_core_api === true)) root.window.ReaderCore = API;
    try {
      if (!host.ReaderCore || host.ReaderCore.__reader_core_api === true) host.ReaderCore = API;
    } catch (error) { /* same-origin is expected */ }
  }
  /* 常驻壳 host.ReaderShell（reader-shell.js）：控制器 iframe、轻信挂载与登记，经 API.kit 订阅酒馆事件。 */
  var shell = null;
  if (typeof modules.createShell === 'function') {
    try { shell = modules.createShell(API, env); } catch (error) { env.console.error('[ReaderCore] 常驻壳启动失败', error); }
  } else {
    env.console.warn('[ReaderCore] 缺少 reader-shell 模块：轻信与读者菜单不会出现');
  }
  API.mountDreamSlots = shell ? shell.scan : function () { return 0; };
  /* 提示词与正文处理（reader-prompt.js）：读者核心、变量列表、更新规则的注入，事件块与来信的显示。原先靠世界书与三条正则。 */
  var prompt = null;
  if (typeof modules.createPromptRuntime === 'function') {
    try { prompt = modules.createPromptRuntime(API, env); } catch (error) { env.console.error('[ReaderCore] 提示词模块启动失败', error); }
  }
  API.prompt = prompt;

  var events = env.tavern_events || {};
  if (events.MESSAGE_SENT) {
    subscriptions.push(env.eventOn(events.MESSAGE_SENT, function (messageId) {
      if (!isEnabled()) return;
      Promise.resolve(processCustomConditions(messageId)).catch(function (error) {
        env.console.warn('[ReaderCore] 自定义条件执行失败', error);
      });
    }));
  }
  if (events.CHAT_CHANGED) {
    subscriptions.push(env.eventOn(events.CHAT_CHANGED, function () {
      syncCoexistState();
      ready = ensureNamespace();
      ready.then(function () { return isEnabled() ? characterKeywordScanner.refresh() : null; }).catch(function (error) {
        env.console.warn('[ReaderCore] 切换聊天后的初始化失败', error);
      });
    }));
  }
  try {
    var wiCtx = context();
    var wiSource = wiCtx && wiCtx.eventSource;
    var wiTypes = wiCtx && (wiCtx.eventTypes || wiCtx.event_types) || events;
    var wiEvent = wiTypes && wiTypes.WORLDINFO_ENTRIES_LOADED;
    if (wiSource && wiEvent) {
      if (typeof wiSource.makeFirst === 'function') wiSource.makeFirst(wiEvent, inspectLoadedWorldInfo);
      else if (typeof wiSource.on === 'function') wiSource.on(wiEvent, inspectLoadedWorldInfo);
      subscriptions.push({ stop: function () { try { if (typeof wiSource.removeListener === 'function') wiSource.removeListener(wiEvent, inspectLoadedWorldInfo); } catch (e) {} } });
    }
  } catch (error) { /* ignore */ }
  try {
    var listenDoc = env.document || (host && host.document);
    if (listenDoc && typeof listenDoc.addEventListener === 'function') {
      var onNativeReaderReady = function () { syncCoexistState(); };
      listenDoc.addEventListener('reader:ready', onNativeReaderReady);
      subscriptions.push({ stop: function () { try { listenDoc.removeEventListener('reader:ready', onNativeReaderReady); } catch (e) {} } });
    }
    if (host && typeof host.addEventListener === 'function') {
      var onCoreManagerChanged = function () { syncCoexistState(); };
      host.addEventListener('dream:core-manager-changed', onCoreManagerChanged);
      subscriptions.push({ stop: function () { try { host.removeEventListener('dream:core-manager-changed', onCoreManagerChanged); } catch (e) {} } });
    }
  } catch (error) { /* ignore */ }
  ['MESSAGE_RECEIVED', 'MESSAGE_SENT'].forEach(function (name) {
    if (!events[name]) return;
    subscriptions.push(env.eventOn(events[name], function (messageId) {
      Promise.resolve(absorbNativeUpdate(name === 'MESSAGE_RECEIVED' ? messageId : undefined)).catch(function (error) {
        env.console.warn('[ReaderCore] 回复里的变量更新没能应用', error);
      });
    }));
  });
  /* 宿主卡的 MVU 可能比我们晚就绪：它就绪时会发这个事件（酒馆助手的 initializeGlobal）。 */
  subscriptions.push(env.eventOn('global_Mvu_initialized', function () { hookHostMvu(); }));
  /* 小白X 在收到、重掷、删除、编辑楼层时改它的变量；MVU 有自己的事件（hookHostMvu），这里只管小白X。 */
  ['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED'].forEach(function (name) {
    if (!lwbHost || !events[name]) return;
    subscriptions.push(env.eventOn(events[name], function () {
      if (lastHostKind !== 'lwb' || !isEnabled()) return;
      setTimeout(function () { notify('host_tree_updated', null); }, 300);
    }));
  });

  function dispose() {
    if (prompt) {
      try { prompt.dispose(); } catch (error) { env.console.warn('[ReaderCore] 提示词模块停止失败', error); }
    }
    if (shell) {
      try { shell.stop(); } catch (error) { env.console.warn('[ReaderCore] 常驻壳停止失败', error); }
    }
    subscriptions.splice(0).forEach(function (handle) {
      try { if (handle && typeof handle.stop === 'function') handle.stop(); } catch (error) { /* ignore */ }
    });
  }
  API.dispose = dispose;
  try {
    if (host !== root && typeof root.addEventListener === 'function') root.addEventListener('pagehide', dispose, { once: true });
  } catch (error) { /* ignore */ }

  ready.then(function () {
    return characterKeywordScanner.install(mvu, root);
  }).then(function () {
    env.console.info('[ReaderCore] initialized', modules.BUILD_VERSION || modules.VERSION);
  }).catch(function (error) {
    env.console.error('[ReaderCore] initialization failed', error);
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
