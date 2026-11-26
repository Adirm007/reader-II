(function (root) {
  'use strict';

  /*
   * 助手窗口的「导演」页：分卷导演（director.js）的全部操作都在这一页。四块：
   *   导演          开关、这一卷的状态与进度、开卷 / 暂停 / 巡检 / 重构 / 完结这些按钮、需要用户拿主意的提示
   *   工作流与插话  总导演（只读 Agent）此刻在做什么与几项指标、只读勘察的实时日志、最近一版草稿、随时可打断续接的自由插话框、待建档的新角色
   *   大纲与简报    下一轮要注入的简报（可改）、当前大纲（可改，存成新版本）、楼层快照（可回退）、已完结各卷
   *   配置          运行参数、长期偏好（全局 / 这张卡）、两份各自独立的 Skill（总导演 / 场记）：编辑、导入导出与恢复默认
   * 导演用哪个模型在「设置 → 导演模型」里（ui-models.js），那里与别的模型连接放在一起。
   *
   * 这一页的输入控件用 data-d，不用设置页的 data-s：设置页底部的「保存设置」会收走窗口里所有 data-s 的值。
   * 按钮的 data-act 一律以 dir- 开头，由 ui.js 转到这里的 action()。
   * 导演干活时页面会被事件驱动着重画：状态与工作流两块每次都重画（插话框是固定的节点，不跟着重建）；
   * 有编辑框的几块各记各的「有没有没保存的改动」，只在没有时才重画，免得把人打到一半的字冲掉。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var STATE_LABEL = {
    nochat: ['没有聊天', ''], loading: ['读取中', ''], idle: ['空闲', ''], planning: ['编纲中', 'is-warn'], draft: ['断点待续', 'is-warn'],
    running: ['执导中', 'is-ok'], paused: ['已暂停', 'is-warn'], restructuring: ['重构中', 'is-warn'], pending_finish: ['待完结', 'is-warn']
  };
  var DRAFT_NOTE = {
    paused: '编纲已暂停，已查到的资料与当前断点都已保存，随时可以续编或插话。',
    interrupted: '上一次编纲被打断了（刷新了页面，或中途切走了聊天），断点与已查资料仍在。',
    failed: '编纲在上游请求或质检中停止了，断点与已查资料已保留：处理好原因后可沿断点继续，或直接插话调整。'
  };
  var RS_NOTE = {
    paused: '重构已暂停，已查到的资料与当前断点都已保存，随时可以续传或插话。',
    interrupted: '上一次重构被打断了（刷新了页面，或中途切走了聊天），断点与已查资料仍在。',
    failed: '重构在上游请求或质检中停止了，断点与已查资料已保留：处理好原因后可沿断点继续，或直接插话调整。'
  };
  var SKILL_ROLES = ['planner', 'patrol'];
  var SKILL_TITLE = { planner: '总导演 Skill（编纲与重构）', patrol: '场记 Skill（每轮巡检与简报）' };
  var SKILL_NOTE = {
    planner: '总导演只读这一份：第 0 原则与叙事底座、全景勘察、十条红线、叙事引擎、五板块大纲规范、交付前自检。开卷编纲与结构重构时整篇带上（开头的 frontmatter 除外），交付格式由程序另行追加，不必写在这里。'
      + '怎么改写都行——删标题、换结构、整篇重写——写成什么样就按什么样用，也不会影响场记那一份。保存后下一次编纲或重构起生效，助手读到的同步更新。',
    patrol: '场记只读这一份：第 0 原则与核心约束、十条红线速记、《导演简报》五栏与防剧透、L0 / L1 / L2 偏移判定、完结判定。每轮巡检整篇带上（开头的 frontmatter 除外），输出契约由程序另行追加，不必写在这里。'
      + '它在巡检提示词的静态前缀里：每保存一次，下一轮巡检的缓存要重建一次，建议改好再存。怎么改写都不会影响总导演那一份，助手读到的同步更新。'
  };
  var KIND_LABEL = { base: '开卷', patrol: '巡检', manual: '手动', restructure: '重构', undo: '撤回重构', edit: '手动修订' };
  var DRIFT_LABEL = ['L0 顺轨', 'L1 局部绕道', 'L2 结构破局'];
  var SAY_LABEL = {
    idle: '开卷前想交代的话（可选）：题材、气质、想看的与不想看的',
    planning: '编纲中自由插话：立即打断当前请求，保留已查资料与断点，带着你的新要求继续',
    restructuring: '重构中自由插话：立即打断当前请求，保留已查资料，按你的新要求继续重写',
    draft: '沿断点续编并插话：会直接注入当前断点会话并继续编纲',
    running: '向导演提修订意见：会按意见重构后续大纲'
  };

  function createDirectorUi(env, kit, director, jobs, view) {
    var esc = view.esc, $ = view.$;
    var host = env.host || root;
    var doc = env.document;
    var core = modules.directorCore;
    var visible = false, stops = [], sayTimer = null;
    var dirty = { brief: false, outline: false, config: false, prefs: false, skill: { planner: false, patrol: false } };
    var finishing = false;            /* 用户点了「完结本卷」，正在挑要留用的条目 */
    var volumeEntries = null;         /* 本卷建过档的条目（完结时列出来勾选） */
    var docsSerial = 0, prefsSerial = 0, skillSerial = { planner: 0, patrol: 0 }, chatMark = '', lastChatLabel = '';
    var kept = Object.create(null);   /* replaceBlock 的 sticky 块：上一次画进去的 HTML（没变就不重画） */

    function icon(name) { return view.icon ? view.icon(name) : ''; }
    function message(error) { return String(error && error.message || error); }
    function scroller() { return $('[data-pane="director"] .ra-scroll'); }
    function time(at) { try { return at ? new Date(at).toLocaleString() : ''; } catch (error) { return ''; } }

    /* 页面底部的一行提示：做完一件事、或出了错，在这里说一句。 */
    function say(text, bad) {
      var bar = $('[data-pane="director"] .rd-bar'), line = $('[data-ra-status="director"]');
      if (!bar || !line) return;
      if (sayTimer) { clearTimeout(sayTimer); sayTimer = null; }
      line.textContent = text || '';
      if (line.classList) line.classList.toggle('is-bad', !!bad);
      bar.hidden = !text;
      if (text && !bad) sayTimer = setTimeout(function () { sayTimer = null; say(''); }, 7000);
    }

    function option(value, label, current) {
      return '<option value="' + esc(value) + '"' + (String(current) === String(value) ? ' selected' : '') + '>' + esc(label) + '</option>';
    }
    function numberField(key, label, value, minimum, maximum, step) {
      return '<label class="ra-num"><span>' + label + '</span><input type="number" inputmode="numeric" data-d="cfg.' + key + '" value="' + esc(value) + '" min="' + minimum + '" max="' + maximum + '" step="' + (step || 1) + '"></label>';
    }
    function selectField(key, label, options, value) {
      return '<label class="ra-num"><span>' + label + '</span><select data-d="' + key + '">' + options.map(function (item) { return option(item[0], item[1], value); }).join('') + '</select></label>';
    }
    function switchField(key, checked, label, hint) {
      return '<label class="ra-check"><input type="checkbox" data-d="' + key + '"' + (checked ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>' + label
        + (hint ? '<span class="ra-hint">' + hint + '</span>' : '') + '</span></label>';
    }
    function button(act, label, kind, disabled, extra) {
      return '<button type="button" class="ra-btn' + (kind ? ' ' + kind : '') + '" data-act="' + act + '"' + (disabled ? ' disabled' : '') + (extra || '') + '>' + label + '</button>';
    }
    function fold(id, title, body, openByDefault) {
      return '<details class="ra-fold" data-fold="' + id + '"' + (openByDefault ? ' open' : '') + '><summary>' + icon('chevron') + title + '</summary><div class="ra-fold-body">' + body + '</div></details>';
    }
    /* 分卷大纲的 Phase 进度条（剧情分幕：走过的、当前的、还没到的）。只用在执导中的状态卡上。 */
    function track(items) {
      return '<ol class="rd-track">' + items.map(function (item, index) {
        return '<li data-on="' + esc(item.on) + '" title="' + esc(item.title) + '"><i>' + (index + 1) + '</i><span>' + esc(item.title) + '</span></li>';
      }).join('') + '</ol>';
    }

    /*
     * 换掉一块的内容：折叠面板开没开照原样留着。
     * sticky 为 true 的块，内容与上一次画的一样就不动它：总导演每查一轮资料页面都会被叫来重画，
     * 草稿预览里正往下翻的位置、展开着的折叠面板不该因此被打回原样。
     */
    function replaceBlock(id, html, sticky) {
      var node = $('#' + id);
      if (!node) return null;
      if (sticky) {
        var last = kept[id];
        if (last && last.node === node && last.html === html) return node;
        kept[id] = { node: node, html: html };
      }
      var opened = {};
      if (typeof node.querySelectorAll === 'function') {
        Array.prototype.forEach.call(node.querySelectorAll('details[data-fold]'), function (item) { opened[item.getAttribute('data-fold')] = item.open; });
      }
      node.innerHTML = html;
      if (typeof node.querySelectorAll === 'function') {
        Array.prototype.forEach.call(node.querySelectorAll('details[data-fold]'), function (item) {
          var key = item.getAttribute('data-fold');
          if (opened[key] !== undefined) item.open = opened[key];
        });
      }
      restoreArmed(node);
      return node;
    }

    /*
     * 「再点一次」的确认状态按按钮身份（data-act + 条目 / 快照 id / 哪一份 Skill）记着，不挂在按钮节点上：
     * 后台每轮写断点都会重画状态卡，节点换了，确认期照样认，三秒后在当时的节点上恢复原文。
     */
    var armedState = Object.create(null);
    function armedKey(node) {
      return [node.getAttribute('data-act') || '', node.getAttribute('data-entry') || '', node.getAttribute('data-snap') || '', node.getAttribute('data-skill') || ''].join('|');
    }
    function armedButtons(root, key) {
      var scope = root || $('[data-pane="director"]');
      if (!scope || typeof scope.querySelectorAll !== 'function') return [];
      return Array.prototype.filter.call(scope.querySelectorAll('[data-act]'), function (node) { return armedKey(node) === key; });
    }
    function restoreArmed(root) {
      var now = Date.now();
      Object.keys(armedState).forEach(function (key) {
        var state = armedState[key];
        if (state.until <= now) { delete armedState[key]; return; }
        armedButtons(root, key).forEach(function (node) {
          if (node.disabled) return;
          node.setAttribute('data-armed', '1');
          node.textContent = state.again;
        });
      });
    }

    /* ---------- 导演（状态与操作） ---------- */

    /* 卷号、回合、版本这些数字也来自工作区里的档案文件（用户与助手都改得到）：和文字一样，转义之后才拼进页面。 */
    function volumeTitle(volume) { return '第 ' + esc(volume.no) + ' 卷' + (volume.title ? '《' + esc(volume.title) + '》' : ''); }

    function keepListHtml() {
      if (volumeEntries === null) return '<p class="ra-note">正在读取本卷建过档的世界书条目…</p>';
      if (!volumeEntries.length) return '<p class="ra-note">这一卷没有新建世界书条目。</p>';
      var npc = volumeEntries.filter(function (item) { return item.roleKind !== 'temp_event'; });
      var temp = volumeEntries.filter(function (item) { return item.roleKind === 'temp_event'; });
      return (npc.length ? '<p class="ra-note">本卷新建的角色条目——勾着的保留启用，去掉勾的停用（只关不删）：</p><div class="rd-keep">' + npc.map(function (item) {
        return '<label class="ra-check"><input type="checkbox" data-d="keep" value="' + esc(item.id) + '"' + (item.enabled ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>' + esc(item.name) + '<span class="ra-hint">《' + esc(item.book) + '》</span></span></label>';
      }).join('') + '</div>' : '')
        + (temp.length ? '<p class="ra-note">一次性的场面与龙套条目会自动停用（只关不删）：' + temp.map(function (item) { return esc(item.name); }).join('、') + '</p>' : '');
    }

    /* 断点横幅里的草稿进度：已经落盘的稿子不会丢，继续时沿当前草稿接着写。 */
    function draftProgressHtml(a, verb) {
      var w = a && a.workspace;
      var parts = [];
      if (w && w.outlineChars) parts.push('已保存草稿进度（' + draftShape(w) + '），' + verb + '将直接沿当前草稿接续，不会从头重写');
      else if (w && !w.empty) parts.push('草稿工作台里已有 ' + count(w.totalChars) + ' 字的笔记与段落，' + verb + '时会接着用');
      if (w && w.partial && w.partial.length) parts.push(w.partial.join('、') + ' 是断流时抢救下来的半稿，会先补完再定稿');
      if (a && a.partialChars) parts.push('上次断流时已收到的 ' + count(a.partialChars) + ' 字也已保存，' + verb + '时会先抢救进草稿');
      return parts.length ? '<p class="rd-draft-progress">' + esc(parts.join('；')) + '。</p>' : '';
    }

    function statusHtml(s) {
      var label = STATE_LABEL[s.state] || [s.state, ''];
      var busy = !!s.work;
      var title = '';
      if (s.volume) title = volumeTitle(s.volume);
      else if (s.plan) title = s.state === 'planning' ? '总导演正在勘察并编纲' : '这一卷的大纲还没有定稿';
      else if (s.state === 'idle') title = '这个聊天还没有开卷' + (s.volumeNo ? '（已完结 ' + esc(s.volumeNo) + ' 卷）' : '');
      else if (s.state === 'loading') title = '正在读取这个聊天的导演档案…';
      else title = '打开一个聊天，就可以让导演开卷';

      var html = '<div class="rd-top"><div class="rd-title">' + title + '</div><span class="ra-badge ' + label[1] + '">' + label[0] + '</span>'
        + (s.work ? '<span class="ra-badge is-warn">' + esc(s.work.label) + '中</span>' : '') + '</div>';
      html += '<div class="rd-switches">' + switchField('global', s.globalEnabled, '导演总开关', '所有聊天默认开不开；各聊天可以单独设')
        + (s.hasChat ? selectField('chat-switch', '这个聊天', [['follow', '跟随总开关（现在：' + (s.globalEnabled ? '开' : '关') + '）'], ['on', '单独开启'], ['off', '单独关闭']],
          s.chatSwitch === null ? 'follow' : s.chatSwitch ? 'on' : 'off') : '') + '</div>';

      if (s.volume) {
        var v = s.volume;
        html += '<div class="rd-meta"><span>' + (v.totalPhases ? 'Phase ' + esc(v.phaseCursor) + ' / ' + esc(v.totalPhases) : 'Phase ' + esc(v.phaseCursor)) + '</span>'
          + '<span>第 ' + esc(v.turn) + ' 回合' + (v.judgedTurn !== v.turn ? '（场记看到第 ' + esc(v.judgedTurn) + ' 回合）' : '') + '</span>'
          + '<span>大纲第 ' + esc(v.version) + ' 版</span><span>' + (DRIFT_LABEL[v.driftLevel] || '') + '</span>'
          + '<span>' + (v.hasBrief ? '简报' + (v.briefExact ? '已备好' : '是上一次的（等下一次巡检）') : '还没有简报') + '</span>'
          + '<span>硬事实 ' + esc(v.facts.length) + ' 条</span>' + (s.created ? '<span>已建档 ' + esc(s.created) + ' 个条目</span>' : '') + '</div>';
        if (v.phases.length) {
          html += track(v.phases.map(function (phase) {
            return { title: phase.title || 'Phase ' + phase.n, on: phase.n < v.phaseCursor ? 'done' : phase.n === v.phaseCursor ? 'now' : 'todo' };
          }));
        }
        if (v.progress || v.reason) {
          html += '<div class="rd-progress">' + (v.progress ? '<b>进度</b>' + esc(v.progress) : '') + (v.progress && v.reason ? '<br>' : '') + (v.reason ? '<b>场记</b>' + esc(v.reason) : '') + '</div>';
        }
        if (!s.enabled) html += '<div class="rd-banner"><h4>导演在这个聊天里是关着的</h4><p>这一卷的状态都留着，但不会注入简报、也不会巡检。打开上面的开关就接着执导。</p></div>';
        else if (!s.slot) html += '<div class="rd-banner"><h4>简报暂时注入不了</h4><p>正文提示词模块还没有就绪（多半是页面还在加载）。编纲与巡检不受影响。</p></div>';
        if (s.forked) html += '<div class="rd-banner"><h4>当前楼层与导演的记录对不上</h4><p>多半是开了分支，或大段删改了聊天。在重新对齐之前不注入简报；下一次巡检会自动对齐，也可以现在点「立即巡检」。</p></div>';
      }
      if (s.lastError) {
        html += '<div class="rd-banner is-bad"><h4>' + (s.pausedBy === 'failures' ? '连续失败，已自动暂停' : '上一次没有成功') + '</h4><p>' + esc(s.lastError) + '</p>'
          + (s.pausedBy === 'failures' ? '<p>先到「设置 → 导演模型」检查连接，再点「恢复」。</p>' : '') + '</div>';
      }
      if (s.plan && s.state === 'draft') {
        html += '<div class="rd-banner' + (s.plan.state === 'failed' ? ' is-bad' : '') + '"><h4>编纲断点待续'
          + (s.plan.toolCalls ? '（已查 ' + esc(s.plan.toolCalls) + ' 项资料）' : '') + '</h4><p>'
          + esc(DRAFT_NOTE[s.plan.state] || '') + (s.plan.error ? '<br>' + esc(s.plan.error) : '') + '</p>' + draftProgressHtml(s.plan, '继续编纲') + '</div>';
      }
      if (s.volume && s.restructureDraft && s.state !== 'restructuring') {
        var rs = s.restructureDraft;
        if (rs.stale) {
          html += '<div class="rd-banner is-bad"><h4>结构重构断点已过期'
            + (rs.toolCalls ? '（已查 ' + esc(rs.toolCalls) + ' 项资料）' : '') + '</h4><p>'
            + '当前聊天楼层或大纲版本已经前进，旧的重构断点不能直接续传或落盘；请点「放弃重构断点」后按最新剧情重新发起重构。</p>'
            + '<div class="rd-acts">'
            + button('dir-rs-discard', '放弃重构断点', 'is-ghost is-small', busy)
            + '</div></div>';
        } else {
          html += '<div class="rd-banner' + (rs.state === 'failed' ? ' is-bad' : '') + '"><h4>结构重构断点待续'
            + (rs.toolCalls ? '（已查 ' + esc(rs.toolCalls) + ' 项资料）' : '') + '</h4><p>'
            + esc(RS_NOTE[rs.state] || '') + (rs.error ? '<br>' + esc(rs.error) : '') + '</p>' + draftProgressHtml(rs, '继续重构')
            + '<div class="rd-acts">'
            + button('dir-rs-resume', '继续重构', 'is-main is-small', busy)
            + (rs.canForceCommit ? button('dir-rs-force', '按当前重构稿落盘', 'is-small', busy) : '')
            + button('dir-rs-discard', '放弃重构断点', 'is-ghost is-small', busy)
            + '</div></div>';
        }
      }
      if (s.volume && (s.state === 'pending_finish' || finishing)) {
        html += '<div class="rd-banner"><h4>' + (finishing && s.state !== 'pending_finish' ? '完结这一卷？' : '这一卷已经走到落幕') + '</h4>'
          + '<p>完结之后：沉淀一份卷档案与跨卷钩子留给下一卷，清掉这一卷的运行状态与简报。归档前的样子会留一份，可以一键恢复。</p>'
          + keepListHtml()
          + '<div class="rd-acts">' + button('dir-finish', '确认完结并归档', 'is-main', busy) + button('dir-finish-cancel', s.state === 'pending_finish' ? '接着往下演' : '先不完结', '', busy) + '</div></div>';
      }

      var acts = [];
      if (busy && s.work.here) acts.push(button('dir-stop', s.work.kind === 'plan' ? '暂停编纲' : '停止' + esc(s.work.label), 'is-bad'));
      if (s.state === 'idle') {
        acts.push(button('dir-activate', '开卷：勘察并编纲', 'is-main', busy));
        if (s.canRestoreArchive) acts.push(button('dir-restore', '恢复上一卷', '', busy, ' title="把最近一次归档（或放弃）的那一卷恢复成执导中"'));
      } else if (s.state === 'draft') {
        acts.push(button('dir-resume', '继续编纲', 'is-main', busy));
        if (s.plan && s.plan.canForceCommit) acts.push(button('dir-draft-force', '忽略自检按当前稿定稿', '', busy, ' title="按草稿工作台（或最近一次交付）里的当前一稿定稿：大纲、索引与简报结构完整，跳过自检告警；结构硬伤仍会拦下"'));
        acts.push(button('dir-draft-discard', '放弃草稿', 'is-ghost', busy));
      } else if (s.volume) {
        if (s.paused) acts.push(button('dir-resume', '恢复执导', 'is-main', busy));
        else acts.push(button('dir-pause', '暂停', '', false));
        acts.push(button('dir-patrol', '立即巡检', '', busy));
        acts.push(button('dir-restructure', '重构大纲', '', busy, ' title="让总导演按既成事实重写后续；想附意见就先写在下面的输入框里"'));
        if (s.canUndoRestructure) acts.push(button('dir-undo', '撤回重构', '', busy));
        if (s.state !== 'pending_finish' && !finishing) acts.push(button('dir-finish-ask', '完结本卷', '', busy));
        acts.push(button('dir-volume-discard', '放弃本卷', 'is-ghost', busy));
      }
      if (acts.length) html += '<div class="rd-acts">' + acts.join('') + '</div>';
      return html;
    }

    function renderStatus(s) {
      replaceBlock('rd-status-body', statusHtml(s));
    }

    /* ---------- 工作流与插话 ---------- */

    function directorJobs() { return jobs ? jobs.list().filter(function (job) { return job.owner === 'director'; }) : []; }

    function liveText() {
      var list = directorJobs();
      if (!list.length) return '';
      var job = list[0];
      var head = job.title + ' · ' + (job.state === 'running' ? (job.stage || '进行中') + (job.steps ? '（' + Math.min(job.step, job.steps) + '/' + job.steps + '）' : '') : job.result || '结束');
      return [head].concat(job.lines.slice(-16)).join('\n');
    }

    function sayKey(s) {
      if (s.state === 'planning') return 'planning';
      if (s.state === 'restructuring') return 'restructuring';
      if (s.state === 'draft') return 'draft';
      if (s.state === 'idle') return 'idle';
      if (s.volume) return 'running';
      return '';
    }

    /*
     * 总导演的工作态（编纲与重构同一个样子）：一行「此刻在做什么」，一排指标徽章。
     * 它是在一个会话里自己决定查什么、写什么的只读 Agent，没有固定的步数，所以这里不画步骤条；
     * 正在查的那一项、每一步的过程在紧挨着的实时日志（#rd-live）里。
     */
    function count(value) { return String(Math.max(0, Math.trunc(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

    /* 草稿工作台的一句话进度：「3,200 字，含板块 A–C · Phase 1–2」。 */
    function draftShape(w) {
      if (!w || !w.outlineChars) return '';
      return count(w.outlineChars) + ' 字' + (w.shape ? '，含' + w.shape : '');
    }

    function agentHtml(kind, a, note) {
      var stale = a.stale === true;
      var w = a.workspace || null;
      var badges = [
        '<span class="ra-badge">已查阅 ' + esc(a.toolCalls || 0) + ' 项资料</span>',
        '<span class="ra-badge">工具 ' + esc(a.rounds || 0) + ' 轮</span>'
      ];
      if (w && w.outlineChars) badges.push('<span class="ra-badge is-ok" data-draft="outline">草稿 ' + esc(count(w.outlineChars)) + ' 字' + (w.sectionRange ? ' · 板块 ' + esc(w.sectionRange) : '') + '</span>');
      else if (w && !w.empty) badges.push('<span class="ra-badge" data-draft="notes">草稿笔记 ' + esc(count(w.totalChars)) + ' 字</span>');
      if (w && w.partial && w.partial.length) badges.push('<span class="ra-badge is-warn">半稿待补：' + esc(w.partial.join('、')) + '</span>');
      if (a.partialChars) badges.push('<span class="ra-badge is-warn">断流半稿 ' + esc(count(a.partialChars)) + ' 字待接续</span>');
      if (a.revisions) badges.push('<span class="ra-badge is-warn">自动重写 ' + esc(a.revisions) + ' / ' + esc(a.maxRevisions || 2) + ' 次</span>');
      if (!stale) badges.push(a.hasCheckpoint ? '<span class="ra-badge is-ok">断点已保存</span>' : '<span class="ra-badge">尚无断点</span>');
      /* 流式接收中：思考与输出的字数实时跳动（不再一直停在「自主查阅与编纲中」）。 */
      var live = a.stream && (a.stream.reasoningChars || a.stream.textChars || a.stream.toolChars)
        ? '<p class="rd-agent-note" data-live="stream">' + [a.stream.reasoningChars ? '已思考 ' + count(a.stream.reasoningChars) + ' 字' : '',
          a.stream.textChars ? '已输出 ' + count(a.stream.textChars) + ' 字' : '', a.stream.toolChars ? '工具参数 ' + count(a.stream.toolChars) + ' 字' : ''].filter(Boolean).join(' · ') + '</p>'
        : '';
      return '<div class="rd-agent" data-kind="' + kind + '" data-state="' + esc(stale ? 'stale' : a.state) + '">'
        + '<div class="rd-agent-top"><span class="rd-agent-dot" aria-hidden="true"></span>'
        + '<b class="rd-agent-label">' + esc(stale ? '断点已过期' : a.activityLabel || '') + '</b>'
        + '<span class="rd-agent-kind">' + (kind === 'plan' ? '总导演 · 编纲' : '总导演 · 结构重构') + '</span></div>'
        + '<div class="rd-agent-stats">' + badges.join('') + '</div>'
        + live
        + (note ? '<p class="rd-agent-note">' + note + '</p>' : '') + '</div>';
    }

    function flowHeadHtml(s) {
      if (s.plan) return agentHtml('plan', s.plan, '');
      if (s.restructureDraft) return agentHtml('restructure', s.restructureDraft, s.restructureDraft.reason ? '重构原因：' + esc(s.restructureDraft.reason) : '');
      /* 重构刚发起、断点还没建起来的那一小会儿。 */
      if (s.state === 'restructuring') return agentHtml('restructure', { state: 'running', activityLabel: '整理既成事实中', toolCalls: 0, rounds: 0, revisions: 0, hasCheckpoint: false }, '');
      if (s.state === 'idle') {
        return '<p class="ra-note">开卷之后，总导演会在同一个只读 Agent 会话里主动查阅世界书、变量与前文，一气呵成编出完整动态大纲并通过铁血自检（发现问题自动打回重写，通过后才定稿清对话）；中途随时可以打开本页查看实时工作日志并自由插话，意外中断也可沿断点续编。</p>';
      }
      return '';
    }

    /* 实时日志下面：最近一版草稿（折叠着）与已经插过的话。 */
    var DRAFT_ORDER = ['outline.md', 'index.json', 'first_brief.md', 'self_check.md', 'restructure_note.md', 'notes.md'];
    function flowDraftHtml(s) {
      var a = s.plan || s.restructureDraft;
      if (!a) return '';
      var plan = !!s.plan, html = '';
      var w = a.workspace, files = a.draftFiles || {};
      if (w && !w.empty) {
        /* 草稿工作台：总导演边写边存的那一稿（不必等定稿或失败才看得见）。大纲在最前面，其余槽位跟在后面。 */
        var slots = (w.slots || []).filter(function (slot) { return slot.written; });
        var body = '<p class="ra-note">' + (w.slots || []).map(function (slot) {
          return esc(slot.file) + '：' + (slot.written ? esc(count(slot.chars)) + ' 字' + (slot.partial ? '（半稿）' : '') : '未写');
        }).join('；') + '</p>'
          + DRAFT_ORDER.filter(function (name) { return slots.some(function (slot) { return slot.file === name; }); }).map(function (name) {
            return '<div class="ra-sub">' + esc(name) + '</div><div class="rd-pre" data-draft-file="' + esc(name) + '">' + esc(files[name] || '') + '</div>';
          }).join('');
        html += fold(plan ? 'ws-draft' : 'rs-ws-draft', (plan ? '草稿预览（' : '重构草稿预览（') + (w.outlineChars ? 'outline.md ' + esc(draftShape(w)) : '共 ' + esc(count(w.totalChars)) + ' 字') + '）', body, false);
      } else if (a.lastOutput) {
        html += fold(plan ? 'last-out' : 'rs-last-out', (plan ? '最近一版草稿预览（' : '最近一版重构草稿预览（') + esc(a.lastOutput.length) + ' 字）', '<div class="rd-pre">' + esc(a.lastOutput) + '</div>', false);
      }
      if (a.feedback.length) {
        html += '<p class="ra-note">' + (plan ? '已插话的意见：' : '重构插话意见：') + a.feedback.map(function (item) { return '「' + esc(item.text) + '」'; }).join('；') + '</p>';
      }
      return html;
    }

    function flowPendingHtml(s) {
      if (!s.pending.length) return '';
      return '<div class="ra-sub">待建档的新角色</div><p class="ra-note">导演在大纲里新引入的人物。写入时按世界书模板生成条目；写进去之后能在「设置 → 改动记录」里撤销。</p>'
        + s.pending.map(function (item) {
          var writing = item.status === 'writing';
          return '<div class="rd-entry"><div class="rd-entry-main"><b>' + esc(item.name) + '</b> <span class="ra-badge">' + (item.kind === 'temp_event' ? '一次性' : '新角色') + '</span>'
            + (item.status === 'failed' ? ' <span class="ra-badge is-bad">没写成</span>' : writing ? ' <span class="ra-badge is-warn">写入中</span>' : '')
            + (item.brief ? '<p>' + esc(item.brief) + '</p>' : '') + (item.error ? '<p class="is-error">' + esc(item.error) + '</p>' : '') + '</div>'
            + '<div class="ra-row">' + button('dir-entry-write', item.status === 'failed' ? '重试写入' : '写入世界书', 'is-small', writing || !!s.work, ' data-entry="' + esc(item.id) + '"')
            + button('dir-entry-skip', '忽略', 'is-small is-ghost', writing, ' data-entry="' + esc(item.id) + '"') + '</div></div>';
        }).join('');
    }

    /*
     * 稳定更新插话框：只在首次挂载时创建 <textarea id="rd-say-text">，之后仅就地更新文案和禁用态，
     * 彻底避免编纲/重构逐轮写断点时重建 DOM 打断中文输入法组字、光标、撤销栈与手机软键盘。
     */
    function updateSayBox(s) {
      var box = $('#rd-flow-say');
      if (!box) return;
      var key = sayKey(s);
      if (!key) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      if (!$('#rd-say-text')) {
        box.innerHTML = '<div class="rd-say"><label id="rd-say-label" for="rd-say-text"></label>'
          + '<textarea id="rd-say-text" rows="2"></textarea>'
          + '<div class="ra-row" id="rd-say-row">' + button('dir-say', '提交意见', 'is-small', false, ' id="rd-say-btn"') + '</div></div>';
      }
      var allowLiveInterject = key === 'planning' || key === 'restructuring';
      var btnLabel = key === 'running' ? (s.restructureDraft && !s.restructureDraft.stale ? '附上意见并继续重构' : '提交意见并重构')
        : key === 'draft' ? '附上意见并续编'
        : allowLiveInterject ? '立即插话' : '提交意见';
      var label = $('#rd-say-label');
      if (label && label.textContent !== SAY_LABEL[key]) label.textContent = SAY_LABEL[key];
      var input = $('#rd-say-text');
      var ph = key === 'idle' ? '例如：这一卷想要一场不带阴谋的节日日常。' : '例如：先查一下小白X里的好感度和银币变量，别让她这么快就原谅他。';
      if (input && input.placeholder !== ph) input.placeholder = ph;
      var row = $('#rd-say-row');
      if (row) row.hidden = key === 'idle';
      var btn = $('#rd-say-btn');
      if (btn) {
        if (btn.textContent !== btnLabel) btn.textContent = btnLabel;
        btn.disabled = !allowLiveInterject && !!s.work;
      }
    }

    /*
     * 工作流卡从上到下：工作态摘要 → 活动条 → 实时日志 → 草稿预览 → 插话框 → 待建档的角色。
     * 摘要与草稿两块内容没变就不重画（sticky）；日志只换文字；插话框是固定的节点（见 updateSayBox）。
     */
    function renderFlow(s) {
      replaceBlock('rd-flow-head', flowHeadHtml(s), true);
      /* 导演在这个聊天里有活在跑：一条循环的活动条（不是进度——它没有固定的步数）。 */
      var bar = $('#rd-flow-bar');
      if (bar) bar.hidden = !(s.work && s.work.here);
      updateLive();
      replaceBlock('rd-flow-draft', flowDraftHtml(s), true);
      updateSayBox(s);
      replaceBlock('rd-flow-pending', flowPendingHtml(s));
    }

    function updateLive() {
      var live = $('#rd-live');
      if (live) live.textContent = liveText();
    }

    /* ---------- 大纲与简报 ---------- */

    function archiveHtml(archive) {
      if (!archive.volumes.length) return '<p class="ra-note">还没有完结的卷。</p>';
      return archive.volumes.slice().reverse().map(function (volume) {
        return '<div class="rd-vol"><h4>第 ' + esc(volume.volumeNo) + ' 卷' + (volume.title ? '《' + esc(volume.title) + '》' : '') + '</h4>'
          + '<p class="ra-note">' + esc(time(volume.finishedAt)) + ' · 演了 ' + esc(Number(volume.turns) || 0) + ' 个回合' + (volume.fallback ? ' · 档案由进度摘要兜底生成' : '') + '</p>'
          + '<p>' + esc(volume.summary) + '</p>'
          + (Array.isArray(volume.hooks) && volume.hooks.length ? '<ul class="ra-list">' + volume.hooks.map(function (hook) { return '<li>' + esc(hook) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
      }).join('');
    }

    function snapshotsHtml(list, busy) {
      if (!list.length) return '<p class="ra-note">还没有快照。</p>';
      return list.map(function (item) {
        return '<div class="rd-snap" data-match="' + (item.matches ? '1' : '0') + '"><div>'
          + (item.floor >= 0 ? '#' + esc(item.floor) + ' 楼' : '开卷时') + ' · ' + (KIND_LABEL[item.kind] || esc(item.kind)) + ' · Phase ' + esc(item.phaseCursor) + (item.phaseTitle ? '（' + esc(item.phaseTitle) + '）' : '')
          + ' · ' + (DRIFT_LABEL[item.driftLevel] || '') + ' · 大纲第 ' + esc(item.outlineVersion) + ' 版'
          + (item.current ? ' <span class="ra-badge is-ok">当前</span>' : item.matches ? '' : ' <span class="ra-badge">楼层已变</span>')
          + '<small>' + esc(time(item.at)) + (item.progress ? ' · ' + esc(item.progress) : '') + '</small></div>'
          + (item.current ? '' : button('dir-rollback', '用这一条', 'is-small', busy, ' data-snap="' + esc(item.id) + '" title="把这条快照的状态、简报与大纲版本用到当前楼层上"')) + '</div>';
      }).join('');
    }

    async function renderDocs(s) {
      var body = $('#rd-docs-body');
      if (!body) return;
      var serial = ++docsSerial;
      var active = !!s.volume;
      var archive = { volumes: [], canRestore: false }, brief = null, outline = null, snapshots = [];
      try {
        archive = await director.getArchive();
        if (active) { brief = await director.getBrief(); outline = await director.getOutline(); snapshots = await director.listSnapshots(); }
      } catch (error) {
        active = false;
        say('读取大纲与简报失败：' + message(error), true);
      }
      if (serial !== docsSerial || !$('#rd-docs-body')) return;
      var card = $('#rd-docs-card');
      if (card) card.hidden = !active && !archive.volumes.length;
      var html = '';
      if (active) {
        var limit = core ? core.BRIEF_LIMIT : 1200;
        html += '<div class="ra-field-stack"><label for="rd-brief">下一轮的导演简报'
          + '<span class="ra-hint">正文生成之前注入的就是它（位置在「设置 → 正文提示词位置 → 导演简报」）。' + (brief.forked ? '当前楼层与记录对不上，暂不注入。' : brief.exact ? '已按最新一楼备好。' : '这是上一次巡检留下的，下一次巡检后更新。') + '</span></label>'
          + '<textarea id="rd-brief" data-d="brief" rows="9" spellcheck="false" placeholder="还没有简报：点「立即巡检」让场记写一份，或自己写。">' + esc(brief.text) + '</textarea></div>'
          + '<div class="ra-row ra-mt">' + button('dir-brief-save', '保存简报', 'is-small') + '<span class="ra-note" id="rd-brief-count">' + brief.text.length + ' / ' + limit + ' 字</span></div>';
        html += fold('outline', '当前大纲（第 ' + esc(outline.version) + ' 版' + (outline.index && outline.index.totalPhases ? ' · ' + esc(outline.index.totalPhases) + ' 个 Phase' : '') + '）',
          '<p class="ra-note">两次结构重构之间，大纲是只读的静态前缀（场记每轮都带着它，改一个字就要重新计费）。在这里改完保存，会存成新的一版并从当前楼层起生效；板块 C 的「后台完整实情」只有导演能看，不会进简报。</p>'
          + '<textarea id="rd-outline" class="rd-editor" data-d="outline" rows="16" spellcheck="false">' + esc(outline.text) + '</textarea>'
          + '<div class="ra-row ra-mt">' + button('dir-outline-save', '保存为新的一版', 'is-small', !!s.work) + '<span class="ra-note">留存的版本：'
          + outline.versions.map(function (item) { return '第 ' + esc(item.n) + ' 版' + (item.note ? '（' + esc(item.note) + '）' : ''); }).join('、') + '</span></div>');
        html += fold('snaps', '楼层快照（' + esc(snapshots.length) + ' 条）',
          '<p class="ra-note">每次巡检都把「状态 + 下一轮简报」存成锚在那一楼的快照：重掷、删楼、改楼之后，自动取对得上的那一条。也可以手动把某一条用到当前楼层上。</p>' + snapshotsHtml(snapshots, !!s.work));
      }
      html += fold('archive', '已完结的卷（' + esc(archive.volumes.length) + '）', archiveHtml(archive));
      replaceBlock('rd-docs-body', html);
      dirty.brief = dirty.outline = false;
    }

    /* ---------- 配置 ---------- */

    /*
     * 配置卡分四块：运行参数、长期偏好、总导演 Skill、场记 Skill。各画各的、各记各的「有没有没保存的改动」：
     * 一块重画不碰另外三块——存了总导演 Skill，场记 Skill 编辑框里打到一半的字还在。
     * 折叠面板的外壳只建一次，之后只换各自面板里面的那一块，所以面板开没开也不会被重画打回去。
     */
    function configSkeleton() {
      var body = $('#rd-config-body');
      if (!body) return false;
      if ($('#rd-cfg-run')) return true;
      body.innerHTML = fold('cfg-run', '运行参数', '<div id="rd-cfg-run"></div>') + fold('cfg-pref', '长期偏好', '<div id="rd-cfg-pref"></div>')
        + SKILL_ROLES.map(function (role) { return fold('cfg-skill-' + role, SKILL_TITLE[role], '<div id="rd-cfg-skill-' + role + '"></div>'); }).join('');
      return true;
    }

    function renderRun() {
      if (!configSkeleton()) return;
      var settings = director.getSettings();
      var templates = [];
      try { templates = director.listTemplates(); } catch (error) { templates = []; }
      replaceBlock('rd-cfg-run', '<div class="ra-nums">'
        + numberField('injectEvery', '每几个回合注入一次', settings.injectEvery, 1, 20)
        + numberField('patrolEvery', '每几个回合巡检一次', settings.patrolEvery, 1, 20)
        + numberField('l2Cooldown', '重构后冷却几个回合', settings.l2Cooldown, 0, 20)
        + numberField('plannerMaxTokens', '编纲回复上限（tokens）', settings.plannerMaxTokens, 2048, 65536, 256)
        + numberField('judgeMaxTokens', '场记回复上限（tokens）', settings.judgeMaxTokens, 512, 16384, 128)
        + numberField('timeoutSec', '请求超时（秒）', Math.round(settings.timeoutMs / 1000), 20, 900)
        + selectField('cfg.floatMode', '状态浮窗', [['all', '显示全部后台任务'], ['major', '只显示编纲、重构、归档']], settings.floatMode)
        + selectField('cfg.wbPolicy', '新角色建档', [['preview', '列出来等我点写入'], ['auto', '权限允许时自动写入'], ['none', '不建档']], settings.wbPolicy)
        + selectField('cfg.wbTemplateId', '角色条目模板', [['', '模板库的默认模板']].concat(templates.map(function (item) { return [item.id, item.name + (item.builtin ? '（内置）' : '') + ' → ' + item.targetWorldbook]; })), settings.wbTemplateId)
        + '</div>'
        + '<p class="ra-note">总导演流式接收：请求超时按「连续多久没有收到新数据」计，模型一直在思考或输出就不会被掐断（另有 6 倍超时、至少 30 分钟的总时长上限）；通道不支持流式时仍是整次请求的总时长。</p>'
        + switchField('cfg.autoArchive', settings.autoArchive, '满足完结条件后自动归档', '关着时会停在「待完结」等你确认；自动归档时新角色条目全部保留，一次性条目照常停用')
        + '<div class="ra-row ra-mt">' + button('dir-config-save', '保存配置', 'is-small is-main')
        + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-director-model-card">导演用哪个模型</button>'
        + '<button type="button" class="ra-btn is-small" data-act="guide-jump" data-tab-target="settings" data-section="ra-placement-card">简报注入在哪</button></div>');
      dirty.config = false;
    }

    /* force 为 false 时，读回来之前用户已经动手改了就不再覆盖。 */
    async function renderPrefs(force) {
      if (!configSkeleton()) return;
      var serial = ++prefsSerial;
      var prefs = { global: '', card: '', hasCard: false, cardLabel: '' };
      try { prefs = await director.getPreferences(); } catch (error) { /* 读不到偏好就当没有 */ }
      if (serial !== prefsSerial || !$('#rd-cfg-pref') || (!force && dirty.prefs)) return;
      replaceBlock('rd-cfg-pref', '<p class="ra-note">偏好的优先级高于两份 Skill 的一切默认规则：题材与气质、甜度与虐度、想看与不想看的套路、角色的去留、指定的关系底线……编纲、巡检、重构、归档都会带上。</p>'
        + '<div class="ra-stack"><div class="ra-field-stack"><label for="rd-pref-global">全局偏好（所有聊天）</label>'
        + '<textarea id="rd-pref-global" data-d="pref" rows="5" placeholder="例如：不要为了显得深刻硬凑代价；日常戏多一些。">' + esc(prefs.global) + '</textarea></div>'
        + '<div class="ra-field-stack"><label for="rd-pref-card">这张卡的偏好' + (prefs.cardLabel ? ' · ' + esc(prefs.cardLabel) : '') + '<span class="ra-hint">跟着角色卡（或群）走，换一个聊天还在；与全局冲突时以这里为准</span></label>'
        + '<textarea id="rd-pref-card" data-d="pref" rows="5"' + (prefs.hasCard ? '' : ' disabled') + ' placeholder="' + (prefs.hasCard ? '例如：这张卡里她和主角已经是过命的交情，不许写猜忌。' : '打开一个聊天后可以填写') + '">' + esc(prefs.card) + '</textarea></div></div>'
        + '<div class="ra-row">' + button('dir-pref-save', '保存偏好', 'is-small is-main') + '</div>');
      dirty.prefs = false;
    }

    /* 一份 Skill 的编辑区：生效来源与路径、正文、保存 / 恢复内置默认 / 导出 / 导入。按钮上的 data-skill 说明是哪一份。 */
    function skillHtml(role, skill) {
      var custom = skill.source === 'user';
      var which = ' data-skill="' + role + '"';
      return '<div class="rd-skill-head"><span class="ra-badge' + (custom ? ' is-ok' : '') + '">' + (custom ? '工作区自定义' : '内置默认') + '</span>'
        + '<span>' + (custom ? '现在生效的是工作区里你改过的这一份：' : '现在生效的是随包内置的默认版本；保存后存到：') + '<code>' + esc(skill.path) + '</code></span></div>'
        + '<p class="ra-note">' + SKILL_NOTE[role] + '</p>'
        + '<textarea id="rd-skill-' + role + '" class="rd-skill is-code" data-d="skill.' + role + '" rows="16" spellcheck="false" aria-label="' + SKILL_TITLE[role] + '">' + esc(skill.text) + '</textarea>'
        + '<div class="ra-row ra-mt">' + button('dir-skill-save', '保存', 'is-small is-main', false, which) + button('dir-skill-reset', '恢复内置默认', 'is-small', !custom, which)
        + button('dir-skill-export', '导出 .md', 'is-small', false, which) + button('dir-skill-import', '导入 .md', 'is-small', false, which)
        + '<input type="file" id="rd-skill-file-' + role + '" data-skill-file="' + role + '" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden></div>';
    }

    async function renderSkill(role, force) {
      if (!configSkeleton()) return;
      var serial = ++skillSerial[role];
      var skill = null, failed = '';
      try { skill = await director.getSkill(role); } catch (error) { failed = message(error); }
      if (serial !== skillSerial[role] || !$('#rd-cfg-skill-' + role) || (!force && dirty.skill[role])) return;
      replaceBlock('rd-cfg-skill-' + role, failed ? '<p class="ra-tip is-bad">' + esc(failed) + '</p>' : skillHtml(role, skill));
      dirty.skill[role] = false;
    }

    /* 整张配置卡：每一块只在没有未保存的改动时重画。 */
    function renderConfig() {
      if (!configSkeleton()) return;
      if (!dirty.config) renderRun();
      if (!dirty.prefs) renderPrefs(false);
      SKILL_ROLES.forEach(function (role) { if (!dirty.skill[role]) renderSkill(role, false); });
    }

    /* ---------- 整页 ---------- */

    function skeleton() {
      var pane = scroller();
      if (!pane || $('#rd-status-card')) return !!pane;
      pane.innerHTML = view.card('rd-status-card', '导演', '<div id="rd-status-body"></div>')
        + view.card('rd-flow-card', '工作流与插话',
          '<div id="rd-flow-body"><div id="rd-flow-head"></div><div class="rd-agent-bar" id="rd-flow-bar" aria-hidden="true" hidden><i></i></div>'
          + '<div class="rd-live" id="rd-live" aria-live="polite"></div><div id="rd-flow-draft"></div><div id="rd-flow-say"></div><div id="rd-flow-pending"></div></div>')
        + view.card('rd-docs-card', '大纲与简报', '<div id="rd-docs-body"></div>')
        + view.card('rd-config-card', '配置', '<div id="rd-config-body"></div>', '单独保存');
      return true;
    }

    function loadVolumeEntries(s) {
      if (!s.volume || !(s.state === 'pending_finish' || finishing)) { volumeEntries = null; return; }
      if (volumeEntries !== null) return;
      director.listVolumeEntries().then(function (list) {
        volumeEntries = list;
        if (visible) renderStatus(director.getStatus());
      }, function () { volumeEntries = []; });
    }

    function refresh(reason) {
      if (!visible || !skeleton()) return;
      var s = director.getStatus();
      /*
       * 流式进度一秒刷两三次：只重画工作态的那一行与实时日志，不动状态卡（按钮在那里，重建会吞掉正按着的点击）、
       * 不动草稿预览与插话框（IME 组字、滚动位置都在那里）。
       */
      if (reason === 'stream') {
        replaceBlock('rd-flow-head', flowHeadHtml(s), true);
        updateLive();
        return;
      }
      if (s.chatLabel !== lastChatLabel) {
        lastChatLabel = s.chatLabel;
        clearSay();
      }
      var mark = s.chatLabel + '|' + (s.volume ? s.volume.id : s.state === 'draft' || s.state === 'planning' ? 'plan' : '');
      if (mark !== chatMark) {
        /* 换了聊天、或这一卷开始 / 结束了：编辑框里的东西属于上一个对象，不再留着。 */
        chatMark = mark;
        dirty.brief = dirty.outline = false;
        finishing = false;
        volumeEntries = null;
        reason = 'all';
      }
      if (!s.volume) finishing = false;
      loadVolumeEntries(s);
      renderStatus(s);
      renderFlow(s);
      var all = reason === 'all' || reason === undefined;
      if ((all || /^(volume|patrol|chat|session|entries|work)$/.test(reason)) && !dirty.brief && !dirty.outline) renderDocs(s);
      /* 配置卡的四块各管各的：哪一块有没保存的改动，哪一块就不重画。 */
      if (all) renderConfig();
      else if (reason === 'settings') { if (!dirty.config) renderRun(); }
      else if (reason === 'preferences') { if (!dirty.prefs) renderPrefs(false); }
      else if (reason === 'skill') SKILL_ROLES.forEach(function (role) { if (!dirty.skill[role]) renderSkill(role, false); });
    }

    function show() {
      if (!director) {
        var pane = scroller();
        if (pane) pane.innerHTML = view.card('rd-status-card', '导演', '<p class="ra-note">导演还没有就绪。</p>');
        return;
      }
      visible = true;
      if (!stops.length) {
        stops.push(director.onChange(function (reason) { if (visible) refresh(reason); }));
        if (jobs) stops.push(jobs.onChange(function (job) { if (visible && job.owner === 'director') updateLive(); }));
      }
      refresh('all');
    }

    function hide() { visible = false; }

    /* ---------- 操作 ---------- */

    function sayText() { var input = $('#rd-say-text'); return input ? input.value.trim() : ''; }
    function clearSay() { var input = $('#rd-say-text'); if (input) input.value = ''; }

    /* 危险的按钮要点两次：第一次点完变成「再点一次……」，三秒不点就恢复。 */
    function armed(actor, again) {
      var key = armedKey(actor);
      var state = armedState[key];
      if (state && state.until > Date.now()) {
        delete armedState[key];
        actor.removeAttribute('data-armed');
        return true;
      }
      var mine = { until: Date.now() + 3000, again: again, label: actor.textContent };
      armedState[key] = mine;
      actor.setAttribute('data-armed', '1');
      actor.textContent = again;
      setTimeout(function () {
        if (armedState[key] !== mine) return;
        delete armedState[key];
        armedButtons(null, key).forEach(function (node) {
          if (node.getAttribute('data-armed') !== '1') return;
          node.removeAttribute('data-armed');
          node.textContent = mine.label;
        });
      }, 3000);
      return false;
    }

    /* 耗时的活（编纲、巡检、重构、归档）不等它做完：发起之后页面跟着事件更新，出了错再在底部说。 */
    function launch(promise, done) {
      Promise.resolve(promise).then(function (result) { if (done && visible) { var text = done(result); if (text) say(text); } }, function (error) { say(message(error), true); });
    }

    function readConfig() {
      var patch = {};
      var bad = null;
      Array.prototype.forEach.call($('#rd-config-body').querySelectorAll('[data-d^="cfg."]'), function (input) {
        var key = input.getAttribute('data-d').slice(4);
        if (input.type === 'checkbox') patch[key] = input.checked;
        else if (input.type === 'number') {
          if (input.value === '' || !input.validity.valid) bad = bad || input;
          patch[key] = Number(input.value);
        } else patch[key] = input.value;
      });
      if (bad) { bad.focus(); throw new Error('有一项数字填得不对：请按输入框允许的范围填写'); }
      if (patch.timeoutSec !== undefined) { patch.timeoutMs = patch.timeoutSec * 1000; delete patch.timeoutSec; }
      return patch;
    }

    /* 按钮上的 data-skill 说的是哪一份 Skill（planner 总导演 / patrol 场记）。 */
    function skillRole(actor) {
      var role = actor && typeof actor.getAttribute === 'function' ? actor.getAttribute('data-skill') : '';
      if (SKILL_ROLES.indexOf(role) < 0) throw new Error('不知道要操作哪一份 Skill');
      return role;
    }

    function exportSkill(role, text) {
      var Blob = host.Blob, urls = host.URL;
      if (!Blob || !urls || typeof urls.createObjectURL !== 'function') throw new Error('这个环境不支持导出文件：可以直接全选复制编辑框里的内容');
      var url = urls.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      var link = doc.createElement('a');
      link.href = url;
      link.download = (core && core.SKILL_NAMES ? core.SKILL_NAMES[role] : 'director-' + role) + '.SKILL.md';
      link.hidden = true;
      /* 放在窗口里再点：助手窗口是模态的，外面的元素点不动。 */
      scroller().appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { try { urls.revokeObjectURL(url); } catch (error) { /* ignore */ } }, 2000);
    }

    async function action(name, actor) {
      if (!director) return;
      try {
        if (name === 'dir-activate') {
          launch(director.activate({ feedback: sayText() }), function (result) { return result && result.done ? '大纲已定稿，导演开始执导' : ''; });
          clearSay();
        } else if (name === 'dir-resume') {
          launch(director.resume(), function (result) { return result && result.done ? '大纲已定稿，导演开始执导' : result && result.resumed ? '已恢复执导' : ''; });
        } else if (name === 'dir-pause') {
          await director.pause();
          say('已暂停：状态都留着，点「恢复执导」接着来');
        } else if (name === 'dir-stop') {
          director.stop();
        } else if (name === 'dir-draft-discard') {
          if (!armed(actor, '再点一次：丢掉草稿')) return;
          await director.discardDraft();
          say('草稿已丢弃');
        } else if (name === 'dir-draft-force') {
          if (!armed(actor, '再点一次：跳过自检直接定稿')) return;
          await director.commitDraftNow();
          say('已按当前草稿定稿，导演开始执导');
        } else if (name === 'dir-rs-resume') {
          launch(director.resumeRestructure(), function (result) { return result && result.version ? '大纲已重构为第 ' + result.version + ' 版' : ''; });
        } else if (name === 'dir-rs-force') {
          if (!armed(actor, '再点一次：按当前重构稿落盘')) return;
          var rsForced = await director.commitRestructureDraftNow();
          say('大纲已按当前重构稿落盘为第 ' + rsForced.version + ' 版');
        } else if (name === 'dir-rs-discard') {
          if (!armed(actor, '再点一次：放弃重构断点')) return;
          await director.discardRestructureDraft();
          say('重构断点已丢弃');
        } else if (name === 'dir-patrol') {
          launch(director.patrolNow(), function (result) { return result ? '巡检完成：' + (DRIFT_LABEL[result.level] || '') : ''; });
        } else if (name === 'dir-restructure') {
          var note = sayText();
          var curSt = director.getStatus();
          var againText = note ? '再点一次：按意见重构' : (curSt.restructureDraft ? '再点一次：放弃断点并重新重构' : '再点一次：重构大纲');
          if (!armed(actor, againText)) return;
          if (note) clearSay();
          Promise.resolve(note ? director.submitFeedback(note) : director.restructureNow('手动发起的结构重构')).then(function (result) {
            if (!visible) return;
            if (result && result.queued) say('已插话：总导演正带着你的新意见继续重构');
            else if (result && result.version) say('大纲已重构为第 ' + result.version + ' 版');
          }, function (error) {
            if (note && !sayText()) { var inp = $('#rd-say-text'); if (inp) inp.value = note; }
            say(message(error), true);
          });
        } else if (name === 'dir-undo') {
          if (!armed(actor, '再点一次：撤回重构')) return;
          var undone = await director.undoRestructure();
          say('已退回第 ' + undone.version + ' 版大纲');
        } else if (name === 'dir-finish-ask') {
          finishing = true;
          volumeEntries = null;
          refresh('status');
        } else if (name === 'dir-finish-cancel') {
          finishing = false;
          if (director.getStatus().state === 'pending_finish') await director.continueVolume();
          refresh('status');
        } else if (name === 'dir-finish') {
          var keep = Array.prototype.filter.call($('#rd-status-body').querySelectorAll('[data-d="keep"]'), function (box) { return box.checked; }).map(function (box) { return box.value; });
          var listed = volumeEntries && volumeEntries.some(function (item) { return item.roleKind !== 'temp_event'; });
          finishing = false;
          launch(director.finish({ keepEntryIds: listed ? keep : undefined }), function (result) {
            return result ? '第 ' + result.volumeNo + ' 卷已归档' + (result.disabled ? '，停用了 ' + result.disabled + ' 个条目' : '') + (result.notes && result.notes.length ? '；' + result.notes[0] : '') : '';
          });
        } else if (name === 'dir-restore') {
          if (!armed(actor, '再点一次：恢复上一卷')) return;
          var restored = await director.restoreLastArchive();
          say('第 ' + restored.volumeNo + ' 卷已恢复成执导中' + (restored.entries ? '，重新启用了 ' + restored.entries + ' 个条目' : ''));
        } else if (name === 'dir-volume-discard') {
          if (!armed(actor, '再点一次：放弃这一卷')) return;
          await director.discardVolume();
          say('这一卷已放弃（没有归档）。点错了可以用「恢复上一卷」找回来');
        } else if (name === 'dir-say') {
          var text = sayText();
          if (!text) { say('先写下你的意见', true); return; }
          clearSay();
          Promise.resolve(director.submitFeedback(text)).then(function (result) {
            if (!visible) return;
            if (result && result.queued) say('已插话：总导演正保留已查资料并按你的新意见继续');
            else if (result && result.done) say('大纲已定稿，导演开始执导');
            else if (result && result.version) say('大纲已重构为第 ' + result.version + ' 版');
          }, function (error) {
            /* 提交失败且输入框为空时自动回填，绝不丢用户刚打的意见。 */
            if (!sayText()) { var inp = $('#rd-say-text'); if (inp) inp.value = text; }
            say(message(error), true);
          });
        } else if (name === 'dir-entry-write') {
          launch(director.confirmPendingEntry(actor.getAttribute('data-entry')), function (result) {
            return result && result.ok ? '「' + result.name + '」已写入《' + result.book + '》' + (result.notes && result.notes.length ? '；' + result.notes[0] : '') : '';
          });
        } else if (name === 'dir-entry-skip') {
          await director.discardPendingEntry(actor.getAttribute('data-entry'));
        } else if (name === 'dir-brief-save') {
          var saved = await director.saveBrief($('#rd-brief').value);
          dirty.brief = false;
          $('#rd-brief').value = saved.text;
          say('简报已保存，下一次正文生成就用它');
        } else if (name === 'dir-outline-save') {
          var outline = await director.saveOutline($('#rd-outline').value);
          dirty.outline = false;
          say('大纲已存为第 ' + outline.version + ' 版，从当前楼层起生效');
        } else if (name === 'dir-rollback') {
          if (!armed(actor, '再点一次')) return;
          await director.rollbackTo(actor.getAttribute('data-snap'));
          say('已把这条快照的状态用到当前楼层上');
        } else if (name === 'dir-config-save') {
          director.saveSettings(readConfig());
          dirty.config = false;
          say('配置已保存');
        } else if (name === 'dir-pref-save') {
          var card = $('#rd-pref-card');
          await director.savePreferences(card && !card.disabled ? { global: $('#rd-pref-global').value, card: card.value } : { global: $('#rd-pref-global').value });
          dirty.prefs = false;
          say('偏好已保存，下一次编纲与巡检起生效');
        } else if (name === 'dir-skill-save') {
          /* 只存这一份、只重画这一份：另一份编辑框里没保存的字不受影响。 */
          var saveRole = skillRole(actor);
          await director.saveSkill(saveRole, $('#rd-skill-' + saveRole).value);
          await renderSkill(saveRole, true);
          say(SKILL_TITLE[saveRole] + '已保存到工作区，立刻生效');
        } else if (name === 'dir-skill-reset') {
          var resetRole = skillRole(actor);
          if (!armed(actor, '再点一次：丢掉修改')) return;
          await director.resetSkill(resetRole);
          await renderSkill(resetRole, true);
          say(SKILL_TITLE[resetRole] + '已恢复成内置的默认版本');
        } else if (name === 'dir-skill-export') {
          var exportRole = skillRole(actor);
          exportSkill(exportRole, $('#rd-skill-' + exportRole).value);
        } else if (name === 'dir-skill-import') {
          $('#rd-skill-file-' + skillRole(actor)).click();
        }
      } catch (error) {
        say(message(error), true);
      }
    }

    /* 导入只是把文件内容放进这一份的编辑框：要点「保存」才生效。 */
    function importSkill(input) {
      var role = input.getAttribute('data-skill-file');
      var file = input.files && input.files[0];
      input.value = '';
      if (!file || SKILL_ROLES.indexOf(role) < 0) return;
      if (file.size > 400000) { say('这个文件太大了，不像一份 Skill', true); return; }
      var done = function (text) {
        var editor = $('#rd-skill-' + role);
        if (!editor) return;
        editor.value = String(text || '');
        dirty.skill[role] = true;
        say('已载入「' + file.name + '」到' + SKILL_TITLE[role] + '：检查一遍，点「保存」才生效');
      };
      if (typeof file.text === 'function') file.text().then(done, function (error) { say('读取文件失败：' + message(error), true); });
      else {
        var reader = new host.FileReader();
        reader.onload = function () { done(reader.result); };
        reader.onerror = function () { say('读取文件失败', true); };
        reader.readAsText(file);
      }
    }

    /* 开关与下拉框：改了立刻生效的那两个（总开关、这个聊天的开关）；别的只是记下「有没保存的改动」。 */
    function change(target) {
      if (!director || !target || typeof target.closest !== 'function' || !target.closest('[data-pane="director"]')) return false;
      if (typeof target.getAttribute === 'function' && target.getAttribute('data-skill-file')) { importSkill(target); return true; }
      var key = target.getAttribute('data-d') || '';
      try {
        if (key === 'global') { director.saveSettings({ enabled: target.checked }); say(target.checked ? '导演总开关已打开' : '导演总开关已关闭'); }
        else if (key === 'chat-switch') { director.setChatEnabled(target.value === 'follow' ? null : target.value === 'on'); say('这个聊天的导演开关已更新'); }
        else input(target);
      } catch (error) { say(message(error), true); }
      return true;
    }

    function input(target) {
      if (!target || typeof target.getAttribute !== 'function') return;
      var key = target.getAttribute('data-d') || '';
      if (key === 'brief') {
        dirty.brief = true;
        var count = $('#rd-brief-count');
        if (count) count.textContent = target.value.length + ' / ' + (core ? core.BRIEF_LIMIT : 1200) + ' 字' + (target.value.length > (core ? core.BRIEF_LIMIT : 1200) ? '（保存时会自动缩短）' : '');
      } else if (key === 'outline') dirty.outline = true;
      else if (key === 'pref') dirty.prefs = true;
      else if (key.indexOf('skill.') === 0) { if (dirty.skill[key.slice(6)] !== undefined) dirty.skill[key.slice(6)] = true; }
      else if (key.indexOf('cfg.') === 0) dirty.config = true;
    }

    function dispose() {
      visible = false;
      stops.splice(0).forEach(function (stop) { try { stop(); } catch (error) { /* ignore */ } });
      if (sayTimer) { clearTimeout(sayTimer); sayTimer = null; }
    }

    return { show: show, hide: hide, refresh: refresh, action: action, change: change, input: input, dispose: dispose };
  }

  modules.createDirectorUi = createDirectorUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
