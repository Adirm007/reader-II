(function (root) {
  'use strict';

  /*
   * 分卷导演的运行器（ReaderII.agent.director）：把 director-core.js 的纯逻辑接到酒馆、模型与存储上。
   *
   * 它是助手的子能力，不是读者的一部分：
   *   · 不看「这张卡」上 Reader-II 的开关。卡没启用读者、或与原版读者共存时，导演照样编纲、注入简报、巡检、建档。
   *   · 有自己的一把锁（编纲 / 巡检 / 重构 / 归档 / 建档互斥），不碰助手主循环的锁，也不往助手的对话记录里写一个字。
   *   · 干活时在后台任务看板（jobs.js）上挂牌子，界面上的状态浮窗读的就是那块看板。
   *
   * 存储都在工作区（ws:/director/…，用户看得见、让助手改得了，不记入改动记录）：
   *   preferences.md                      全局长期偏好
   *   cards/<卡或群的哈希>/preferences.md   这张卡（这个群）的偏好——跟卡走，换一个聊天还在
   *   chats/<聊天的哈希>/active.json       这一卷的运行状态（写它是提交点）
   *                      outline.md        当前大纲（两次结构重构之间不变；改了它等于手动修订）
   *                      snapshots.json    大纲各版本 + 楼层快照环（状态与简报跟着楼层走）
   *                      archive.json      已完结各卷的档案与跨卷钩子
   *                      restore.json      最近一次归档之前的样子（一键恢复用）
   *                      draft.json        编纲进行到一半的草稿（定稿后删掉）
   * 聊天的哈希取自「卡的头像文件名（或群 id）+ 酒馆的聊天 id」，不用角色列表的下标，增删角色卡不会让它变成孤儿。
   * 聊天变量里另放两样小东西：reader_ii_director（这个聊天单独的开关）与 reader_ii_director_ref（指回目录的小指针：
   * 聊天改了名、开了分支之后新聊天自己没有档，就按指针把原来的档抄一份过来，各自往下演）。
   *
   * 每轮正文要注入的简报不是临时算的：巡检在上一轮收楼之后就把它预写好、连同状态存成锚在那一楼的快照；
   * 生成时只要按楼层指纹取出对得上的那一条。所以注入不等模型，Swipe、删楼、改楼之后取到的也是对应那一楼的状态。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_NAMESPACE = 'reader_ii';
  var SETTINGS_LOCAL_KEY = 'reader_ii_director_settings_v1';
  var CHAT_SWITCH_KEY = 'reader_ii_director';
  var CHAT_REF_KEY = 'reader_ii_director_ref';
  var ROOT = 'ws:/director';
  var SKILL_PATH = 'ws:/skills/volume-director/SKILL.md';
  var ACTIVE_STATES = ['running', 'restructuring', 'pending_finish'];
  var DEBOUNCE_MS = 1500;          /* 收楼之后等这么久再巡检：别的扩展补写变量、群聊里下一位角色接着回复，都在这段时间里 */
  var FAIL_LIMIT = 3;              /* 巡检连续失败这么多次就自动暂停 */
  var MODEL_CACHE_MS = 10 * 60 * 1000;
  var GENERATING_STALE_MS = 5 * 60 * 1000;
  var WORK_LABEL = { plan: '编纲', patrol: '巡检', restructure: '重构大纲', archive: '归档', entry: '给新角色建档' };
  var FILES = ['active.json', 'outline.md', 'snapshots.json', 'archive.json', 'restore.json'];

  function noop() {}
  function str(value) { return value == null ? '' : String(value); }
  function message(error) { return str(error && error.message || error); }
  function isAbort(error) { return !!error && (error.name === 'AbortError' || error.code === 'director_stale'); }
  function staleError(text) { return Object.assign(new Error(text || '聊天已经切换，这次操作作废'), { code: 'director_stale' }); }
  function randomId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

  /*
   * deps: { vfs, skills, connectors, permissions, journal, jobs, agent, prompt(), openTab(tab), debounceMs }
   * prompt() 返回正文提示词模块（reader-prompt.js 的运行时）；读者核心没加载时是 null，导演仍可编纲与巡检，只是没有地方注入。
   */
  function createDirector(env, kit, llm, deps) {
    var core = modules.directorCore, kernel = modules.agentKernel;
    var host = env.host || root;
    var log = env.console || console;
    var vfs = deps.vfs, skills = deps.skills, connectors = deps.connectors, jobs = deps.jobs;
    var wb = modules.createDirectorWorldbook(env, kit, llm, { vfs: vfs, permissions: deps.permissions, journal: deps.journal });
    var debounceMs = deps.debounceMs >= 0 ? deps.debounceMs : DEBOUNCE_MS;

    var listeners = [], subscriptions = [], disposed = false;
    var session = makeSession(null);
    var work = null;               /* 正在干的活：{ kind, key, controller, job, reason } */
    var generatingAt = 0;          /* 酒馆正在生成（任何类型）的起始时间；0 = 没在生成 */
    var patrolTimer = null;
    var slotOwner = null;          /* 已经登记过槽位的那个提示词模块 */
    var skillCache = null;
    var viewCache = null;
    var unwatch = null;

    /* ---------- 小工具 ---------- */

    function emit(reason) {
      listeners.slice().forEach(function (listener) { try { listener(reason); } catch (error) { /* 界面出错不影响导演 */ } });
    }

    function warn(text) {
      var toastr = env.toastr || host.toastr;
      if (toastr && typeof toastr.warning === 'function') { try { toastr.warning(text, 'Reader-II · 导演'); return; } catch (error) { /* 退回控制台 */ } }
      log.warn('[ReaderII] ' + text);
    }

    function owner() { return kernel.chatOwner(kit.context()); }

    async function readText(path) {
      try { return await vfs.readText(path); } catch (error) { return null; }
    }
    async function readJson(path) {
      var text = await readText(path);
      if (!text) return null;
      try { var value = JSON.parse(text); return modules.isObject(value) ? value : null; } catch (error) { return null; }
    }
    function writeJson(path, value) { return vfs.write(path, JSON.stringify(value, null, 1)); }
    async function removeFile(path) {
      try { await vfs.remove(path); } catch (error) { /* 本来就没有 */ }
    }

    /* ---------- 设置与开关 ---------- */

    function getSettings() {
      var ctx = kit.context();
      var bag = ctx && ctx.extensionSettings && ctx.extensionSettings[SETTINGS_NAMESPACE];
      return core.normalizeSettings(bag && modules.isObject(bag.director) ? bag.director : kit.localRead(SETTINGS_LOCAL_KEY, {}));
    }

    function saveSettings(patch) {
      var next = core.normalizeSettings(Object.assign({}, getSettings(), patch || {}));
      kit.localWrite(SETTINGS_LOCAL_KEY, next);
      var ctx = kit.context();
      if (ctx && ctx.extensionSettings) {
        ctx.extensionSettings[SETTINGS_NAMESPACE] = Object.assign({}, ctx.extensionSettings[SETTINGS_NAMESPACE], { director: next });
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
      }
      emit('settings');
      schedulePatrol();
      return next;
    }

    /* 这个聊天单独的开关：true / false；没设过是 null（跟总开关）。 */
    function chatSwitch() {
      var value = kit.readChatValue(CHAT_SWITCH_KEY);
      return modules.isObject(value) && typeof value.enabled === 'boolean' ? value.enabled : null;
    }
    function isEnabled() {
      var own = chatSwitch();
      return own === null ? getSettings().enabled : own;
    }
    function setChatEnabled(value) {
      if (!owner().key) throw new Error('先打开一个聊天');
      kit.writeChatValue(CHAT_SWITCH_KEY, value === null || value === undefined ? undefined : { enabled: value === true });
      emit('enabled');
      schedulePatrol();
      return isEnabled();
    }

    /* ---------- 这个聊天的档 ---------- */

    function makeSession(info) {
      var o = info && info.key ? info : { key: '', owner: '', label: '', group: false };
      var hash = o.key ? core.hashId(o.key) : '';
      return {
        key: o.key, owner: o.owner, label: o.label, group: o.group === true, hash: hash, dir: hash ? ROOT + '/chats/' + hash : '',
        active: null, snaps: core.emptySnapshots(), draft: null, hasArchive: false, canRestore: false,
        loaded: !o.key, promise: null, retryAfter: 0
      };
    }

    function volumeActive(target) { return !!(target.active && target.active.volumeId && ACTIVE_STATES.indexOf(target.active.status) >= 0); }

    function normalizeActive(raw, target) {
      if (!modules.isObject(raw)) return null;
      var a = raw;
      a.v = 1;
      a.ownerKey = target.key;
      a.label = target.label;
      a.status = ACTIVE_STATES.indexOf(a.status) >= 0 ? a.status : 'idle';
      /* 页面是在重构半道上关掉的：重构没有落盘，回到执导中。 */
      if (a.status === 'restructuring') a.status = 'running';
      if (a.status !== 'idle' && !a.volumeId) a.status = 'idle';
      a.paused = a.paused === true;
      /* 档案是工作区里的普通文件，用户与助手都改得到：数字与文本各按类型收一遍，界面才能放心用。 */
      a.volumeId = str(a.volumeId).slice(0, 80);
      a.volumeNo = Math.max(0, Math.trunc(Number(a.volumeNo) || 0));
      a.title = str(a.title).slice(0, 80);
      a.profile = str(a.profile).slice(0, 4000);
      a.baseTurn = Math.max(0, Math.trunc(Number(a.baseTurn) || 0));
      a.outlineVersion = Math.max(1, Math.trunc(Number(a.outlineVersion) || 1));
      a.pausedBy = typeof a.pausedBy === 'string' ? a.pausedBy.slice(0, 20) : '';
      a.pendingEntries = (Array.isArray(a.pendingEntries) ? a.pendingEntries : []).filter(modules.isObject).map(function (item) {
        return {
          id: str(item.id).slice(0, 60) || randomId('pe'), name: str(item.name).slice(0, 60), kind: item.kind === 'temp_event' ? 'temp_event' : 'npc',
          brief: str(item.brief).slice(0, 400), keywords: (Array.isArray(item.keywords) ? item.keywords : []).map(str).slice(0, 8),
          status: item.status === 'failed' ? 'failed' : 'pending', error: str(item.error).slice(0, 300)
        };
      }).filter(function (item) { return item.name; });
      a.createdEntries = (Array.isArray(a.createdEntries) ? a.createdEntries : []).filter(modules.isObject);
      a.failStreak = Math.max(0, Math.trunc(Number(a.failStreak) || 0));
      a.lastError = str(a.lastError);
      a.undo = modules.isObject(a.undo) ? a.undo : null;
      return a;
    }

    function normalizeDraft(raw) {
      if (!modules.isObject(raw)) return null;
      return {
        v: 1, mode: raw.mode === 'review' ? 'review' : 'auto',
        state: ['running', 'paused', 'review', 'interrupted', 'failed'].indexOf(raw.state) >= 0 ? raw.state : 'interrupted',
        step: Math.max(0, Math.min(4, Math.trunc(Number(raw.step) || 0))),
        outputs: (Array.isArray(raw.outputs) ? raw.outputs : []).map(str).slice(0, 4),
        feedback: (Array.isArray(raw.feedback) ? raw.feedback : []).filter(modules.isObject).map(function (item) { return { step: Math.trunc(Number(item.step) || 1), text: str(item.text) }; }),
        revise: modules.isObject(raw.revise) ? { step: Math.trunc(Number(raw.revise.step) || 0), previous: str(raw.revise.previous), text: str(raw.revise.text) } : null,
        reviewed: raw.reviewed === true, materials: str(raw.materials), error: str(raw.error),
        startedAt: Number(raw.startedAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now()
      };
    }

    /*
     * 这个聊天自己没有档时，看聊天变量里的小指针：它指着原来那个聊天的目录（改名、开分支之后的新聊天会带着它）。
     * 指针指向的档确实属于它说的那个聊天、而且是同一张卡（同一个群）的，就抄一份过来。
     */
    async function claim(target) {
      var ref = kit.readChatValue(CHAT_REF_KEY);
      if (!modules.isObject(ref) || !ref.chatHash || !ref.ownerKey || ref.chatHash === target.hash || ref.ownerKey === target.key) return false;
      var card = '';
      try { card = JSON.parse(ref.ownerKey)[0]; } catch (error) { card = ''; }
      if (card !== target.owner) return false;
      var from = ROOT + '/chats/' + ref.chatHash;
      var old = await readJson(from + '/active.json');
      var oldArchive = await readText(from + '/archive.json');
      if (!(old && old.ownerKey === ref.ownerKey) && !oldArchive) return false;
      for (var index = 0; index < FILES.length; index += 1) {
        var text = await readText(from + '/' + FILES[index]);
        if (text === null) continue;
        if (FILES[index] === 'active.json') {
          /* 档案里记着它属于哪个聊天：抄过来的这一份改记成新聊天，下次打开才认得是自己的。 */
          try { text = JSON.stringify(Object.assign(JSON.parse(text), { ownerKey: target.key, label: target.label, claimedFrom: ref.ownerKey }), null, 1); } catch (error) { continue; }
        }
        await vfs.write(target.dir + '/' + FILES[index], text);
      }
      return true;
    }

    async function loadSession(target) {
      if (!target.key) { target.loaded = true; return target; }
      var raw = await readJson(target.dir + '/active.json');
      if (raw && raw.ownerKey && raw.ownerKey !== target.key) {
        /* 目录里是别的聊天的档（哈希撞了，几乎不会发生）：换一个目录，不去覆盖别人的。 */
        target.hash = core.hashId(target.key + '\u0003alt');
        target.dir = ROOT + '/chats/' + target.hash;
        raw = await readJson(target.dir + '/active.json');
      }
      var archive = await readJson(target.dir + '/archive.json');
      if (!raw && !archive) {
        var claimed = false;
        try { claimed = await claim(target); } catch (error) { claimed = false; }
        if (claimed) {
          raw = await readJson(target.dir + '/active.json');
          archive = await readJson(target.dir + '/archive.json');
        }
      }
      target.active = normalizeActive(raw, target);
      target.snaps = core.normalizeSnapshots(await readJson(target.dir + '/snapshots.json'));
      target.draft = normalizeDraft(await readJson(target.dir + '/draft.json'));
      /* 页面重新加载之后，原来在跑的编纲已经没了：标成「中断」，由用户决定接着编还是放弃。 */
      if (target.draft && target.draft.state === 'running') target.draft.state = 'interrupted';
      target.hasArchive = !!(archive && Array.isArray(archive.volumes) && archive.volumes.length);
      target.canRestore = !!(await readJson(target.dir + '/restore.json'));
      /* 档案说在执导，但快照没了（文件被删）：没法注入也没法巡检，回到空闲。 */
      if (volumeActive(target) && !target.snaps.base) target.active.status = 'idle';
      target.loaded = true;
      return target;
    }

    /* 当前聊天的档（没读过就去读）。聊天切换之后旧的读取结果不会串到新聊天上。 */
    function ensureSession() {
      var current = owner();
      if (session.key !== current.key) { session = makeSession(current); viewCache = null; }
      var target = session;
      if (target.loaded) return Promise.resolve(target);
      if (!target.promise) {
        target.promise = loadSession(target).then(function () {
          if (target === session) { syncRef(); emit('session'); }
          return target;
        }, function (error) {
          target.promise = null;
          throw error;
        });
      }
      return target.promise;
    }

    function assertCurrent(target) {
      if (disposed || target !== session || owner().key !== target.key) throw staleError();
    }

    /*
     * 聊天变量里的小指针 { chatHash, ownerKey, on }：
     * on 记着「这个聊天有一卷在执导、而且没暂停」。刚打开页面、刚切到这个聊天时档还没读进来，
     * 正文生成却可能马上开始——注入开关先看这个标记，简报读取时再等档案。
     */
    function syncRef() {
      var target = session;
      if (!target.key || !target.loaded) return;
      var has = !!(target.active || target.hasArchive || target.draft);
      var current = kit.readChatValue(CHAT_REF_KEY);
      if (!has && !modules.isObject(current)) return;
      var next = { chatHash: target.hash, ownerKey: target.key, on: volumeActive(target) && target.active.paused !== true };
      if (modules.isObject(current) && current.chatHash === next.chatHash && current.ownerKey === next.ownerKey && current.on === next.on) return;
      try { kit.writeChatValue(CHAT_REF_KEY, next); } catch (error) { /* 聊天变量写不进去时，只是少了这个提示 */ }
    }

    async function persist(target, what) {
      var parts = what || { snaps: true, active: true };
      if (parts.snaps) await writeJson(target.dir + '/snapshots.json', target.snaps);
      if (parts.active && target.active) {
        target.active.updatedAt = Date.now();
        await writeJson(target.dir + '/active.json', target.active);
      }
      if (target === session) syncRef();
    }

    function saveDraft(target, draft) {
      draft.updatedAt = Date.now();
      return writeJson(target.dir + '/draft.json', draft);
    }

    /* ---------- 聊天视图 ---------- */

    function chatView() {
      var chat = kit.rawChat();
      var last = chat.length ? chat[chat.length - 1] : null;
      var mark = last ? str(last.mes) : '';
      if (viewCache && viewCache.chat === chat && viewCache.length === chat.length && viewCache.mark === mark) return viewCache.view;
      viewCache = { chat: chat, length: chat.length, mark: mark, view: core.createChatView(chat, kit.cleanText) };
      return viewCache.view;
    }

    /* 当前聊天此刻对得上的那条快照（常规生成的口径）。 */
    function currentPick(target) {
      var view = chatView();
      var floor = view.lastAssistant();
      var picked = core.pickSnapshot(target.snaps, view, view.lastVisible());
      return { view: view, floor: floor, picked: picked };
    }

    function versionRecord(target, version) {
      var record = target.snaps.versions[version] || target.snaps.versions[core.latestVersion(target.snaps)];
      return record || { outline: '', index: core.normalizeIndex(null, '') };
    }

    function clippedRecent(view, maxFloor, count, afterFloor, aiCap, userCap) {
      return view.recent(maxFloor, count, afterFloor).map(function (item) {
        return { floor: item.floor, role: item.role, name: item.name, text: core.clipMiddle(item.text, item.role === 'user' ? userCap : aiCap) };
      });
    }

    /* ---------- Skill 与偏好 ---------- */

    /* 生效的导演 Skill：工作区里有就用工作区的（用户改过的），否则用内置的。读过之后记着，工作区那份被改动时作废。 */
    async function skillText() {
      if (skillCache) return skillCache;
      var user = await readText(SKILL_PATH);
      if (typeof user === 'string' && user.trim()) { skillCache = { text: user, source: 'user' }; return skillCache; }
      var builtin = '';
      try { builtin = skills && typeof skills.builtinText === 'function' ? await skills.builtinText(core.SKILL_NAME) : ''; } catch (error) { builtin = ''; }
      if (!builtin && typeof modules.inlineBuiltinSkill === 'function') builtin = modules.inlineBuiltinSkill(core.SKILL_NAME);
      if (!str(builtin).trim()) throw new Error('读不到导演 Skill 的正文：内置的没有随包带上，工作区里也没有。');
      skillCache = { text: builtin, source: 'builtin' };
      return skillCache;
    }

    function cardPreferencePath(target) { return ROOT + '/cards/' + core.hashId(target.owner) + '/preferences.md'; }

    async function loadPreferences(target) {
      var globalText = await readText(ROOT + '/preferences.md') || '';
      var cardText = target.owner ? await readText(cardPreferencePath(target)) || '' : '';
      return { global: globalText, card: cardText, merged: core.mergePreferences(globalText, cardText) };
    }

    /* ---------- 勘察 ---------- */

    function cardTexts(ctx) {
      function describe(card) {
        if (!card) return '';
        var data = card.data || {};
        return [card.description || data.description, card.personality || data.personality ? '性格：' + (card.personality || data.personality) : '',
          card.scenario || data.scenario ? '场景：' + (card.scenario || data.scenario) : ''].filter(Boolean).join('\n');
      }
      var characters = Array.isArray(ctx.characters) ? ctx.characters : [];
      if (ctx.groupId != null && ctx.groupId !== '') {
        var group = (ctx.groups || []).filter(function (item) { return str(item.id) === str(ctx.groupId); })[0];
        return (group && Array.isArray(group.members) ? group.members : []).map(function (avatar) {
          var card = characters.filter(function (item) { return item && item.avatar === avatar; })[0];
          return card ? { name: str(card.name), text: describe(card) } : null;
        }).filter(Boolean);
      }
      var single = characters[ctx.characterId];
      return single ? [{ name: str(single.name || ctx.name2), text: describe(single) }] : [];
    }

    function personaText(ctx) {
      var settings = ctx.powerUserSettings || ctx.power_user || {};
      return str(settings.persona_description).trim();
    }

    /* 场记每轮都要带的角色简介：主角人设 + 卡描述，掐到一千多字。激活时算一次存进档里，之后逐字节不变。 */
    function buildProfile() {
      var ctx = kit.context() || {};
      var names = kit.names();
      var persona = personaText(ctx);
      var cards = cardTexts(ctx);
      var share = Math.max(300, Math.floor(1100 / Math.max(1, cards.length)));
      var parts = ['主角「' + names.user + '」' + (persona ? '：' + core.clipChars(persona.replace(/\s+/g, ' '), 420) : '（没有填写人设）')];
      cards.forEach(function (card) {
        parts.push('角色卡「' + card.name + '」' + (card.text ? '：' + core.clipChars(card.text.replace(/\s+/g, ' '), share) : '（没有描述）'));
      });
      return core.expandUser(parts.join('\n'), names.user);
    }

    async function worldbookDigest(signal) {
      await kit.prepareWorldbooks();
      var scopes = kit.worldbookScopes();
      var names = [];
      [scopes.chat, scopes.character_primary].concat(scopes.character_additional || [], scopes.global || []).forEach(function (name) {
        if (name && names.indexOf(name) < 0) names.push(name);
      });
      var blocks = [];
      for (var index = 0; index < names.length && index < 8; index += 1) {
        if (signal && signal.aborted) break;
        var entries = null;
        try { entries = await kit.readWorldbook(names[index], { optional: true }); } catch (error) { entries = null; }
        var digest = core.summarizeWorldbook(entries, 150);
        if (digest) blocks.push('【' + names[index] + '】\n' + digest);
      }
      return blocks.join('\n');
    }

    async function variableDigest() {
      var text = await readText('var:/mvu.json#/stat_data');
      if (!text) return '';
      try { return core.summarizeVariables(JSON.parse(text), 3, 1600); } catch (error) { return ''; }
    }

    async function archiveDigest(target) {
      var archive = await readJson(target.dir + '/archive.json');
      var volumes = archive && Array.isArray(archive.volumes) ? archive.volumes.slice(-3) : [];
      return volumes.map(function (volume) {
        return '第 ' + volume.volumeNo + ' 卷' + (volume.title ? '《' + volume.title + '》' : '') + '：' + str(volume.summary)
          + ((volume.hooks || []).length ? '\n留下的钩子：\n' + volume.hooks.map(function (hook) { return '- ' + hook; }).join('\n') : '');
      }).join('\n\n');
    }

    /*
     * 自动勘察：主角与角色卡、已完结各卷、插件给的剧情摘要、变量、当前生效的世界书、近期楼层。
     * 各段按权重分 budget 个字；哪一段读不到就少一段，不为它卡住。
     */
    async function gatherMaterials(target, budget, signal, job) {
      var ctx = kit.context() || {};
      var names = kit.names();
      var view = chatView();
      var persona = personaText(ctx);
      var cards = cardTexts(ctx).map(function (card) { return '【' + card.name + '】\n' + (card.text || '（没有描述）'); }).join('\n\n');
      var plot = '';
      if (connectors && typeof connectors.brief === 'function') {
        try {
          if (typeof connectors.prepare === 'function') await connectors.prepare(signal);
          /* 导演勘察始终要剧情摘要：不看助手那边「了解当前剧情」的开关，只沿用它选的来源。 */
          var sources = deps.agent && typeof deps.agent.getSettings === 'function' ? deps.agent.getSettings().plotSources : 'auto';
          plot = str(await connectors.brief(sources === undefined ? 'auto' : sources, Math.max(600, Math.floor(budget * 0.14)), signal));
        } catch (error) { if (isAbort(error)) throw error; plot = ''; }
      }
      if (job) job.log('读取世界书与变量');
      var books = '', variables = '', archive = '';
      try { books = await worldbookDigest(signal); } catch (error) { books = ''; }
      try { variables = await variableDigest(); } catch (error) { variables = ''; }
      try { archive = await archiveDigest(target); } catch (error) { archive = ''; }
      var floors = view.recent(view.lastVisible(), 80, -1).map(function (item) {
        return '[#' + item.floor + ' ' + (item.role === 'user' ? '用户 · ' + names.user : item.name || '角色') + ']\n' + core.clipMiddle(item.text, 2400);
      }).join('\n\n');
      return core.composeMaterials([
        { key: 'persona', title: '主角', text: '实名：' + names.user + (persona ? '\n' + persona : '\n（没有填写人设）'), weight: 8 },
        { key: 'cards', title: '角色卡', text: cards, weight: 14 },
        { key: 'archive', title: '已完结各卷的档案与跨卷钩子', text: archive, weight: 7 },
        { key: 'plot', title: '剧情摘要（来自已对接的插件）', text: plot, weight: 12 },
        { key: 'variables', title: '当前变量（MVU，精简）', text: variables, weight: 5 },
        { key: 'books', title: '当前生效的世界书（常驻在前）', text: books, weight: 14 },
        { key: 'floors', title: '近期正文（# 后面是楼层号，越靠后越新）', text: floors || '（聊天里还没有正文）', weight: 40, tail: true }
      ], budget);
    }

    /* ---------- 互斥与任务牌 ---------- */

    function openPage() { if (typeof deps.openTab === 'function') { try { deps.openTab('director'); } catch (error) { /* 界面打不开不影响 */ } } }

    function quietJob() {
      return { id: '', update: noop, log: noop, done: noop, fail: noop, cancelled: noop, running: function () { return false; } };
    }

    function begin(kind, spec) {
      if (disposed) throw new Error('导演已经停用');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
      var Controller = host.AbortController || root.AbortController;
      var entry = { kind: kind, key: session.key, controller: Controller ? new Controller() : null, job: null, reason: '' };
      entry.job = jobs ? jobs.start(Object.assign({ owner: 'director', kind: kind, level: 'major', cancel: function () { abortWork(entry, 'user'); }, open: openPage }, spec)) : quietJob();
      work = entry;
      emit('work');
      return entry;
    }

    function finishWork(entry) {
      if (work === entry) work = null;
      emit('work');
    }

    function abortWork(entry, reason) {
      if (!entry || work !== entry) return false;
      entry.reason = reason || 'user';
      if (entry.controller) { try { entry.controller.abort(); } catch (error) { /* ignore */ } }
      return true;
    }

    function signalOf(entry) { return entry.controller ? entry.controller.signal : undefined; }

    function closeJob(entry, error) {
      if (isAbort(error) || (entry.controller && entry.controller.signal.aborted)) entry.job.cancelled(entry.reason === 'chat' ? '聊天已切换' : entry.reason === 'pause' ? '已暂停' : '已停止');
      else entry.job.fail(error);
    }

    /* ---------- 四步编纲 ---------- */

    function pendingFromIndex(index, known) {
      var taken = {};
      (known || []).forEach(function (item) { taken[item.name] = true; });
      return (index && index.newCharacters || []).filter(function (item) { return !taken[item.name]; }).map(function (item) {
        return { id: randomId('pe'), name: item.name, kind: item.kind, brief: item.brief, keywords: item.keywords, status: 'pending', error: '' };
      });
    }

    async function commitVolume(target, final, userName) {
      assertCurrent(target);
      var settings = getSettings();
      var view = chatView();
      var floor = view.lastAssistant();
      var turn = view.turns(view.lastVisible());
      var snaps = core.emptySnapshots();
      var version = core.addVersion(snaps, { outline: final.outline, index: final.index, note: '首次编纲' });
      var state = core.initialState();
      state.turn = turn;
      var brief = core.sanitizeBriefDetailed(final.firstBrief, { userName: userName, outline: final.outline });
      snaps.base = core.makeSnapshot(core.anchorOf(view, floor), { outlineVersion: version, kind: 'base', state: state, brief: brief.text });
      var archive = await readJson(target.dir + '/archive.json');
      var now = Date.now();
      var active = {
        v: 1, ownerKey: target.key, label: target.label, volumeId: randomId('vol'),
        volumeNo: (archive && Array.isArray(archive.volumes) ? archive.volumes.length : 0) + 1,
        title: final.index.title, status: 'running', paused: false, createdAt: now, updatedAt: now,
        outlineVersion: version, baseTurn: turn, profile: buildProfile(), failStreak: 0, lastError: '',
        pendingEntries: settings.wbPolicy === 'none' ? [] : pendingFromIndex(final.index, []), createdEntries: [], undo: null
      };
      assertCurrent(target);
      /* 顺序：大纲 → 快照 → 状态。写状态是提交点：前两步断了，档里仍是「没有活跃卷」，草稿还在，可以接着来。 */
      await vfs.write(target.dir + '/outline.md', final.outline);
      await writeJson(target.dir + '/snapshots.json', snaps);
      await writeJson(target.dir + '/active.json', active);
      await removeFile(target.dir + '/draft.json');
      target.active = active;
      target.snaps = snaps;
      target.draft = null;
      target.retryAfter = 0;
      syncRef();
      return { brief: brief, active: active };
    }

    /*
     * 从草稿当前的位置往下编，直到定稿、被暂停，或在第 2 步后停下等用户过目（review 模式）。
     * 四步的请求一问一答往后接、共用同一份 System 与勘察资料；定稿之后这些消息就不再需要了（草稿也删掉）。
     */
    async function runPlan(target, entry) {
      var draft = target.draft;
      var settings = getSettings();
      var signal = signalOf(entry), job = entry.job;
      var userName = kit.names().user;
      draft.state = 'running';
      draft.error = '';
      var skill = await skillText();
      var prefs = await loadPreferences(target);
      var system = core.buildPlannerSystem(skill.text, prefs.merged, userName);
      if (!draft.materials) {
        job.update({ stage: '勘察：收集前文、设定与偏好', step: 0 });
        var model = null;
        try { model = await llm.resolveTaskModel('director', { cacheMs: MODEL_CACHE_MS, signal: signal }); } catch (error) { if (isAbort(error)) throw error; }
        var budget = core.reconBudget(model && model.contextWindow, kernel.tokenEstimate(system), settings.plannerMaxTokens);
        var gathered = await gatherMaterials(target, budget, signal, job);
        assertCurrent(target);
        draft.materials = gathered.text;
        job.log('勘察资料 ' + gathered.text.length + ' 字（上限 ' + budget + '）');
        await saveDraft(target, draft);
      }
      while (draft.step < 4) {
        var step = draft.step + 1;
        var revise = draft.revise && draft.revise.step === step ? draft.revise : null;
        job.update({ stage: '第 ' + step + ' 步 · ' + core.PLANNER_STEP_NAMES[step - 1] + (revise ? '（按意见修订）' : ''), step: step });
        emit('plan');
        var reply = await llm.chatTask({
          kind: 'director', maxTokens: settings.plannerMaxTokens, timeoutMs: settings.timeoutMs, signal: signal, retries: 1, cacheMs: MODEL_CACHE_MS,
          generationId: 'reader-director-plan',
          messages: core.buildPlannerStepMessages(step, { system: system, materials: draft.materials, outputs: draft.outputs, feedback: draft.feedback, revise: revise })
        });
        assertCurrent(target);
        draft.outputs = draft.outputs.slice(0, step - 1);
        draft.outputs[step - 1] = str(reply);
        draft.step = step;
        draft.revise = null;
        job.log('第 ' + step + ' 步完成（' + str(reply).length + ' 字）');
        if (step === 2 && draft.mode === 'review' && !draft.reviewed) {
          draft.state = 'review';
          await saveDraft(target, draft);
          return { review: true };
        }
        await saveDraft(target, draft);
      }
      job.update({ stage: '定稿：解析大纲与首轮简报', step: 4 });
      var final = core.parseFinalOutline(draft.outputs[3]);
      if (!final.ok) {
        /* 第 4 步的交付不能用：退回到第 3 步之后，改了上限或提了意见再接着来，不必从头勘察。 */
        draft.step = 3;
        draft.outputs = draft.outputs.slice(0, 3);
        throw new Error(final.error);
      }
      var committed = await commitVolume(target, final, userName);
      if (committed.brief.leaks) job.log('首轮简报里有 ' + committed.brief.leaks + ' 处与后台实情重合，已拿掉');
      return { review: false, final: final };
    }

    async function drivePlan(target) {
      var entry = begin('plan', { title: '导演 · 编纲', stage: '准备', steps: 4, step: target.draft.step });
      var outcome = null;
      try {
        outcome = await runPlan(target, entry);
        if (outcome.review) entry.job.done('第 2 步已交：等你过目后继续');
        else entry.job.done('《' + (target.active.title || '第 ' + target.active.volumeNo + ' 卷') + '》大纲已定稿，开始执导');
      } catch (error) {
        var draft = target.draft;
        if (draft) {
          var aborted = isAbort(error) || (entry.controller && entry.controller.signal.aborted);
          draft.state = aborted ? (entry.reason === 'chat' ? 'interrupted' : 'paused') : 'failed';
          draft.error = aborted ? '' : message(error);
          try { await saveDraft(target, draft); } catch (ignored) { /* 草稿存不下只影响续接 */ }
        }
        closeJob(entry, error);
        finishWork(entry);
        emit('plan');
        if (isAbort(error) || (entry.controller && entry.controller.signal.aborted)) return { paused: true };
        throw error;
      }
      finishWork(entry);
      emit(outcome.review ? 'plan' : 'volume');
      if (!outcome.review) {
        if (getSettings().wbPolicy === 'auto') autoEntries(target).catch(noop);
        else schedulePatrol();
      }
      return outcome.review ? { review: true } : { done: true };
    }

    /*
     * 给当前聊天开一卷：勘察 → 四步编纲 → 定稿并开始执导。options: { mode: auto | review, feedback }
     * 这个聊天没开导演时顺手打开（用户点了激活，意思再明白不过）。
     */
    async function activate(options) {
      var opts = options || {};
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天，再让导演开卷');
      if (volumeActive(target)) throw new Error('这个聊天已经有一卷在执导：先完结它，或放弃这一卷');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
      if (!isEnabled()) setChatEnabled(true);
      var now = Date.now();
      target.draft = normalizeDraft({ mode: opts.mode || getSettings().planMode, state: 'running', step: 0, outputs: [], feedback: [], startedAt: now, updatedAt: now });
      if (str(opts.feedback).trim()) target.draft.feedback.push({ step: 1, text: str(opts.feedback).trim() });
      return drivePlan(target);
    }

    /* ---------- 新角色建档 ---------- */

    function findPending(target, id) {
      var list = target.active ? target.active.pendingEntries : [];
      return list.filter(function (item) { return item.id === id; })[0] || null;
    }

    /*
     * 生成并写入一位待建档角色的世界书条目。options.auto 为 true 表示后台自动建档（不是用户亲手点的）：
     * 权限要问的、不让写的都停下来等用户，而且先看权限再请模型——写不进去就不白花这一次请求。
     */
    async function confirmPendingEntry(id, options) {
      var opts = options || {};
      var target = await ensureSession();
      var item = findPending(target, id);
      if (!item) throw new Error('这位角色已经不在待建档的列表里');
      var settings = getSettings();
      var template = wb.pickTemplate(settings.wbTemplateId);
      if (!template) throw new Error('没有可用的条目模板');
      if (opts.auto === true) {
        var permission = wb.checkPermission(template.output.targetWorldbook, item.name);
        if (permission.decision !== 'allow') {
          item.error = permission.decision === 'ask' ? '等你确认：' + permission.reason : permission.reason;
          await persist(target, { active: true });
          emit('entries');
          return { ok: false, waiting: true };
        }
      }
      var entry = begin('entry', { title: '导演 · 新角色建档', stage: item.name + '：撰写条目', steps: 2, step: 1 });
      try {
        item.status = 'writing';
        item.error = '';
        emit('entries');
        var now = currentPick(target);
        var record = versionRecord(target, now.picked.entry ? now.picked.entry.outlineVersion : target.active.outlineVersion);
        var prefs = await loadPreferences(target);
        var names = kit.names();
        var recent = clippedRecent(now.view, now.view.lastVisible(), 3, -1, 1200, 500).map(function (floor) {
          return '[#' + floor.floor + ' ' + (floor.role === 'user' ? names.user : floor.name || '角色') + ']\n' + floor.text;
        }).join('\n\n');
        var draft = await wb.draftEntry({
          character: item, template: template, outline: record.outline, recent: recent, userName: names.user, preferences: prefs.merged,
          signal: signalOf(entry), maxTokens: item.kind === 'temp_event' ? Math.min(1536, settings.judgeMaxTokens) : Math.max(6144, settings.plannerMaxTokens),
          timeoutMs: settings.timeoutMs, chatKey: target.key, volumeId: target.active.volumeId, floorAnchor: Math.max(0, now.floor)
        });
        assertCurrent(target);
        entry.job.update({ stage: item.name + '：写入「' + draft.book + '」', step: 2 });
        if (draft.leaks) entry.job.log('条目里有 ' + draft.leaks + ' 处与后台实情重合，已拿掉');
        var result = await wb.writeEntry({ book: draft.book, entry: draft.entry, confirmed: opts.auto !== true });
        target.active.pendingEntries = target.active.pendingEntries.filter(function (other) { return other.id !== id; });
        target.active.createdEntries.push({ book: result.book, uid: result.uid, name: result.name, roleKind: item.kind === 'temp_event' ? 'temp_event' : 'npc', runId: result.runId, at: Date.now() });
        await persist(target, { active: true });
        entry.job.done(result.skipped ? '「' + result.name + '」之前已经建过档' : '「' + result.name + '」已写入《' + result.book + '》' + (result.notes.length ? '；' + result.notes[0] : ''));
        finishWork(entry);
        emit('entries');
        return { ok: true, book: result.book, name: result.name, notes: result.notes, skipped: result.skipped };
      } catch (error) {
        item.status = error && error.code === 'needs_confirm' ? 'pending' : isAbort(error) ? 'pending' : 'failed';
        item.error = isAbort(error) ? '' : message(error);
        try { await persist(target, { active: true }); } catch (ignored) { /* 状态存不下不盖过原来的错 */ }
        closeJob(entry, error);
        finishWork(entry);
        emit('entries');
        if (opts.auto === true || isAbort(error)) return { ok: false };
        throw error;
      }
    }

    /* 建档策略是「自动」时，定稿（或重构）之后挨个建；哪一位卡住了不影响下一位。 */
    async function autoEntries(target) {
      var ids = (target.active ? target.active.pendingEntries : []).filter(function (item) { return item.status === 'pending'; }).map(function (item) { return item.id; });
      for (var index = 0; index < ids.length; index += 1) {
        if (disposed || target !== session || work) break;
        try { await confirmPendingEntry(ids[index], { auto: true }); } catch (error) { /* 记在条目上了 */ }
      }
      schedulePatrol();
    }

    async function discardPendingEntry(id) {
      var target = await ensureSession();
      if (!target.active) return false;
      var before = target.active.pendingEntries.length;
      target.active.pendingEntries = target.active.pendingEntries.filter(function (item) { return item.id !== id || item.status === 'writing'; });
      if (target.active.pendingEntries.length === before) return false;
      await persist(target, { active: true });
      emit('entries');
      return true;
    }

    /* ---------- 巡检（场记） ---------- */

    /*
     * 用户（或助手）直接改了 outline.md：当成一次手动修订收进来，存成新的一版，返回版本号（没改过返回 0）。
     * 只在巡检开头调用，所以不单独拍快照——紧接着这次巡检存的快照就带着新版本。
     */
    async function adoptOutlineEdit(target) {
      if (!volumeActive(target)) return 0;
      var text = await readText(target.dir + '/outline.md');
      var record = versionRecord(target, target.active.outlineVersion);
      if (text === null || !text.trim() || text.trim() === str(record.outline).trim()) return 0;
      var index = core.normalizeIndex(null, text.trim());
      if (!index.title) index.title = record.index && record.index.title || '';
      var version = core.addVersion(target.snaps, { outline: text.trim(), index: index, note: '直接改了 outline.md' });
      target.active.outlineVersion = version;
      await persist(target);
      return version;
    }

    async function askJudge(messages, entry, settings) {
      var problem = '';
      for (var attempt = 0; attempt < 2; attempt += 1) {
        var reply = await llm.chatTask({
          kind: 'director_judge', messages: messages, maxTokens: settings.judgeMaxTokens, timeoutMs: settings.timeoutMs, signal: signalOf(entry),
          retries: 0, cacheMs: MODEL_CACHE_MS, generationId: 'reader-director-judge'
        });
        var parsed = core.parseVerdict(reply);
        if (parsed.ok) return parsed.verdict;
        problem = parsed.error;
        if (attempt === 0) entry.job.log('回复不合约定，重试一次');
      }
      throw new Error(problem);
    }

    /* 窗口放不下时先掐最新正文：静态前缀（Skill、大纲）不能动，动了缓存就没了。 */
    async function judgeMessages(target, input, entry, settings) {
      var info = null;
      try { info = await llm.resolveTaskModel('director_judge', { cacheMs: MODEL_CACHE_MS, signal: signalOf(entry) }); } catch (error) { if (isAbort(error)) throw error; }
      var windowSize = info && info.contextWindow || 32768;
      var system = core.buildJudgeSystem(input);
      var room = windowSize - kernel.tokenEstimate(system) - settings.judgeMaxTokens - 512;
      if (room < 500) throw new Error('场记模型的上下文窗口（' + windowSize + ' tokens）放不下 Skill 与大纲：换一个窗口更大的模型，或精简大纲。');
      var user = core.buildJudgeUser(input);
      for (var shrink = 0; shrink < 4 && kernel.tokenEstimate(user) > room; shrink += 1) {
        input.recent = input.recent.map(function (item) { return Object.assign({}, item, { text: core.clipMiddle(item.text, Math.max(240, Math.floor(item.text.length * 0.6))) }); });
        user = core.buildJudgeUser(input);
      }
      return [{ role: 'system', content: system }, { role: 'user', content: user }];
    }

    /*
     * 巡检一次：读最新正文 → 场记判定 → 把新状态与下一轮简报存成锚在这一楼的快照。
     * options: { manual, note }。后台自动触发的（manual 不为 true）不满足条件就静静返回 null；手动的会把原因抛出来。
     */
    async function patrol(options) {
      var opts = options || {};
      var manual = opts.manual === true;
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) {
        if (manual) throw new Error('这个聊天里没有正在执导的分卷');
        return null;
      }
      if (!manual && (!isEnabled() || target.active.paused || generating() || work || Date.now() < target.retryAfter)) return null;
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
      var settings = getSettings();
      var view = chatView();
      var floor = view.lastAssistant();
      if (floor < 0) {
        if (manual) throw new Error('聊天里还没有可以巡检的正文');
        return null;
      }
      var picked = core.pickSnapshot(target.snaps, view, floor);
      if (!picked.entry) return null;
      var turn = view.turns(floor);
      if (!manual && !picked.forked && picked.entry.brief) {
        /* 这一楼已经判过了；或者离上一次判定还不到 patrolEvery 个回合。 */
        if (picked.entry.floor === floor) return null;
        if (turn - picked.entry.state.turn < settings.patrolEvery) return null;
      }

      var entry = begin('patrol', { level: manual ? 'major' : 'minor', title: '导演 · 后台巡检', stage: '读取最新正文', steps: 0 });
      var followUp = null, outcome = null;
      try {
        var adopted = await adoptOutlineEdit(target);
        var version = adopted || picked.entry.outlineVersion;
        var record = versionRecord(target, version);
        var skill = await skillText();
        var prefs = await loadPreferences(target);
        var userName = kit.names().user;
        var count = Math.min(9, Math.max(3, settings.patrolEvery * 2 + 1));
        var input = {
          skillRaw: skill.text, preferences: prefs.merged, userName: userName, profile: target.active.profile,
          outline: record.outline, index: record.index, state: picked.entry.state, brief: picked.entry.brief, turn: turn, note: opts.note,
          recent: clippedRecent(view, floor, count, picked.forked ? -1 : picked.entry.floor, 2400, 800)
        };
        var guard = core.anchorOf(view, floor);
        entry.job.update({ stage: '场记判定偏移并预写下一轮简报' });
        var verdict = await askJudge(await judgeMessages(target, input, entry, settings), entry, settings);
        /* 请求回来时聊天可能已经不是那个样子了：切了聊天、这一楼被重掷或改写过，判定就作废。 */
        assertCurrent(target);
        var after = chatView();
        if (after.contentHash(floor) !== guard.contentHash || after.tailHash(floor) !== guard.tailHash) throw staleError('正文在巡检途中变了，这次判定作废');

        var applied = core.applyVerdict(picked.entry.state, verdict, record.index, { turn: turn, l2Cooldown: settings.l2Cooldown, manual: manual });
        var brief = applied.level < 2 ? core.sanitizeBriefDetailed(verdict.next_brief, { userName: userName, outline: record.outline }) : { text: picked.entry.brief, leaks: 0 };
        if (!brief.text) brief.text = picked.entry.brief;
        target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(guard, { outlineVersion: version, kind: manual ? 'manual' : 'patrol', state: applied.state, brief: brief.text }));
        target.active.failStreak = 0;
        target.active.lastError = '';
        target.retryAfter = 0;
        if (target.active.outlineVersion !== version) {
          /* 删楼退回到了上一版大纲管着的地方：大纲跟着换回去。 */
          target.active.outlineVersion = version;
          await vfs.write(target.dir + '/outline.md', record.outline);
        }
        var landed = applied.readyToFinish && target.active.status === 'running';
        if (landed) target.active.status = 'pending_finish';
        await persist(target);
        var label = 'L' + applied.level + (applied.level === 0 ? ' 顺轨' : applied.level === 1 ? ' 局部绕道' : ' 结构破局');
        if (applied.downgraded) entry.job.log('冷却期内的 L2 已按 L1 处理');
        if (brief.leaks) entry.job.log('简报里有 ' + brief.leaks + ' 处与后台实情重合，已拿掉');
        if (applied.restructure) followUp = { kind: 'restructure', reason: verdict.reason };
        else if (applied.readyToFinish && settings.autoArchive) followUp = { kind: 'finish' };
        outcome = { level: applied.level, downgraded: applied.downgraded, restructure: applied.restructure, readyToFinish: applied.readyToFinish, leaks: brief.leaks };
        entry.job.done(applied.restructure ? label + ' · 交给总导演重构' : landed ? label + ' · 本卷可以完结了' : label + ' · 下一轮简报已备好');
        finishWork(entry);
        emit('patrol');
        if (landed && !settings.autoArchive) warn('《' + (target.active.title || '这一卷') + '》已经走到落幕：到「导演」页确认完结，或接着往下演。');
      } catch (error) {
        if (isAbort(error) || (entry.controller && entry.controller.signal.aborted)) {
          closeJob(entry, error);
          finishWork(entry);
          if (error && error.code === 'director_stale' && target === session) schedulePatrol();
          return null;
        }
        target.active.failStreak += 1;
        target.active.lastError = message(error);
        target.retryAfter = Date.now() + Math.min(300000, 20000 * target.active.failStreak);
        if (target.active.failStreak >= FAIL_LIMIT) {
          target.active.paused = true;
          target.active.pausedBy = 'failures';
          warn('导演连续 ' + FAIL_LIMIT + ' 次巡检失败，已自动暂停：' + message(error) + '。检查导演模型的连接后，到「导演」页点「恢复」。');
        }
        try { await persist(target, { active: true }); } catch (ignored) { /* ignore */ }
        entry.job.fail(error);
        finishWork(entry);
        emit('patrol');
        if (manual) throw error;
        return null;
      }
      if (followUp && followUp.kind === 'restructure') {
        /* 升档由这里的状态机决定：场记判了 L2，直接拉总导演（director 用途）重构，不经过助手，也不靠模型互相派发。 */
        try { outcome.restructured = !!(await restructure({ reason: followUp.reason, auto: true })); } catch (error) { outcome.restructured = false; }
      } else if (followUp && followUp.kind === 'finish') {
        try { outcome.archived = !!(await finish({ auto: true })); } catch (error) { outcome.archived = false; }
      }
      return outcome;
    }

    /* ---------- 结构重构（总导演） ---------- */

    /*
     * 重写后续大纲。options: { reason, feedback, manual, auto }。
     * 不带着之前的对话：总导演看到的只有同一份编纲 System、原大纲、迄今硬事实与最近的正文。
     * 重构前那一版大纲与当时的状态留着（active.undo），undoRestructure() 可以一键撤回。
     */
    async function restructure(options) {
      var opts = options || {};
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      var entry = begin('restructure', { title: '导演 · 结构重构', stage: '整理既成事实', steps: 2 });
      var previousStatus = target.active.status;
      try {
        target.active.status = 'restructuring';
        emit('volume');
        var settings = getSettings();
        var view = chatView();
        var floor = view.lastAssistant();
        var picked = core.pickSnapshot(target.snaps, view, view.lastVisible());
        var base = picked.entry;
        var version = base.outlineVersion;
        var record = versionRecord(target, version);
        var skill = await skillText();
        var prefs = await loadPreferences(target);
        var userName = kit.names().user;
        var guard = core.anchorOf(view, floor);
        var reason = str(opts.reason).trim() || (opts.feedback ? '用户要求修订大纲' : '手动发起的结构重构');
        entry.job.update({ stage: '总导演重写后续阶段', step: 1 });
        var reply = await llm.chatTask({
          kind: 'director', maxTokens: settings.plannerMaxTokens, timeoutMs: settings.timeoutMs, signal: signalOf(entry), retries: 1, cacheMs: MODEL_CACHE_MS,
          generationId: 'reader-director-restructure',
          messages: core.buildRestructureMessages({
            system: core.buildPlannerSystem(skill.text, prefs.merged, userName), outline: record.outline, index: record.index, state: base.state,
            recent: clippedRecent(view, view.lastVisible(), 6, -1, 2000, 700), userName: userName, reason: reason, feedback: opts.feedback, manual: opts.auto !== true
          })
        });
        var final = core.parseFinalOutline(reply);
        if (!final.ok) throw new Error(final.error);
        assertCurrent(target);
        entry.job.update({ stage: '落盘：新大纲与下一轮简报', step: 2 });
        var turn = floor >= 0 ? view.turns(floor) : view.turns(view.lastVisible());
        var nextVersion = core.addVersion(target.snaps, { outline: final.outline, index: final.index, note: final.note || reason });
        var state = core.normalizeState(base.state);
        state.phaseCursor = 1;
        state.patches = [];
        state.finishStreak = 0;
        state.lastL2Turn = turn;
        state.turn = turn;
        state.driftLevel = 2;
        state.reason = final.note || reason;
        var brief = core.sanitizeBriefDetailed(final.firstBrief, { userName: userName, outline: final.outline });
        target.active.undo = { fromVersion: version, toVersion: nextVersion, at: Date.now(), reason: reason, state: modules.clone(base.state), brief: base.brief };
        target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(guard, { outlineVersion: nextVersion, kind: 'restructure', state: state, brief: brief.text || base.brief }));
        target.active.outlineVersion = nextVersion;
        if (final.index.title) target.active.title = final.index.title;
        target.active.status = 'running';
        target.active.failStreak = 0;
        target.active.lastError = '';
        if (settings.wbPolicy !== 'none') {
          var known = target.active.pendingEntries.concat(target.active.createdEntries);
          target.active.pendingEntries = target.active.pendingEntries.concat(pendingFromIndex(final.index, known));
        }
        await vfs.write(target.dir + '/outline.md', final.outline);
        await persist(target);
        entry.job.done('大纲已重构为第 ' + nextVersion + ' 版' + (final.note ? '：' + final.note : ''));
        finishWork(entry);
        emit('volume');
        if (settings.wbPolicy === 'auto') autoEntries(target).catch(noop);
        return { version: nextVersion, note: final.note };
      } catch (error) {
        target.active.status = previousStatus === 'restructuring' ? 'running' : previousStatus;
        if (!isAbort(error)) target.active.lastError = '结构重构没有完成：' + message(error);
        try { await persist(target, { active: true }); } catch (ignored) { /* ignore */ }
        closeJob(entry, error);
        finishWork(entry);
        emit('volume');
        if (isAbort(error)) return null;
        throw error;
      }
    }

    /* 把大纲退回重构之前的那一版；状态与简报也回到重构前，并从当前楼层起生效。 */
    async function undoRestructure() {
      var target = await ensureSession();
      var undo = target.active && target.active.undo;
      if (!volumeActive(target) || !undo) throw new Error('没有可以撤回的重构');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完再撤回');
      var record = target.snaps.versions[undo.fromVersion];
      if (!record) throw new Error('重构前的那一版大纲已经不在了');
      var view = chatView();
      var floor = view.lastAssistant();
      var turn = floor >= 0 ? view.turns(floor) : view.turns(view.lastVisible());
      var state = core.normalizeState(undo.state);
      /* 撤回之后的几个回合里不再自动重构：不然场记多半会立刻再判一次 L2。 */
      state.lastL2Turn = turn;
      state.turn = turn;
      target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(core.anchorOf(view, floor), { outlineVersion: undo.fromVersion, kind: 'undo', state: state, brief: undo.brief }));
      target.active.outlineVersion = undo.fromVersion;
      target.active.undo = null;
      target.active.status = 'running';
      await vfs.write(target.dir + '/outline.md', record.outline);
      await persist(target);
      emit('volume');
      return { version: undo.fromVersion };
    }

    /* ---------- 手动修订：大纲、简报、快照 ---------- */

    async function applyOutline(target, text, note) {
      var now = currentPick(target);
      var base = now.picked.entry;
      var previous = versionRecord(target, base ? base.outlineVersion : target.active.outlineVersion);
      var index = core.normalizeIndex(null, text);
      if (!index.title) index.title = previous.index && previous.index.title || '';
      var version = core.addVersion(target.snaps, { outline: text, index: index, note: note || '手动修订' });
      var state = core.normalizeState(base ? base.state : null);
      if (index.totalPhases) state.phaseCursor = Math.min(state.phaseCursor, index.totalPhases);
      state.turn = now.floor >= 0 ? now.view.turns(now.floor) : state.turn;
      target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(core.anchorOf(now.view, now.floor), { outlineVersion: version, kind: 'edit', state: state, brief: base ? base.brief : '' }));
      target.active.outlineVersion = version;
      await vfs.write(target.dir + '/outline.md', text);
      await persist(target);
      return version;
    }

    async function saveOutline(text) {
      var target = await ensureSession();
      if (!volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完再改大纲');
      var outline = str(text).trim();
      if (outline.length < 40) throw new Error('大纲太短了');
      var version = await applyOutline(target, outline, '手动修订');
      emit('volume');
      return { version: version };
    }

    async function getOutline() {
      var target = await ensureSession();
      if (!volumeActive(target)) return { text: '', version: 0, index: null, versions: [] };
      var now = currentPick(target);
      var version = now.picked.entry && !now.picked.forked ? now.picked.entry.outlineVersion : target.active.outlineVersion;
      var record = versionRecord(target, version);
      return {
        text: record.outline, version: version, index: record.index,
        versions: Object.keys(target.snaps.versions).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
          return { n: n, at: target.snaps.versions[n].at, note: target.snaps.versions[n].note };
        })
      };
    }

    /* 此刻会注入的简报（按常规生成的口径取）。 */
    async function getBrief() {
      var target = await ensureSession();
      if (!volumeActive(target)) return { text: '', floor: -1, exact: false, forked: false };
      var now = currentPick(target);
      var entry = now.picked.entry;
      return { text: entry && !now.picked.forked ? entry.brief : '', floor: entry ? entry.floor : -1, exact: !!entry && entry.floor === now.floor, forked: now.picked.forked, at: entry ? entry.at : 0 };
    }

    /* 用户改写下一轮的简报：照样净化（主角名、宏、字数），但不做防泄密比对——作者自己愿意写什么是他的事。 */
    async function saveBrief(text) {
      var target = await ensureSession();
      if (!volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      var now = currentPick(target);
      var base = now.picked.entry;
      var brief = core.sanitizeBrief(text, { userName: kit.names().user });
      var state = core.normalizeState(base ? base.state : null);
      state.turn = now.floor >= 0 ? now.view.turns(now.floor) : state.turn;
      target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(core.anchorOf(now.view, now.floor), {
        outlineVersion: base ? base.outlineVersion : target.active.outlineVersion, kind: 'edit', state: state, brief: brief
      }));
      await persist(target, { snaps: true });
      emit('volume');
      return { text: brief };
    }

    async function listSnapshots() {
      var target = await ensureSession();
      if (!volumeActive(target)) return [];
      var now = currentPick(target);
      var view = now.view, top = view.lastVisible();
      var current = now.picked.entry && !now.picked.forked ? now.picked.entry.id : '';
      return (target.snaps.base ? [target.snaps.base] : []).concat(target.snaps.ring).map(function (entry) {
        var record = target.snaps.versions[entry.outlineVersion];
        return {
          id: entry.id, floor: entry.floor, at: entry.at, kind: entry.kind, outlineVersion: entry.outlineVersion,
          phaseCursor: entry.state.phaseCursor, phaseTitle: core.phaseTitle(record && record.index, entry.state.phaseCursor),
          driftLevel: entry.state.driftLevel, reason: entry.state.reason, progress: entry.state.progress, brief: entry.brief,
          matches: core.snapshotMatches(entry, view, top), current: entry.id === current
        };
      }).reverse();
    }

    /* 回到某条快照的状态：不动聊天楼层，而是把那条快照的状态、简报与大纲版本复制一份，锚到当前楼层上，从这里起生效。 */
    async function rollbackTo(id) {
      var target = await ensureSession();
      if (!volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完再回退');
      var source = (target.snaps.base ? [target.snaps.base] : []).concat(target.snaps.ring).filter(function (entry) { return entry.id === id; })[0];
      if (!source) throw new Error('这条快照已经不在了');
      var record = target.snaps.versions[source.outlineVersion];
      if (!record) throw new Error('这条快照用的那一版大纲已经不在了');
      var view = chatView();
      var floor = view.lastAssistant();
      var state = core.normalizeState(source.state);
      state.turn = floor >= 0 ? view.turns(floor) : state.turn;
      target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(core.anchorOf(view, floor), { outlineVersion: source.outlineVersion, kind: 'manual', state: state, brief: source.brief }));
      if (target.active.outlineVersion !== source.outlineVersion) {
        target.active.outlineVersion = source.outlineVersion;
        await vfs.write(target.dir + '/outline.md', record.outline);
      }
      if (target.active.status === 'pending_finish') target.active.status = 'running';
      await persist(target);
      emit('volume');
      return true;
    }

    /* ---------- 完结与归档 ---------- */

    function createdBooks(target) {
      var books = [];
      (target.active && target.active.createdEntries || []).forEach(function (item) { if (item.book && books.indexOf(item.book) < 0) books.push(item.book); });
      return books;
    }

    async function listVolumeEntries() {
      var target = await ensureSession();
      if (!target.active || !target.active.volumeId) return [];
      try { return await wb.listVolumeEntries(target.active.volumeId, createdBooks(target)); } catch (error) { return []; }
    }

    /*
     * 完结这一卷。options: { keepEntryIds, auto }
     *   keepEntryIds  要保留启用的新角色条目（listVolumeEntries 给的 id）；不给就全部保留。一次性的条目一律停用（只关不删）。
     * 沉淀卷档案与跨卷钩子 → 存一份归档前的恢复点 → 世界书分流 → 追加 archive.json → 清空活跃卷，回到空闲。
     * 归档模型出了问题不卡住完结：用进度摘要与硬事实兜底成档案。
     */
    async function finish(options) {
      var opts = options || {};
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有可以完结的分卷');
      var entry = begin('archive', { title: '导演 · 完结归档', stage: '沉淀卷档案与跨卷钩子', steps: 3, step: 1 });
      try {
        var settings = getSettings();
        var active = target.active;
        var now = currentPick(target);
        var base = now.picked.entry || target.snaps.base;
        var record = versionRecord(target, base ? base.outlineVersion : active.outlineVersion);
        var state = base ? base.state : core.initialState();
        var entries = [];
        try { entries = await wb.listVolumeEntries(active.volumeId, createdBooks(target)); } catch (error) { entries = []; }
        var note = null;
        try {
          var skill = await skillText();
          var prefs = await loadPreferences(target);
          var reply = await llm.chatTask({
            kind: 'director_judge', maxTokens: Math.min(2048, settings.judgeMaxTokens), timeoutMs: settings.timeoutMs, signal: signalOf(entry), retries: 1, cacheMs: MODEL_CACHE_MS,
            generationId: 'reader-director-archive',
            messages: core.buildArchiveMessages({
              skillRaw: skill.text, preferences: prefs.merged, userName: kit.names().user, outline: record.outline, index: record.index, state: state,
              recent: clippedRecent(now.view, now.view.lastVisible(), 4, -1, 1600, 500), entries: entries
            })
          });
          var parsed = core.parseArchive(reply);
          if (!parsed.ok) throw new Error(parsed.error);
          note = parsed.archive;
        } catch (error) {
          if (isAbort(error) || (entry.controller && entry.controller.signal.aborted)) throw error;
          note = core.fallbackArchive(record.index, state);
          entry.job.log('归档模型没有给出可用的档案（' + message(error) + '），已用进度摘要与硬事实兜底');
        }
        assertCurrent(target);

        entry.job.update({ stage: '保存恢复点，分流本卷的世界书条目', step: 2 });
        var restore = { v: 1, at: Date.now(), volumeId: active.volumeId, active: modules.clone(active), outline: record.outline, snaps: modules.clone(target.snaps), triaged: [] };
        await writeJson(target.dir + '/restore.json', restore);
        var triage = { changed: [], notes: [] };
        try { triage = await wb.triageVolumeEntries(active.volumeId, opts.keepEntryIds === undefined ? null : opts.keepEntryIds, { books: createdBooks(target), confirmed: opts.auto !== true }); }
        catch (error) { triage.notes.push('世界书条目没有分流：' + message(error)); }
        triage.notes.forEach(function (line) { entry.job.log(line); });
        if (triage.changed.length) {
          restore.triaged = triage.changed;
          await writeJson(target.dir + '/restore.json', restore);
        }

        entry.job.update({ stage: '写入档案，清空活跃卷', step: 3 });
        var archive = await readJson(target.dir + '/archive.json') || { v: 1, volumes: [] };
        if (!Array.isArray(archive.volumes)) archive.volumes = [];
        archive.volumes.push({
          volumeId: active.volumeId, volumeNo: active.volumeNo, title: note.title || active.title || '', summary: note.summary, hooks: note.hooks,
          entries: note.entries, fallback: note.fallback === true, finishedAt: Date.now(), turns: Math.max(0, state.turn - (active.baseTurn || 0)),
          disabled: triage.changed.map(function (item) { return item.name; })
        });
        await writeJson(target.dir + '/archive.json', archive);
        var idle = { v: 1, ownerKey: target.key, label: target.label, status: 'idle', volumeNo: active.volumeNo, updatedAt: Date.now() };
        await writeJson(target.dir + '/active.json', idle);
        await removeFile(target.dir + '/outline.md');
        await removeFile(target.dir + '/snapshots.json');
        target.active = normalizeActive(idle, target);
        target.snaps = core.emptySnapshots();
        target.hasArchive = true;
        target.canRestore = true;
        syncRef();
        entry.job.done('第 ' + active.volumeNo + ' 卷已归档' + (triage.changed.length ? '，停用了 ' + triage.changed.length + ' 个一次性条目' : ''));
        finishWork(entry);
        emit('volume');
        return { volumeNo: active.volumeNo, summary: note.summary, hooks: note.hooks, disabled: triage.changed.length, notes: triage.notes, fallback: note.fallback === true };
      } catch (error) {
        if (!isAbort(error) && target.active) target.active.lastError = '归档没有完成：' + message(error);
        closeJob(entry, error);
        finishWork(entry);
        emit('volume');
        /* 用户点了停止：不算出错，这一卷原样留着。 */
        if (isAbort(error)) return null;
        throw error;
      }
    }

    /* 「待完结」时用户决定接着往下演：回到执导中，完结的计数清零（之后要重新连着两轮达成条件，才会再提示）。 */
    async function continueVolume() {
      var target = await ensureSession();
      if (!volumeActive(target) || target.active.status !== 'pending_finish') return false;
      var now = currentPick(target);
      var base = now.picked.entry;
      if (base && !now.picked.forked) {
        var state = core.normalizeState(base.state);
        state.finishStreak = 0;
        target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(core.anchorOf(now.view, now.floor), { outlineVersion: base.outlineVersion, kind: 'manual', state: state, brief: base.brief }));
      }
      target.active.status = 'running';
      await persist(target);
      emit('volume');
      return true;
    }

    /* 撤销最近一次归档：活跃卷、大纲、快照都回来，分流时停用的条目重新启用，档案里刚加的那一卷去掉。 */
    async function restoreLastArchive() {
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完再恢复');
      if (volumeActive(target)) throw new Error('这个聊天已经有一卷在执导：先完结或放弃它，再恢复上一卷');
      var restore = await readJson(target.dir + '/restore.json');
      if (!restore || !modules.isObject(restore.active)) throw new Error('没有可以恢复的归档');
      var active = normalizeActive(restore.active, target);
      if (!active || !active.volumeId) throw new Error('恢复点已经损坏');
      if (active.status === 'idle') active.status = 'running';
      await vfs.write(target.dir + '/outline.md', str(restore.outline));
      await writeJson(target.dir + '/snapshots.json', core.normalizeSnapshots(restore.snaps));
      await writeJson(target.dir + '/active.json', active);
      var archive = await readJson(target.dir + '/archive.json');
      if (archive && Array.isArray(archive.volumes)) {
        archive.volumes = archive.volumes.filter(function (volume) { return volume.volumeId !== restore.volumeId; });
        await writeJson(target.dir + '/archive.json', archive);
        target.hasArchive = archive.volumes.length > 0;
      }
      var restored = 0;
      try { restored = await wb.restoreTriagedEntries(restore.triaged); } catch (error) { restored = 0; }
      await removeFile(target.dir + '/restore.json');
      target.active = active;
      target.snaps = core.normalizeSnapshots(restore.snaps);
      target.canRestore = false;
      syncRef();
      emit('volume');
      schedulePatrol();
      return { volumeNo: active.volumeNo, entries: restored };
    }

    /* 放弃这一卷：不归档，直接清掉。先存一份恢复点，点错了还能找回来。 */
    async function discardVolume() {
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，先点「停止」');
      var active = target.active;
      await writeJson(target.dir + '/restore.json', {
        v: 1, at: Date.now(), volumeId: active.volumeId, active: modules.clone(active),
        outline: versionRecord(target, active.outlineVersion).outline, snaps: modules.clone(target.snaps), triaged: []
      });
      var idle = { v: 1, ownerKey: target.key, label: target.label, status: 'idle', volumeNo: Math.max(0, active.volumeNo - 1), updatedAt: Date.now() };
      await writeJson(target.dir + '/active.json', idle);
      await removeFile(target.dir + '/outline.md');
      await removeFile(target.dir + '/snapshots.json');
      target.active = normalizeActive(idle, target);
      target.snaps = core.emptySnapshots();
      target.canRestore = true;
      syncRef();
      emit('volume');
      return true;
    }

    async function getArchive() {
      var target = await ensureSession();
      var archive = target.key ? await readJson(target.dir + '/archive.json') : null;
      return { volumes: archive && Array.isArray(archive.volumes) ? archive.volumes : [], canRestore: target.canRestore };
    }

    /* ---------- 暂停、恢复、插话 ---------- */

    /* 编纲在跑：立刻掐掉当前请求、存下草稿。分卷在执导：停止注入与巡检（状态都留着）。 */
    async function pause() {
      var target = await ensureSession();
      if (work && work.kind === 'plan') { abortWork(work, 'pause'); return 'plan'; }
      if (volumeActive(target)) {
        if (work) abortWork(work, 'pause');
        target.active.paused = true;
        target.active.pausedBy = 'user';
        await persist(target, { active: true });
        emit('volume');
        return 'volume';
      }
      return '';
    }

    /* 接着编（草稿在）或恢复执导（分卷暂停着）。review 停下的草稿：继续 = 这一步过目通过。 */
    async function resume() {
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');
      if (target.draft && !volumeActive(target)) {
        if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
        if (target.draft.state === 'review') target.draft.reviewed = true;
        return drivePlan(target);
      }
      if (volumeActive(target) && target.active.paused) {
        target.active.paused = false;
        target.active.pausedBy = '';
        target.active.failStreak = 0;
        target.active.lastError = '';
        target.retryAfter = 0;
        await persist(target, { active: true });
        emit('volume');
        schedulePatrol();
        return { resumed: true };
      }
      return { resumed: false };
    }

    /* 丢掉编到一半的草稿。 */
    async function discardDraft() {
      var target = await ensureSession();
      if (work && work.kind === 'plan') abortWork(work, 'user');
      target.draft = null;
      await removeFile(target.dir + '/draft.json');
      emit('plan');
      return true;
    }

    /*
     * 向导演提意见。意见的优先级最高：
     *   编纲在跑       掐掉当前这一步，把意见附在这一步上重跑；
     *   编纲停着       停在第 2 步等过目的：按意见修订第 2 步（修订完仍停下给你看）；别的情况：把意见附在下一步上接着编；
     *   分卷在执导     按意见重构后续大纲。
     */
    async function submitFeedback(text) {
      var note = str(text).trim();
      if (!note) throw new Error('先写下你的意见');
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');
      if (target.draft && !volumeActive(target)) {
        var draft = target.draft;
        if (work && work.kind === 'plan') {
          var running = work;
          abortWork(running, 'pause');
          /* 等那一步真的停下来（它的 catch 会把草稿存成「暂停」），再改草稿、重新起跑。 */
          for (var wait = 0; wait < 200 && work === running; wait += 1) await new Promise(function (resolve) { setTimeout(resolve, 10); });
          if (work) throw new Error('编纲还没有停下来，稍等再试');
        }
        if (draft.state === 'review' && draft.step === 2) {
          draft.feedback.push({ step: 2, text: note });
          draft.revise = { step: 2, previous: draft.outputs[1], text: note };
          draft.step = 1;
          draft.reviewed = false;
        } else {
          draft.feedback.push({ step: Math.min(4, draft.step + 1), text: note });
        }
        return drivePlan(target);
      }
      if (volumeActive(target)) return restructure({ feedback: note, reason: '用户要求修订大纲', manual: true });
      throw new Error('现在没有编纲、也没有执导中的分卷：先点「开卷」');
    }

    function stop() {
      if (!work) return false;
      return abortWork(work, work.kind === 'plan' ? 'pause' : 'user');
    }

    /* ---------- 偏好与 Skill ---------- */

    async function getPreferences() {
      var target = await ensureSession();
      var prefs = await loadPreferences(target);
      return { global: prefs.global, card: prefs.card, hasCard: !!target.owner, cardLabel: target.label ? target.label.split(' / ')[0] : '' };
    }

    async function savePreferences(input) {
      var target = await ensureSession();
      var source = input || {};
      if (source.global !== undefined) {
        if (str(source.global).trim()) await vfs.write(ROOT + '/preferences.md', str(source.global));
        else await removeFile(ROOT + '/preferences.md');
      }
      if (source.card !== undefined) {
        if (!target.owner) throw new Error('先打开一个聊天，才能保存这张卡的偏好');
        if (str(source.card).trim()) await vfs.write(cardPreferencePath(target), str(source.card));
        else await removeFile(cardPreferencePath(target));
      }
      emit('preferences');
      return getPreferences();
    }

    async function getSkill() {
      var current = await skillText();
      var detail = core.sliceDirectorSkillDetailed(current.text, 'planner');
      var runtime = core.sliceDirectorSkillDetailed(current.text, 'runtime');
      return {
        text: current.text, source: current.source, path: SKILL_PATH,
        degraded: detail.degraded || runtime.degraded, missing: detail.missing.concat(runtime.missing).filter(function (item, index, list) { return list.indexOf(item) === index; })
      };
    }

    /* 保存到工作区：知识库那边（skills.js）监听着这个文件，助手读到的也同步换成新的。 */
    async function saveSkill(text) {
      var body = str(text);
      if (!body.trim()) throw new Error('Skill 不能是空的；要回到内置的那份，请点「恢复内置默认」');
      await vfs.write(SKILL_PATH, body);
      skillCache = null;
      emit('skill');
      return getSkill();
    }

    async function resetSkill() {
      await removeFile(SKILL_PATH);
      skillCache = null;
      if (skills && typeof skills.reload === 'function') { try { await skills.reload(core.SKILL_NAME); } catch (error) { /* 下次启动会再扫一遍 */ } }
      emit('skill');
      return getSkill();
    }

    /* ---------- 正文注入 ---------- */

    function generating() { return generatingAt > 0 && Date.now() - generatingAt < GENERATING_STALE_MS; }

    /* 同步、便宜：每次生成之前正文提示词模块都会问一遍。 */
    function injectable() {
      if (disposed) return false;
      var current = owner();
      if (!current.key || !isEnabled()) return false;
      if (session.key === current.key && session.loaded) return volumeActive(session) && session.active.paused !== true;
      ensureSession().catch(noop);
      var ref = kit.readChatValue(CHAT_REF_KEY);
      return modules.isObject(ref) && ref.ownerKey === current.key && ref.on === true;
    }

    /*
     * 这一次生成要注入的简报。快照是巡检时就存好的，这里只按楼层指纹取出来，不调模型。
     * 分叉了（聊天与记录对不上）就先不注入，安排一次重新巡检；不该注入的回合（injectEvery）返回空串。
     */
    async function provideBrief(generationType) {
      var target = await ensureSession();
      if (target !== session || !injectable() || !volumeActive(target)) return '';
      var view = chatView();
      var anchor = core.injectionAnchor(view, generationType);
      var picked = core.pickSnapshot(target.snaps, view, anchor.maxFloor);
      if (!picked.entry) return '';
      if (picked.forked) { schedulePatrol(); return ''; }
      var every = getSettings().injectEvery;
      if (every > 1) {
        var round = view.turns(anchor.maxFloor) - (target.active.baseTurn || 0);
        if (((round % every) + every) % every !== 0) return '';
      }
      return picked.entry.brief || '';
    }

    function registerSlot() {
      var prompt = null;
      try { prompt = typeof deps.prompt === 'function' ? deps.prompt() : deps.prompt; } catch (error) { prompt = null; }
      if (!prompt || typeof prompt.registerSlot !== 'function' || prompt === slotOwner) return !!slotOwner;
      try {
        if (prompt.registerSlot('director', { active: injectable, brief: provideBrief })) slotOwner = prompt;
      } catch (error) { log.warn('[ReaderII] 导演简报槽位登记失败', error); }
      return !!slotOwner;
    }

    /* ---------- 酒馆事件 ---------- */

    function clearPatrolTimer() {
      if (patrolTimer) { clearTimeout(patrolTimer); patrolTimer = null; }
    }

    function schedulePatrol(delay) {
      if (disposed) return;
      clearPatrolTimer();
      patrolTimer = setTimeout(function () {
        patrolTimer = null;
        if (disposed || generating() || work) return;
        patrol({ manual: false }).catch(function (error) { log.warn('[ReaderII] 导演巡检出错', error); });
      }, delay === undefined ? debounceMs : delay);
      if (patrolTimer && typeof patrolTimer.unref === 'function') patrolTimer.unref();
    }

    function listen(name, handler) {
      var subscription = null;
      try { subscription = kit.on(name, handler); } catch (error) { subscription = null; }
      if (subscription && typeof subscription.stop === 'function') subscriptions.push(subscription);
    }

    function onChatChanged() {
      clearPatrolTimer();
      generatingAt = 0;
      viewCache = null;
      var current = owner();
      /* 旧聊天里还在途的活：编纲存成草稿（drivePlan 的收尾里做），巡检、重构直接作废。 */
      if (work && work.key !== current.key) abortWork(work, 'chat');
      emit('chat');
      ensureSession().then(function () { emit('chat'); schedulePatrol(); }, noop);
    }

    listen('GENERATION_STARTED', function (type, options, dryRun) {
      if (dryRun === true) return;
      generatingAt = Date.now();
      clearPatrolTimer();
      registerSlot();
    });
    listen('GENERATION_ENDED', function () { generatingAt = 0; viewCache = null; schedulePatrol(); });
    listen('GENERATION_STOPPED', function () { generatingAt = 0; viewCache = null; schedulePatrol(); });
    listen('MESSAGE_RECEIVED', function () { viewCache = null; schedulePatrol(); });
    ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED'].forEach(function (name) {
      listen(name, function () { viewCache = null; emit('chat'); schedulePatrol(); });
    });
    listen('CHAT_CHANGED', onChatChanged);

    if (typeof vfs.onWrite === 'function') {
      unwatch = vfs.onWrite(function (event) {
        if (event.mount === 'ws' && event.segs.length === 3 && event.segs[0] === 'skills' && event.segs[1] === core.SKILL_NAME && event.segs[2] === 'SKILL.md') {
          skillCache = null;
          emit('skill');
        }
      });
    }

    registerSlot();
    ensureSession().catch(noop);

    /* ---------- 状态快照（界面用，同步） ---------- */

    function getStatus() {
      registerSlot();
      var current = owner();
      var settings = getSettings();
      var own = current.key ? chatSwitch() : null;
      var status = {
        hasChat: !!current.key, chatLabel: current.label, group: current.group, ready: true,
        enabled: current.key ? (own === null ? settings.enabled : own) : settings.enabled, globalEnabled: settings.enabled, chatSwitch: own,
        slot: !!slotOwner, state: 'nochat', paused: false, pausedBy: '', lastError: '', failStreak: 0,
        work: work ? { kind: work.kind, label: WORK_LABEL[work.kind] || work.kind, id: work.job.id, here: work.key === current.key } : null,
        generating: generating(), volume: null, plan: null, pending: [], created: 0,
        canUndoRestructure: false, canRestoreArchive: false, hasArchive: false, forked: false
      };
      if (!current.key) return status;
      if (session.key !== current.key || !session.loaded) {
        ensureSession().catch(noop);
        status.ready = false;
        status.state = 'loading';
        return status;
      }
      var target = session;
      status.canRestoreArchive = target.canRestore && !volumeActive(target);
      status.hasArchive = target.hasArchive;
      if (target.draft && !volumeActive(target)) {
        var draft = target.draft;
        var planning = !!(work && work.kind === 'plan' && work.key === target.key);
        status.state = planning ? 'planning' : 'draft';
        status.plan = {
          state: planning ? 'running' : draft.state, mode: draft.mode, step: draft.step, steps: 4, names: core.PLANNER_STEP_NAMES.slice(),
          outputs: draft.outputs.slice(), feedback: draft.feedback.slice(), error: draft.error, hasMaterials: !!draft.materials, updatedAt: draft.updatedAt
        };
        return status;
      }
      if (!volumeActive(target)) {
        status.state = 'idle';
        status.volumeNo = target.active ? target.active.volumeNo : 0;
        return status;
      }
      var active = target.active;
      var now = currentPick(target);
      var entry = now.picked.entry || target.snaps.base;
      var record = versionRecord(target, entry ? entry.outlineVersion : active.outlineVersion);
      var state = core.normalizeState(entry ? entry.state : null);
      status.state = active.paused ? 'paused' : active.status;
      status.paused = active.paused;
      status.pausedBy = active.pausedBy || '';
      status.lastError = active.lastError;
      status.failStreak = active.failStreak;
      status.forked = now.picked.forked;
      status.canUndoRestructure = !!active.undo;
      status.pending = active.pendingEntries.map(function (item) { return { id: item.id, name: item.name, kind: item.kind, brief: item.brief, status: item.status, error: item.error }; });
      status.created = active.createdEntries.length;
      status.volume = {
        id: active.volumeId, no: active.volumeNo, title: active.title, status: active.status, version: entry ? entry.outlineVersion : active.outlineVersion,
        phaseCursor: state.phaseCursor, totalPhases: record.index ? record.index.totalPhases : 0, phaseTitle: core.phaseTitle(record.index, state.phaseCursor),
        phases: record.index ? record.index.phases : [], turn: now.floor >= 0 ? now.view.turns(now.floor) : 0, judgedTurn: state.turn, baseTurn: active.baseTurn || 0,
        driftLevel: state.driftLevel, reason: state.reason, progress: state.progress, facts: state.facts.slice(), patches: state.patches.slice(),
        briefFloor: entry ? entry.floor : -1, briefExact: !!entry && entry.floor === now.floor, hasBrief: !!(entry && entry.brief), createdAt: active.createdAt, updatedAt: active.updatedAt
      };
      return status;
    }

    function dispose() {
      disposed = true;
      clearPatrolTimer();
      if (work) abortWork(work, 'user');
      subscriptions.splice(0).forEach(function (subscription) { try { subscription.stop(); } catch (error) { /* ignore */ } });
      if (unwatch) { try { unwatch(); } catch (error) { /* ignore */ } unwatch = null; }
      if (slotOwner) { try { slotOwner.registerSlot('director', null); } catch (error) { /* ignore */ } slotOwner = null; }
      listeners = [];
    }

    return {
      getSettings: getSettings, saveSettings: saveSettings, isEnabled: isEnabled, setChatEnabled: setChatEnabled, getStatus: getStatus,
      activate: activate, pause: pause, resume: resume, submitFeedback: submitFeedback, discardDraft: discardDraft, stop: stop,
      patrolNow: function (note) { return patrol({ manual: true, note: note }); },
      restructureNow: function (reason) { return restructure({ reason: reason, manual: true }); },
      undoRestructure: undoRestructure, finish: finish, continueVolume: continueVolume, restoreLastArchive: restoreLastArchive, discardVolume: discardVolume,
      getOutline: getOutline, saveOutline: saveOutline, getBrief: getBrief, saveBrief: saveBrief, listSnapshots: listSnapshots, rollbackTo: rollbackTo,
      getArchive: getArchive, getPreferences: getPreferences, savePreferences: savePreferences, getSkill: getSkill, saveSkill: saveSkill, resetSkill: resetSkill,
      listPendingEntries: async function () { var target = await ensureSession(); return target.active ? modules.clone(target.active.pendingEntries) : []; },
      confirmPendingEntry: function (id) { return confirmPendingEntry(id, { auto: false }); },
      discardPendingEntry: discardPendingEntry, listVolumeEntries: listVolumeEntries, listTemplates: wb.listTemplates,
      /* 给正文提示词模块与测试用：此刻该不该注入、这一次生成注入什么。 */
      injectable: injectable, briefFor: provideBrief, ready: ensureSession,
      onChange: function (listener) {
        listeners.push(listener);
        return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
      },
      dispose: dispose
    };
  }

  modules.createDirector = createDirector;
})(typeof globalThis !== 'undefined' ? globalThis : window);
