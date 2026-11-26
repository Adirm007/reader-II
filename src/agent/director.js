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
   *
   * 方法论是两份物理独立的 Skill（名字见 director-core.js 的 SKILL_NAMES）：总导演读 planner 那一份，场记读 patrol 那一份。
   * 各自先看工作区 ws:/skills/<名>/SKILL.md（用户改过的），没有才用随包内置的；各有各的缓存，改一份不动另一份。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SETTINGS_NAMESPACE = 'reader_ii';
  var SETTINGS_LOCAL_KEY = 'reader_ii_director_settings_v1';
  var CHAT_SWITCH_KEY = 'reader_ii_director';
  var CHAT_REF_KEY = 'reader_ii_director_ref';
  var ROOT = 'ws:/director';
  var ACTIVE_STATES = ['running', 'restructuring', 'pending_finish'];
  var DEBOUNCE_MS = 1500;          /* 收楼之后等这么久再巡检：别的扩展补写变量、群聊里下一位角色接着回复，都在这段时间里 */
  var FAIL_LIMIT = 3;              /* 巡检连续失败这么多次就自动暂停 */
  var MAX_SELF_REVISIONS = 2;      /* 自动质检/自查未通过时，同一会话内最多自动打回重写次数 */
  /*
   * 总导演这个只读 Agent 此刻在做什么（编纲与重构共用）。它是一个会话里自己决定查什么、写什么，
   * 没有固定的步数，所以界面上只有「当前动作 + 指标」，任务牌也不带步数（steps: 0，浮窗显示循环脉冲条）。
   */
  var ACTIVITIES = ['mapping', 'exploring', 'revising', 'checking', 'committing'];
  var ACTIVITY_LABEL = {
    plan: { mapping: '建图中', exploring: '自主查阅与编纲中', revising: '自检重写中', checking: '质检中', committing: '定稿落盘中' },
    restructure: { mapping: '整理既成事实中', exploring: '自主查阅与重写中', revising: '自检重写中', checking: '质检中', committing: '重构落盘中' }
  };
  var IDLE_LABEL = { paused: '已暂停', interrupted: '已中断', failed: '出错待续' };
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
   * deps: { vfs, registry, skills, connectors, permissions, journal, jobs, agent, prompt(), openTab(tab), debounceMs }
   * prompt() 返回正文提示词模块（reader-prompt.js 的运行时）；读者核心没加载时是 null，导演仍可编纲与巡检，只是没有地方注入。
   */
  function createDirector(env, kit, llm, deps) {
    var core = modules.directorCore, kernel = modules.agentKernel, protocol = modules.agentProtocol;
    var host = env.host || root;
    var log = env.console || console;
    var vfs = deps.vfs, registry = deps.registry, skills = deps.skills, connectors = deps.connectors, jobs = deps.jobs;
    var wb = modules.createDirectorWorldbook(env, kit, llm, { vfs: vfs, permissions: deps.permissions, journal: deps.journal });
    var debounceMs = deps.debounceMs >= 0 ? deps.debounceMs : DEBOUNCE_MS;

    var listeners = [], subscriptions = [], disposed = false;
    var session = makeSession(null);
    var work = null;               /* 正在干的活：{ kind, key, controller, job, reason } */
    var generatingAt = 0;          /* 酒馆正在生成（任何类型）的起始时间；0 = 没在生成 */
    var patrolTimer = null;
    var slotOwner = null;          /* 已经登记过槽位的那个提示词模块 */
    var skillCache = Object.create(null);   /* 角色（planner / patrol）→ { text, source }；两份各记各的 */
    var skillStamp = Object.create(null);   /* 角色 → 这一份被作废过几次（读的途中又被改了，就不把旧的记进缓存） */
    var viewCache = null;
    var unwatch = null;
    var unwatchAgent = null;
    /* 总导演独立的原生工具退避缓存（按 连接缓存键|模型 记）；不碰主助手的状态。 */
    var directorTextOnly = Object.create(null);

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
        active: null, snaps: core.emptySnapshots(), draft: null, rsDraft: null, hasArchive: false, canRestore: false,
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
      var feedback = (Array.isArray(raw.feedback) ? raw.feedback : []).filter(modules.isObject).map(function (item) {
        return { at: Number(item.at) || Date.now(), text: str(item.text).trim() };
      }).filter(function (item) { return item.text; });
      var proto = ['native', 'text'].indexOf(raw.protocol) >= 0 ? raw.protocol : '';
      return {
        v: 2, epoch: str(raw.epoch) || randomId('ep'), mode: 'auto',
        state: ['running', 'paused', 'interrupted', 'failed'].indexOf(raw.state) >= 0 ? raw.state : 'interrupted',
        activity: ACTIVITIES.indexOf(raw.activity) >= 0 ? raw.activity : 'mapping',
        materials: str(raw.materials),
        protocol: proto,
        protocolKey: str(raw.protocolKey),
        protocolFallback: raw.protocolFallback === true,
        messages: Array.isArray(raw.messages) ? normalizeConversationMessages(raw.messages, proto || 'native') : [],
        rounds: Math.max(0, Math.trunc(Number(raw.rounds) || 0)),
        stepRounds: Math.max(0, Math.trunc(Number(raw.stepRounds) || 0)),
        toolCalls: Math.max(0, Math.trunc(Number(raw.toolCalls) || 0)),
        revisions: Math.max(0, Math.trunc(Number(raw.revisions) || 0)),
        feedback: feedback,
        lastOutput: str(raw.lastOutput),
        canForceCommit: raw.canForceCommit === true,
        softPending: raw.softPending === true,
        workspace: core.normalizeWorkspace(raw.workspace, 'plan'),
        partialOutput: normalizePartial(raw.partialOutput),
        draftOps: Math.max(0, Math.trunc(Number(raw.draftOps) || 0)),
        error: str(raw.error),
        startedAt: Number(raw.startedAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now()
      };
    }

    /* 断流时已经吐出、还没并进工作台的半稿（下次续跑开头先抢救进工作台）。 */
    function normalizePartial(raw) {
      if (!modules.isObject(raw) || !str(raw.text).trim()) return null;
      return { text: str(raw.text).slice(0, 120000), reason: str(raw.reason).slice(0, 200), at: Number(raw.at) || Date.now() };
    }

    function normalizeRestructureDraft(raw) {
      if (!modules.isObject(raw) || !str(raw.volumeId)) return null;
      var proto = ['native', 'text'].indexOf(raw.protocol) >= 0 ? raw.protocol : '';
      var feedback = (Array.isArray(raw.feedback) ? raw.feedback : []).filter(modules.isObject).map(function (item) {
        return { at: Number(item.at) || Date.now(), text: str(item.text).trim() };
      }).filter(function (item) { return item.text; });
      return {
        v: 2, epoch: str(raw.epoch) || randomId('rep'),
        volumeId: str(raw.volumeId).slice(0, 80),
        baseVersion: Math.max(1, Math.trunc(Number(raw.baseVersion) || 1)),
        anchorFloor: Number.isFinite(Number(raw.anchorFloor)) ? Math.trunc(Number(raw.anchorFloor)) : -1,
        anchorHash: str(raw.anchorHash),
        reason: str(raw.reason),
        manual: raw.manual !== false,
        state: ['running', 'paused', 'interrupted', 'failed'].indexOf(raw.state) >= 0 ? raw.state : 'interrupted',
        activity: ACTIVITIES.indexOf(raw.activity) >= 0 ? raw.activity : 'exploring',
        protocol: proto,
        protocolKey: str(raw.protocolKey),
        protocolFallback: raw.protocolFallback === true,
        messages: Array.isArray(raw.messages) ? normalizeConversationMessages(raw.messages, proto || 'native') : [],
        rounds: Math.max(0, Math.trunc(Number(raw.rounds) || 0)),
        stepRounds: Math.max(0, Math.trunc(Number(raw.stepRounds) || 0)),
        toolCalls: Math.max(0, Math.trunc(Number(raw.toolCalls) || 0)),
        revisions: Math.max(0, Math.trunc(Number(raw.revisions) || 0)),
        feedback: feedback,
        lastOutput: str(raw.lastOutput),
        canForceCommit: raw.canForceCommit === true,
        softPending: raw.softPending === true,
        workspace: core.normalizeWorkspace(raw.workspace, 'restructure'),
        partialOutput: normalizePartial(raw.partialOutput),
        draftOps: Math.max(0, Math.trunc(Number(raw.draftOps) || 0)),
        error: str(raw.error),
        startedAt: Number(raw.startedAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now()
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
      target.rsDraft = normalizeRestructureDraft(await readJson(target.dir + '/restructure-draft.json'));
      if (target.rsDraft && (!volumeActive(target) || target.rsDraft.volumeId !== target.active.volumeId)) {
        target.rsDraft = null;
        removeFile(target.dir + '/restructure-draft.json').catch(noop);
      } else if (target.rsDraft && target.rsDraft.state === 'running') {
        target.rsDraft.state = 'interrupted';
      }
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

    function saveDraft(target, draft, epoch) {
      if (!target || !draft || target.draft !== draft) return Promise.resolve(false);
      if (epoch && draft.epoch !== epoch) return Promise.resolve(false);
      draft.updatedAt = Date.now();
      return writeJson(target.dir + '/draft.json', draft).then(function () { return true; });
    }

    function saveRsDraft(target, rsDraft, epoch) {
      if (!target || !rsDraft || target.rsDraft !== rsDraft) return Promise.resolve(false);
      if (epoch && rsDraft.epoch !== epoch) return Promise.resolve(false);
      rsDraft.updatedAt = Date.now();
      return writeJson(target.dir + '/restructure-draft.json', rsDraft).then(function () { return true; });
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

    function skillName(role) {
      if (core.SKILL_ROLES.indexOf(role) < 0) throw new Error('没有这一份导演 Skill：' + str(role) + '（只有 planner 总导演、patrol 场记两份）');
      return core.SKILL_NAMES[role];
    }
    function skillPath(role) { return 'ws:/skills/' + skillName(role) + '/SKILL.md'; }

    /*
     * 某个角色此刻生效的 Skill 原文：工作区里有就用工作区的（用户改过的），否则用内置的。
     * 两份各读各的、各记各的缓存；工作区那份被改动时只作废它自己的。读到什么就用什么——
     * 用户把其中一份改得面目全非，也不会去拿另一份或内置正文来补。
     */
    async function skillText(role) {
      var name = skillName(role);
      if (skillCache[role]) return skillCache[role];
      var stamp = skillStamp[role] || 0;
      var result = null;
      var user = await readText(skillPath(role));
      if (typeof user === 'string' && user.trim()) result = { text: user, source: 'user' };
      else {
        var builtin = '';
        try { builtin = skills && typeof skills.builtinText === 'function' ? await skills.builtinText(name) : ''; } catch (error) { builtin = ''; }
        if (!builtin && typeof modules.inlineBuiltinSkill === 'function') builtin = modules.inlineBuiltinSkill(name);
        if (!str(builtin).trim()) throw new Error('读不到' + core.SKILL_LABELS[role] + '的正文：内置的没有随包带上，工作区里也没有。');
        result = { text: builtin, source: 'builtin' };
      }
      /* 读的途中这一份又被改了：这次读到的照样返回，但不记进缓存，下一次重新读。 */
      if ((skillStamp[role] || 0) === stamp) skillCache[role] = result;
      return result;
    }

    /* 作废某一份的缓存（只动这一份）。 */
    function dropSkill(role) {
      skillCache[role] = null;
      skillStamp[role] = (skillStamp[role] || 0) + 1;
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

    async function collectWorldbooks(signal) {
      await kit.prepareWorldbooks();
      var scopes = kit.worldbookScopes();
      var ordered = [];
      var tags = Object.create(null);
      function mark(name, tag) {
        if (!name) return;
        if (ordered.indexOf(name) < 0) ordered.push(name);
        tags[name] = tags[name] || [];
        if (tags[name].indexOf(tag) < 0) tags[name].push(tag);
      }
      mark(scopes.chat, '当前聊天');
      mark(scopes.character_primary, '角色主书');
      (scopes.character_additional || []).forEach(function (name) { mark(name, '角色附书'); });
      (scopes.global || []).forEach(function (name) { mark(name, '全局启用'); });
      var list = [];
      for (var index = 0; index < ordered.length; index += 1) {
        if (signal && signal.aborted) break;
        var bookName = ordered[index];
        var entries = null;
        try { entries = await kit.readWorldbook(bookName, { optional: true }); } catch (error) { entries = null; }
        if (Array.isArray(entries) && entries.length) {
          list.push({ name: bookName, tag: '[' + tags[bookName].join(' / ') + ']', entries: entries });
        }
      }
      return list;
    }

    async function worldbookDigest(signal, budget) {
      var list = await collectWorldbooks(signal);
      if (!list.length) return '';
      return core.formatWorldbookCatalog(list, budget).text;
    }

    async function variableDigest() {
      var specs = [
        { path: 'var:/mvu.json', label: 'MVU / 最新楼层变量' },
        { path: 'var:/chat.json', label: '聊天变量（含小白X等）' },
        { path: 'var:/character.json', label: '角色卡变量' },
        { path: 'var:/global.json', label: '全局变量' }
      ];
      var sources = [];
      for (var index = 0; index < specs.length; index += 1) {
        var data = await readJson(specs[index].path);
        if (data && Object.keys(data).length) sources.push({ path: specs[index].path, label: specs[index].label, data: data });
      }
      return core.indexVariableSources(sources);
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
     * 自动勘察：主角与角色卡、已完结各卷、插件剧情摘要、全类型变量全景探测索引、
     * 当前生效世界书全量轻索引目录地图、近期正文楼层（附总楼层数提示）。
     * 目录地图与变量索引优先完整保全，绝不截丢绿灯角色条目；正文等其余段按预算弹性分配。
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
      if (job) job.log('扫描生效世界书全量目录与全部变量源');
      var bookSpecs = [], books = '', variables = '', archive = '';
      try {
        bookSpecs = await collectWorldbooks(signal);
        books = bookSpecs.length ? core.formatWorldbookCatalog(bookSpecs).text : '';
      } catch (error) { bookSpecs = []; books = ''; }
      try { variables = await variableDigest(); } catch (error) { variables = ''; }
      try { archive = await archiveDigest(target); } catch (error) { archive = ''; }
      var recentList = view.recent(view.lastVisible(), 80, -1);
      var floors = recentList.map(function (item) {
        return '[#' + item.floor + ' ' + (item.role === 'user' ? '用户 · ' + names.user : item.name || '角色') + ']\n' + core.clipMiddle(item.text, 2400);
      }).join('\n\n');
      var floorNote = '全聊天共 ' + view.length + ' 楼（可见 ' + view.visible.length + ' 楼）；# 后面是楼层号，越靠后越新；需追溯更早楼层伏笔时可用 grep / read 查阅 chat:/';
      return core.composeMaterials([
        { key: 'persona', title: '主角', text: '实名：' + names.user + (persona ? '\n' + persona : '\n（没有填写人设）'), weight: 8, preserve: true },
        { key: 'cards', title: '角色卡', text: cards, weight: 14 },
        { key: 'archive', title: '已完结各卷的档案与跨卷钩子', text: archive, weight: 7 },
        { key: 'plot', title: '剧情摘要（来自已对接的插件）', text: plot, weight: 12 },
        { key: 'variables', title: '变量全景探测索引（非空变量源与读取路径）', text: variables, weight: 10, preserve: true },
        {
          key: 'books', title: '当前生效世界书目录地图（常驻在前，含启用条目）', text: books, weight: 24, preserve: true,
          render: function (cap) { return core.formatWorldbookCatalog(bookSpecs, cap).text; }
        },
        { key: 'floors', title: '近期正文（' + floorNote + '）', text: floors || '（聊天里还没有正文）', weight: 40, tail: true }
      ], budget);
    }

    /* ---------- 总导演只读 VFS Agent（显式白名单沙箱 + 自适应协议工具循环） ---------- */

    var ALLOWED_MOUNTS = { wb: true, var: true, chat: true, card: true, cards: true, mem: true, kb: true, ws: true };
    var ALLOWED_SCOPES = { tavern: true, workspace: true, chat: true, card: true, worldbook: true, memory: true };
    var BLOCKED_TOOLSETS = /^(?:core|web|device|tavern|reader|memory|mcp(?:\/|$))/;
    var ALLOWED_MEMORY_TOOLS = { memory_search: true, memory_list: true };
    var PARALLEL_READS = 4;

    function isSafeMount(mount) {
      if (!mount || !mount.id || !ALLOWED_MOUNTS[mount.id]) return false;
      try {
        var sc = typeof mount.scope === 'function' ? mount.scope([], 'read') : mount.scope;
        if (sc && !ALLOWED_SCOPES[sc]) return false;
      } catch (error) { return false; }
      return true;
    }

    function safeMounts() {
      return typeof vfs.mounts === 'function' ? vfs.mounts().filter(isSafeMount).map(function (item) {
        return { id: item.id, title: item.title, hint: item.hint };
      }) : [];
    }

    function assertSafeVfsPath(rawPath) {
      var parsed = vfs.parse(rawPath);
      if (!ALLOWED_MOUNTS[parsed.mount]) {
        throw new Error('总导演只允许读取本地酒馆与工作区资料，禁止访问 ' + parsed.mount + ':/');
      }
      var sc = '';
      try { sc = vfs.scope(rawPath, 'read'); } catch (error) {
        throw new Error('无法核验目标路径权限范围，已默认拒绝访问：' + parsed.mount + ':/');
      }
      if (!ALLOWED_SCOPES[sc]) {
        throw new Error('总导演只允许读取本地酒馆与工作区资料，禁止访问该权限域路径：' + parsed.mount + ':/');
      }
      return parsed;
    }

    function formatLsResult(listing, offset) {
      var enc = modules.vfsEnc || function (s) { return String(s); };
      var lines = (listing.items || []).map(function (item) {
        var name = /:\/$/.test(item.name) ? item.name : enc(item.name) + (item.dir ? '/' : '');
        return name + (item.size !== undefined ? '  (' + item.size + ' 字)' : '') + (item.note ? '  — ' + item.note : '');
      });
      var shown = offset + (listing.items || []).length;
      var tail = listing.total > shown ? '\n…共 ' + listing.total + ' 项，已列 ' + (offset + 1) + '–' + shown + '。继续列用 offset=' + shown : '';
      return (lines.join('\n') || '（空）') + tail;
    }

    function directorTools() {
      var list = [];
      var seenNames = Object.create(null);
      function add(def) {
        /* draft_ 前缀留给总导演自己的草稿工作台：连接器里同名的工具一律不收，免得撞名。 */
        if (!def || !def.name || seenNames[def.name] || /^draft_/i.test(def.name)) return;
        seenNames[def.name] = true;
        list.push(def);
      }
      var regLs = registry && typeof registry.find === 'function' ? registry.find('ls') : null;
      var regRead = registry && typeof registry.find === 'function' ? registry.find('read') : null;
      var regGrep = registry && typeof registry.find === 'function' ? registry.find('grep') : null;

      add({
        name: 'ls', effect: 'read', parallel: true,
        scope: function (args) { try { return args && args.path ? vfs.scope(args.path, 'read') : 'workspace'; } catch (e) { return 'tavern'; } },
        summary: regLs ? regLs.summary : '列出一个路径下有什么。不带 path 时列出所有可读挂载点。',
        params: regLs ? regLs.params : [{ name: 'path', type: 'string', desc: '如 wb:/ 或 var:/ 或 chat:/' }, { name: 'offset', type: 'number', desc: '从第几项开始，默认 0' }, { name: 'limit', type: 'number', desc: '最多列几项，默认 100' }],
        run: async function (args, ctx) {
          var offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
          var limit = Math.max(1, Math.min(500, Math.trunc(Number(args.limit) || 100)));
          if (!str(args.path).trim()) {
            var mounts = safeMounts();
            var items = mounts.map(function (m) { return { name: m.id + ':/', dir: true, note: m.title + (m.hint ? '。' + m.hint : '') }; });
            return formatLsResult({ items: items.slice(offset, offset + limit), total: items.length }, offset);
          }
          assertSafeVfsPath(args.path);
          if (regLs && typeof regLs.run === 'function') return regLs.run(args, ctx);
          return formatLsResult(await vfs.list(args.path, { offset: offset, limit: limit }), offset);
        }
      });

      add({
        name: 'read', effect: 'read', parallel: true,
        scope: function (args) { try { return vfs.scope(args.path, 'read'); } catch (e) { return 'tavern'; } },
        summary: regRead ? regRead.summary : '读一个文件，返回带行号的内容。支持 JSON Pointer（如 var:/mvu.json#/stat_data、var:/chat.json#/键名）。长文件可分段读。',
        params: regRead ? regRead.params : [{ name: 'path', type: 'string', required: true }, { name: 'offset', type: 'number', desc: '起始行，默认 1' }, { name: 'limit', type: 'number', desc: '行数，默认 200' }, { name: 'column', type: 'number', desc: '起始行很长时，从该行第几个字符读起' }],
        run: async function (args, ctx) {
          assertSafeVfsPath(args.path);
          if (regRead && typeof regRead.run === 'function') return regRead.run(args, ctx);
          var out = await vfs.read(args.path, { offset: args.offset, limit: args.limit, column: args.column, cap: ctx && ctx.resultCap ? ctx.resultCap - 400 : 8000 });
          return out.text + (out.more ? '\n' + out.more : '');
        }
      });

      add({
        name: 'grep', effect: 'read', parallel: true,
        scope: function (args) { try { return vfs.scope(args.path, 'read'); } catch (e) { return 'tavern'; } },
        summary: regGrep ? regGrep.summary : '在一个文件或整个目录里按正则检索，返回「路径:行号: 内容」。跨世界书、历史楼层、角色卡检索细节与旧伏笔。',
        params: regGrep ? regGrep.params : [{ name: 'pattern', type: 'string', required: true, desc: '正则表达式' }, { name: 'path', type: 'string', required: true, desc: '文件或目录，如 wb:/ 、chat:/ 、card:/ 、var:/' },
          { name: 'flags', type: 'string', desc: '默认 i（忽略大小写）' }, { name: 'context', type: 'number', desc: '每处命中带几行上下文，0–5' }, { name: 'limit', type: 'number', desc: '最多返回几处，默认 40' }],
        run: async function (args, ctx) {
          assertSafeVfsPath(args.path);
          /*
           * 直接调 vfs.grep（与注册表的 grep 格式相同），不转交注册表：检索被中断时返回结构化的 { ok: false }，
           * 由 execTool 按失败处理（不进 seen、不计数），不靠在正文里找提示句来判断。
           */
          var out = await vfs.grep(args.path, args.pattern, { flags: args.flags, context: args.context, limit: args.limit, signal: ctx && ctx.signal });
          if (out.aborted) {
            return { ok: false, error: '检索被中断，结果不完整（仅扫描 ' + out.scanned + '/' + (out.totalFiles || out.scanned) + ' 个文件，已发现 ' + out.total + ' 处命中）', partial: out.hits.slice(0, 20) };
          }
          if (!out.total) return '没有命中（检索了 ' + out.scanned + ' 个文件）。';
          return out.hits.join('\n') + '\n— 共 ' + out.total + ' 处命中，分布在 ' + out.files + ' 个文件' + (out.total > out.hits.length ? '；只列出前 ' + out.hits.length + ' 处，可缩小 path 或换更具体的 pattern' : '');
        }
      });

      /* 可选只读记忆检索工具（仅允许静态 effect === 'read' 的白名单检索工具）。 */
      if (registry && typeof registry.find === 'function') {
        Object.keys(ALLOWED_MEMORY_TOOLS).forEach(function (name) {
          var def = registry.find(name);
          if (def && def.effect === 'read' && def.irreversible !== true && typeof def.run === 'function') add(def);
        });
      }

      /* 可选已启用内置插件连接器的纯只读查询工具（显式排除用户自定义/外部声明式连接器、写/删/联网/执行/试算工具）。 */
      if (registry && typeof registry.tools === 'function' && connectors) {
        var activeSets = Object.create(null);
        if (typeof connectors.list === 'function') {
          connectors.list().forEach(function (item) {
            if (item && item.id && item.origin === 'builtin' && item.present && item.enabled && !BLOCKED_TOOLSETS.test(item.id)) {
              activeSets[item.id] = true;
            }
          });
        } else if (typeof connectors.active === 'function') {
          connectors.active().forEach(function (item) {
            if (item && item.id && !BLOCKED_TOOLSETS.test(item.id)) activeSets[item.id] = true;
          });
        }
        Object.keys(activeSets).forEach(function (setId) {
          registry.tools(setId).forEach(function (def) {
            if (!def || def.effect !== 'read' || def.irreversible === true || def.volatile === true || typeof def.run !== 'function') return;
            add(def);
          });
        });
      }
      return list;
    }

    /*
     * 总导演私有草稿工作台的四个工具（只在 runDirectorAgent 里绑定到当前这份草稿）。它们不碰任何 VFS 挂载点：
     * 不过权限判定、不进改动记录、不弹确认。draft_write / draft_edit 不可并行（同一批里按顺序执行），读与预检可以并行。
     */
    function draftToolSpecs() {
      /* 工具声明也是前缀缓存的一部分：编纲与重构用同一份，restructure_note.md 只在重构草稿里写得进去（由工作台按草稿类型拦）。 */
      var names = core.DRAFT_SLOTS.map(function (slot) { return slot.file + (slot.restructure ? '（仅结构重构）' : ''); }).join(' / ');
      return [
        { name: 'draft_read', effect: 'draft', parallel: true, draft: true,
          summary: '查看私有草稿工作台。不带 file：所有槽位的总览（字数、行数、大纲写到哪个板块与 Phase）；带 file：带行号的正文，长的用 offset / limit 分段读。',
          params: [{ name: 'file', type: 'string', desc: '槽位名：' + names }, { name: 'offset', type: 'number', desc: '起始行，默认 1' }, { name: 'limit', type: 'number', desc: '行数，默认 400' }] },
        { name: 'draft_write', effect: 'draft', parallel: false, draft: true,
          summary: '写入私有草稿工作台的一个槽位并立即存盘（只写这份草稿，不碰酒馆资产）。mode=replace 整份覆盖（默认）；mode=append 接在末尾，适合把大纲分几次写完。',
          params: [{ name: 'file', type: 'string', required: true, desc: '槽位名：' + names }, { name: 'content', type: 'string', required: true, desc: '要写入的正文（就是对应交付标签里的内容，不用写标签）' },
            { name: 'mode', type: 'string', desc: 'replace（默认）或 append' }] },
        { name: 'draft_edit', effect: 'draft', parallel: false, draft: true,
          summary: '精确替换草稿槽位里的一段原文并立即存盘。old 须与原文完全一致（不带行号）且唯一；多处相同时加 all=true；new 留空即删除这段。',
          params: [{ name: 'file', type: 'string', required: true, desc: '槽位名：' + names }, { name: 'old', type: 'string', required: true, desc: '要被替换的原文' },
            { name: 'new', type: 'string', desc: '替换成的内容；留空即删除' }, { name: 'all', type: 'boolean', desc: 'true 时替换所有出现处' }] },
        { name: 'draft_check', effect: 'draft', parallel: true, draft: true,
          summary: '对当前草稿跑一遍与最终交付相同的程序质检（大纲结构、Phase、索引 JSON、首轮简报、自检残留、半稿），返回硬伤与软问题清单。',
          params: [] }
      ];
    }

    function agentToolConfig() {
      var s = deps.agent && typeof deps.agent.getSettings === 'function' ? (deps.agent.getSettings() || {}) : {};
      var maxSteps = kernel.clampInt(s.maxSteps, 1, modules.AGENT_MAX_STEP_BUDGET || 1000, 32);
      var resultCap = kernel.clampInt(s.resultCap, 1000, 200000, 9000);
      var toolProtocol = ['auto', 'native', 'text'].indexOf(s.toolProtocol) >= 0 ? s.toolProtocol : 'auto';
      return { maxSteps: maxSteps, resultCap: resultCap, toolProtocol: toolProtocol };
    }

    /*
     * 选协议。want 是助手的「工具调用方式」（auto / native / text）；preferred* 是断点里记下的上一次实际用的协议。
     * - text：照办；
     * - 断点是「自动降级」留下的文本，而且仍是同一条通道与模型：沿用文本（用户手动选文本留下的断点不算，改回自动后重新走原生）；
     * - native：总导演的通道可能和助手主循环不同，原生走不通时改用文本协议并在日志里说明，不让整卷编纲直接失败。
     */
    function pickDirectorProtocol(want, preferred, preferredKey, preferredFallback) {
      var support = typeof llm.taskToolSupport === 'function' ? llm.taskToolSupport('director')
        : (typeof llm.toolSupport === 'function' && typeof llm.chatTools === 'function' ? llm.toolSupport('agent') : { native: false, via: '', key: 'director', reason: '当前网关不支持原生函数调用' });
      var key = support.key || ('director|' + (support.via || '') + '|' + (support.model || ''));
      var hasNativeCall = typeof llm.chatTaskTools === 'function' || typeof llm.chatTools === 'function';
      if (want === 'text') return { mode: 'text', via: '', key: key, reason: '设置为只用文本协议' };
      if (preferred === 'text' && preferredFallback === true && (!preferredKey || preferredKey === key)) {
        return { mode: 'text', via: '', key: key, reason: '沿用断点已自动切换的文本协议', fallback: true };
      }
      if (support.native && hasNativeCall && !directorTextOnly[key]) return { mode: 'native', via: support.via, key: key, reason: '' };
      var reason = directorTextOnly[key] ? '这条连接此前已确认不接受原生函数调用' : support.native ? '该接口不支持原生函数调用' : (support.reason || '当前通道不支持原生函数调用');
      if (want === 'native') {
        return { mode: 'text', via: '', key: key, reason: '助手设为只用原生函数调用，但总导演通道不支持（' + reason + '），已改用文本协议', fallback: true };
      }
      return { mode: 'text', via: '', key: key, reason: reason, fallback: true };
    }

    function flattenForText(messages) {
      var output = [];
      messages.forEach(function (msg) {
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          var blocks = msg.tool_calls.map(function (call) {
            var parsed = protocol.nativeArgs(call.function && call.function.arguments);
            return protocol.callBlock(call.function && call.function.name || '?', parsed.args || {});
          });
          output.push({ role: 'assistant', content: (msg.content ? msg.content + '\n' : '') + blocks.join('\n') });
        } else if (msg.role === 'tool') {
          var block = protocol.resultBlock(msg.toolName || 'tool', msg.toolStatus || 'ok', msg.content);
          var last = output[output.length - 1];
          if (last && last.role === 'user' && last.toolResult) last.content += '\n' + block;
          else output.push({ role: 'user', content: block, toolResult: true });
        } else if (msg.role === 'user') {
          var prev = output[output.length - 1];
          if (prev && prev.role === 'user') {
            prev.content = str(prev.content) + '\n\n---\n\n' + str(msg.content);
            if (msg.userNote) prev.userNote = true;
          } else {
            output.push(Object.assign({}, msg));
          }
        } else {
          output.push(Object.assign({}, msg));
        }
      });
      return output;
    }

    function plainMessages(messages) {
      return messages.map(function (msg) { return { role: msg.role === 'tool' ? 'user' : msg.role, content: str(msg.content) }; });
    }

    function cleanTraceMessage(msg) {
      var out = { role: msg.role, content: str(msg.content) };
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        out.tool_calls = modules.clone(msg.tool_calls);
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
      } else if (msg.role === 'tool') {
        out.tool_call_id = str(msg.tool_call_id);
        out.toolResult = true;
        if (msg.toolName) out.toolName = str(msg.toolName);
        if (msg.toolStatus) out.toolStatus = str(msg.toolStatus);
      } else if (msg.toolResult) {
        out.toolResult = true;
      }
      if (msg.userNote) out.userNote = true;
      if (msg.compressed) out.compressed = true;
      return out;
    }

    /*
     * 断点消息序列合法性清洗：
     * - 剔除 system（始终由 runDirectorAgent 按当前 Skill/偏好/协议动态组装在 [0]）。
     * - 丢弃任何未闭合的 assistant(tool_calls)（缺少全部对应 tool 回复）或孤立的 role: 'tool'。
     */
    function sanitizeCheckpointMessages(list) {
      var src = (Array.isArray(list) ? list : []).filter(function (item) {
        return modules.isObject(item) && ['user', 'assistant', 'tool'].indexOf(item.role) >= 0;
      });
      var out = [];
      for (var i = 0; i < src.length; i += 1) {
        var cur = src[i];
        if (cur.role === 'tool') continue; /* 孤立 tool 消息直接跳过 */
        if (cur.role === 'assistant' && Array.isArray(cur.tool_calls) && cur.tool_calls.length) {
          var needIds = cur.tool_calls.map(function (tc) { return str(tc && tc.id); }).filter(Boolean);
          var replies = [];
          var j = i + 1;
          while (j < src.length && src[j].role === 'tool') {
            replies.push(src[j]);
            j += 1;
          }
          var got = Object.create(null);
          replies.forEach(function (r) { if (r.tool_call_id) got[str(r.tool_call_id)] = true; });
          var complete = needIds.length > 0 && needIds.every(function (id) { return got[id]; });
          if (complete) {
            out.push(cleanTraceMessage(cur));
            replies.forEach(function (r) { out.push(cleanTraceMessage(r)); });
          }
          i = j - 1;
          continue;
        }
        out.push(cleanTraceMessage(cur));
      }
      return out;
    }

    /*
     * 统一消息序列规范化（加载断点、插话、发送请求前共用）：
     * - 去除孤立 tool 与未闭合 tool_calls；
     * - 合并因清理或异常产生的相邻 user 消息及相邻普通 assistant 消息；
     * - 保证普通 assistant 消息非空；
     * - 文本模式下自动扁平化并消除 tool → user 相邻冲突。
     */
    function normalizeConversationMessages(list, mode) {
      var cleaned = sanitizeCheckpointMessages(list);
      if (mode === 'text') cleaned = flattenForText(cleaned);
      var merged = [];
      for (var i = 0; i < cleaned.length; i += 1) {
        var cur = cleanTraceMessage(cleaned[i]);
        var hasCalls = cur.role === 'assistant' && Array.isArray(cur.tool_calls) && cur.tool_calls.length > 0;
        if (cur.role === 'assistant' && !hasCalls && !cur.content.trim()) {
          cur.content = '（继续）';
        }
        var prev = merged[merged.length - 1];
        if (cur.role === 'user' && prev && prev.role === 'user') {
          prev.content = str(prev.content) + '\n\n---\n\n' + str(cur.content);
          if (cur.userNote) prev.userNote = true;
          if (!cur.toolResult) prev.toolResult = false;
          continue;
        }
        if (cur.role === 'assistant' && !hasCalls && prev && prev.role === 'assistant' && !(Array.isArray(prev.tool_calls) && prev.tool_calls.length)) {
          prev.content = str(prev.content) + '\n\n' + str(cur.content);
          continue;
        }
        merged.push(cur);
      }
      return merged;
    }

    /*
     * 向会话末尾安全追加用户消息（插话、自动质检打回或系统收尾提示）：
     * - 末尾已是 user 时合并，杜绝相邻两条 user；
     * - protect !== false 时标记 userNote，保护用户插话与打回反馈不被压缩截断。
     */
    function appendUserTurn(messages, text, protect) {
      var content = str(text).trim();
      if (!content) return messages;
      var keepNote = protect !== false;
      var last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        last.content = str(last.content) + '\n\n---\n\n' + content;
        if (keepNote) last.userNote = true;
      } else {
        var entryMsg = { role: 'user', content: content };
        if (keepNote) entryMsg.userNote = true;
        messages.push(entryMsg);
      }
      return messages;
    }

    /*
     * 原生调用写回历史前的清洗：参数不是合法 JSON 的调用（多半被长度截断）把 arguments 换成 "{}"。
     * 这条调用的结果本来就是「参数不合法，请重发」；把半截 JSON 原样发回上游，严格的接口会因此拒收整段历史，
     * 而那类 400 又容易被当成「不支持原生工具」触发降级。
     */
    function echoedCallMessage(message, calls) {
      var out = Object.assign({}, message);
      if (!Array.isArray(out.tool_calls)) return out;
      var bad = Object.create(null);
      (calls || []).forEach(function (call) { if (call && call.malformed && call.id) bad[call.id] = true; });
      out.tool_calls = out.tool_calls.map(function (tc) {
        if (!tc || !bad[tc.id] || !modules.isObject(tc.function)) return tc;
        return Object.assign({}, tc, { function: Object.assign({}, tc.function, { arguments: '{}' }) });
      });
      return out;
    }

    function estimateDirectorRequest(messages, tools, mode, sizer) {
      var toolSize = mode === 'native' && protocol ? sizer.tools(tools, protocol.toolSchema) : 0;
      return sizer.messages(messages, toolSize ? toolSize + 16 : 8);
    }

    /*
     * 上下文超限滞回压缩：
     * - 正常未超窗时一字不动以吃满前缀缓存；
     * - 超窗时一次性压缩到 70% 目标预算（滞回），避免随后每轮都改写中段破坏前缀缓存；
     * - 优先折叠已被打回重写的历史整稿（最大头），其次截短较早工具结果并标记 compressed: true（绝不截断 userNote），
     *   仍超目标时整组折叠最早工具批次（绝不留孤立 tool，绝不制造相邻 user）。
     */
    function fitDirectorContext(messages, tools, mode, windowSize, maxTokens, sizer, job) {
      var win = Math.max(4096, Number(windowSize) || 32768);
      var outCap = Math.min(maxTokens, Math.max(512, Math.floor(win / 3)));
      var reserve = Math.max(128, Math.ceil(win * 0.04));
      var inputBudget = Math.max(1024, win - outCap - reserve);
      if (estimateDirectorRequest(messages, tools, mode, sizer) <= inputBudget) return { messages: messages, maxTokens: outCap, changed: false };

      var baseUsed = estimateDirectorRequest(messages.slice(0, 2), tools, mode, sizer);
      var targetBudget = Math.min(inputBudget, Math.max(baseUsed + 1024, Math.floor(inputBudget * 0.7)));
      var next = messages.map(function (item) { return Object.assign({}, item); });
      var changed = false;

      /* 1. 优先折叠已被打回重写的旧草稿（后面紧跟「自动质检打回」提示，且非最后两条消息）。 */
      var foldedDrafts = 0;
      for (var d = 2; d < next.length - 2; d += 1) {
        var m = next[d], afterM = next[d + 1];
        if (m.role === 'assistant' && !(Array.isArray(m.tool_calls) && m.tool_calls.length) && !m.compressed
          && str(m.content).length > 800 && afterM && afterM.role === 'user' && str(afterM.content).indexOf('自动质检打回') >= 0) {
          m.content = '（此前提交的一版草稿因质检未通过已被打回重写，具体问题见下方打回清单；本轮请直接基于最新要求输出完整合规稿件。）';
          m.compressed = true;
          foldedDrafts += 1;
          changed = true;
          if (estimateDirectorRequest(next, tools, mode, sizer) <= targetBudget) break;
        }
      }
      if (foldedDrafts && job) job.log('上下文接近上限，已折叠 ' + foldedDrafts + ' 版被打回的旧草稿');
      if (estimateDirectorRequest(next, tools, mode, sizer) <= targetBudget) return { messages: next, maxTokens: outCap, changed: changed };

      /* 2. 截短倒数 4 条之前的较早工具结果，并显式打标 compressed: true 防止续传回填进 seen 缓存。 */
      var toolIndices = [];
      for (var i = 2; i < next.length; i += 1) {
        if ((next[i].role === 'tool' || next[i].toolResult) && !next[i].userNote) toolIndices.push(i);
      }
      var keepTail = Math.max(0, toolIndices.length - 4);
      var trimmed = false;
      for (var k = 0; k < keepTail; k += 1) {
        var idx = toolIndices[k];
        if (!next[idx].compressed && str(next[idx].content).length > 420) {
          next[idx].content = str(next[idx].content).slice(0, 320) + '\n…（较早的查阅结果已压缩以节省上下文，必要时可再次 read 获取全文）';
          next[idx].compressed = true;
          trimmed = true;
          changed = true;
          if (estimateDirectorRequest(next, tools, mode, sizer) <= targetBudget) break;
        }
      }
      if (trimmed && job) job.log('上下文接近窗口上限，已压缩较早的查阅结果');
      if (estimateDirectorRequest(next, tools, mode, sizer) <= inputBudget) return { messages: next, maxTokens: outCap, changed: changed };

      /* 3. 仍超过硬上限 inputBudget 才破坏性整批折叠最老的工具交互（从第 2 条之后找，保住 System、初始目录地图与 userNote）。 */
      var collapsed = false;
      for (var guard = 0; guard < 32 && estimateDirectorRequest(next, tools, mode, sizer) > inputBudget; guard += 1) {
        var start = -1, end = -1, summary = '';
        for (var p = 2; p < next.length - 2; p += 1) {
          var cur = next[p];
          if (cur.role === 'assistant' && Array.isArray(cur.tool_calls) && cur.tool_calls.length) {
            var stop = p + 1;
            while (stop < next.length && next[stop].role === 'tool') stop += 1;
            if (stop < next.length) {
              start = p; end = stop;
              summary = cur.tool_calls.map(function (c) { return c.function && c.function.name || 'tool'; }).join('、');
              break;
            }
          } else if (cur.role === 'assistant' && next[p + 1] && next[p + 1].role === 'user' && next[p + 1].toolResult && !next[p + 1].userNote) {
            if (p + 2 < next.length) {
              start = p; end = p + 2;
              summary = '文本只读工具查阅';
              break;
            }
          }
        }
        if (start < 0) break;
        var after = next[end];
        /* 折叠掉的那一轮里有写草稿的调用：说清楚工作台里的内容不受影响，免得模型以为写过的都没了。 */
        var label = /draft_/.test(summary) ? '（已折叠一轮较早的工具调用：' + summary + '；草稿工作台里的内容不受影响，需要时用 draft_read 查看）'
          : '（已折叠一轮较早的只读查阅：' + summary + '）';
        var replacement = after && after.role === 'user'
          ? [{ role: 'assistant', content: label, compressed: true }]
          : [
              { role: 'assistant', content: label, compressed: true },
              { role: 'user', content: '（请继续基于上下文已有资料推进当前编纲任务。）' }
            ];
        next.splice.apply(next, [start, end - start].concat(replacement));
        collapsed = true;
        changed = true;
      }
      if (collapsed && job) job.log('已折叠早期探索记录以适配模型上下文窗口');
      var finalUsed = estimateDirectorRequest(next, tools, mode, sizer);
      if (finalUsed > inputBudget) {
        var remaining = win - reserve - finalUsed;
        if (remaining >= 256) outCap = Math.min(outCap, remaining);
      }
      return { messages: next, maxTokens: outCap, changed: changed };
    }

    var CANT_READ_CLAIM = /(?:我|当前(?:对话|环境|模式|状态)?)(?:目前|现在|暂时)?(?:无法|不能|看不了|看不到|没有权限|没有工具|无权)(?:直接)?(?:查看|读取|访问|查阅|获取).{0,24}(?:世界书|变量|原文|历史|楼层|结构|工具)/;
    var SEQUENCE_ERROR_RE = /tool_use_id|tool_result|must be a response to a preceeding|preceding message|function call turn|turn order|expected.*role|alternate.*user.*assistant|missing.*tool_result|without.*tool_calls/i;
    var CONTEXT_OVERFLOW_RE = /context_(?:length|window)_exceeded|context (?:window|limit)|maximum context length|maximum number of tokens|too many tokens|prompt is too long|输入超过.{0,8}上下文/i;

    /*
     * 总导演 Agent 工具循环（单会话编纲、实时插话、自动自检打回、L2 结构重构共用）。
     * - 独立锁与独立历史：不占主助手锁，不写入夜梦私聊历史。
     * - 双级中止（任务级取消 vs 单请求插话打断）与 inbox 实时插话队列：插话仅打断在途模型请求，不截断本地工具。
     * - 酒馆与工作区资产严格只读白名单，零确认弹窗；另有一个只属于当前草稿的私有工作台（draft_* 四个工具）。
     * - 流式接收：等模型时任务牌实时写着「正在构思推演 / 正在撰写 / 正在写入草稿」与字数；断流时已经吐出的正文抢救进工作台接着写。
     * - 仅在明确 no_native_tools 时退回文本协议，并记录 protocolKey 便于换模型后恢复原生。
     * options.workspace: { kind: 'plan' | 'restructure', get(), set(ws) }    options.partial: { get(), set(p | null) }
     *   两者都只改内存里的草稿对象（set 带 epoch 守卫，草稿作废时抛 director_stale）；落盘交给 onCheckpoint。
     */
    async function runDirectorAgent(options) {
      var target = options.target;
      var entry = options.entry;
      var job = entry.job;
      var settings = options.settings;
      var cfg = agentToolConfig();
      var space = options.workspace && typeof options.workspace.get === 'function' && typeof options.workspace.set === 'function' ? options.workspace : null;
      var kind = space && space.kind === 'restructure' ? 'restructure' : 'plan';
      var pending = options.partial && typeof options.partial.get === 'function' && typeof options.partial.set === 'function' ? options.partial : null;
      var tools = directorTools().concat(space ? draftToolSpecs() : []);
      var toolsByName = Object.create(null);
      tools.forEach(function (def) { toolsByName[def.name] = def; });
      var toolNames = tools.map(function (def) { return def.name; });
      var mounts = safeMounts();
      var proto = pickDirectorProtocol(cfg.toolProtocol, options.preferredProtocol, options.preferredProtocolKey, options.preferredProtocolFallback);
      if (job && cfg.toolProtocol === 'native' && proto.mode === 'text' && proto.reason) job.log(proto.reason);
      var makeSystem = function (mode) {
        return core.buildPlannerSystem(options.skillText, options.preferences, options.userName, { toolMode: mode, tools: tools, mounts: mounts, draftKind: space ? kind : '' });
      };
      var bodyMsgs = normalizeConversationMessages(options.baseMessages.slice(1), proto.mode);
      var messages = [{ role: 'system', content: makeSystem(proto.mode) }].concat(bodyMsgs);
      var sizer = kernel.createSizer();
      var windowSize = Number(options.modelWindow) > 0 ? Number(options.modelWindow) : 32768;
      var rounds = Math.max(0, Math.trunc(Number(options.initialRounds) || 0));
      var stepRounds = Math.max(0, Math.trunc(Number(options.initialStepRounds) || 0));
      var toolCount = Math.max(0, Math.trunc(Number(options.initialToolCalls) || 0));
      var draftOps = Math.max(0, Math.trunc(Number(options.initialDraftOps) || 0));
      var localRounds = 0, forced = '', finalTries = 0, nudged = false, retryWindow = 0, seqRetried = false;
      /* 工具轮数用完时，工作台里已经有稿子：再给几轮只限 draft_* 的收尾（grace 是剩下的轮数；null = 还没进收尾）。 */
      var GRACE_ROUNDS = Math.min(6, Math.max(3, Math.ceil(cfg.maxSteps / 4)));
      var grace = null;
      /* 断流抢救之后自动接着写，一次会话最多一次；再断就停下来留着断点。 */
      var autoContinues = 0;
      var lastCheck = null;
      var seen = Object.create(null);
      var lastIdleBatch = '', idleRepeats = 0, idleStreak = 0;
      var streamSerial = 0, streamEmitAt = 0;

      function ws() { return space ? space.get() : null; }
      function hasDraft() { return !!space && core.workspaceHasContent(ws()); }
      function hasOutline() { return !!space && !!core.workspaceOutline(ws()).trim(); }
      /* 草稿改过之后，之前 draft_read 的结果都过期了：不能再让模型「复用已读」。 */
      function forgetDraftReads() {
        Object.keys(seen).forEach(function (key) { if (key.indexOf('draft_read:') === 0) delete seen[key]; });
        lastCheck = null;
      }

      function rebuildSeenFromMessages() {
        seen = Object.create(null);
        for (var si = 1; si < messages.length; si += 1) {
          var sm = messages[si];
          if (sm.role === 'assistant' && Array.isArray(sm.tool_calls)) {
            var byId = Object.create(null);
            sm.tool_calls.forEach(function (tc) {
              var n = tc && tc.function && str(tc.function.name).trim();
              var def = n && toolsByName[n];
              /* 草稿工具的旧结果不从历史里回填：草稿之后可能又改过，续传后让模型重新 draft_read。 */
              if (!def || def.draft) return;
              var parsedArg = protocol.nativeArgs(tc.function.arguments);
              if (parsedArg.error) return;
              var coercedArg = protocol.coerce(def, parsedArg.args || {});
              if (!coercedArg.error) byId[tc.id] = def.name + ':' + JSON.stringify(coercedArg.args);
            });
            for (var sj = si + 1; sj < messages.length && messages[sj].role === 'tool'; sj += 1) {
              var tm = messages[sj];
              var sig = byId[tm.tool_call_id];
              /* 被压缩过的旧工具结果绝不回填进 seen，确保模型按提示重新 read 时能拿到全文。 */
              if (sig && !tm.compressed && tm.toolStatus !== 'error' && tm.toolStatus !== 'denied') {
                seen[sig] = { content: str(tm.content), inContext: true };
              }
            }
          }
        }
      }
      rebuildSeenFromMessages();

      function snapshotMessages() {
        return messages.slice(1).map(cleanTraceMessage);
      }

      /* 把会话落成断点（草稿工作台与半稿都在草稿对象上，一起写进去）。它「此刻在做什么」由调用方（编纲 / 重构）自己记。 */
      async function checkpoint() {
        if (typeof options.onCheckpoint !== 'function') return;
        await options.onCheckpoint({
          messages: snapshotMessages(),
          protocol: proto.mode,
          protocolKey: proto.key,
          protocolFallback: proto.fallback === true,
          rounds: rounds,
          stepRounds: stepRounds,
          toolCalls: toolCount,
          draftOps: draftOps
        });
      }

      function result(text) {
        return { text: str(text), protocol: proto.mode, protocolKey: proto.key, protocolFallback: proto.fallback === true, rounds: rounds, stepRounds: stepRounds,
          toolCalls: toolCount, draftOps: draftOps, messages: snapshotMessages() };
      }

      /*
       * 等模型回话时任务牌上写什么。它是自己决定「接着查」还是「开始写」的，所以平时只写调用方给的那句
       * （带已查项数）；工具被收走之后（空转拦截、轮数用尽）它只能动笔，这时才写「正在撰写与自检」。
       * 流式收到东西以后，换成实时的「正在构思推演（已思考 N 字）」这一类（streamLabel）。
       */
      function waitingStage() {
        if (forced) return '正在撰写与自检';
        if (grace !== null) return '工具轮数已用完，正在用草稿工作台收尾';
        return typeof options.stageOf === 'function' ? str(options.stageOf(toolCount)) : '自主查阅与撰稿';
      }

      function streamLabel(progress) {
        var fmt = core.formatCount;
        if (proto.mode === 'text' && progress.phase === 'text' && typeof progress.snapshot === 'function') {
          var text = str(progress.snapshot());
          var at = text.lastIndexOf('<action');
          if (at >= 0 && at > text.lastIndexOf('</action>')) {
            return /^<action\s+name\s*=\s*["']?draft_(?:write|edit)/i.test(text.slice(at, at + 80))
              ? '正在写入草稿（已接收 ' + fmt(text.length - at) + ' 字）' : '正在组织工具调用';
          }
        }
        if (progress.phase === 'tool') {
          return /^draft_(?:write|edit)$/.test(str(progress.toolName)) ? '正在写入草稿（已接收 ' + fmt(progress.toolChars) + ' 字）'
            : '正在组织工具调用' + (progress.toolName ? '（' + str(progress.toolName).slice(0, 40) + '）' : '');
        }
        if (progress.phase === 'thinking') return '正在构思推演（已思考 ' + fmt(progress.reasoningChars) + ' 字）';
        if (progress.phase === 'text') return '正在撰写（已输出 ' + fmt(progress.textChars) + ' 字）';
        return '';
      }

      /* 每次请求一个新的进度回调；请求结束（streamDone）之后晚到的进度一律不认。界面最多每 400 毫秒刷新一次。 */
      function streamWatcher() {
        var serial = ++streamSerial;
        return function (progress) {
          if (serial !== streamSerial || taskAborted(entry) || !progress) return;
          var label = streamLabel(progress);
          entry.stream = {
            phase: str(progress.phase), label: label, textChars: Number(progress.textChars) || 0, reasoningChars: Number(progress.reasoningChars) || 0,
            toolName: str(progress.toolName), toolChars: Number(progress.toolChars) || 0, bytes: Number(progress.bytes) || 0, at: Date.now()
          };
          var now = Date.now();
          if (now - streamEmitAt < 400) return;
          streamEmitAt = now;
          if (label) setStage(entry, label);
          emit('stream');
        };
      }
      function streamDone() {
        streamSerial += 1;
        if (entry.stream) { entry.stream = null; emit('stream'); }
      }

      async function drainInbox() {
        if (!entry.inbox || !entry.inbox.length) return false;
        var batch = entry.inbox.splice(0, entry.inbox.length);
        var texts = batch.map(function (item) { return str(item && item.text).trim(); }).filter(Boolean);
        if (!texts.length) return false;
        if (typeof options.onInbox === 'function') await options.onInbox(batch);
        var merged = texts.length === 1 ? texts[0] : texts.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
        appendUserTurn(messages, core.buildInterjectionMessage(merged, { workspace: hasDraft() }), true);
        forced = '';
        grace = null;
        idleRepeats = 0;
        lastIdleBatch = '';
        idleStreak = 0;
        localRounds = 0;
        nudged = false;
        if (stepRounds >= cfg.maxSteps) stepRounds = 0;
        if (job) job.log('收到用户实时插话：' + merged.replace(/\s+/g, ' ').slice(0, 80));
        await checkpoint();
        return true;
      }

      async function switchToText(reason, remember) {
        if (remember && proto.key) directorTextOnly[proto.key] = true;
        proto = { mode: 'text', via: '', key: proto.key, reason: reason, fallback: true };
        var norm = normalizeConversationMessages(messages.slice(1), 'text');
        messages = [{ role: 'system', content: makeSystem('text') }].concat(norm);
        if (job) job.log('模型接口不支持原生工具调用，已自动切换文本工具协议');
        await checkpoint();
      }

      /*
       * 断流抢救：流式回复中途断开（超时、断网、暂停、插话、切聊天）时，已经吐出的可见正文够长、而且不是断在工具调用里，
       * 就先记成草稿上的 partialOutput（同步，调用方的收尾会一起落盘）；absorbPartial 再把它拆进工作台、在会话里接上续写提示。
       * 文本协议下只认工具块之外的正文：断在 <action> 里的半截调用丢掉，不污染消息序列。
       */
      function salvageable(error) {
        if (!space || !pending || !error || error.hasToolCalls) return '';
        var text = str(error.partialText);
        if (!text.trim()) return '';
        if (proto.mode === 'text') {
          var parsed = protocol.parse(text.replace(/<(?:action_result|tool_result|tool_response)\b[\s\S]*$/i, ''));
          if (parsed.calls.length) return '';
          text = parsed.prose;
        }
        var min = modules.llmStream ? modules.llmStream.SALVAGE_MIN : 200;
        return text.trim().length >= min ? text : '';
      }
      function cutReason(error) {
        if (!error) return '';
        if (error.name === 'AbortError') return entry.inbox.length ? '被用户插话打断' : '被中止';
        if (error.code === 'provider_stop') return '输出达到长度上限';
        if (error.name === 'TimeoutError' || error.code === 'timeout') return '长时间没有收到新数据';
        return message(error).replace(/\s+/g, ' ').slice(0, 80);
      }
      function keepPartial(error) {
        var text = salvageable(error);
        if (text) pending.set({ text: text, reason: cutReason(error), at: Date.now() });
        return text;
      }
      async function absorbPartial() {
        var held = pending ? pending.get() : null;
        if (!held || !str(held.text).trim() || !space) return false;
        var salvaged = core.salvagePartial(space.get(), held.text, kind);
        space.set(salvaged.workspace);
        pending.set(null);
        forgetDraftReads();
        messages.push({ role: 'assistant', content: '（这条回复写到 ' + core.formatCount(str(held.text).length) + ' 字时传输中断，已收到的内容已由系统抢救进草稿工作台。）' });
        appendUserTurn(messages, core.buildSalvageNote(salvaged, held.reason, kind), true);
        if (job) {
          job.log('已把断流前收到的 ' + core.formatCount(str(held.text).length) + ' 字抢救进草稿工作台'
            + (salvaged.saved.length ? '：' + salvaged.saved.map(function (item) { return item.file + (item.partial ? '（半稿）' : ''); }).join('、') : ''));
        }
        await checkpoint();
        return true;
      }
      /* 断流后能不能自动接着写：超时、断网、上游 5xx、流里报错、写到长度上限。鉴权、风控、额度这类报错停下来。 */
      function continuable(error) {
        if (!error) return false;
        if (error.code === 'provider_stop') return /^(?:max_tokens|length)$/i.test(str(error.stopReason)) || /max_tokens|length/i.test(message(error));
        if (error.name === 'TimeoutError' || error.code === 'timeout' || error.code === 'stream_error') return true;
        return /\b(?:408|409|425|429|500|502|503|504|520|522|524|529|530)\b|timeout|timed out|超时|overloaded|temporarily|ECONNRESET|socket|network|网络|fetch failed|Failed to fetch|tunnel|中断/i.test(message(error));
      }

      async function askOnce(reqMessages, maxTokens, reqSignal) {
        var common = {
          kind: 'director', maxTokens: maxTokens, timeoutMs: settings.timeoutMs, signal: reqSignal, retries: 1, cacheMs: MODEL_CACHE_MS,
          generationId: options.generationId || 'reader-director-plan',
          /* 总导演一律流式：长思考、长输出期间连接不再 0 字节静默，timeoutMs 按空闲计；工作台有大纲时最后一句确认可以是空的。 */
          stream: true, onStream: streamWatcher(), allowEmpty: hasOutline()
        };
        try {
          if (proto.mode === 'native') {
            var reply = await llm.chatTaskTools(Object.assign({ messages: reqMessages, tools: tools.map(protocol.toolSchema), toolChoice: forced ? 'none' : 'auto' }, common));
            var calls = (reply.toolCalls || []).map(function (item) {
              var parsed = protocol.nativeArgs(item.arguments);
              return { id: item.id, name: item.name, args: parsed.args || {}, malformed: parsed.error || '' };
            });
            if (calls.length) return { style: 'native', text: str(reply.text), prose: str(reply.text).trim(), calls: calls, truncated: false, message: reply.message, reasoning: str(reply.reasoning) };
            var fallbackParsed = protocol.parse(str(reply.text));
            return { style: 'text', text: str(reply.text), prose: fallbackParsed.prose, calls: fallbackParsed.calls, truncated: fallbackParsed.truncated, reasoning: str(reply.reasoning) };
          }
          var raw = str(await llm.chatTask(Object.assign({ messages: plainMessages(reqMessages) }, common)));
          /* 文本协议下模型可能在工具块之后自己编出 <action_result>（文本补全通道尤其常见）：从那里截断，只认它自己发出的调用。 */
          var fake = raw.search(/<(?:action_result|tool_result|tool_response)\b/i);
          if (fake > 0) raw = raw.slice(0, fake).trimEnd();
          var parsedText = protocol.parse(raw);
          return { style: 'text', text: raw, prose: parsedText.prose, calls: parsedText.calls, truncated: parsedText.truncated, reasoning: '' };
        } finally {
          streamDone();
        }
      }

      function toolPermissionDenied(def, args) {
        if (!deps.permissions || typeof deps.permissions.evaluate !== 'function') return '';
        var sc = typeof modules.resolveToolField === 'function' ? modules.resolveToolField(def.scope, args, 'tavern') : (typeof def.scope === 'function' ? def.scope(args) : (def.scope || 'tavern'));
        var path = args && args.path ? str(args.path) : '';
        try { if (path) path = vfs.parse(path).canonical; } catch (error) { /* 原样 */ }
        var decision = deps.permissions.evaluate({ effect: 'read', scope: sc, path: path, tool: def.name });
        if (decision.decision === 'allow') return '';
        return decision.reason || '权限规则限制了该只读操作。';
      }

      /*
       * 草稿工具：只读写 space 指向的那份草稿，不过权限判定、不进改动记录。写入改了内容就立刻 checkpoint 存盘，
       * 并让之前的 draft_read 结果失效。没改动的写入、草稿没变时的重复预检算空转（reused）。
       */
      async function execDraftTool(def, rawArgs) {
        var coerced = protocol.coerce(def, rawArgs);
        if (coerced.error) return { name: def.name, args: rawArgs, status: 'error', body: coerced.error, ok: false, reused: false, draft: true, summary: coerced.error };
        var args = coerced.args;
        var label = core.describeToolCall(def.name, args);
        var signature = def.name === 'draft_read' ? def.name + ':' + JSON.stringify(args) : '';
        if (signature && seen[signature] && seen[signature].inContext) {
          if (job) job.log('✓ ' + label + '（复用已读）');
          return { name: def.name, args: args, signature: signature, status: 'ok', ok: true, reused: true, draft: true,
            body: '（你已查看过完全相同的 ' + label + '，之后草稿没有改动，完整结果仍在上方对话记录中。）', summary: '重复查看，草稿没有改动' };
        }
        setStage(entry, label, label);
        assertCurrent(target);
        if (taskAborted(entry)) throw staleError('已停止');
        var current = space.get();
        var out;
        if (def.name === 'draft_read') out = core.workspaceRead(current, kind, args);
        else if (def.name === 'draft_write') out = core.workspaceWrite(current, kind, args);
        else if (def.name === 'draft_edit') out = core.workspaceEdit(current, kind, args);
        else if (lastCheck && lastCheck.rev === (current && current.rev)) out = { ok: true, text: lastCheck.text, reused: true };
        else {
          var report = core.checkWorkspace(current, kind, { userName: options.userName });
          lastCheck = { rev: current && current.rev, text: report.text };
          out = { ok: true, text: report.text };
        }
        if (!out.ok) {
          if (job) job.log('× ' + label + '：' + str(out.error).slice(0, 120));
          return { name: def.name, args: args, status: 'error', body: str(out.error), ok: false, reused: false, draft: true, summary: str(out.error) };
        }
        var writes = def.name === 'draft_write' || def.name === 'draft_edit';
        if (writes && out.changed) {
          space.set(out.ws);
          draftOps += 1;
          forgetDraftReads();
          await checkpoint();
        }
        if (job) job.log((writes && !out.changed ? '· ' : '✓ ') + label + (writes && !out.changed ? '（没有改动）' : ''));
        return { name: def.name, args: args, signature: signature, status: 'ok', body: str(out.text), ok: true, draft: true, wrote: writes && out.changed === true,
          reused: writes ? out.changed !== true : out.reused === true, summary: str(out.text).replace(/\s+/g, ' ').slice(0, 120) };
      }

      async function execTool(call, taskSignal) {
        var name = str(call.name).trim();
        var rawArgs = modules.isObject(call.args) ? call.args : {};
        var def = call.malformed ? null : toolsByName[name];
        if (!def) {
          var reason = call.malformed || ('总导演只具备只读勘察工具与私有草稿工具（' + toolNames.join('、') + '），禁止调用「' + (name || '未知工具') + '」。');
          if (job && !call.malformed) job.log('× 已拦截未授权工具：' + name);
          return { name: name || '?', args: rawArgs, status: 'denied', body: reason, ok: false, reused: false, summary: reason };
        }
        if (def.draft) return execDraftTool(def, rawArgs);
        if (grace !== null) {
          var closing = '工具轮数已经用完，收尾阶段只执行 draft_read / draft_write / draft_edit / draft_check，查阅工具不再执行。请用已经查到的资料补齐草稿并交付。';
          if (job) job.log('× 收尾阶段不再查阅：' + core.describeToolCall(def.name, rawArgs));
          return { name: def.name, args: rawArgs, status: 'denied', body: closing, ok: false, reused: false, summary: closing };
        }
        var coerced = protocol.coerce(def, rawArgs);
        if (coerced.error) {
          return { name: def.name, args: rawArgs, status: 'error', body: coerced.error, ok: false, reused: false, summary: coerced.error };
        }
        var args = coerced.args;
        var label = core.describeToolCall(def.name, args);
        var permError = toolPermissionDenied(def, args);
        if (permError) {
          if (job) job.log('× ' + label + '：' + permError);
          return { name: def.name, args: args, status: 'denied', body: permError, ok: false, reused: false, summary: permError };
        }
        var signature = def.name + ':' + JSON.stringify(args);
        if (Object.prototype.hasOwnProperty.call(seen, signature) && seen[signature] && seen[signature].inContext) {
          if (job) job.log('✓ ' + label + '（复用已读）');
          return {
            name: def.name, args: args, signature: signature, status: 'ok',
            body: '（你已查阅过完全相同的 ' + label + '，完整结果仍在上方对话记录中，请直接复用，无需重复调用。）',
            ok: true, reused: true, summary: '重复调用，复用上下文已有结果'
          };
        }
        /* 任务牌上直接写正在查的那一项（「查阅世界书 wb:/…」），日志里再留一行。 */
        setStage(entry, label, label);
        if (job) job.log(label);
        try {
          /* 只读工具仅响应任务级中止，不被插话打断；且不在执行阶段提前写 seen/toolCount，待整批原子落入会话后再提交。 */
          var value = await def.run(args, { signal: taskSignal, resultCap: cfg.resultCap });
          assertCurrent(target);
          if (taskAborted(entry)) throw staleError('已停止');
          var body = protocol.serialize(value, cfg.resultCap);
          if (modules.isObject(value) && value.ok === false) {
            var note = str(value.error || value.reason || value.note || body).replace(/\s+/g, ' ').slice(0, 160);
            if (job) job.log('× ' + label + '：' + note);
            return { name: def.name, args: args, signature: signature, status: 'error', body: body, ok: false, reused: false, summary: note };
          }
          if (job) job.log('✓ ' + label + '（' + body.length + ' 字）');
          return { name: def.name, args: args, signature: signature, status: 'ok', body: body, ok: true, reused: false, summary: body.replace(/\s+/g, ' ').slice(0, 120) };
        } catch (error) {
          if (isAbort(error) || (taskSignal && taskSignal.aborted) || taskAborted(entry)) throw error;
          var errMsg = message(error).slice(0, 400);
          if (job) job.log('× ' + label + '：' + errMsg.slice(0, 120));
          return { name: def.name, args: args, signature: signature, status: 'error', body: errMsg, ok: false, reused: false, summary: errMsg };
        }
      }

      function canRunParallel(calls) {
        if (!Array.isArray(calls) || calls.length < 2) return false;
        var batchSeen = Object.create(null);
        for (var i = 0; i < calls.length; i += 1) {
          var c = calls[i];
          var def = c && !c.malformed ? toolsByName[str(c.name).trim()] : null;
          if (!def || def.parallel !== true) return false;
          var coerced = protocol.coerce(def, c.args || {});
          if (coerced.error) return false;
          var sig = def.name + ':' + JSON.stringify(coerced.args);
          if (batchSeen[sig]) return false;
          batchSeen[sig] = true;
        }
        return true;
      }

      for (;;) {
        assertCurrent(target);
        if (taskAborted(entry)) throw staleError('已停止');
        /* 上一次断流留下的半稿（续传开头、或这一轮被插话打断）：先抢救进工作台，接上续写提示。 */
        if (pending && pending.get()) await absorbPartial();
        await drainInbox();
        /* 发送前统一规范化消息序列，杜绝相邻同角色或残缺工具块触发 400。 */
        messages = [messages[0]].concat(normalizeConversationMessages(messages.slice(1), proto.mode));
        var fitted = fitDirectorContext(messages, tools, proto.mode, windowSize, settings.plannerMaxTokens, sizer, job);
        if (fitted.changed) {
          messages = fitted.messages;
          rebuildSeenFromMessages();
          /* 较早的记录（可能包括写草稿的那几轮）被折叠了：告诉它工作台里现在有什么，别从头重写。 */
          var compactNote = space ? core.buildWorkspaceNote(ws(), kind, 'compact') : '';
          if (compactNote) appendUserTurn(messages, compactNote, false);
        }
        setStage(entry, waitingStage(), '');
        var req = makeRequestSignal(entry);
        var turn;
        try {
          turn = await askOnce(messages, fitted.maxTokens, req.signal);
        } catch (error) {
          req.cleanup();
          var salvage = keepPartial(error);
          assertCurrent(target);
          /* 单请求被实时插话打断（任务本身未被取消）：留在同一会话消费 inbox 继续（已经写出的半稿先抢救进工作台）。 */
          if ((isAbort(error) || (req.signal && req.signal.aborted)) && !taskAborted(entry) && entry.inbox.length > 0) {
            continue;
          }
          if (isAbort(error) || taskAborted(entry) || (error && error.code === 'model_changed')) throw error;
          var detail = message(error);
          /* 流式断开，但已经写出了一大段：抢救进工作台，在同一会话里接着写（每次会话最多自动一次）。 */
          if (salvage && autoContinues < 1 && continuable(error)) {
            autoContinues += 1;
            if (job) job.log('传输中断（' + detail.replace(/\s+/g, ' ').slice(0, 80) + '），已收到 ' + core.formatCount(salvage.length) + ' 字，抢救进草稿工作台后接着写');
            continue;
          }
          if (error && error.code === 'provider_stop') {
            if (/max_tokens|length/i.test(detail)) {
              throw new Error('总导演本轮输出达到长度上限被截断（' + detail + '）' + (salvage ? '；已写出的 ' + core.formatCount(salvage.length) + ' 字已保存，沿断点继续会接着写' : '')
                + '。请到「导演 → 配置」把「编纲回复上限」调大后沿断点继续。');
            }
            throw error;
          }
          if (retryWindow < 3 && CONTEXT_OVERFLOW_RE.test(detail)) {
            retryWindow += 1;
            var reported = kernel.reportedWindow(detail);
            var est = estimateDirectorRequest(messages, tools, proto.mode, sizer) + fitted.maxTokens;
            windowSize = reported && reported < windowSize ? reported : Math.max(4096, Math.floor(Math.min(windowSize, est) * 0.7));
            if (job) job.log('模型上下文窗口收紧至 ' + windowSize + ' tokens，压缩后重试');
            continue;
          }
          if (!seqRetried && SEQUENCE_ERROR_RE.test(detail)) {
            seqRetried = true;
            messages = [messages[0]].concat(normalizeConversationMessages(messages.slice(1), proto.mode));
            if (job) job.log('检测到消息序列不兼容，已自动规范化会话序列后重试');
            await checkpoint();
            continue;
          }
          /* 仅对明确由网关识别的 no_native_tools 才降级为文本协议；风控/鉴权/5xx 上游故障一律直报并完整保留原生断点。 */
          if (proto.mode === 'native' && cfg.toolProtocol !== 'text' && error && error.code === 'no_native_tools') {
            await switchToText(detail.slice(0, 200), true);
            continue;
          }
          if (salvage && job) job.log('已写出的 ' + core.formatCount(salvage.length) + ' 字已随断点保存，沿断点继续会先把它抢救进草稿工作台');
          throw error;
        }
        req.cleanup();
        assertCurrent(target);
        if (taskAborted(entry)) throw staleError('已停止');

        if (!turn.calls.length && !turn.truncated) {
          var said = turn.prose || str(turn.text).trim();
          if (entry.inbox.length > 0) {
            /* 回复刚回来就收到了用户插话：保留刚才模型说的话并把插话接上去继续！ */
            if (said) messages.push({ role: 'assistant', content: said });
            continue;
          }
          /*
           * 工作台里已经有大纲：这一句（甚至空回复）就是交付确认，交给调用方合成与质检。
           * 不再套「只说不做」「推说看不了」的检测——「草稿写好了，现在开始执导」这种收尾会被误判，甚至触发协议降级。
           */
          var drafted = hasOutline();
          if (!drafted && !forced && !nudged && localRounds === 0 && CANT_READ_CLAIM.test(said)) {
            nudged = true;
            messages.push({ role: 'assistant', content: said });
            appendUserTurn(messages, '（系统提示：你已配备只读 VFS 工具 ls / read / grep，可直接查阅 wb:/、var:/、chat:/、card:/ 的完整原文与变量结构。请立即调用只读工具查证后再交付产出，不要推说看不了。）', false);
            await checkpoint();
            continue;
          }
          if (!drafted && !forced && !nudged && localRounds === 0 && protocol.stalled(said, turn.reasoning)) {
            nudged = true;
            messages.push({ role: 'assistant', content: said });
            appendUserTurn(messages, '（系统提示：上一条回复没有发出任何工具调用。如需查阅世界书、变量或历史，请立即调用只读工具；若已查证充分，请直接交付完整产出。）', false);
            await checkpoint();
            continue;
          }
          if (!drafted && !forced && nudged && localRounds === 0 && proto.mode === 'native' && cfg.toolProtocol === 'auto' && protocol.stalled(said, turn.reasoning)) {
            await switchToText('模型未响应原生函数调用', false);
            continue;
          }
          return result(said);
        }

        if (forced) {
          if (turn.prose || hasOutline()) return result(turn.prose);
          if (finalTries < 1) {
            finalTries += 1;
            var fallbackReq = makeRequestSignal(entry);
            var fallbackText;
            try {
              fallbackText = str(await llm.chatTask({
                kind: 'director',
                messages: plainMessages(messages).concat([{ role: 'user', content: core.buildFinaleNote(forced, ws(), kind, cfg.maxSteps) }]),
                maxTokens: fitted.maxTokens, timeoutMs: settings.timeoutMs, signal: fallbackReq.signal, retries: 0, cacheMs: MODEL_CACHE_MS,
                generationId: options.generationId || 'reader-director-plan', stream: true, onStream: streamWatcher(), allowEmpty: hasOutline()
              }));
            } catch (fbErr) {
              fallbackReq.cleanup();
              streamDone();
              keepPartial(fbErr);
              if ((isAbort(fbErr) || (fallbackReq.signal && fallbackReq.signal.aborted)) && !taskAborted(entry) && entry.inbox.length > 0) continue;
              throw fbErr;
            }
            fallbackReq.cleanup();
            streamDone();
            assertCurrent(target);
            var cleanFinal = protocol.parse(fallbackText).prose || fallbackText.trim();
            return result(cleanFinal);
          }
          throw new Error('总导演在工具预算耗尽后仍未交付正文产出');
        }

        rounds += 1;
        stepRounds += 1;
        localRounds += 1;
        var native = turn.style === 'native';
        var callMessage = native
          ? echoedCallMessage(turn.message, turn.calls)
          : { role: 'assistant', content: turn.text };

        var taskSignal = signalOf(entry);
        var outcomes = [];
        try {
          outcomes = canRunParallel(turn.calls)
            ? await kernel.mapLimit(turn.calls, PARALLEL_READS, function (call) { assertCurrent(target); return execTool(call, taskSignal); })
            : [];
          if (!outcomes.length) {
            for (var cIdx = 0; cIdx < turn.calls.length; cIdx += 1) {
              assertCurrent(target);
              outcomes.push(await execTool(turn.calls[cIdx], taskSignal));
            }
          }
        } catch (toolErr) {
          rounds = Math.max(0, rounds - 1);
          stepRounds = Math.max(0, stepRounds - 1);
          rebuildSeenFromMessages();
          throw toolErr;
        }
        assertCurrent(target);
        if (taskAborted(entry)) throw staleError('已停止');

        /* 工具全部执行完毕后再把整组 call + result + seen 缓存与计数原子提交并落盘，杜绝半截断点与缓存锁死。 */
        messages.push(callMessage);
        var textBlocks = [];
        /* 同一批里草稿被改过：这一批的 draft_read 结果可能是改之前读的，不进 seen。 */
        var batchWrote = outcomes.some(function (item) { return item && item.wrote; });
        for (var oIdx = 0; oIdx < outcomes.length; oIdx += 1) {
          var callItem = turn.calls[oIdx];
          var outcome = outcomes[oIdx];
          if (outcome.ok && !outcome.reused && outcome.signature && !(outcome.draft && batchWrote)) {
            seen[outcome.signature] = { content: outcome.body, inContext: true };
          }
          if (outcome.ok && !outcome.reused && outcome.signature && !outcome.draft) toolCount += 1;
          if (native) {
            messages.push({
              role: 'tool', tool_call_id: callItem.id, toolResult: true, toolName: callItem.name || '?', toolStatus: outcome.status,
              content: (outcome.status === 'ok' ? '' : outcome.status === 'denied' ? '［未执行］' : '［失败］') + outcome.body
            });
          } else {
            textBlocks.push(protocol.resultBlock(callItem.name || '?', outcome.status, outcome.body));
          }
        }

        var allIdle = outcomes.length > 0 ? outcomes.every(function (item) { return !item.ok || item.reused; }) : !!turn.truncated;
        if (allIdle) {
          var batchSig = outcomes.length
            ? JSON.stringify(outcomes.map(function (item) { return [item.name, item.args, item.status]; }))
            : '__truncated__';
          idleRepeats = batchSig === lastIdleBatch ? idleRepeats + 1 : 1;
          lastIdleBatch = batchSig;
          idleStreak += 1;
        } else {
          idleRepeats = 0;
          lastIdleBatch = '';
          idleStreak = 0;
        }

        var tail = '';
        if (idleRepeats >= 2 || idleStreak >= 3) {
          forced = 'no_progress';
          tail = core.buildFinaleNote('no_progress', ws(), kind, cfg.maxSteps);
          if (job) job.log('拦截重复/无效的工具调用，要求总导演基于现有资料收尾');
        } else if (stepRounds >= cfg.maxSteps) {
          if (grace === null && hasDraft()) {
            grace = GRACE_ROUNDS;
            tail = core.buildGraceNote(ws(), kind, cfg.maxSteps, GRACE_ROUNDS);
            if (job) job.log('达到工具轮数上限（' + cfg.maxSteps + ' 轮）：草稿工作台已有稿子，再给 ' + GRACE_ROUNDS + ' 轮只限草稿工具的收尾');
          } else if (grace !== null && grace > 1) {
            grace -= 1;
          } else {
            forced = 'step_limit';
            tail = core.buildFinaleNote('step_limit', ws(), kind, cfg.maxSteps);
            if (job) job.log('达到工具轮数上限（' + cfg.maxSteps + ' 轮），要求总导演' + (hasDraft() ? '基于草稿工作台直接交付' : '基于已查资料收尾'));
          }
        } else if (turn.truncated) {
          tail = '（上一条回复里有一个工具块未写完，未执行。请重新发起调用（draft_write 的内容太长就拆成几次 append），或基于现有资料直接交付产出。）';
        } else if (!native) {
          tail = space
            ? '（以上是工具返回结果。仍有信息盲区就继续查阅；查证充分后用 draft_write 把大纲分块写进草稿工作台（也可以直接交付四段标签），draft_check 通过后回复一句简短的交付确认即可。）'
            : '（以上是只读工具返回结果。若仍有信息盲区请继续查阅；若已查证充分，请一气呵成完成大纲撰写与自检，直接交付四段标签产出。）';
        }

        if (native) {
          /* 原生模式不把系统收尾提示拼进 tool 正文，保持 tool 消息纯净、不污染 seen 缓存。 */
          if (tail) appendUserTurn(messages, tail, false);
        } else {
          messages.push({ role: 'user', content: (textBlocks.length ? textBlocks.join('\n') + '\n' : '') + tail, toolResult: true });
        }
        await checkpoint();
      }
    }

    /* ---------- 互斥与任务牌（支持 Inbox 队列与双级中止） ---------- */

    function openPage() { if (typeof deps.openTab === 'function') { try { deps.openTab('director'); } catch (error) { /* 界面打不开不影响 */ } } }

    function quietJob() {
      return { id: '', update: noop, log: noop, done: noop, fail: noop, cancelled: noop, running: function () { return false; } };
    }

    /* 任务牌上的「当前动作」（编纲与重构的实时文案都走这里）。 */
    function setStage(entry, text, detail) {
      var patch = { stage: str(text) };
      if (detail !== undefined) patch.detail = str(detail);
      entry.job.update(patch);
    }

    function begin(kind, spec) {
      if (disposed) throw new Error('导演已经停用');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
      var Controller = host.AbortController || root.AbortController;
      var resolveSettled = noop;
      var settled = new Promise(function (resolve) { resolveSettled = resolve; });
      var entry = {
        kind: kind, key: session.key,
        controller: Controller ? new Controller() : null,
        reqController: null,
        inbox: [],
        committing: false,
        closing: false,
        job: null, reason: '', stage: str(spec && spec.stage),
        settled: settled, resolveSettled: resolveSettled
      };
      var job = jobs ? jobs.start(Object.assign({ owner: 'director', kind: kind, level: 'major', cancel: function () { abortWork(entry, 'user'); }, open: openPage }, spec)) : quietJob();
      /* 牌子上写了什么，这件活自己也记一份（entry.stage）：状态快照（getStatus）把它交给界面与调用方。 */
      entry.job = Object.assign({}, job, {
        update: function (patch) {
          if (patch && patch.stage !== undefined) entry.stage = str(patch.stage);
          job.update(patch);
        }
      });
      work = entry;
      emit('work');
      return entry;
    }

    function finishWork(entry) {
      if (entry.reqController) { try { entry.reqController.abort(); } catch (error) { /* ignore */ } entry.reqController = null; }
      if (work === entry) work = null;
      if (typeof entry.resolveSettled === 'function') { entry.resolveSettled(); entry.resolveSettled = null; }
      emit('work');
    }

    function abortWork(entry, reason) {
      if (!entry || work !== entry) return false;
      entry.reason = reason || 'user';
      if (entry.reqController) { try { entry.reqController.abort(); } catch (error) { /* ignore */ } }
      if (entry.controller) { try { entry.controller.abort(); } catch (error) { /* ignore */ } }
      return true;
    }

    function interruptRequest(entry) {
      if (!entry || work !== entry) return false;
      if (entry.reqController) { try { entry.reqController.abort(); } catch (error) { /* ignore */ } }
      return true;
    }

    function taskAborted(entry) {
      return !!(entry && entry.controller && entry.controller.signal && entry.controller.signal.aborted);
    }

    function makeRequestSignal(entry) {
      var Controller = host.AbortController || root.AbortController;
      if (!Controller) return { signal: signalOf(entry), cleanup: noop };
      var reqCtrl = new Controller();
      entry.reqController = reqCtrl;
      var parent = signalOf(entry);
      var onParentAbort = function () { try { reqCtrl.abort(); } catch (error) { /* ignore */ } };
      if (parent) {
        if (parent.aborted) onParentAbort();
        else parent.addEventListener('abort', onParentAbort, { once: true });
      }
      return {
        signal: reqCtrl.signal,
        cleanup: function () {
          if (parent) { try { parent.removeEventListener('abort', onParentAbort); } catch (error) { /* ignore */ } }
          if (entry.reqController === reqCtrl) entry.reqController = null;
        }
      };
    }

    function signalOf(entry) { return entry.controller ? entry.controller.signal : undefined; }

    function waitSettled(entry, timeoutMs) {
      if (!entry || !entry.settled) return Promise.resolve(true);
      var limit = timeoutMs > 0 ? timeoutMs : 3000;
      return Promise.race([
        entry.settled.then(function () { return true; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(false); }, limit); })
      ]);
    }

    function closeJob(entry, error) {
      if (isAbort(error) || taskAborted(entry)) {
        var label = entry.reason === 'chat' ? '聊天已切换'
          : entry.reason === 'pause' ? '已暂停' : '已停止';
        entry.job.cancelled(label);
      } else {
        entry.job.fail(error);
      }
    }

    /* ---------- 单会话编纲（勘察、撰稿、自检、断点续传、实时插话） ---------- */

    function pendingFromIndex(index, known) {
      var taken = {};
      (known || []).forEach(function (item) { taken[item.name] = true; });
      return (index && index.newCharacters || []).filter(function (item) { return !taken[item.name]; }).map(function (item) {
        return { id: randomId('pe'), name: item.name, kind: item.kind, brief: item.brief, keywords: item.keywords, status: 'pending', error: '' };
      });
    }

    /*
     * 草稿工作台与断流半稿的读写口：只改内存里的这一份草稿对象，落盘交给 saveDraft / saveRsDraft（epoch 守卫）。
     * 定稿、放弃、切卷之后草稿换了对象：工作台的 set 一律抛 director_stale，半稿的 set 静默作废，绝不写到别的草稿上。
     * 编纲与重构共用；isCurrent 判断这份草稿是否还是当前的那一份。
     */
    function draftSpace(draft, kind, isCurrent) {
      return {
        kind: kind,
        get: function () { return draft.workspace; },
        set: function (next) {
          if (!isCurrent()) throw staleError('这份草稿已经作废');
          draft.workspace = core.normalizeWorkspace(next, kind);
        }
      };
    }
    function partialSlot(draft, isCurrent) {
      return {
        get: function () { return draft.partialOutput || null; },
        set: function (value) {
          if (!isCurrent()) return;
          draft.partialOutput = value && str(value.text).trim()
            ? { text: str(value.text).slice(0, 120000), reason: str(value.reason).slice(0, 200), at: Number(value.at) || Date.now() } : null;
        }
      };
    }

    /* 断点续传时把工作台进度接在会话末尾；末尾已经是上一次续传留下的同类提示就换成新的，不一条条叠上去。 */
    var RESUME_MARK = '【草稿工作台进度（断点续传）】';
    function appendResumeNote(messages, workspace, kind) {
      var note = core.buildWorkspaceNote(workspace, kind, 'resume');
      if (!note || !Array.isArray(messages) || !messages.length) return;
      var last = messages[messages.length - 1];
      var content = last && last.role === 'user' ? str(last.content) : '';
      var at = content.lastIndexOf(RESUME_MARK);
      if (at >= 0 && content.slice(at).indexOf('\n\n---\n\n') < 0) {
        if (content.slice(at) === note) return;
        last.content = content.slice(0, at).replace(/(?:\s*\n---\n\s*)+$/, '').trim();
        if (!last.content) messages.pop();
      }
      appendUserTurn(messages, note, false);
    }

    /* 交付合成的过程记进日志：哪些段落取自工作台、哪些是回复里没写完而存成的半稿。 */
    function noteComposition(job, composed) {
      if (!job || !composed) return;
      var files = {};
      core.DRAFT_SLOTS.forEach(function (slot) { if (slot.tag) files[slot.tag] = slot.file; });
      var fromDraft = Object.keys(composed.used || {}).filter(function (tag) { return composed.used[tag] === 'workspace'; }).map(function (tag) { return files[tag] || tag; });
      if (fromDraft.length) job.log('交付合成：' + fromDraft.join('、') + ' 取自草稿工作台' + (composed.backfilled.length ? '，回复里的 ' + composed.backfilled.join('、') + ' 已回填' : ''));
      else if (composed.backfilled.length) job.log('交付合成：回复里的 ' + composed.backfilled.join('、') + ' 已回填草稿工作台');
      if (composed.salvaged.length) job.log('回复里没写完的段落已存成半稿：' + composed.salvaged.join('、'));
    }

    async function commitVolume(target, final, userName, entry) {
      assertCurrent(target);
      if (entry && taskAborted(entry)) throw staleError('已停止');
      if (entry && entry.inbox && entry.inbox.length) return { interjected: true };
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
      assertCurrent(target);
      if (entry && taskAborted(entry)) throw staleError('已停止');
      if (entry && entry.inbox && entry.inbox.length) return { interjected: true };
      var now = Date.now();
      var active = {
        v: 1, ownerKey: target.key, label: target.label, volumeId: randomId('vol'),
        volumeNo: (archive && Array.isArray(archive.volumes) ? archive.volumes.length : 0) + 1,
        title: final.index.title, status: 'running', paused: false, createdAt: now, updatedAt: now,
        outlineVersion: version, baseTurn: turn, profile: buildProfile(), failStreak: 0, lastError: '',
        pendingEntries: settings.wbPolicy === 'none' ? [] : pendingFromIndex(final.index, []), createdEntries: [], undo: null
      };
      if (entry) entry.committing = true;
      /* 顺序：大纲 → 快照 → 状态。写状态是提交点：前两步断了，档里仍是「没有活跃卷」，草稿还在，可以接着来。 */
      await vfs.write(target.dir + '/outline.md', final.outline);
      await writeJson(target.dir + '/snapshots.json', snaps);
      await writeJson(target.dir + '/active.json', active);
      target.active = active;
      target.snaps = snaps;
      target.draft = null;
      target.rsDraft = null;
      target.retryAfter = 0;
      await removeFile(target.dir + '/draft.json');
      await removeFile(target.dir + '/restructure-draft.json');
      syncRef();
      return { brief: brief, active: active };
    }

    /* 编纲时等模型回话，任务牌上写的那一句。 */
    function planStage(draft, toolCount) {
      if (draft.revisions > 0) return '自检打回重写（第 ' + draft.revisions + '/' + MAX_SELF_REVISIONS + ' 次）';
      return '自主查阅与编纲' + (toolCount ? '（已查 ' + toolCount + ' 项资料）' : '');
    }

    /*
     * 单会话连贯编纲：
     * 1. 建图（若草稿尚无轻索引地图）：一次生成世界书分级全量目录、变量全景与近期正文；
     * 2. 探索与撰稿：在同一个只读 Agent 会话内边查资料边一气呵成产出四段交付物，每轮工具完成即落盘断点；
     * 3. 实时插话（Inbox 队列）：工作途中用户随时插话只打断当前在途请求，保留已查资料与断点无缝续跑；
     * 4. 自动质检与自查闭环：校验大纲闭合/结构、索引 JSON、首轮简报防泄密与 <self_check> 全过关；
     *    若发现问题自动在同一会话内打回重写（最多 MAX_SELF_REVISIONS 次）；
     * 5. 全部校验通过且无待处理插话时才落盘提交并清空 draft.json，绝不留给后台场记。
     * 这几样不是固定的步数：查几轮、写几稿都由它自己和质检决定。draft.activity 只记「此刻在做什么」，给界面看。
     */
    async function runPlan(target, entry) {
      var draft = target.draft;
      if (!draft) throw new Error('编纲草稿已不存在');
      var epoch = draft.epoch;
      var planCurrent = function () { return target.draft === draft && draft.epoch === epoch; };
      var settings = getSettings();
      var signal = signalOf(entry), job = entry.job;
      var userName = kit.names().user;
      draft.state = 'running';
      draft.error = '';
      draft.canForceCommit = false;
      var skill = await skillText('planner');
      var prefs = await loadPreferences(target);
      var model = null;
      try { model = await llm.resolveTaskModel('director', { cacheMs: MODEL_CACHE_MS, signal: signal }); } catch (error) { if (isAbort(error)) throw error; }
      var modelWindow = model && model.contextWindow || 32768;
      var cfg = agentToolConfig();
      var probeProto = pickDirectorProtocol(cfg.toolProtocol, draft.protocol, draft.protocolKey, draft.protocolFallback);
      var system = core.buildPlannerSystem(skill.text, prefs.merged, userName, { toolMode: probeProto.mode, tools: directorTools(), mounts: safeMounts() });

      if (!draft.materials) {
        draft.activity = 'mapping';
        setStage(entry, '构建世界书与变量地图');
        emit('plan');
        var budget = core.reconBudget(modelWindow, kernel.tokenEstimate(system), settings.plannerMaxTokens);
        var gathered = await gatherMaterials(target, budget, signal, job);
        assertCurrent(target);
        if (taskAborted(entry) || target.draft !== draft || draft.epoch !== epoch) throw staleError('已停止');
        draft.materials = gathered.text;
        job.log('开局轻索引地图 ' + gathered.text.length + ' 字（上限 ' + budget + '）');
        await saveDraft(target, draft, epoch);
      }

      /* 建图期间若有用户插话进来，先合进初始 feedback 再组装开局消息。 */
      if ((!Array.isArray(draft.messages) || !draft.messages.length) && entry.inbox.length) {
        entry.inbox.splice(0, entry.inbox.length).forEach(function (item) {
          if (item && str(item.text).trim()) draft.feedback.push({ at: item.at || Date.now(), text: str(item.text).trim() });
        });
      }

      if (!Array.isArray(draft.messages) || !draft.messages.length) {
        draft.messages = normalizeConversationMessages(
          core.buildPlannerMessages({ system: '', materials: draft.materials, feedback: draft.feedback }).slice(1),
          draft.protocol || 'native'
        );
        draft.activity = 'exploring';
        await saveDraft(target, draft, epoch);
      } else {
        draft.messages = normalizeConversationMessages(draft.messages, draft.protocol || 'native');
        if (!draft.messages.length) {
          draft.messages = normalizeConversationMessages(
            core.buildPlannerMessages({ system: '', materials: draft.materials, feedback: draft.feedback }).slice(1),
            draft.protocol || 'native'
          );
        }
        job.log('从断点续传（已累计 ' + draft.rounds + ' 轮工具调用，查阅 ' + draft.toolCalls + ' 项资料'
          + (core.workspaceHasContent(draft.workspace) ? '，草稿工作台已有 ' + core.formatCount(core.workspaceSummary(draft.workspace, 'plan').totalChars) + ' 字' : '') + '）');
        /* 草稿工作台里已有进度：明确告诉它从哪里接着写。还有没并进工作台的半稿时，由 runDirectorAgent 抢救后一并说明。 */
        if (!draft.partialOutput) appendResumeNote(draft.messages, draft.workspace, 'plan');
      }

      for (;;) {
        assertCurrent(target);
        if (taskAborted(entry) || target.draft !== draft || draft.epoch !== epoch) throw staleError('已停止');
        draft.activity = draft.revisions > 0 ? 'revising' : 'exploring';
        setStage(entry, planStage(draft, draft.toolCalls));
        emit('plan');

        var outcome = await runDirectorAgent({
          target: target, entry: entry, settings: settings,
          skillText: skill.text, preferences: prefs.merged, userName: userName,
          baseMessages: [{ role: 'system', content: '' }].concat(draft.messages),
          preferredProtocol: draft.protocol, preferredProtocolKey: draft.protocolKey, preferredProtocolFallback: draft.protocolFallback,
          stageOf: function (toolCount) { return planStage(draft, toolCount); },
          generationId: 'reader-director-plan', modelWindow: modelWindow,
          initialRounds: draft.rounds, initialStepRounds: draft.stepRounds, initialToolCalls: draft.toolCalls, initialDraftOps: draft.draftOps,
          workspace: draftSpace(draft, 'plan', planCurrent),
          partial: partialSlot(draft, planCurrent),
          onInbox: async function (batch) {
            if (target.draft !== draft || draft.epoch !== epoch) return;
            batch.forEach(function (item) { draft.feedback.push({ at: item.at || Date.now(), text: str(item.text).trim() }); });
            draft.revisions = 0;
            draft.activity = 'exploring';
            draft.canForceCommit = false;
            draft.softPending = false;
            draft.error = '';
            emit('plan');
          },
          onCheckpoint: async function (cp) {
            if (target.draft !== draft || draft.epoch !== epoch) return;
            draft.messages = cp.messages;
            draft.protocol = cp.protocol;
            draft.protocolKey = cp.protocolKey;
            draft.protocolFallback = cp.protocolFallback === true;
            draft.rounds = cp.rounds;
            draft.stepRounds = cp.stepRounds;
            draft.toolCalls = cp.toolCalls;
            draft.draftOps = cp.draftOps || 0;
            await saveDraft(target, draft, epoch);
            emit('plan');
          }
        });
        assertCurrent(target);
        if (taskAborted(entry) || target.draft !== draft || draft.epoch !== epoch) throw staleError('已停止');

        draft.messages = outcome.messages;
        draft.protocol = outcome.protocol;
        draft.protocolKey = outcome.protocolKey;
        draft.protocolFallback = outcome.protocolFallback === true;
        draft.rounds = outcome.rounds;
        draft.stepRounds = outcome.stepRounds;
        draft.toolCalls = outcome.toolCalls;
        draft.draftOps = outcome.draftOps || draft.draftOps;
        /*
         * 交付合成：回复里写了（闭合、非空）的标签以回复为准并回填工作台，没写的从工作台取。
         * 所以只重交一段 <self_check>、只补一段 <first_brief>、或者只回一句「已交付」都能和工作台拼成完整的一稿。
         */
        var checked = core.validateDelivery(str(outcome.text), draft.workspace, 'plan', { userName: userName });
        noteComposition(job, checked.composed);
        draft.workspace = checked.workspace;
        draft.lastOutput = checked.composed.text;
        draft.activity = 'checking';
        setStage(entry, '质检：校验大纲结构、索引与防剧透简报');
        emit('plan');

        /* 若校验瞬间收到新的实时插话，优先纳入本稿并按用户新意见修订。 */
        if (entry.inbox.length > 0) {
          draft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
          draft.revisions = 0;
          draft.softPending = false;
          await saveDraft(target, draft, epoch);
          continue;
        }

        if (!checked.ok) {
          draft.canForceCommit = !checked.hardFailure;
          draft.softPending = !checked.hardFailure;
          draft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
          appendUserTurn(draft.messages, core.buildRevisionPrompt(checked.issues, { softOnly: !checked.hardFailure, workspace: !!core.workspaceOutline(draft.workspace).trim() }), true);
          if (draft.revisions < MAX_SELF_REVISIONS) {
            draft.revisions += 1;
            if (draft.stepRounds >= cfg.maxSteps) draft.stepRounds = Math.max(0, cfg.maxSteps - 4);
            draft.activity = 'revising';
            job.log('质检未通过（' + checked.issues[0] + '），自动打回总导演重写（第 ' + draft.revisions + '/' + MAX_SELF_REVISIONS + ' 次）');
            await saveDraft(target, draft, epoch);
            emit('plan');
            continue;
          }
          await saveDraft(target, draft, epoch);
          throw new Error('自动修订 ' + MAX_SELF_REVISIONS + ' 次后仍未通过质检：' + checked.issues[0]);
        }

        draft.activity = 'committing';
        draft.canForceCommit = false;
        draft.softPending = false;
        setStage(entry, '定稿落盘：写入大纲、索引与首轮简报');
        emit('plan');
        var committed = await commitVolume(target, checked.final, userName, entry);
        if (committed && committed.interjected) {
          draft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
          draft.revisions = 0;
          draft.activity = 'exploring';
          job.log('定稿前收到用户实时插话，继续按新意见修订');
          await saveDraft(target, draft, epoch);
          continue;
        }
        if (committed.brief.leaks) job.log('首轮简报里有 ' + committed.brief.leaks + ' 处与后台实情重合，已拿掉');
        job.log('质检通过，已定稿落盘并清空探索会话（共查阅 ' + outcome.toolCalls + ' 项资料' + (draft.revisions ? '，自动重写 ' + draft.revisions + ' 次' : '') + '）');
        return { done: true, final: checked.final };
      }
    }

    async function drivePlan(target) {
      var draft = target.draft;
      if (!draft) throw new Error('没有可以继续的编纲草稿');
      var epoch = draft.epoch;
      /* 不带步数：总导演在一个会话里自己决定查几轮、写几稿，牌子上只写它此刻在做什么。 */
      var entry = begin('plan', { title: '导演 · 编纲', stage: '准备', steps: 0 });
      try {
        await runPlan(target, entry);
        entry.job.done('《' + (target.active.title || '第 ' + target.active.volumeNo + ' 卷') + '》大纲已定稿，开始执导');
      } catch (error) {
        entry.closing = true;
        var aborted = isAbort(error) || taskAborted(entry);
        if (target.draft === draft && draft.epoch === epoch) {
          /* 若退出前 inbox 还有未消费的插话，一并沉淀到草稿里，绝不丢失用户输入。 */
          if (entry.inbox.length) {
            var leftover = entry.inbox.splice(0, entry.inbox.length);
            var texts = leftover.map(function (item) { return str(item && item.text).trim(); }).filter(Boolean);
            leftover.forEach(function (item) { if (item && str(item.text).trim()) draft.feedback.push({ at: item.at || Date.now(), text: str(item.text).trim() }); });
            if (texts.length && Array.isArray(draft.messages) && draft.messages.length) {
              appendUserTurn(draft.messages, core.buildInterjectionMessage(texts.join('\n'), { workspace: core.workspaceHasContent(draft.workspace) }), true);
            }
          }
          draft.state = aborted ? (entry.reason === 'chat' ? 'interrupted' : 'paused') : 'failed';
          draft.error = aborted ? '' : message(error);
          try { await saveDraft(target, draft, epoch); } catch (ignored) { /* 草稿存不下只影响续接 */ }
        }
        closeJob(entry, error);
        finishWork(entry);
        emit('plan');
        if (aborted) return { paused: true };
        throw error;
      }
      finishWork(entry);
      emit('volume');
      if (getSettings().wbPolicy === 'auto') autoEntries(target).catch(noop);
      else schedulePatrol();
      return { done: true };
    }

    /* 忽略 <self_check> 软告警，按当前草稿最近一次合法输出直接定稿（硬结构必须全合法，且受任务互斥锁保护）。 */
    async function commitDraftNow() {
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');
      if (volumeActive(target)) throw new Error('这个聊天已经有一卷在执导');
      var draft = target.draft;
      var drafted = !!(draft && core.workspaceHasContent(draft.workspace));
      if (!draft || (!drafted && !str(draft.lastOutput).trim())) throw new Error('没有可直接定稿的草稿输出');
      var userName = kit.names().user;
      /* 工作台是最新的一稿（每次交付都回填进去、之后的 draft_edit 也改在这里）；没有工作台的旧断点才用最近一次的输出。 */
      var checked = drafted ? core.validateDelivery('', draft.workspace, 'plan', { userName: userName }) : core.validateFinalDelivery(draft.lastOutput, { userName: userName });
      if (checked.hardFailure) throw new Error('当前草稿存在结构硬伤，不能直接定稿：' + checked.hardIssues[0]);
      var entry = begin('plan', { title: '导演 · 定稿落盘', stage: '按当前草稿定稿落盘', steps: 0 });
      entry.committing = true;
      try {
        await commitVolume(target, checked.final, userName, entry);
        entry.job.done('《' + (target.active.title || '第 ' + target.active.volumeNo + ' 卷') + '》大纲已按当前草稿定稿');
      } catch (error) {
        entry.closing = true;
        closeJob(entry, error);
        finishWork(entry);
        emit('plan');
        throw error;
      }
      finishWork(entry);
      emit('volume');
      if (getSettings().wbPolicy === 'auto') autoEntries(target).catch(noop);
      else schedulePatrol();
      return { done: true, forced: true };
    }

    /*
     * 给当前聊天开一卷：建图 → 单会话只读勘察与撰稿 → 自动自检闭环 → 定稿清会话并开始执导。options: { feedback }
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
      target.draft = normalizeDraft({ v: 2, epoch: randomId('ep'), mode: 'auto', state: 'running', activity: 'mapping', messages: [], feedback: [], startedAt: now, updatedAt: now });
      if (str(opts.feedback).trim()) target.draft.feedback.push({ at: now, text: str(opts.feedback).trim() });
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
        /* 场记只读它自己那一份 Skill；总导演的编纲方法论不进巡检的提示词。 */
        var skill = await skillText('patrol');
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
        var pendingRs = target.rsDraft && target.rsDraft.volumeId === target.active.volumeId ? target.rsDraft : null;
        if (pendingRs && rsDraftResumable(target)) {
          /* 断点还能续传（锚点楼层与大纲版本都没变）：不静默覆盖，请用户到导演页决定继续或放弃。 */
          warn('场记判定剧情已达 L2 结构偏移，但当前已有未完成的重构断点，已跳过自动重构；请到「导演」页继续或放弃原有重构断点。');
          outcome.restructured = false;
          outcome.restructureSkipped = 'existing_draft';
        } else {
          /*
           * 升档由这里的状态机决定：场记判了 L2，直接拉总导演（director 用途）重构，不经过助手，也不靠模型互相派发。
           * 已经过期的旧断点（之后又演了新楼层，或大纲换了版本）再也续不上：把里面用户提过的意见带进这次重构，
           * 新断点落盘时自然替换掉它，免得一份失效的断点永远挡住自动重构。
           */
          var carried = pendingRs ? pendingRs.feedback.slice() : [];
          try { outcome.restructured = !!(await restructure({ reason: followUp.reason, auto: true, carryFeedback: carried })); } catch (error) { outcome.restructured = false; }
        }
      } else if (followUp && followUp.kind === 'finish') {
        try { outcome.archived = !!(await finish({ auto: true })); } catch (error) { outcome.archived = false; }
      }
      return outcome;
    }

    /* ---------- 结构重构（总导演，支持断点持久化与工作态自由插话） ---------- */

    async function commitRestructure(target, final, ctx, entry) {
      assertCurrent(target);
      if (entry && taskAborted(entry)) throw staleError('已停止');
      if (entry && entry.inbox && entry.inbox.length) return { interjected: true };
      var settings = getSettings();
      var turn = ctx.floor >= 0 ? ctx.view.turns(ctx.floor) : ctx.view.turns(ctx.view.lastVisible());
      var nextVersion = core.addVersion(target.snaps, { outline: final.outline, index: final.index, note: final.note || ctx.reason });
      var state = core.normalizeState(ctx.base.state);
      state.phaseCursor = 1;
      state.patches = [];
      state.finishStreak = 0;
      state.lastL2Turn = turn;
      state.turn = turn;
      state.driftLevel = 2;
      state.reason = final.note || ctx.reason;
      var brief = core.sanitizeBriefDetailed(final.firstBrief, { userName: ctx.userName, outline: final.outline });
      if (entry) entry.committing = true;
      target.active.undo = { fromVersion: ctx.version, toVersion: nextVersion, at: Date.now(), reason: ctx.reason, state: modules.clone(ctx.base.state), brief: ctx.base.brief };
      target.snaps = core.pushSnapshot(target.snaps, core.makeSnapshot(ctx.guard, { outlineVersion: nextVersion, kind: 'restructure', state: state, brief: brief.text || ctx.base.brief }));
      target.active.outlineVersion = nextVersion;
      if (final.index.title) target.active.title = final.index.title;
      target.active.status = 'running';
      target.active.failStreak = 0;
      target.active.lastError = '';
      if (settings.wbPolicy !== 'none') {
        var known = target.active.pendingEntries.concat(target.active.createdEntries);
        target.active.pendingEntries = target.active.pendingEntries.concat(pendingFromIndex(final.index, known));
      }
      target.rsDraft = null;
      await vfs.write(target.dir + '/outline.md', final.outline);
      await persist(target);
      await removeFile(target.dir + '/restructure-draft.json');
      return { version: nextVersion, note: final.note };
    }

    function rsDraftMatchesContext(rsDraft, target, version, guard) {
      if (!rsDraft || !volumeActive(target)) return false;
      if (rsDraft.volumeId !== target.active.volumeId) return false;
      if (rsDraft.baseVersion !== version) return false;
      if (rsDraft.anchorFloor !== guard.floor) return false;
      if (rsDraft.anchorHash && guard.hash && rsDraft.anchorHash !== guard.hash) return false;
      return Array.isArray(rsDraft.messages) && rsDraft.messages.length > 0;
    }

    /* 当前这份重构断点还能不能续传：按此刻的楼层与快照口径核对（与 restructure() 开头取锚点的方式一致）。 */
    function rsDraftResumable(target) {
      if (!target || !target.rsDraft || !volumeActive(target)) return false;
      var view = chatView();
      var floor = view.lastAssistant();
      var picked = core.pickSnapshot(target.snaps, view, view.lastVisible());
      var version = picked.entry ? picked.entry.outlineVersion : target.active.outlineVersion;
      return rsDraftMatchesContext(target.rsDraft, target, version, core.anchorOf(view, floor));
    }

    /* 重构时等模型回话，任务牌上写的那一句。 */
    function restructureStage(rsDraft, toolCount) {
      if (rsDraft.revisions > 0) return '自检打回重写后续（第 ' + rsDraft.revisions + '/' + MAX_SELF_REVISIONS + ' 次）';
      return '自主查阅与重写后续' + (toolCount ? '（已查 ' + toolCount + ' 项资料）' : '');
    }

    /*
     * 重写后续大纲。options: { reason, feedback, manual, auto, resume }。
     * - 支持持久化断点（restructure-draft.json）：遇到上游 5xx / 超时 / 暂停 / 刷新 / 质检打回超限，均可沿断点续跑，不重查已读资料；
     * - 工作态中随时可通过 submitFeedback 走 Inbox 实时插话，仅打断在途请求，保留已查资料与原 reason；
     * - 完成后立即删除 restructure-draft.json，绝不污染场记。
     */
    async function restructure(options) {
      var opts = options || {};
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      /* 和编纲一样不带步数：同一个只读 Agent 会话，查几轮、写几稿由它自己和质检决定。 */
      var entry = begin('restructure', { title: '导演 · 结构重构', stage: '整理既成事实', steps: 0 });
      var previousStatus = target.active.status;
      var rsDraft = null;
      var rsEpoch = '';
      var rsCurrent = function () { return !!rsDraft && target.rsDraft === rsDraft && rsDraft.epoch === rsEpoch; };
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
        var skill = await skillText('planner');
        var prefs = await loadPreferences(target);
        var userName = kit.names().user;
        var guard = core.anchorOf(view, floor);
        var signal = signalOf(entry);
        var model = null;
        try { model = await llm.resolveTaskModel('director', { cacheMs: MODEL_CACHE_MS, signal: signal }); } catch (error) { if (isAbort(error)) throw error; }
        var modelWindow = model && model.contextWindow || 32768;
        var cfg = agentToolConfig();

        var matchesDraft = rsDraftMatchesContext(target.rsDraft, target, version, guard);
        if (opts.resume === true && !matchesDraft) {
          throw new Error('当前聊天楼层或大纲版本已经改变，旧的重构断点已失效，不能直接续传；请点「放弃重构断点」或「重构大纲」按最新剧情重新重构。');
        }
        var canResume = (opts.resume === true || (target.rsDraft && opts.feedback && opts.fresh !== true)) && matchesDraft;
        if (canResume) {
          rsDraft = target.rsDraft;
          rsEpoch = rsDraft.epoch;
          rsDraft.state = 'running';
          rsDraft.error = '';
          rsDraft.canForceCommit = false;
          if (rsDraft.revisions >= MAX_SELF_REVISIONS) rsDraft.revisions = 0;
          if (rsDraft.stepRounds >= cfg.maxSteps) rsDraft.stepRounds = 0;
          if (str(opts.feedback).trim()) {
            var extraNote = str(opts.feedback).trim();
            rsDraft.feedback.push({ at: Date.now(), text: extraNote });
            rsDraft.softPending = false;
            appendUserTurn(rsDraft.messages, core.buildInterjectionMessage(extraNote, { workspace: core.workspaceHasContent(rsDraft.workspace) }), true);
          }
          entry.job.log('从重构断点续传（已累计 ' + rsDraft.rounds + ' 轮工具调用，查阅 ' + rsDraft.toolCalls + ' 项资料'
            + (core.workspaceHasContent(rsDraft.workspace) ? '，草稿工作台已有 ' + core.formatCount(core.workspaceSummary(rsDraft.workspace, 'restructure').totalChars) + ' 字' : '') + '）');
          if (!rsDraft.partialOutput) appendResumeNote(rsDraft.messages, rsDraft.workspace, 'restructure');
          await saveRsDraft(target, rsDraft, rsEpoch);
        } else {
          var reason = str(opts.reason).trim() || (opts.feedback ? '用户要求修订大纲' : '手动发起的结构重构');
          var books = '', variables = '';
          var wbBudget = Math.max(4000, Math.floor(core.reconBudget(modelWindow, 3000, settings.plannerMaxTokens) * 0.45));
          try { books = await worldbookDigest(signal, wbBudget); } catch (error) { books = ''; }
          try { variables = await variableDigest(); } catch (error) { variables = ''; }
          assertCurrent(target);
          if (taskAborted(entry)) throw staleError('已停止');
          var initFeedback = [];
          var carriedNotes = (Array.isArray(opts.carryFeedback) ? opts.carryFeedback : []).filter(function (item) { return item && str(item.text).trim(); });
          carriedNotes.forEach(function (item) { initFeedback.push({ at: Number(item.at) || Date.now(), text: str(item.text).trim() }); });
          if (carriedNotes.length) entry.job.log('旧的重构断点已过期，沿用其中 ' + carriedNotes.length + ' 条用户意见重新重构');
          if (str(opts.feedback).trim()) initFeedback.push({ at: Date.now(), text: str(opts.feedback).trim() });
          if (entry.inbox.length) {
            entry.inbox.splice(0, entry.inbox.length).forEach(function (item) {
              if (item && str(item.text).trim()) initFeedback.push({ at: item.at || Date.now(), text: str(item.text).trim() });
            });
          }
          var mergedFeedbackText = initFeedback.map(function (f) { return f.text; }).join('\n');
          var initMsgs = normalizeConversationMessages(core.buildRestructureMessages({
            system: '', outline: record.outline, index: record.index, state: base.state,
            recent: clippedRecent(view, view.lastVisible(), 6, -1, 2000, 700), userName: userName,
            reason: reason, feedback: mergedFeedbackText, manual: opts.auto !== true,
            books: books, variables: variables, totalFloors: view.length
          }).slice(1), 'native');
          var now = Date.now();
          rsDraft = normalizeRestructureDraft({
            v: 2, epoch: randomId('rep'), volumeId: target.active.volumeId, baseVersion: version,
            anchorFloor: guard.floor, anchorHash: guard.hash || '', reason: reason, manual: opts.auto !== true,
            state: 'running', protocol: '', messages: initMsgs, feedback: initFeedback,
            rounds: 0, stepRounds: 0, toolCalls: 0, revisions: 0, startedAt: now, updatedAt: now
          });
          rsEpoch = rsDraft.epoch;
          target.rsDraft = rsDraft;
          await saveRsDraft(target, rsDraft, rsEpoch);
        }

        for (;;) {
          assertCurrent(target);
          if (taskAborted(entry) || target.rsDraft !== rsDraft || rsDraft.epoch !== rsEpoch) throw staleError('已停止');
          rsDraft.activity = rsDraft.revisions > 0 ? 'revising' : 'exploring';
          setStage(entry, restructureStage(rsDraft, rsDraft.toolCalls));
          emit('volume');
          var outcome = await runDirectorAgent({
            target: target, entry: entry, settings: settings,
            skillText: skill.text, preferences: prefs.merged, userName: userName,
            stageOf: function (toolCount) { return restructureStage(rsDraft, toolCount); },
            generationId: 'reader-director-restructure',
            modelWindow: modelWindow,
            preferredProtocol: rsDraft.protocol, preferredProtocolKey: rsDraft.protocolKey, preferredProtocolFallback: rsDraft.protocolFallback,
            initialRounds: rsDraft.rounds, initialStepRounds: rsDraft.stepRounds, initialToolCalls: rsDraft.toolCalls, initialDraftOps: rsDraft.draftOps,
            workspace: draftSpace(rsDraft, 'restructure', rsCurrent),
            partial: partialSlot(rsDraft, rsCurrent),
            baseMessages: [{ role: 'system', content: '' }].concat(rsDraft.messages),
            onInbox: async function (batch) {
              if (target.rsDraft !== rsDraft || rsDraft.epoch !== rsEpoch) return;
              batch.forEach(function (item) { rsDraft.feedback.push({ at: item.at || Date.now(), text: str(item.text).trim() }); });
              rsDraft.revisions = 0;
              rsDraft.activity = 'exploring';
              rsDraft.canForceCommit = false;
              rsDraft.softPending = false;
              rsDraft.error = '';
              emit('volume');
            },
            onCheckpoint: async function (cp) {
              if (target.rsDraft !== rsDraft || rsDraft.epoch !== rsEpoch) return;
              rsDraft.messages = cp.messages;
              rsDraft.protocol = cp.protocol;
              rsDraft.protocolKey = cp.protocolKey;
              rsDraft.protocolFallback = cp.protocolFallback === true;
              rsDraft.rounds = cp.rounds;
              rsDraft.stepRounds = cp.stepRounds;
              rsDraft.toolCalls = cp.toolCalls;
              rsDraft.draftOps = cp.draftOps || 0;
              await saveRsDraft(target, rsDraft, rsEpoch);
              emit('volume');
            }
          });
          assertCurrent(target);
          if (taskAborted(entry) || target.rsDraft !== rsDraft || rsDraft.epoch !== rsEpoch) throw staleError('已停止');
          rsDraft.messages = outcome.messages;
          rsDraft.protocol = outcome.protocol;
          rsDraft.protocolKey = outcome.protocolKey;
          rsDraft.protocolFallback = outcome.protocolFallback === true;
          rsDraft.rounds = outcome.rounds;
          rsDraft.stepRounds = outcome.stepRounds;
          rsDraft.toolCalls = outcome.toolCalls;
          rsDraft.draftOps = outcome.draftOps || rsDraft.draftOps;
          /* 与编纲同一套交付合成：回复里写了的标签以回复为准并回填，没写的从重构草稿的工作台取。 */
          var checked = core.validateDelivery(str(outcome.text), rsDraft.workspace, 'restructure', { userName: userName });
          noteComposition(entry.job, checked.composed);
          rsDraft.workspace = checked.workspace;
          rsDraft.lastOutput = checked.composed.text;
          rsDraft.activity = 'checking';
          setStage(entry, '质检：校验重构稿的结构、索引与防剧透简报');
          emit('volume');

          if (entry.inbox.length > 0) {
            rsDraft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
            rsDraft.revisions = 0;
            rsDraft.softPending = false;
            await saveRsDraft(target, rsDraft, rsEpoch);
            continue;
          }

          if (!checked.ok) {
            rsDraft.canForceCommit = !checked.hardFailure;
            rsDraft.softPending = !checked.hardFailure;
            rsDraft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
            appendUserTurn(rsDraft.messages, core.buildRevisionPrompt(checked.issues, { softOnly: !checked.hardFailure, workspace: !!core.workspaceOutline(rsDraft.workspace).trim() }), true);
            if (rsDraft.revisions < MAX_SELF_REVISIONS) {
              rsDraft.revisions += 1;
              if (rsDraft.stepRounds >= cfg.maxSteps) rsDraft.stepRounds = Math.max(0, cfg.maxSteps - 4);
              rsDraft.activity = 'revising';
              entry.job.log('重构质检未通过（' + checked.issues[0] + '），自动打回重写（第 ' + rsDraft.revisions + '/' + MAX_SELF_REVISIONS + ' 次）');
              await saveRsDraft(target, rsDraft, rsEpoch);
              continue;
            }
            await saveRsDraft(target, rsDraft, rsEpoch);
            throw new Error(checked.issues[0]);
          }

          rsDraft.activity = 'committing';
          setStage(entry, '重构落盘：新大纲与下一轮简报');
          emit('volume');
          var committed = await commitRestructure(target, checked.final, {
            view: view, floor: floor, base: base, version: version, guard: guard,
            reason: rsDraft.reason, userName: userName
          }, entry);
          if (committed && committed.interjected) {
            rsDraft.messages.push({ role: 'assistant', content: str(outcome.text).trim() || '（上一次回复为空）' });
            rsDraft.revisions = 0;
            rsDraft.activity = 'exploring';
            entry.job.log('重构落盘前收到用户实时插话，继续按新意见修订');
            await saveRsDraft(target, rsDraft, rsEpoch);
            continue;
          }
          entry.job.done('大纲已重构为第 ' + committed.version + ' 版' + (committed.note ? '：' + committed.note : ''));
          finishWork(entry);
          emit('volume');
          if (settings.wbPolicy === 'auto') autoEntries(target).catch(noop);
          return committed;
        }
      } catch (error) {
        entry.closing = true;
        var aborted = isAbort(error) || taskAborted(entry);
        target.active.status = previousStatus === 'restructuring' ? 'running' : previousStatus;
        if (rsDraft && target.rsDraft === rsDraft && rsDraft.epoch === rsEpoch) {
          if (entry.inbox.length) {
            var leftover = entry.inbox.splice(0, entry.inbox.length);
            var texts = leftover.map(function (item) { return str(item && item.text).trim(); }).filter(Boolean);
            leftover.forEach(function (item) { if (item && str(item.text).trim()) rsDraft.feedback.push({ at: item.at || Date.now(), text: str(item.text).trim() }); });
            if (texts.length && Array.isArray(rsDraft.messages) && rsDraft.messages.length) {
              appendUserTurn(rsDraft.messages, core.buildInterjectionMessage(texts.join('\n'), { workspace: core.workspaceHasContent(rsDraft.workspace) }), true);
            }
          }
          rsDraft.state = aborted ? (entry.reason === 'chat' ? 'interrupted' : 'paused') : 'failed';
          rsDraft.error = aborted ? '' : message(error);
          try { await saveRsDraft(target, rsDraft, rsEpoch); } catch (ignored) { /* ignore */ }
        }
        if (!aborted) target.active.lastError = '结构重构没有完成：' + message(error);
        try { await persist(target, { active: true }); } catch (ignored) { /* ignore */ }
        closeJob(entry, error);
        finishWork(entry);
        emit('volume');
        if (aborted) return null;
        throw error;
      }
    }

    async function resumeRestructure() {
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      if (!target.rsDraft) throw new Error('没有可以继续的重构断点');
      if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
      if (!rsDraftResumable(target)) {
        throw new Error('当前聊天楼层或大纲版本已经改变，旧的重构断点已失效，不能直接续传；请点「放弃重构断点」或「重构大纲」按最新剧情重新重构。');
      }
      return restructure({ resume: true, reason: target.rsDraft.reason, manual: target.rsDraft.manual });
    }

    async function discardRestructureDraft() {
      var target = await ensureSession();
      if (work && work.kind === 'restructure' && work.key === target.key) {
        var running = work;
        abortWork(running, 'user');
        await waitSettled(running, 3000);
      }
      target.rsDraft = null;
      await removeFile(target.dir + '/restructure-draft.json');
      emit('volume');
      return true;
    }

    async function commitRestructureDraftNow() {
      var target = await ensureSession();
      if (!target.key || !volumeActive(target)) throw new Error('这个聊天里没有正在执导的分卷');
      var rsDraft = target.rsDraft;
      var rsDrafted = !!(rsDraft && core.workspaceHasContent(rsDraft.workspace));
      if (!rsDraft || (!rsDrafted && !str(rsDraft.lastOutput).trim())) throw new Error('没有可直接落盘的重构草稿输出');
      var view = chatView();
      var floor = view.lastAssistant();
      var picked = core.pickSnapshot(target.snaps, view, view.lastVisible());
      var base = picked.entry;
      var version = base.outlineVersion;
      var guard = core.anchorOf(view, floor);
      if (!rsDraftMatchesContext(rsDraft, target, version, guard)) {
        throw new Error('当前聊天楼层或大纲版本已经改变，旧的重构草稿已过期，不能直接落盘；请点「放弃重构断点」后重新发起「重构大纲」。');
      }
      var userName = kit.names().user;
      var checked = rsDrafted ? core.validateDelivery('', rsDraft.workspace, 'restructure', { userName: userName }) : core.validateFinalDelivery(rsDraft.lastOutput, { userName: userName });
      if (checked.hardFailure) throw new Error('当前重构草稿存在结构硬伤，不能直接落盘：' + checked.hardIssues[0]);
      var entry = begin('restructure', { title: '导演 · 重构落盘', stage: '按当前重构草稿落盘', steps: 0 });
      entry.committing = true;
      var committed;
      try {
        committed = await commitRestructure(target, checked.final, {
          view: view, floor: floor, base: base, version: version, guard: guard,
          reason: rsDraft.reason || '按当前重构草稿落盘', userName: userName
        }, entry);
        entry.job.done('大纲已按当前重构稿落盘为第 ' + committed.version + ' 版');
      } catch (error) {
        entry.closing = true;
        closeJob(entry, error);
        finishWork(entry);
        emit('volume');
        throw error;
      }
      finishWork(entry);
      emit('volume');
      if (getSettings().wbPolicy === 'auto') autoEntries(target).catch(noop);
      return Object.assign({ forced: true }, committed);
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
      target.rsDraft = null;
      await removeFile(target.dir + '/restructure-draft.json');
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
      target.rsDraft = null;
      await removeFile(target.dir + '/restructure-draft.json');
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
      target.rsDraft = null;
      await removeFile(target.dir + '/restructure-draft.json');
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
          /* 归档用写死的短协议（core.ARCHIVE_PROTOCOL），不读任何一份 Skill。 */
          var prefs = await loadPreferences(target);
          var reply = await llm.chatTask({
            kind: 'director_judge', maxTokens: Math.min(2048, settings.judgeMaxTokens), timeoutMs: settings.timeoutMs, signal: signalOf(entry), retries: 1, cacheMs: MODEL_CACHE_MS,
            generationId: 'reader-director-archive',
            messages: core.buildArchiveMessages({
              preferences: prefs.merged, userName: kit.names().user, outline: record.outline, index: record.index, state: state,
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
        await removeFile(target.dir + '/restructure-draft.json');
        target.active = normalizeActive(idle, target);
        target.snaps = core.emptySnapshots();
        target.rsDraft = null;
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
      await removeFile(target.dir + '/restructure-draft.json');
      target.active = normalizeActive(idle, target);
      target.snaps = core.emptySnapshots();
      target.rsDraft = null;
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
      if (work && work.kind === 'plan' && work.key === target.key) { abortWork(work, 'pause'); return 'plan'; }
      if (volumeActive(target)) {
        if (work && work.key === target.key) abortWork(work, 'pause');
        target.active.paused = true;
        target.active.pausedBy = 'user';
        await persist(target, { active: true });
        emit('volume');
        return 'volume';
      }
      return '';
    }

    /* 接着编（从草稿断点续传）或恢复执导（分卷暂停着）。 */
    async function resume() {
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');
      if (target.draft && !volumeActive(target)) {
        if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
        var cfg = agentToolConfig();
        /* 此前因达到重试上限或工具预算上限而失败时，手动继续给予新一轮额度。 */
        if (target.draft.revisions >= MAX_SELF_REVISIONS) target.draft.revisions = 0;
        if (target.draft.stepRounds >= cfg.maxSteps) target.draft.stepRounds = 0;
        target.draft.error = '';
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

    /* 丢掉编到一半的草稿（先中止同聊天的在途编纲并等待其收尾，配合 epoch 守卫绝不回写）。 */
    async function discardDraft() {
      var target = await ensureSession();
      if (work && work.kind === 'plan' && work.key === target.key) {
        var running = work;
        abortWork(running, 'user');
        await waitSettled(running, 3000);
      }
      target.draft = null;
      await removeFile(target.dir + '/draft.json');
      emit('plan');
      return true;
    }

    /*
     * 用户自由插话（最高优先级，Inbox 队列架构）：
     *   本聊天编纲/重构进行中（且未进入不可逆写盘）  直接入队 inbox 并仅打断在途请求，零轮询、零锁冲突、零丢失；
     *   本聊天恰好在落盘最后几毫秒                    等待 settled（数毫秒）后按新状态无缝衔接（通常转入重构）；
     *   另一聊天在后台收尾                            校验 work.key !== target.key，绝不跨聊天接管，等待收尾再按本聊天处理；
     *   编纲停在断点                                  注入断点会话并立即恢复续跑；
     *   分卷有重构断点或执导中                        沿重构断点或新建会话拉起总导演修订后续大纲。
     */
    async function submitFeedback(text) {
      var note = str(text).trim();
      if (!note) throw new Error('先写下你的意见');
      var target = await ensureSession();
      if (!target.key) throw new Error('先打开一个聊天');

      /* 1. 同一聊天正在编纲或重构中：未进入不可逆落盘/异常收尾时直接走 Inbox 即时入队（绝不跨聊天接管）。 */
      if (work && work.key === target.key && (work.kind === 'plan' || work.kind === 'restructure')) {
        if (!work.committing && !work.closing) {
          work.inbox.push({ at: Date.now(), text: note });
          interruptRequest(work);
          return { queued: true, kind: work.kind };
        }
        /* 正在不可逆落盘或异常收尾写断点：等 settled（数毫秒），再按落盘后的最新状态重新路由，绝不丢话也不回写旧草稿。 */
        var settling = work;
        await waitSettled(settling, 3000);
        assertCurrent(target);
      } else if (work && work.key !== target.key) {
        /* 切聊天后旧聊天的任务尚在收尾：等待其退出，严禁读取旧聊天的探索会话。 */
        var foreign = work;
        abortWork(foreign, 'chat');
        await waitSettled(foreign, 3000);
        assertCurrent(target);
      }

      /* 2. 重新核对当前最新状态（避免落盘窗口过期）。 */
      if (target.draft && !volumeActive(target)) {
        if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
        var draft = target.draft;
        var epoch = draft.epoch;
        draft.feedback.push({ at: Date.now(), text: note });
        if (Array.isArray(draft.messages) && draft.messages.length) {
          draft.messages = normalizeConversationMessages(draft.messages, draft.protocol || 'native');
          appendUserTurn(draft.messages, core.buildInterjectionMessage(note, { workspace: core.workspaceHasContent(draft.workspace) }), true);
        }
        var cfg = agentToolConfig();
        draft.revisions = 0;
        draft.canForceCommit = false;
        draft.softPending = false;
        draft.error = '';
        if (draft.stepRounds >= cfg.maxSteps) draft.stepRounds = 0;
        await saveDraft(target, draft, epoch);
        return drivePlan(target);
      }
      if (volumeActive(target)) {
        if (work) throw new Error('导演正在' + (WORK_LABEL[work.kind] || '忙') + '，等它做完，或先点「停止」');
        return restructure({ feedback: note, reason: '用户要求修订大纲', manual: true });
      }
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

    /*
     * 两份 Skill 的读、写、恢复默认。role 取 'planner'（总导演：编纲与重构）或 'patrol'（场记：每轮巡检与简报）。
     * 一份的保存、恢复、作废都只动它自己：另一份的文件、缓存与知识库登记原样不动。
     */
    async function getSkill(role) {
      var current = await skillText(role);
      return { role: role, name: skillName(role), label: core.SKILL_LABELS[role], text: current.text, source: current.source, path: skillPath(role) };
    }

    async function getSkills() {
      var out = {};
      for (var index = 0; index < core.SKILL_ROLES.length; index += 1) out[core.SKILL_ROLES[index]] = await getSkill(core.SKILL_ROLES[index]);
      return out;
    }

    /* 知识库那边（skills.js）也登记着这两份：改完让它当场换成新的，助手用 skill / kb:/ 读到的与导演用的是同一份。 */
    async function reloadKnowledge(role) {
      if (!skills || typeof skills.reload !== 'function') return;
      try { await skills.reload(skillName(role)); } catch (error) { /* 下次启动会再扫一遍 */ }
    }

    /* 保存到工作区。写什么就是什么：不核对标题、不补段；只拦「什么都没写」。 */
    async function saveSkill(role, text) {
      var path = skillPath(role);
      var body = str(text);
      if (!core.skillBody(body)) throw new Error(core.SKILL_LABELS[role] + '不能是空的；要回到内置的那份，请点「恢复内置默认」');
      await vfs.write(path, body);
      dropSkill(role);
      await reloadKnowledge(role);
      emit('skill');
      return getSkill(role);
    }

    async function resetSkill(role) {
      await removeFile(skillPath(role));
      dropSkill(role);
      await reloadKnowledge(role);
      emit('skill');
      return getSkill(role);
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
      /*
       * 工作区里某一份 Skill 被写入或删掉（不管是面板、助手，还是用户让助手改的）：只作废这一份的缓存，
       * 并让知识库把这一份重新登记；另一份不受影响。别的文件、别的知识一概不理。
       */
      unwatch = vfs.onWrite(function (event) {
        if (event.mount !== 'ws' || event.segs.length !== 3 || event.segs[0] !== 'skills' || event.segs[2] !== 'SKILL.md') return;
        var role = core.SKILL_ROLES.filter(function (item) { return core.SKILL_NAMES[item] === event.segs[1]; })[0];
        if (!role) return;
        dropSkill(role);
        reloadKnowledge(role).then(function () { emit('skill'); }, function () { emit('skill'); });
      });
    }
    if (deps.agent && typeof deps.agent.onChange === 'function') {
      unwatchAgent = deps.agent.onChange(function (reason) {
        if (reason === 'settings') directorTextOnly = Object.create(null);
      });
    }

    registerSlot();
    ensureSession().catch(noop);

    /* ---------- 状态快照（界面用，同步） ---------- */

    /*
     * 总导演这个只读 Agent 的工作态（编纲断点与重构断点同一个形状）：
     *   state          running / paused / interrupted / failed
     *   activity       在跑的时候它此刻在做什么（mapping / exploring / revising / checking / committing）；没在跑是空串
     *   activityLabel  给人看的那句：在跑时是「建图中 / 自主查阅与编纲中 / 自检重写中…」，停着时是「已暂停 / 已中断 / 出错待续」
     *   stage          任务牌上实时的那一句（「查阅世界书 wb:/…」「自检打回重写（第 1/2 次）」）；没在跑是空串
     *   rounds / toolCalls / revisions / maxRevisions   工具轮次、已查阅的资料项数、自动重写了几次、最多几次
     *   hasCheckpoint / canForceCommit / feedback / lastOutput / error / updatedAt
     * 它在一个会话里自己决定查几轮、写几稿，所以这里没有「第几步、共几步」。
     */
    /*
     * 草稿工作台在状态里的样子：概要（字数、写到哪个板块 / Phase、半稿）、各槽位正文（给「草稿预览」）、能不能直接定稿。
     * getStatus 每次事件都会被调用，按「哪一份草稿、第几版工作台」记一份，没变就不重算（整份质检不便宜）。
     */
    var spaceCache = { draft: null, rev: -1, value: null };
    function workspaceView(draft, kind) {
      var ws = draft.workspace || core.emptyWorkspace();
      if (spaceCache.draft === draft && spaceCache.rev === ws.rev && spaceCache.value) return spaceCache.value;
      var summary = core.workspaceSummary(ws, kind);
      var files = {};
      Object.keys(ws.files || {}).forEach(function (name) { files[name] = str(ws.files[name] && ws.files[name].text); });
      var committable = false;
      if (summary.ready) {
        try { committable = !core.validateDelivery('', ws, kind, { userName: kit.names().user }).hardFailure; } catch (error) { committable = false; }
      }
      spaceCache = { draft: draft, rev: ws.rev, value: { summary: summary, files: files, committable: committable } };
      return spaceCache.value;
    }

    function agentState(draft, kind, running, stale) {
      var state = running ? 'running' : draft.state;
      var labels = ACTIVITY_LABEL[kind];
      var space = workspaceView(draft, kind === 'restructure' ? 'restructure' : 'plan');
      /* 流式收到东西时，「此刻在做什么」换成实时的那一句（正在构思推演 / 正在撰写 / 正在写入草稿 + 字数）。 */
      var live = running && work && work.stream ? work.stream : null;
      return {
        state: state,
        activity: running ? draft.activity : '',
        activityLabel: running ? (live && live.label ? live.label : labels[draft.activity] || labels.exploring) : (IDLE_LABEL[state] || IDLE_LABEL.interrupted),
        stage: running && work ? str(work.stage) : '',
        rounds: draft.rounds, toolCalls: draft.toolCalls,
        revisions: draft.revisions, maxRevisions: MAX_SELF_REVISIONS,
        hasCheckpoint: Array.isArray(draft.messages) && draft.messages.length > 0,
        /* 能直接定稿：上一次交付只差自检软问题；或者工作台里的一稿结构完整、没有半稿（模型没来得及回确认就断了也能定）。 */
        canForceCommit: !running && !stale && ((draft.canForceCommit === true && !!str(draft.lastOutput).trim()) || space.committable),
        feedback: draft.feedback.slice(), lastOutput: draft.lastOutput,
        error: draft.error, updatedAt: draft.updatedAt,
        workspace: space.summary, draftFiles: space.files, draftOps: draft.draftOps || 0,
        partialChars: draft.partialOutput ? str(draft.partialOutput.text).length : 0,
        stream: live ? { phase: live.phase, label: live.label, textChars: live.textChars, reasoningChars: live.reasoningChars, toolName: live.toolName, toolChars: live.toolChars } : null
      };
    }

    function getStatus() {
      registerSlot();
      var current = owner();
      var settings = getSettings();
      var own = current.key ? chatSwitch() : null;
      var status = {
        hasChat: !!current.key, chatLabel: current.label, group: current.group, ready: true,
        enabled: current.key ? (own === null ? settings.enabled : own) : settings.enabled, globalEnabled: settings.enabled, chatSwitch: own,
        slot: !!slotOwner, state: 'nochat', paused: false, pausedBy: '', lastError: '', failStreak: 0,
        work: work ? { kind: work.kind, label: WORK_LABEL[work.kind] || work.kind, id: work.job.id, here: work.key === current.key, stage: str(work.stage) } : null,
        generating: generating(), volume: null, plan: null, restructureDraft: null, pending: [], created: 0,
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
        status.plan = Object.assign(agentState(draft, 'plan', planning, false), { hasMaterials: !!draft.materials });
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
      var restructuringHere = !!(work && work.kind === 'restructure' && work.key === target.key);
      var rsDraft = target.rsDraft && target.rsDraft.volumeId === active.volumeId ? target.rsDraft : null;
      var rsStale = rsDraft ? !rsDraftMatchesContext(rsDraft, target, entry ? entry.outlineVersion : active.outlineVersion, core.anchorOf(now.view, now.floor)) : false;
      status.state = active.paused ? 'paused' : active.status;
      status.paused = active.paused;
      status.pausedBy = active.pausedBy || '';
      status.lastError = active.lastError;
      status.failStreak = active.failStreak;
      status.forked = now.picked.forked;
      status.canUndoRestructure = !!active.undo;
      status.restructureDraft = rsDraft
        ? Object.assign(agentState(rsDraft, 'restructure', restructuringHere, rsStale), { stale: rsStale, reason: rsDraft.reason })
        : null;
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
      if (unwatchAgent) { try { unwatchAgent(); } catch (error) { /* ignore */ } unwatchAgent = null; }
      if (slotOwner) { try { slotOwner.registerSlot('director', null); } catch (error) { /* ignore */ } slotOwner = null; }
      listeners = [];
    }

    return {
      getSettings: getSettings, saveSettings: saveSettings, isEnabled: isEnabled, setChatEnabled: setChatEnabled, getStatus: getStatus,
      activate: activate, pause: pause, resume: resume, submitFeedback: submitFeedback, discardDraft: discardDraft, commitDraftNow: commitDraftNow, stop: stop,
      patrolNow: function (note) { return patrol({ manual: true, note: note }); },
      restructureNow: function (reason) { return restructure({ reason: reason, manual: true }); },
      resumeRestructure: resumeRestructure, discardRestructureDraft: discardRestructureDraft, commitRestructureDraftNow: commitRestructureDraftNow,
      undoRestructure: undoRestructure, finish: finish, continueVolume: continueVolume, restoreLastArchive: restoreLastArchive, discardVolume: discardVolume,
      getOutline: getOutline, saveOutline: saveOutline, getBrief: getBrief, saveBrief: saveBrief, listSnapshots: listSnapshots, rollbackTo: rollbackTo,
      getArchive: getArchive, getPreferences: getPreferences, savePreferences: savePreferences,
      /* 两份 Skill：role 取 'planner'（总导演）或 'patrol'（场记）。getSkills() 一次给出两份。 */
      getSkills: getSkills, getSkill: getSkill, saveSkill: saveSkill, resetSkill: resetSkill,
      listPendingEntries: async function () { var target = await ensureSession(); return target.active ? modules.clone(target.active.pendingEntries) : []; },
      confirmPendingEntry: function (id) { return confirmPendingEntry(id, { auto: false }); },
      discardPendingEntry: discardPendingEntry, listVolumeEntries: listVolumeEntries, listTemplates: wb.listTemplates,
      listReadonlyTools: function () { return directorTools().map(function (def) { return { name: def.name, summary: def.summary, effect: 'read' }; }); },
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
