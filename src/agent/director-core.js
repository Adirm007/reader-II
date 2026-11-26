(function (root) {
  'use strict';

  /*
   * 分卷导演的纯逻辑：两份 Skill 的正文、简报净化、楼层指纹与快照环、判定解析与三级路由、编纲 / 巡检 / 重构 / 归档的提示词。
   * 这里不碰 DOM、不读写存储、不发请求——那些在 director.js；这里只做「给定输入算出输出」，所以能在 Node 里直接测。
   *
   * 几条贯穿全文件的约定：
   *   · 提示词一律「静态在前、动态在后」。总导演单会话探索与撰稿全程共用同一份 System 与初始轻索引地图；场记每轮的 System
   *     （场记 Skill 原文 + 偏好 + 角色简介 + 大纲）在两次结构重构之间一字不变，变的只有末尾那条 User。
   *   · 大纲（outline）在两次 L2 之间只读。L1 的局部改写是一条「补丁」，跟着楼层快照走、只出现在动态尾部，
   *     所以既不打掉前缀缓存，也会随 Swipe / 删楼自动回滚。
   *   · 交给正文模型的简报是「惰性文本」：主角名已经换成实名，其余宏与 EJS 记号全部失活。酒馆的两条注入通道
   *     拿到的是同一份，比对得上，模型写出来的 {{setvar::…}}、<% … %> 也不会被执行。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  /*
   * 导演的方法论是两份物理独立的 Skill，各管各的角色，谁也不引用谁：
   *   planner  总导演（编纲与结构重构）  内置正文 knowledge/director-planner/SKILL.md
   *   patrol   场记（每轮巡检与简报）    内置正文 knowledge/director-patrol/SKILL.md
   * 进提示词的是「去掉 frontmatter 之后的原文」（skillBody）：不认标题、不切段、不补齐，也不拿内置正文去替换哪一段。
   * 用户怎么改写其中一份（删标题、换结构、整篇重写），生效的就是他写的那一份，另一份丝毫不受影响。
   * 归档与新角色建档不读 Skill：各有一段写死的短协议（ARCHIVE_PROTOCOL / WORLDBOOK_PROMPT）。
   */
  var SKILL_ROLES = ['planner', 'patrol'];
  var SKILL_NAMES = { planner: 'director-planner', patrol: 'director-patrol' };
  var SKILL_LABELS = { planner: '总导演 Skill（编纲与重构）', patrol: '场记 Skill（每轮巡检与简报）' };
  var BRIEF_LIMIT = 550;      /* 每轮导演简报的字数上限（场记 Skill 的简报规范与两处输出契约都按它写） */
  var RING_LIMIT = 20;        /* 快照环留多少条 */
  var ARCHIVE_LIMIT = 400;    /* 已完结卷档案的字数上限（归档协议） */
  var TAIL_WINDOW = 4;        /* 指纹里带上前面几楼 */
  var LEAK_SPAN = 18;         /* 简报与「后台完整实情」连续重合到这么多字，就当成泄密 */
  var FACT_LIMIT = 48;
  var PATCH_LIMIT = 4;
  var BRIEF_COLUMNS = ['【当前阶段与承接】', '【在场角色意图（仅表现层）】', '【本轮细节与暗压】', '【节奏与情绪红线】', '【本轮防 AI 味忌口】'];

  var DEFAULT_SETTINGS = {
    enabled: false,           /* 总开关；每个聊天还可以单独开关（聊天变量），没设过的跟这里 */
    injectEvery: 1,           /* 每几个回合注入一次简报 */
    patrolEvery: 1,           /* 每几个回合巡检一次 */
    planMode: 'auto',         /* 仅保留 auto：一轮连贯编纲，工作途中随时自由插话 */
    wbPolicy: 'preview',      /* 新角色建档：preview 列出来等用户点 ｜ auto 权限允许时直接写 ｜ none 不建档 */
    wbTemplateId: '',         /* 角色条目用哪份模板；空 = 模板库的默认模板 */
    autoArchive: false,       /* 满足完结条件后不等用户确认，直接归档 */
    floatMode: 'all',         /* 状态浮窗：all 全部后台任务 ｜ major 只显示编纲、重构、归档这类大活 */
    plannerMaxTokens: 8192,
    judgeMaxTokens: 3072,
    timeoutMs: 240000,
    l2Cooldown: 2             /* 一次结构重构之后，这么多回合内再判 L2 一律按 L1 处理 */
  };

  function clampInt(value, minimum, maximum, fallback) {
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }
  function oneOf(list, value, fallback) { return list.indexOf(value) >= 0 ? value : fallback; }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function str(value) { return value == null ? '' : String(value); }
  function clip(text, max) { var source = str(text).trim(); return source.length > max ? source.slice(0, Math.max(0, max - 1)) + '…' : source; }

  function normalizeSettings(raw) {
    var s = isObject(raw) ? raw : {};
    return {
      enabled: s.enabled === true,
      injectEvery: clampInt(s.injectEvery, 1, 20, DEFAULT_SETTINGS.injectEvery),
      patrolEvery: clampInt(s.patrolEvery, 1, 20, DEFAULT_SETTINGS.patrolEvery),
      planMode: 'auto',
      wbPolicy: oneOf(['preview', 'auto', 'none'], s.wbPolicy, DEFAULT_SETTINGS.wbPolicy),
      wbTemplateId: typeof s.wbTemplateId === 'string' ? s.wbTemplateId.trim().slice(0, 120) : '',
      autoArchive: s.autoArchive === true,
      floatMode: oneOf(['all', 'major'], s.floatMode, DEFAULT_SETTINGS.floatMode),
      plannerMaxTokens: clampInt(s.plannerMaxTokens, 2048, 65536, DEFAULT_SETTINGS.plannerMaxTokens),
      judgeMaxTokens: clampInt(s.judgeMaxTokens, 512, 16384, DEFAULT_SETTINGS.judgeMaxTokens),
      timeoutMs: clampInt(s.timeoutMs, 20000, 900000, DEFAULT_SETTINGS.timeoutMs),
      l2Cooldown: clampInt(s.l2Cooldown, 0, 20, DEFAULT_SETTINGS.l2Cooldown)
    };
  }

  /* ---------- 稳定 id ---------- */

  function hash32(text) {
    if (typeof modules.hashText === 'function') return modules.hashText(text);
    var hash = 0x811c9dc5, source = str(text);
    for (var index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }
  function pad8(hex) { return ('00000000' + hex).slice(-8); }

  /*
   * 16 位十六进制的稳定 id：同一段文本用两种加盐方式各算一次 32 位哈希再拼起来。
   * 单个 32 位哈希拿来当目录名、当楼层指纹都嫌短（几万个聊天、几千层楼就有撞的可能），拼成 64 位就够用了。
   */
  function hashId(text) {
    var source = str(text);
    return pad8(hash32('rd\u0001' + source)) + pad8(hash32(source + '\u0002' + source.length));
  }

  /* ---------- Skill 正文与两段固定协议 ---------- */

  /* 归档不读 Skill：一卷落幕之后要做的事是固定的，协议也就写死在这里。 */
  var ARCHIVE_PROTOCOL = '你是单卷群像导演的归档员：一卷落幕之后，把它沉淀成一份简短、可靠、下一卷拿来就能用的档案。\n'
    + '只写正文里已经发生的事，不新编剧情、不替角色补心理；用户偏好与显式指令永远优先。\n\n'
    + '### 归档与清理原则\n'
    + '- 产出不超过 ' + ARCHIVE_LIMIT + ' 字的《已完结卷档案》：发生过的硬事实 + 人物关系变化；\n'
    + '- 另列 2–3 条沉淀进跨卷钩子库的具体伏笔（一笔未清的人情、一件转手的旧物、一条传开的风声、一个尚未深究的异常）；\n'
    + '- 本卷新建的世界书条目：一次性场景 / 事件 / 龙套条目建议停用（只关不删）；与主角结下真实羁绊或留有长线余波的新角色条目建议保留启用，交由用户确认。';
  /* 新角色建档同样不读 Skill（director-wb.js 用）。 */
  var WORLDBOOK_PROMPT = '你在为分卷导演新引入的角色写世界书条目，它会在后续聊天里被关键词触发、交给正文模型看。\n'
    + '- 只写这位角色在前台已经公开、或一登场就看得见的东西：身份与生活质感、性格与矛盾、说话习惯、与旁人的关系。\n'
    + '- 严禁写进后台尚未揭晓的秘密、隐藏身份、真实目的与结局安排——条目一旦触发，等于直接剧透给正文。\n'
    + '- 人要像活人：有自己的日子、习惯与小毛病，不是为某段剧情量身定做的部件；不用功能拼接式的名字与罐头人名。\n'
    + '- 不为了填满字段去发明新的组织、地名与世界规则；资料没有的宁可写得朴素。';

  function stripFrontmatter(text) {
    return str(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  }

  /* 一份 Skill 进提示词的正文：去掉 frontmatter 与首尾的空白，其余一字不动。 */
  function skillBody(raw) { return stripFrontmatter(raw).trim(); }

  /* ---------- 主角名与宏 ---------- */

  /* 只把 {{user}} 与 <user> 换成主角的实名。{{char}} 不换：它是角色卡的标题，在群像里往往不是任何一个角色的名字。 */
  function expandUser(text, userName) {
    var name = str(userName).trim() || '主角';
    return str(text).replace(/\{\{\s*user\s*\}\}/gi, function () { return name; }).replace(/<user>/gi, function () { return name; });
  }

  /*
   * 把剩下的宏与 EJS 记号改写成全角：看得出原来写了什么，但酒馆的宏替换、提示词模板（EJS）都不会再认它。
   * <char>、<bot> 这几个是酒馆的旧式宏，同样处理。
   */
  function neutralizeMacros(text) {
    return str(text)
      .replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
      .replace(/<%/g, '＜%').replace(/%>/g, '%＞')
      .replace(/<(\/?)(bot|char|group|charifnotgroup)>/gi, '＜$1$2＞');
  }

  /* 模型顺手带出来的块：思维链、变量更新、Reader 事件、样式与脚本。没写完（只有开头）的也一并去掉。 */
  function stripBlocks(text) {
    return str(text)
      .replace(/<(thinking|think|reasoning|thought)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<UpdateVariable>[\s\S]*?(?:<\/UpdateVariable>|$)/gi, '')
      .replace(/<READER_(?:FP|TASK|ACTION)_EVENT>[\s\S]*?(?:<\/READER_(?:FP|TASK|ACTION)_EVENT>|$)/gi, '')
      .replace(/<(style|script)\b[\s\S]*?(?:<\/\1>|$)/gi, '');
  }

  function tidy(text) {
    return str(text).replace(/\r\n?/g, '\n').replace(/[ \t\u3000]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 大纲板块 C 里只有导演能看的那一段：「后台完整实情」到「客观推进时钟」之间。时钟的节点是可以在简报里露出来的，不算。 */
  function hiddenTruth(outline) {
    var text = str(outline);
    var start = text.indexOf('后台完整实情');
    if (start < 0) return '';
    var from = start + '后台完整实情'.length;
    var end = text.indexOf('客观推进时钟', from);
    if (end < 0) {
      var next = /\n#{1,4}[ \t]*板块[ \t]*[D-Ed-e]/.exec(text.slice(from));
      end = next ? from + next.index : Math.min(text.length, from + 4000);
    }
    return text.slice(from, end);
  }

  /* 去掉空白与排版记号后的文本，以及每个字在原文里的位置。 */
  function compact(text) {
    var source = str(text), out = '', map = [];
    for (var index = 0; index < source.length; index += 1) {
      var ch = source.charAt(index);
      if (/[\s*_`#>~]/.test(ch)) continue;
      out += ch;
      map.push(index);
    }
    return { text: out, map: map };
  }

  var SENTENCE_END = '。！？!?；;\n';

  /*
   * 防泄密：简报里有一段与「后台完整实情」连续重合达到 span 个字，就把它所在的那句话整句拿掉。
   * 短于 span 的重合（人名、地名、一个公开的时间点）不算，免得误伤。返回 { text, leaks }。
   */
  function removeLeaks(brief, outline, span) {
    var size = span > 0 ? span : LEAK_SPAN;
    var source = str(brief);
    var hidden = compact(hiddenTruth(outline)).text;
    if (hidden.length < size || source.length < size) return { text: source, leaks: 0 };
    var grams = new Set();
    for (var h = 0; h + size <= hidden.length; h += 1) grams.add(hidden.substr(h, size));
    var packed = compact(source);
    var ranges = [];
    for (var at = 0; at + size <= packed.text.length; at += 1) {
      if (!grams.has(packed.text.substr(at, size))) continue;
      var end = at + size;
      while (end < packed.text.length && grams.has(packed.text.substr(end - size + 1, size))) end += 1;
      ranges.push([packed.map[at], packed.map[end - 1]]);
      at = end - 1;
    }
    if (!ranges.length) return { text: source, leaks: 0 };
    /* 扩到整句：往前到上一个句末或栏名的「】」，往后到本句的句末。 */
    var cuts = ranges.map(function (range) {
      var from = range[0], to = range[1] + 1;
      while (from > 0 && SENTENCE_END.indexOf(source.charAt(from - 1)) < 0 && source.charAt(from - 1) !== '】') from -= 1;
      while (from < range[0] && /[：:\s]/.test(source.charAt(from))) from += 1;
      while (to < source.length && SENTENCE_END.indexOf(source.charAt(to)) < 0) to += 1;
      if (to < source.length && source.charAt(to) !== '\n') to += 1;
      return [from, to];
    }).sort(function (left, right) { return left[0] - right[0]; });
    var merged = [];
    cuts.forEach(function (cut) {
      var last = merged[merged.length - 1];
      if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]);
      else merged.push(cut.slice());
    });
    var out = source;
    for (var index = merged.length - 1; index >= 0; index -= 1) out = out.slice(0, merged[index][0]) + out.slice(merged[index][1]);
    return { text: tidy(out), leaks: ranges.length };
  }

  function cutLine(line, target) {
    if (target >= line.length) return line;
    var keep = Math.max(1, target - 1);
    var floor = Math.floor(keep * 0.6);
    for (var index = keep - 1; index >= floor; index -= 1) {
      if ('。！？!?；;，,、'.indexOf(line.charAt(index)) >= 0) return line.slice(0, index + 1).replace(/[，,、；;]$/, '') + '…';
    }
    return line.slice(0, keep) + '…';
  }

  /* 缩到 limit 个字以内：每次从最长的那一段下手，在句读处截断，各栏的开头都留得住。 */
  function clampBrief(text, limit) {
    var max = limit > 0 ? limit : BRIEF_LIMIT;
    var source = tidy(text);
    if (source.length <= max) return source;
    var lines = source.split('\n');
    var KEEP = 26;
    for (var guard = 0; guard < 400; guard += 1) {
      var total = lines.join('\n').length;
      if (total <= max) break;
      var longest = 0;
      for (var index = 1; index < lines.length; index += 1) if (lines[index].length > lines[longest].length) longest = index;
      var line = lines[longest];
      if (line.length <= KEEP) break;
      lines[longest] = cutLine(line, Math.max(KEEP, line.length - (total - max)));
      if (lines[longest].length >= line.length) break;
    }
    var out = lines.join('\n');
    return out.length > max ? out.slice(0, max - 1).replace(/\s+$/, '') + '…' : out;
  }

  /*
   * 模型写的简报 → 可以注入的简报。options: { userName, outline, limit }。返回 { text, leaks }。
   * 顺序有讲究：先去块、再认 <user>，然后才失活其余宏、剥掉别的标签——反过来的话 <user> 会被当成普通标签剥掉。
   */
  function sanitizeBriefDetailed(text, options) {
    var opts = options || {};
    /* 模型爱把交付物包进代码围栏：围栏那一行（只有 ``` 的行）去掉，里面的正文留着。 */
    var body = stripBlocks(text).replace(/^[ \t]*```[A-Za-z0-9_-]*[ \t]*$/gm, '');
    body = neutralizeMacros(expandUser(body, opts.userName));
    body = tidy(body.replace(/<\/?[A-Za-z_][^<>\n]{0,120}>/g, ''));
    var checked = opts.outline ? removeLeaks(body, opts.outline, opts.span) : { text: body, leaks: 0 };
    return { text: clampBrief(checked.text, opts.limit || BRIEF_LIMIT), leaks: checked.leaks };
  }
  function sanitizeBrief(text, options) { return sanitizeBriefDetailed(text, options).text; }

  /* ---------- 楼层指纹 ---------- */

  function defaultClean(input) {
    return stripBlocks(input).replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[A-Za-z_][^<>]{0,200}>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/[ \t\u3000]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /*
   * 一次生成 / 一次巡检里对聊天的只读视图。指纹按需算、算过就记着：注入时通常只要看最后一两楼，不必把整段聊天都哈希一遍。
   *   contentHash(楼)  这一楼「谁说的 + 清洗后的正文」的哈希。清洗掉变量更新块、Reader 事件、思维链之后，
   *                    别的扩展在收楼后往正文里补写这些东西，指纹不变。
   *   tailHash(楼)     它前面最多 TAIL_WINDOW 个可见楼层的指纹串起来再哈希：同一段正文出现在不同的前文后面，算两回事。
   * 可见楼层 = 没被隐藏（is_system）的楼层。回合 = 一段连续的 AI 楼（群聊里几个角色接连回复算一个回合）。
   */
  function createChatView(rawChat, cleanFn) {
    var chat = Array.isArray(rawChat) ? rawChat : [];
    var clean = typeof cleanFn === 'function' ? cleanFn : defaultClean;
    var visible = [], position = Object.create(null);
    for (var index = 0; index < chat.length; index += 1) {
      var message = chat[index];
      if (message && message.is_system !== true) { position[index] = visible.length; visible.push(index); }
    }
    var texts = Object.create(null), contents = Object.create(null), tails = Object.create(null);

    function role(floor) { var item = chat[floor]; return !item || position[floor] === undefined ? '' : item.is_user === true ? 'user' : 'assistant'; }
    function text(floor) {
      if (position[floor] === undefined) return '';
      if (texts[floor] === undefined) texts[floor] = str(clean(chat[floor].mes));
      return texts[floor];
    }
    function contentHash(floor) {
      if (position[floor] === undefined) return '';
      if (contents[floor] === undefined) contents[floor] = hashId(role(floor) + '\n' + text(floor));
      return contents[floor];
    }
    function tailHash(floor) {
      var at = position[floor];
      if (at === undefined) return '';
      if (tails[floor] === undefined) {
        var parts = [];
        for (var p = Math.max(0, at - TAIL_WINDOW); p < at; p += 1) parts.push(contentHash(visible[p]));
        tails[floor] = hashId(parts.join('>'));
      }
      return tails[floor];
    }
    function lastVisible() { return visible.length ? visible[visible.length - 1] : -1; }
    function previousVisible(floor) { var at = position[floor]; return at === undefined || at === 0 ? -1 : visible[at - 1]; }
    /* 不超过 maxFloor 的最后一个 AI 楼；没有就是 -1。 */
    function lastAssistant(maxFloor) {
      var top = maxFloor === undefined ? Infinity : maxFloor;
      for (var p = visible.length - 1; p >= 0; p -= 1) if (visible[p] <= top && role(visible[p]) === 'assistant') return visible[p];
      return -1;
    }
    function turns(maxFloor) {
      var top = maxFloor === undefined ? Infinity : maxFloor, count = 0, previous = '';
      for (var p = 0; p < visible.length && visible[p] <= top; p += 1) {
        var current = role(visible[p]);
        if (current === 'assistant' && previous !== 'assistant') count += 1;
        previous = current;
      }
      return count;
    }
    /* 不超过 maxFloor、且在 afterFloor 之后的最近 count 楼（从旧到新）；至少给一楼。 */
    function recent(maxFloor, count, afterFloor) {
      var top = maxFloor === undefined ? Infinity : maxFloor, floor = afterFloor === undefined ? -1 : afterFloor;
      var picked = [];
      for (var p = visible.length - 1; p >= 0 && picked.length < Math.max(1, count); p -= 1) {
        if (visible[p] > top) continue;
        if (visible[p] <= floor && picked.length) break;
        picked.push(visible[p]);
      }
      return picked.reverse().map(function (item) { return { floor: item, role: role(item), name: str(chat[item].name), text: text(item) }; });
    }

    return {
      length: chat.length, visible: visible, role: role, text: text, contentHash: contentHash, tailHash: tailHash,
      lastVisible: lastVisible, previousVisible: previousVisible, lastAssistant: lastAssistant, turns: turns, recent: recent
    };
  }

  /*
   * 这一次生成该用哪一楼之前的状态。返回 { maxFloor, floor, excluded, type }：快照只能取锚在 maxFloor 及之前的。
   * 重掷（swipe）、续写（continue）、以及末楼是 AI 时的重新生成：末楼就是要被替换（或接着写）的那一楼，
   * 它是上一份简报的产物——给它拍的快照里装的是「它之后」的指导，拿来指导重写它自己就错位了。所以把它排除，取再前面的。
   */
  function injectionAnchor(view, generationType) {
    var type = str(generationType) || 'normal';
    var last = view.lastVisible();
    var maxFloor = last, excluded = -1;
    if (last >= 0 && view.role(last) === 'assistant' && (type === 'swipe' || type === 'continue' || type === 'regenerate')) {
      excluded = last;
      maxFloor = view.previousVisible(last);
    }
    return { maxFloor: maxFloor, floor: view.lastAssistant(maxFloor), excluded: excluded, type: type };
  }

  /* ---------- 快照环 ---------- */

  function initialState() {
    return { phaseCursor: 1, progress: '', facts: [], patches: [], finishStreak: 0, lastL2Turn: -1000, turn: 0, driftLevel: 0, reason: '' };
  }

  function normalizeState(raw) {
    var s = isObject(raw) ? raw : {};
    var base = initialState();
    return {
      phaseCursor: clampInt(s.phaseCursor, 1, 99, base.phaseCursor),
      progress: clip(s.progress, 400),
      facts: (Array.isArray(s.facts) ? s.facts : []).map(function (item) { return clip(item, 160); }).filter(Boolean).slice(-FACT_LIMIT),
      patches: (Array.isArray(s.patches) ? s.patches : []).filter(isObject).map(function (item) {
        return { phase: clampInt(item.phase, 1, 99, 1), turn: clampInt(item.turn, 0, 1e9, 0), text: clip(item.text, 800) };
      }).filter(function (item) { return item.text; }).slice(-PATCH_LIMIT),
      finishStreak: clampInt(s.finishStreak, 0, 99, 0),
      lastL2Turn: clampInt(s.lastL2Turn, -1000, 1e9, base.lastL2Turn),
      turn: clampInt(s.turn, 0, 1e9, 0),
      driftLevel: clampInt(s.driftLevel, 0, 2, 0),
      reason: clip(s.reason, 300)
    };
  }

  function emptySnapshots() { return { v: 1, versions: {}, base: null, ring: [] }; }

  /* 从文件里读回来的一条快照：档案在工作区里，用户与助手都改得到，所以每个字段都按类型收一遍。 */
  function normalizeEntry(raw) {
    if (!isObject(raw)) return null;
    var floor = Math.trunc(Number(raw.floor));
    var anchored = Number.isFinite(floor) && floor >= 0;
    return {
      id: str(raw.id).slice(0, 60) || 's-' + Math.random().toString(36).slice(2, 9),
      floor: anchored ? floor : -1,
      contentHash: anchored ? str(raw.contentHash).slice(0, 32) : '',
      tailHash: anchored ? str(raw.tailHash).slice(0, 32) : '',
      outlineVersion: clampInt(raw.outlineVersion, 1, 1e6, 1),
      kind: /^[a-z_]{1,20}$/.test(str(raw.kind)) ? str(raw.kind) : 'patrol',
      at: Number(raw.at) > 0 ? Number(raw.at) : 0,
      state: normalizeState(raw.state),
      brief: str(raw.brief).slice(0, 4000)
    };
  }

  function normalizeSnapshots(raw) {
    var s = isObject(raw) ? raw : {};
    var versions = {};
    Object.keys(isObject(s.versions) ? s.versions : {}).forEach(function (key) {
      var record = s.versions[key];
      if (!/^\d{1,7}$/.test(key) || !isObject(record)) return;
      var outline = str(record.outline);
      versions[Number(key)] = { outline: outline, index: normalizeIndex(record.index, outline), note: clip(record.note, 200), at: Number(record.at) > 0 ? Number(record.at) : 0 };
    });
    return {
      v: 1,
      versions: versions,
      base: normalizeEntry(s.base),
      ring: (Array.isArray(s.ring) ? s.ring : []).map(normalizeEntry).filter(Boolean)
    };
  }

  /* 做一条快照。anchor: { floor, contentHash, tailHash }（没有 AI 楼时 floor 为 -1，两个哈希为空）。 */
  function makeSnapshot(anchor, fields) {
    var f = fields || {};
    return {
      id: 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      floor: anchor && anchor.floor >= 0 ? anchor.floor : -1,
      contentHash: anchor && anchor.floor >= 0 ? str(anchor.contentHash) : '',
      tailHash: anchor && anchor.floor >= 0 ? str(anchor.tailHash) : '',
      outlineVersion: clampInt(f.outlineVersion, 1, 1e6, 1),
      kind: str(f.kind) || 'patrol',
      at: Date.now(),
      state: normalizeState(f.state),
      brief: str(f.brief)
    };
  }

  function anchorOf(view, floor) {
    return floor >= 0 ? { floor: floor, contentHash: view.contentHash(floor), tailHash: view.tailHash(floor) } : { floor: -1, contentHash: '', tailHash: '' };
  }

  function snapshotMatches(entry, view, maxFloor) {
    if (!entry) return false;
    if (entry.floor < 0) return true;   /* 聊天还没有 AI 楼时立的基线：什么时候都算数 */
    if (entry.floor > maxFloor) return false;
    return view.contentHash(entry.floor) === entry.contentHash && view.tailHash(entry.floor) === entry.tailHash;
  }

  /*
   * 在 maxFloor 及之前，找与当前聊天对得上的那条快照。返回 { entry, source: ring|base|none, forked }。
   * 楼层对得上（正文指纹 + 前文指纹都一样）才算数，所以：
   *   · 重掷出了新正文 → 这一楼的旧快照对不上，自动退回上一楼的；切回原来那一页 → 又对上了；
   *   · 删楼 → 被删楼层的快照自然落空，取到的就是留下来的最后一楼的状态；
   *   · 改了某一楼 → 它和它后面几楼的快照落空，退回更早的一条，等下一次巡检补上。
   * 对得上的里面取楼层最高的（同一楼取最新的一条）。环里一条都对不上时退回基线；连基线也对不上，
   * 说明这段聊天与导演记录的不是同一条线（分支、导入、大段删改）：forked 为 true，调用方不该再注入，先重新巡检。
   */
  function pickSnapshot(snaps, view, maxFloor) {
    var ring = snaps && Array.isArray(snaps.ring) ? snaps.ring : [];
    var best = null;
    for (var index = ring.length - 1; index >= 0; index -= 1) {
      var entry = ring[index];
      if (!snapshotMatches(entry, view, maxFloor)) continue;
      if (!best || entry.floor > best.floor) best = entry;
    }
    var base = snaps && snaps.base || null;
    if (best && !(base && snapshotMatches(base, view, maxFloor) && base.floor > best.floor)) return { entry: best, source: 'ring', forked: false };
    if (snapshotMatches(base, view, maxFloor)) return { entry: base, source: 'base', forked: false };
    return { entry: base, source: base ? 'base' : 'none', forked: true };
  }

  /* 只留基线、环里还引用着的大纲版本，再加最新的两版（撤回重构要用上一版）。 */
  function pruneVersions(snaps) {
    var keep = {};
    if (snaps.base) keep[snaps.base.outlineVersion] = true;
    snaps.ring.forEach(function (entry) { keep[entry.outlineVersion] = true; });
    Object.keys(snaps.versions).map(Number).filter(Number.isFinite).sort(function (a, b) { return a - b; }).slice(-2).forEach(function (n) { keep[n] = true; });
    Object.keys(snaps.versions).forEach(function (key) { if (!keep[key]) delete snaps.versions[key]; });
    return snaps;
  }

  /*
   * 往环里放一条。同一楼、同一份正文、同一段前文的旧快照被它顶替；同一楼但正文不同的（别的 Swipe）留着，
   * 用户来回翻页时各自对得上各自的。超过 RING_LIMIT 条时从最旧的丢起。
   */
  function pushSnapshot(snaps, entry) {
    var target = normalizeSnapshots(snaps);
    var ring = target.ring.filter(function (item) {
      return !(item.floor === entry.floor && item.contentHash === entry.contentHash && item.tailHash === entry.tailHash);
    });
    ring.push(entry);
    target.ring = ring.length > RING_LIMIT ? ring.slice(ring.length - RING_LIMIT) : ring;
    return pruneVersions(target);
  }

  function latestVersion(snaps) {
    var numbers = Object.keys(snaps && snaps.versions || {}).map(Number).filter(Number.isFinite);
    return numbers.length ? Math.max.apply(null, numbers) : 0;
  }

  /* 存一版大纲，返回版本号。record: { outline, index, note }。 */
  function addVersion(snaps, record) {
    var number = latestVersion(snaps) + 1;
    snaps.versions[number] = { outline: str(record.outline), index: record.index || null, note: clip(record.note, 200), at: Date.now() };
    return number;
  }

  /* ---------- 大纲与索引 ---------- */

  function cleanTitle(text) {
    return str(text).replace(/\*\*/g, '').replace(/^[\s:：·.\-—–|｜]+/, '').replace(/[\s#*]+$/, '').trim().slice(0, 60);
  }

  /* 从板块 D 的「#### Phase N：阶段名」标题里读出阶段表。没有带 # 的标题时，退而认加粗的那种写法。 */
  function inferPhases(outline) {
    var source = str(outline);
    function scan(pattern) {
      var found = [], seen = {}, match;
      while ((match = pattern.exec(source))) {
        var number = Number(match[1]);
        if (!number || seen[number]) continue;
        seen[number] = true;
        found.push({ n: number, title: cleanTitle(match[2]) });
      }
      return found.sort(function (left, right) { return left.n - right.n; });
    }
    var phases = scan(/^[ \t]*#{1,6}[ \t]*(?:\*\*)?[ \t]*Phase[ \t]*(\d{1,2})(.*)$/gim);
    if (!phases.length) phases = scan(/^[ \t>-]*\*\*[ \t]*Phase[ \t]*(\d{1,2})([^\n]*?)\*\*[^\n]{0,8}$/gim);
    return phases.map(function (phase, index) { return { n: index + 1, title: phase.title }; });
  }

  function normalizeCharacters(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(isObject).map(function (item) {
      var name = str(item.name).replace(/[\r\n<>\/:"\\|?*#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      return {
        name: name,
        kind: /temp|event|龙套|一次性|事件/i.test(str(item.kind)) ? 'temp_event' : 'npc',
        brief: clip(item.brief, 300),
        keywords: (Array.isArray(item.keywords) ? item.keywords : []).map(function (key) { return str(key).trim().slice(0, 30); }).filter(Boolean).slice(0, 8)
      };
    }).filter(function (item) {
      if (!item.name || seen[item.name]) return false;
      seen[item.name] = true;
      return true;
    }).slice(0, 8);
  }

  /* 结构索引：{ title, phases: [{ n, title }], totalPhases, newCharacters, inferred }。模型没给或给坏了，就从大纲标题回推。 */
  function normalizeIndex(raw, outline) {
    var source = isObject(raw) ? raw : {};
    var phases = (Array.isArray(source.phases) ? source.phases : []).map(function (item, index) {
      if (typeof item === 'string') return { n: index + 1, title: cleanTitle(item) };
      if (!isObject(item)) return null;
      return { n: clampInt(item.n, 1, 99, index + 1), title: cleanTitle(item.title || item.name) };
    }).filter(Boolean).sort(function (left, right) { return left.n - right.n; }).map(function (item, index) { return { n: index + 1, title: item.title }; }).slice(0, 12);
    var inferred = false;
    if (!phases.length) { phases = inferPhases(outline); inferred = true; }
    var title = cleanTitle(source.title).replace(/[《》]/g, '');
    if (!title) {
      var heading = /^#{1,3}[ \t]+(.+)$/m.exec(str(outline));
      title = heading && !/板块/.test(heading[1]) ? cleanTitle(heading[1]) : '';
    }
    return { title: title, phases: phases, totalPhases: phases.length, newCharacters: normalizeCharacters(source.new_characters || source.newCharacters), inferred: inferred };
  }

  function tagBody(text, name) {
    var source = str(text);
    var open = new RegExp('<' + name + '>', 'i').exec(source);
    if (!open) return { found: false, closed: false, body: '' };
    var rest = source.slice(open.index + open[0].length);
    var close = new RegExp('</' + name + '>', 'i').exec(rest);
    return close ? { found: true, closed: true, body: rest.slice(0, close.index).trim() } : { found: true, closed: false, body: rest.trim() };
  }

  /*
   * 编纲（以及结构重构）的最终交付物 → { ok, outline, index, firstBrief, note } 或 { ok: false, truncated, error }。
   * <volume_outline> 只有开头没有结尾 = 回复被截断：不能把半截大纲当定稿，直接报错并提示调大上限。
   * 模型忘了套标签、但正文里确实是一份带 Phase 标题的大纲时，整段当大纲收下（lenient）。
   */
  function parseFinalOutline(rawText) {
    var text = stripBlocks(rawText);
    var outlineTag = tagBody(text, 'volume_outline');
    var outline = '', lenient = false;
    if (outlineTag.found) {
      if (!outlineTag.closed) {
        return { ok: false, truncated: true, error: '大纲没有写完就断了（<volume_outline> 没有结尾）。请到「导演 → 配置」把「编纲回复上限」调大后重试。' };
      }
      outline = outlineTag.body;
    } else {
      var loose = text.replace(/<(self_check|volume_index|first_brief|restructure_note)>[\s\S]*?(?:<\/\1>|$)/gi, '').trim();
      if (!inferPhases(loose).length) return { ok: false, truncated: false, error: '模型没有按约定交付大纲（缺少 <volume_outline>，正文里也找不到 Phase 标题）。' };
      outline = loose;
      lenient = true;
    }
    outline = tidy(outline.replace(/^\s*```[A-Za-z0-9_-]*[ \t]*\n/, '').replace(/\n```\s*$/, ''));
    if (outline.length < 120) return { ok: false, truncated: false, error: '模型交付的大纲太短，不像一份完整的分卷大纲。' };
    var indexTag = tagBody(text, 'volume_index');
    var parsedIndex = null;
    var indexError = '';
    if (!indexTag.found) indexError = '缺少 <volume_index> JSON 索引块';
    else if (!indexTag.closed) indexError = '<volume_index> 标签没有闭合';
    else if (!indexTag.body) indexError = '<volume_index> 为空';
    else if (modules.agentKernel) {
      var parsed = modules.agentKernel.extractJson(indexTag.body);
      if (parsed.ok) parsedIndex = parsed.value;
      else indexError = '<volume_index> 不是合法 JSON：' + parsed.error;
    }
    var briefTag = tagBody(text, 'first_brief');
    var noteTag = tagBody(text, 'restructure_note');
    var checkTag = tagBody(text, 'self_check');
    return {
      ok: true, outline: outline, index: normalizeIndex(parsedIndex, outline), firstBrief: briefTag.found ? briefTag.body : '',
      note: noteTag.found ? clip(noteTag.body, 200) : '', selfCheck: checkTag.found ? checkTag.body : '',
      indexOk: !indexError, indexError: indexError, briefClosed: !briefTag.found || briefTag.closed, lenient: lenient
    };
  }

  /*
   * 检查 <self_check> 中是否残留未修正的失败项：
   * 1. 先剥掉序号和项名，只审视紧随其后的状态结论；
   * 2. 以明确正向状态（「通过 / 已修正 / 过关 / 无需修改 / 不存在问题」等）开头直接放行，
   *    避免因为括号说明里提到「玩家强攻失败」或「不存在问题 / 无需修改」被误杀；
   * 3. 剥离否定语境（无需/不必/不用/不存在/没有/未发现/无）后仍命中未通过/失败/待修改且未标明已修正的才打回。
   */
  var SELF_CHECK_PASS_LEAD = /^(?:[✅✔✓]\s*|\[(?:通过|已修正|已修改|过关)\]\s*)?(?:已?(?:通过|过关|达标|合规|合格|符合|满足|无问题|没有问题|未发现问题|无需修改|无需重写|不必修改|不用修改|不存在问题|ok\b|pass\b)|已(?:修正|修改|改正|重写|删改|补足|解决|修复))/i;
  var SELF_CHECK_NEGATED = /(?:无需|不必|不用|不需要|不存在|没有|未发现|并非|不涉及|无)(?:明显|任何)?(?:修改|重写|调整|改动|问题|漏洞|缺陷|失败|风险|硬伤|透风)/g;
  var SELF_CHECK_FAIL = /(?:未通过|不通过|不合格|未达标|未修正|待修改|待重写|需修改|需重写|存在问题|未解决|未修复|仍(?:有|存在).{0,8}(?:问题|漏洞|缺陷|透风|硬伤)|^(?:❌|✗|✘|\[未通过\]|不通过|未通过)|(?:^|[\s：:，,。.;；!！\-—–（(\[])(?:检验|检查|自检|判定|核查|审核|验证)?失败(?=$|[\s：:，,。.;；!！\-—–）)\]]))/i;
  /*
   * 以「通过」开头的行，只有后面真写了「还没好」的状态才打回：待修改、需重写、未修正、未解决、还没改、仍有……硬伤 / 漏洞 / 问题。
   * 只是提到「问题」「漏洞」这些名词（「问题不大」「旧账问题留给下一卷」「原先的漏洞已补上」「需留意节奏问题」）不算。
   */
  var SELF_CHECK_RESIDUAL_FAIL = /(?:未通过|不通过|不合格|未达标|未修正|待修改|待重写|待处理|待解决|需修改|需重写|需要修改|需要重写|未解决|未修复|(?:还没|尚未|仍未)(?:改|修|补|处理|解决)|(?:仍|还|尚)(?:有|存在|残留|留有)[^，,。；;]{0,8}(?:硬伤|漏洞|缺陷|透风|问题))/;
  var SELF_CHECK_FIXED = /(?:已修正|已修改|已改正|已重写|已删改|已补足|已补齐|已补上|已解决|已修复|已处理|已调整|已改掉|修正为|改为|改成了|改掉了|补上了|补齐了|现已通过|重新通过|复核通过)/;
  /* 「还没改掉」「尚未补上」这类否定的修正说法先剥掉，再看是否真的已修正。 */
  var SELF_CHECK_NOT_FIXED = /(?:还没有|还没|尚未|仍未|没有|没能|未能|没|未)(?:修正|修改|改正|重写|删改|补足|补齐|补上|解决|修复|处理|调整|改掉|改好)/g;

  function selfCheckFixed(text) {
    return SELF_CHECK_FIXED.test(str(text).replace(SELF_CHECK_NOT_FIXED, ''));
  }

  function stripSelfCheckPrefix(line) {
    var s = str(line).trim();
    /* 去掉开头的列表符或序号，如 "1. "、"- "、"（2）" */
    s = s.replace(/^(?:[-*•]\s*|[（(]?\d{1,2}[.、．)）]\s*)/, '').trim();
    /* 若有项名 + 冒号/破折号（如 "**命名嗅探检验**：通过，无需修改"），提取状态正文 */
    var colon = /^[^:：—–-]{1,36}[:：]\s*(.+)$/.exec(s);
    if (colon) return colon[1].replace(/^\*{1,2}([^*]+)\*{1,2}/, '$1').trim();
    return s.replace(/^\*{1,2}([^*]+)\*{1,2}/, '$1').trim();
  }

  function inspectSelfCheck(text) {
    var source = str(text).trim();
    if (!source) return [];
    var failed = [];
    source.split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var body = stripSelfCheckPrefix(line);
      if (!body) return;
      var cleaned = body.replace(SELF_CHECK_NEGATED, '');
      if (SELF_CHECK_PASS_LEAD.test(body)) {
        /* 以「通过」开头但同一行又写了「仍有硬伤 / 待修改」且没说已修正：依然打回。 */
        if (SELF_CHECK_RESIDUAL_FAIL.test(cleaned) && !selfCheckFixed(cleaned)) failed.push(clip(line, 120));
        return;
      }
      if (SELF_CHECK_FAIL.test(cleaned) && !selfCheckFixed(cleaned)) failed.push(clip(line, 120));
    });
    return failed;
  }

  /*
   * 最终交付的全面质检（用于单会话自动打回闭环）：
   * 区分硬失败（大纲截断、缺少核心板块 A/D 或 Phase、索引损坏、首轮简报缺失/截断/严重泄密）与软失败（仅 <self_check> 残留未修正项）。
   * 返回 { ok, final, brief, issues, hardIssues, softIssues, hardFailure }。
   */
  function validateFinalDelivery(rawText, options) {
    var opts = options || {};
    var final = parseFinalOutline(rawText);
    if (!final.ok) {
      return { ok: false, final: final, brief: null, issues: [final.error], hardIssues: [final.error], softIssues: [], hardFailure: true };
    }
    var hardIssues = [];
    var softIssues = [];
    if (!final.index.totalPhases) {
      hardIssues.push('板块 D 缺少连续编号的「#### Phase N：阶段名」阶段标题。');
    }
    if (!/板块\s*[AＡ]/i.test(final.outline) || !/板块\s*[DＤ]/i.test(final.outline)) {
      hardIssues.push('大纲缺少核心板块结构（须包含以三级标题开头的板块 A 至板块 E，特别是板块 A 与板块 D）。');
    }
    if (!final.indexOk) {
      hardIssues.push(final.indexError || '<volume_index> 缺失或不是合法 JSON。');
    }
    if (!str(final.firstBrief).trim()) {
      hardIssues.push('缺少 <first_brief> 首轮《导演简报》（不超过 ' + BRIEF_LIMIT + ' 字，固定五栏）。');
    } else if (!final.briefClosed) {
      hardIssues.push('<first_brief> 标签没有闭合（可能被输出长度截断）。');
    }
    var brief = str(final.firstBrief).trim()
      ? sanitizeBriefDetailed(final.firstBrief, { userName: opts.userName, outline: final.outline })
      : { text: '', leaks: 0 };
    if (str(final.firstBrief).trim() && brief.leaks > 0 && brief.text.length < 40) {
      hardIssues.push('<first_brief> 与板块 C「后台完整实情」严重重合（触发防泄密后几乎清空），请重写一份严守信息隔离的首轮简报。');
    }
    var failedChecks = inspectSelfCheck(final.selfCheck);
    if (failedChecks.length) {
      softIssues.push('你在 <self_check> 中标出了尚未修正的项：' + failedChecks.join('；') + '。请直接在正文中修改到位，确保全部通过后再交付。');
    }
    var issues = hardIssues.concat(softIssues);
    return {
      ok: issues.length === 0, final: final, brief: brief,
      issues: issues, hardIssues: hardIssues, softIssues: softIssues,
      hardFailure: hardIssues.length > 0
    };
  }

  /*
   * 构造自动打回重写的质检反馈消息。options.softOnly：问题只出在 <self_check>（大纲、索引、简报的结构都合法），
   * 这时允许模型只重交一段 <self_check>，程序把它换进上一稿（mergeSelfCheck），不必为几行自检措辞整卷重写。
   */
  function buildRevisionPrompt(issues, options) {
    var list = (Array.isArray(issues) ? issues : []).map(function (item) { return str(item).trim(); }).filter(Boolean);
    var softOnly = !!(options && options.softOnly);
    return [
      '【自动质检打回 · 请直接修正并重新交付】',
      '刚才提交的交付物存在以下问题，尚未落盘：',
      list.map(function (item, idx) { return (idx + 1) + '. ' + item; }).join('\n'),
      '',
      softOnly
        ? '以上只涉及 <self_check> 自检。如果正文确实还有没改到位的地方，请修改正文后重新输出完整、闭合的四段标签交付物；如果正文其实已经改好、只是自检那几行写得让人误会，只需重新输出一段 <self_check>…</self_check>（每项一行，写「通过」或「已修正：改了什么」），程序会把它换进上一稿，不必重写全文。'
        : '请直接针对上述问题修改正文（如某项需要核实世界书、变量或前文，可继续调用只读工具查证），然后重新输出完整、闭合、全部自检通过的四段标签交付物，标签之外不要有任何多余文字。'
    ].join('\n');
  }

  /* 回复里只有一段闭合的 <self_check>，没有大纲（模型按软打回的提示只重交了自检）。 */
  function isSelfCheckOnly(rawText) {
    var text = stripBlocks(rawText);
    var check = tagBody(text, 'self_check');
    if (!check.found || !check.closed || tagBody(text, 'volume_outline').found) return false;
    var rest = text.replace(/<self_check>[\s\S]*?<\/self_check>/i, '').trim();
    return rest.length < 400 && !inferPhases(rest).length;
  }

  /* 把新的 <self_check> 换进上一稿；上一稿没有自检段就加在开头。 */
  function mergeSelfCheck(previous, reply) {
    var fresh = tagBody(stripBlocks(reply), 'self_check');
    var block = '<self_check>\n' + (fresh.found ? fresh.body : '') + '\n</self_check>';
    var prev = str(previous);
    if (/<self_check>[\s\S]*?<\/self_check>/i.test(prev)) return prev.replace(/<self_check>[\s\S]*?<\/self_check>/i, function () { return block; });
    return block + '\n' + prev;
  }

  function phaseTitle(index, cursor) {
    var phases = index && Array.isArray(index.phases) ? index.phases : [];
    var hit = phases.filter(function (phase) { return phase.n === cursor; })[0];
    return hit ? hit.title : '';
  }

  /* ---------- 判定与三级路由 ---------- */

  function driftLevel(value) {
    var match = /^\s*[Ll]?([012])\s*$/.exec(str(value));
    return match ? Number(match[1]) : -1;
  }

  /*
   * 场记的回复 → { ok, verdict } 或 { ok: false, error }。
   * verdict: { drift_level 0|1|2, reason, phase_cursor, state_delta, facts_add, local_patch, next_brief, volume_completed }
   * L0 / L1 必须带下一轮简报（巡检的一半意义就在预写简报）；L2 可以没有：马上要重构，简报由重构给。
   */
  function parseVerdict(rawText) {
    var kernel = modules.agentKernel;
    var parsed = kernel ? kernel.extractJson(stripBlocks(rawText)) : { ok: false, error: '缺少 JSON 解析器' };
    if (!parsed.ok) return { ok: false, error: '场记没有按约定返回 JSON：' + parsed.error };
    var value = parsed.value;
    var level = driftLevel(value.drift_level !== undefined ? value.drift_level : value.level);
    if (level < 0) return { ok: false, error: '场记的回复缺少 drift_level（应为 0、1 或 2）' };
    var brief = str(value.next_brief !== undefined ? value.next_brief : value.brief).trim();
    if (level < 2 && !brief) return { ok: false, error: '场记的回复缺少 next_brief' };
    var facts = Array.isArray(value.facts_add) ? value.facts_add : typeof value.facts_add === 'string' && value.facts_add.trim() ? [value.facts_add] : [];
    return {
      ok: true,
      verdict: {
        drift_level: level,
        reason: clip(value.reason, 300),
        phase_cursor: clampInt(value.phase_cursor, 1, 99, 0),
        state_delta: clip(value.state_delta, 400),
        facts_add: facts.map(function (item) { return clip(item, 160); }).filter(Boolean).slice(0, 6),
        local_patch: clip(value.local_patch, 800),
        next_brief: brief,
        volume_completed: value.volume_completed === true || /^true$/i.test(str(value.volume_completed).trim())
      }
    };
  }

  /*
   * 把一次判定落到状态上。纯函数：不改传进来的 state。
   * opts: { turn 当前回合数, l2Cooldown, manual 用户手动要求的 }
   * 返回 { state, level, downgraded, restructure, readyToFinish }
   *
   *   L0  只推进游标、换进度摘要、追加硬事实。
   *   L1  再追加一条局部补丁（记在状态里，不动大纲）。
   *   L2  restructure = true，由调用方去拉总导演重构。距上一次重构还不到 l2Cooldown 个回合（且不是手动）时降成 L1：
   *       场记偶尔会连着两轮喊「结构破局」，不拦一下就成了神经质式的反复重构。
   * 完结的闸门有三道，缺一不可：游标已经到最后一个 Phase；场记这一轮判了 volume_completed；而且上一轮巡检它就已经
   * 这么判过（finishStreak ≥ 1）——也就是落地之后确实又走了一轮余韵，不是卡在决战刚落刀的半空。
   */
  function applyVerdict(state, verdict, index, opts) {
    var options = opts || {};
    var previous = normalizeState(state);
    var next = normalizeState(state);
    var total = index && index.totalPhases > 0 ? index.totalPhases : 0;
    var turn = clampInt(options.turn, 0, 1e9, previous.turn);
    var level = verdict.drift_level;
    var downgraded = false;
    if (level === 2 && options.manual !== true && turn - previous.lastL2Turn < clampInt(options.l2Cooldown, 0, 20, DEFAULT_SETTINGS.l2Cooldown)) {
      level = 1;
      downgraded = true;
    }

    /* 游标只进不退；没有阶段表时不设上限。 */
    var cursor = Math.max(previous.phaseCursor, verdict.phase_cursor || previous.phaseCursor);
    next.phaseCursor = total ? Math.min(total, cursor) : cursor;
    if (verdict.state_delta) next.progress = verdict.state_delta;
    verdict.facts_add.forEach(function (fact) { if (next.facts.indexOf(fact) < 0) next.facts.push(fact); });
    if (next.facts.length > FACT_LIMIT) next.facts = next.facts.slice(next.facts.length - FACT_LIMIT);
    /* 补丁管的是「当前及下一个 Phase 的承接」：游标走过去两个阶段之后就没用了。 */
    next.patches = next.patches.filter(function (patch) { return patch.phase >= next.phaseCursor - 1; });
    if (level === 1) {
      var patchText = verdict.local_patch || (downgraded ? '（冷却期内的结构偏移，先按局部绕道接住）' + verdict.reason : verdict.reason);
      if (patchText) next.patches.push({ phase: next.phaseCursor, turn: turn, text: clip(patchText, 800) });
      if (next.patches.length > PATCH_LIMIT) next.patches = next.patches.slice(next.patches.length - PATCH_LIMIT);
    }
    next.turn = turn;
    next.driftLevel = level;
    next.reason = verdict.reason;

    var atFinale = total ? next.phaseCursor >= total : true;
    var claimed = verdict.volume_completed === true && atFinale && level < 2;
    var ready = claimed && previous.finishStreak >= 1;
    next.finishStreak = claimed ? previous.finishStreak + 1 : 0;
    if (level === 2) next.lastL2Turn = turn;

    return { state: next, level: level, downgraded: downgraded, restructure: level === 2, readyToFinish: ready };
  }

  /* ---------- 提示词：公共部分 ---------- */

  function preferenceText(preferences) {
    var text = str(preferences).trim();
    return text || '（用户还没有保存偏好）';
  }

  /* 两层偏好合成一段：全局的在前，本卡（或本群）的在后；冲突时后者为准。 */
  function mergePreferences(globalText, cardText) {
    var parts = [];
    if (str(globalText).trim()) parts.push('【全局偏好】\n' + str(globalText).trim());
    if (str(cardText).trim()) parts.push('【这张卡的偏好（与全局冲突时以这里为准）】\n' + str(cardText).trim());
    return parts.join('\n\n');
  }

  function environmentNotes(roleLine, userName, preferences) {
    var name = str(userName).trim() || '主角';
    return [
      roleLine,
      '- 主角实名：「' + name + '」。资料里凡是主角的占位写法，指的都是这位；行文一律直接写这个名字，不要输出双花括号的占位记号，也不要输出尖括号标签（下面明确要求的交付标签除外）。',
      '- 角色卡的标题、世界书的书名只是资料的出处，不是人物：除非资料明确写了有人叫这个名字，否则不要把它当成角色来写。',
      '- 用户长期偏好（第 0 原则：优先级高于本 Skill 的一切默认规则与自检项）：',
      preferenceText(preferences)
    ].join('\n');
  }

  /* ---------- 提示词：总导演（单会话编纲与重构） ---------- */

  function formatToolManual(tools) {
    if (typeof modules.agentToolManual === 'function') return modules.agentToolManual(tools);
    return (Array.isArray(tools) ? tools : []).map(function (def) {
      var params = (def.params || []).map(function (param) {
        return '  - ' + param.name + '（' + param.type + (param.required ? '，必填' : '') + '）' + (param.desc ? '：' + param.desc : '');
      });
      return '● ' + def.name + '\n  ' + str(def.summary) + (params.length ? '\n' + params.join('\n') : '');
    }).join('\n');
  }

  function buildPlannerToolGuide(options) {
    if (!isObject(options) || !options.toolMode) return '';
    var mode = options.toolMode === 'native' ? 'native' : 'text';
    var tools = Array.isArray(options.tools) ? options.tools : [];
    var mounts = Array.isArray(options.mounts) ? options.mounts : [];
    var lines = [
      '## 只读资料勘察工具（消除信息盲区）',
      '- 你具备只读资料查阅能力（零写入风险、无需确认，可随时发起调用）。大纲落盘与新角色世界书建档由系统自动托管，你只负责查证资料并按要求交付文本。',
      '- 开局提供的世界书仅是全量条目目录地图、变量仅是全景结构探测、近期正文未必涵盖全部前史。',
      '- **“不偷懒、无盲区”勘察原则**：正式落笔产出本卷动态大纲或重构/修订方案之前，必须依据目录索引主动调用 `read` / `grep` / `ls`（及可用的只读查询工具）深入查阅与本卷舞台、核心人物、关键规则、关系细节及现状相关的世界书原文、完整变量结构与必要前文历史，直到对世界与现状没有明显信息盲区再交付最终成果。',
      '- 当用户要求查看变量结构、核实世界书细节或追溯前文伏笔时，必须直接调用只读工具核实；**严禁在未查阅原文的情况下凭空猜测，严禁推说“看不了”或“无法查看”**。',
      '- `read` 支持直接读取世界书条目全文（`wb:/书名/条目`）、任意历史楼层（`chat:/楼层号`）、角色卡字段（`card:/...`）、记忆（`mem:/...`），以及通过 JSON Pointer 钻取任意深度变量结构（如 `var:/mvu.json#/stat_data/...`、`var:/chat.json#/...`、`var:/character.json`、`var:/message/latest.json`）。'
    ];
    if (mode === 'native') {
      lines.push('- 工具已随本次请求声明，直接发起函数调用即可（支持同轮并行调用多个只读工具）；收到返回结果后再继续查阅，或直接交付最终四段标签成果。');
    } else {
      var textFormat = modules.agentProtocol && modules.agentProtocol.TEXT_FORMAT;
      if (textFormat) lines.push('', textFormat);
      if (tools.length) lines.push('', '【可用只读工具】\n' + formatToolManual(tools));
    }
    if (mounts.length) {
      lines.push('', '【可读挂载点】\n' + mounts.map(function (mount) {
        return '- ' + mount.id + ':/  ' + str(mount.title) + (mount.hint ? '（' + str(mount.hint) + '）' : '');
      }).join('\n'));
    }
    return lines.join('\n');
  }

  /*
   * 编纲与重构共用的 System：总导演 Skill 的原文 + 运行环境补充（+ 只读工具指引）。
   * 整轮探索、撰稿、插话修订与自动打回重修全程共用同一份 System，吃满前缀缓存。
   * skillRaw 是总导演那一份 Skill（去掉 frontmatter 后原样使用）；场记的协议不在这里，也不会被带进来。
   */
  function buildPlannerSystem(skillRaw, preferences, userName, options) {
    var parts = [
      expandUser(skillBody(skillRaw), userName),
      '---',
      '## 运行环境补充（Reader-II 分卷导演 · 总导演）',
      environmentNotes('- 你正以「插件运行模式」工作：先用只读工具充分勘察，再一气呵成完成本卷动态大纲、交付前自检与最终交付；不寒暄、不复述要求、不解释你用了什么写作技巧。', userName, preferences)
    ];
    var toolGuide = buildPlannerToolGuide(options);
    if (toolGuide) parts.push(toolGuide);
    return parts.join('\n\n');
  }

  var INDEX_SAMPLE = '{"title":"本卷标题（不带书名号）","phases":[{"n":1,"title":"阶段名"}],"new_characters":[{"name":"姓名","kind":"npc","brief":"定位、性格与说话习惯的要点（80 字以内）","keywords":["会在聊天里出现的叫法"]}]}';
  var DELIVERY_NOTES = [
    '<volume_outline>',
    '（完整大纲：板块 A–E；每个板块以单独一行的「### 板块 A：……」这样的三级标题开头；板块 D 的每个阶段以单独一行的「#### Phase N：阶段名」开头，N 从 1 连续编号；板块 C 里「后台完整实情」与「客观推进时钟」各自单独起一行、以这几个字开头）',
    '</volume_outline>',
    '<volume_index>',
    INDEX_SAMPLE,
    '</volume_index>',
    '<first_brief>',
    '（下一轮的《导演简报》，不超过 ' + BRIEF_LIMIT + ' 字，固定五栏，每栏以栏名开头单独成段：' + BRIEF_COLUMNS.join('') + '。只写在场角色此刻明面上的表现与可以顺手带出的细节；严禁出现板块 C「后台完整实情」里尚未揭晓的任何内容。）',
    '</first_brief>',
    '',
    'volume_index 必须是合法 JSON：phases 与板块 D 的 Phase 一一对应；new_characters 只列板块 B 里标了 [新增] 的角色，kind 取 npc（会长期留在这个世界里的人物）或 temp_event（只为本卷某个场面服务的龙套、一次性事件），没有新增就给空数组。'
  ].join('\n');

  /*
   * 编纲任务。这里只按「做什么」引用 Skill（方法论、交付前自检），不提它的章节编号：
   * 总导演 Skill 可以被用户整篇重写，任务说明不能依赖某个标题还在。交付格式由下面的标签与程序的质检钉死。
   */
  var PLANNER_TASK = [
    '## 编纲与交付任务（单会话连贯完成）',
    '1. **充分勘察（不偷懒、无盲区）**：先依据上方世界书目录地图、变量全景探测与楼层提示，主动调用只读工具（read / grep / ls 及可用只读查询工具）深入查阅与本卷舞台、核心人物、关键规则、关系细节及现状相关的世界书原文、完整变量结构与必要早期楼层，直到对世界与现状没有明显信息盲区。',
    '2. **一气呵成构思与撰稿**：按上方 Skill 的方法论，在同一条完整思路下连贯完成工况定性、原件锚定、卷核立意、3–5 位核心人物独立关系网，并直接写出颗粒度饱满、现场能直接演起来的单卷动态大纲（板块 A–E，3–5 个弹性 Phase，每个 Phase 写齐五项；板块 B 有 [新增] 角色时在末尾附「待建档角色要点」）。',
    '3. **交付前自检**：按上方 Skill 的交付前自检清单逐条审视自己的草稿；**凡查出任何破绽或触发红线，立刻在正文中直接推翻重写到位**，直到全部过关再输出最终稿。',
    '4. **最终交付格式**（只输出以下四段，标签之外不要有任何寒暄或多余解释）：',
    '',
    '<self_check>',
    '（逐项对应 Skill 的交付前自检清单，每项一行：写「通过」或「已修正：改了什么」）',
    '</self_check>',
    DELIVERY_NOTES
  ].join('\n');

  function feedbackBlock(items) {
    var list = (Array.isArray(items) ? items : []).map(function (item) {
      return str(typeof item === 'string' ? item : item && item.text).trim();
    }).filter(Boolean);
    if (!list.length) return '';
    return '\n\n【用户意见（最高优先级：与上面任何默认做法冲突时，以这里为准）】\n' + list.map(function (item) { return '- ' + item; }).join('\n');
  }

  /* 单会话开局消息：System + 初始轻索引地图与完整编纲交付任务。 */
  function buildPlannerMessages(ctx) {
    var context = ctx || {};
    var notes = Array.isArray(context.feedback) ? context.feedback : (context.feedback ? [context.feedback] : []);
    var user = '## 勘察资料（全量轻索引与近期正文；完整条目与深层变量请用只读工具按需查阅）\n\n'
      + str(context.materials).trim() + '\n\n---\n\n'
      + PLANNER_TASK + feedbackBlock(notes);
    return [{ role: 'system', content: str(context.system) }, { role: 'user', content: user }];
  }

  /* 构造编纲途中用户的自由插话消息。 */
  function buildInterjectionMessage(text) {
    return [
      '【用户实时插话（最高优先级：与此前构思或默认做法冲突时，一律以这里为准）】',
      str(text).trim(),
      '',
      '请立刻结合此前已查到的资料处理用户的要求（若用户点名查看变量结构、核实世界书细节或追溯前文，请先调用只读工具查证原文，不要推说看不了），再按完整交付格式直接输出修正后的最终四段标签成果。'
    ].join('\n');
  }

  /* ---------- 提示词：场记（每轮巡检） ---------- */

  var JUDGE_CONTRACT = [
    '## 输出契约',
    '只输出一个 JSON 对象：不要代码围栏，不要多余的话。',
    '{"drift_level":0,"reason":"","phase_cursor":1,"state_delta":"","facts_add":[],"local_patch":"","next_brief":"","volume_completed":false}',
    '- drift_level：0 顺轨或良性发散；1 局部绕道（本卷的核心人物与主轴仍然有效）；2 结构破局（原定冲突的前提已经不成立）。拿不准时取较小的一级，严禁神经质式地频繁判 2。',
    '- reason：一句话判定依据，60 字以内。',
    '- phase_cursor：最新正文实际处在大纲的第几个 Phase（从 1 起，只进不退）。',
    '- state_delta：这一轮之后的进度摘要，120 字以内：走到哪了、谁的态度变了、哪条时钟动了。',
    '- facts_add：这一轮新发生、今后不能被推翻的硬事实，0–3 条，每条 40 字以内；没有就给空数组。',
    '- local_patch：只在 drift_level 为 1 时填，240 字以内：当前及下一个 Phase 的承接路径与 NPC 反应怎样局部改写；其余情况给空字符串。大纲原文不会改，补丁只在之后的巡检里生效。',
    '- next_brief：下一轮《导演简报》全文，不超过 ' + BRIEF_LIMIT + ' 字，固定五栏、每栏以栏名开头单独成段：' + BRIEF_COLUMNS.join('') + '。严守信息隔离：不得出现「后台完整实情」里尚未在正文中揭晓的内容。drift_level 为 2 时给一句克制的过渡提示即可。',
    '- volume_completed：只有三项同时成立才为 true——剧情已实际进入最后一个 Phase；本卷的核心矛盾已有明确结果或实质转化；落地之后至少已有一轮情绪收束与余韵。否则为 false。'
  ].join('\n');

  /*
   * 场记的 System（静态）：场记 Skill 的原文 + 环境补充 + 角色简介 + 大纲 + 输出契约。
   * 只要 Skill、偏好、主角名、角色简介、大纲这五样没变，它就逐字节相同；L1 的补丁、进度、最新正文都不在这里。
   * skillRaw 是场记那一份 Skill（去掉 frontmatter 后原样使用）；总导演的编纲方法论不在这里，也不会被带进来。
   */
  function buildJudgeSystem(input) {
    var source = input || {};
    return [
      expandUser(skillBody(source.skillRaw), source.userName),
      '---',
      '## 运行环境补充（Reader-II 分卷导演 · 场记）',
      environmentNotes('- 你是这一卷的场记：每轮读最新正文，对照大纲判定偏移，并预写下一轮的《导演简报》。你不写正文，也不替玩家做决定。', source.userName, source.preferences),
      '## 角色与世界简介',
      str(source.profile).trim() || '（没有可用的角色简介）',
      '## 本卷大纲（两次结构重构之间一字不变；板块 C 的「后台完整实情」只有你能看）',
      str(source.outline).trim(),
      JUDGE_CONTRACT
    ].join('\n\n');
  }

  function roleLabel(item, userName) {
    if (item.role === 'user') return '用户 · ' + (str(userName).trim() || str(item.name) || '主角');
    return str(item.name) || '角色';
  }

  function floorsText(recent, userName) {
    return (Array.isArray(recent) ? recent : []).map(function (item) {
      return '[#' + item.floor + ' ' + roleLabel(item, userName) + ']\n' + str(item.text).trim();
    }).join('\n\n');
  }

  /* 一个带标题的段；正文是空的就整段不要。 */
  function block(title, body) {
    var text = str(body).trim();
    return text ? title + '\n' + text : '';
  }
  function joinBlocks(list) { return list.filter(Boolean).join('\n\n'); }
  function bullets(list) { return list.map(function (item) { return '- ' + item; }).join('\n'); }
  function progressLine(index, state) {
    var total = index && index.totalPhases > 0 ? index.totalPhases : 0;
    var title = phaseTitle(index, state.phaseCursor);
    return 'Phase ' + state.phaseCursor + (total ? ' / ' + total : '') + (title ? '（' + title + '）' : '');
  }

  /* 场记的 User（动态）：进度、硬事实、补丁、上一份简报、最新正文。 */
  function buildJudgeUser(input) {
    var source = input || {};
    var state = normalizeState(source.state);
    var progress = [
      '- 游标：' + progressLine(source.index, state),
      '- 回合：第 ' + clampInt(source.turn, 0, 1e9, state.turn) + ' 回合' + (state.lastL2Turn >= 0 ? '；上一次结构重构在第 ' + state.lastL2Turn + ' 回合' : ''),
      '- 进度摘要：' + (state.progress || '（本卷刚开始）')
    ];
    if (state.finishStreak > 0) progress.push('- 上一轮你已判定本卷达成完结条件；这一轮请确认落地之后的余韵是否已经走完。');
    return joinBlocks([
      block('## 当前进度', progress.join('\n')),
      block('## 迄今硬事实', state.facts.length ? bullets(state.facts) : '（暂无）'),
      block('## 局部补丁（此前判定为 L1 时留下的改写；大纲原文未动，以补丁为准）',
        bullets(state.patches.map(function (patch) { return '[Phase ' + patch.phase + ' · 第 ' + patch.turn + ' 回合] ' + patch.text; }))),
      block('## 上一份导演简报（正文模型这一轮看到的就是它）', source.brief),
      block('## 用户的话（最高优先级）', source.note),
      block('## 最新正文（# 后面是楼层号）', floorsText(source.recent, source.userName) || '（没有读到正文）'),
      '请按输出契约给出 JSON。'
    ]);
  }

  function buildJudgeMessages(input) {
    return [{ role: 'system', content: buildJudgeSystem(input) }, { role: 'user', content: buildJudgeUser(input) }];
  }

  /* ---------- 提示词：结构重构（L2） ---------- */

  /* input: { system（编纲的 System）, outline, index, state, recent, userName, reason, feedback, manual, books?, variables?, totalFloors? } */
  function buildRestructureMessages(input) {
    var source = input || {};
    var state = normalizeState(source.state);
    var progress = '原大纲 ' + progressLine(source.index, state) + '；' + (state.progress || '（没有进度摘要）');
    if (state.patches.length) progress += '\n此前的局部补丁：\n' + bullets(state.patches.map(function (patch) { return '[Phase ' + patch.phase + '] ' + patch.text; }));
    var floorHeading = '### 最近的正文（# 后面是楼层号'
      + (Number(source.totalFloors) > 0 ? '；全聊天共 ' + Math.trunc(Number(source.totalFloors)) + ' 楼，如需追溯更早楼层请用 read / grep 查阅 chat:/' : '') + '）';
    var user = joinBlocks([
      block('## 结构重构', source.manual
        ? '这一卷正在后台执导中，用户要求修订大纲。请在尊重既成事实的前提下重写后续。'
        : '这一卷正在后台执导中，正文的实际发展已经让原大纲的冲突前提不再成立。请在尊重既成事实的前提下重写后续。'),
      block('### 重构原因', str(source.reason).trim() || '（场记判定为结构破局）'),
      block('### 用户的修订意见（最高优先级）', source.feedback),
      block('### 原大纲', source.outline),
      block('### 迄今硬事实（不可推翻）', state.facts.length ? bullets(state.facts) : '（暂无）'),
      block('### 当前进度', progress),
      block('### 变量全景探测索引（可用 read 钻取完整结构）', source.variables),
      block('### 当前生效世界书目录地图（可用 read / grep 查原文）', source.books),
      block(floorHeading, floorsText(source.recent, source.userName) || '（没有读到正文）'),
      block('### 要求', [
        '- 重写前若涉及核实世界书设定、完整变量结构或更早历史楼层（特别是用户意见中要求查看或核实的内容），必须先主动调用只读工具（read / grep / ls 等）查阅原文，消除信息盲区后再落笔；严禁凭空猜测或推说看不了。',
        '- 完全尊重既成事实，严禁把玩家拗回原来的轨道；保留仍有活力的角色关系与客观时钟，顺着玩家的选择长出新的展开。',
        '- 板块 A、B、C、E 只改必须改的地方；板块 D 从当前时点起重新推演，Phase 从 1 重新连续编号（已经演完的阶段不再列入，在板块 A 用两三句交代前情）。',
        '- 仍按 Skill 的大纲产出规范与交付前自检标准。只输出下面四段，标签之外不要有任何内容：'
      ].join('\n')),
      ['<restructure_note>', '（80 字以内：为什么改、改了什么）', '</restructure_note>', DELIVERY_NOTES].join('\n')
    ]);
    return [{ role: 'system', content: str(source.system) }, { role: 'user', content: user }];
  }

  /* ---------- 提示词：归档 ---------- */

  /* input: { preferences, userName, outline, index, state, recent, entries: [{ name, roleKind }] }。归档用固定协议，不读任何一份 Skill。 */
  function buildArchiveMessages(input) {
    var source = input || {};
    var state = normalizeState(source.state);
    var entries = (Array.isArray(source.entries) ? source.entries : []).filter(function (item) { return item && item.name; });
    var system = [
      ARCHIVE_PROTOCOL,
      '---',
      environmentNotes('- 你正在给刚刚落幕的这一卷归档。', source.userName, source.preferences),
      '## 输出契约',
      '只输出一个 JSON 对象：不要代码围栏，不要多余的话。',
      '{"title":"本卷标题","summary":"","hooks":[],"entries":[{"name":"条目名","keep":true,"why":""}]}',
      '- summary：《已完结卷档案》，不超过 ' + ARCHIVE_LIMIT + ' 字：发生过的硬事实 + 人物关系的变化。只写正文里已经发生的。',
      '- hooks：2–3 条沉淀进跨卷钩子库的具体伏笔，每条 60 字以内。',
      '- entries：对下面列出的每个世界书条目给一条留用建议（没有列出条目就给空数组）；keep 为 true 表示建议保持启用。'
    ].join('\n\n');
    var user = joinBlocks([
      block('## 本卷大纲', str(source.outline).trim() || '（大纲缺失）'),
      block('## 进度与硬事实', '停在 ' + progressLine(source.index, state) + '；' + (state.progress || '（没有进度摘要）') + '\n'
        + (state.facts.length ? bullets(state.facts) : '（没有记录硬事实）')),
      block('## 收尾的正文（# 后面是楼层号）', floorsText(source.recent, source.userName) || '（没有读到正文）'),
      block('## 本卷新建的世界书条目', entries.length
        ? bullets(entries.map(function (item) { return item.name + '（' + (item.roleKind === 'temp_event' ? '一次性事件 / 龙套' : '新角色') + '）'; })) : '（没有）'),
      '请按输出契约给出 JSON。'
    ]);
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  /* 归档回复 → { ok, archive: { title, summary, hooks, entries } }。 */
  function parseArchive(rawText) {
    var kernel = modules.agentKernel;
    var parsed = kernel ? kernel.extractJson(stripBlocks(rawText)) : { ok: false, error: '缺少 JSON 解析器' };
    if (!parsed.ok) return { ok: false, error: '归档回复不是 JSON：' + parsed.error };
    var value = parsed.value;
    var summary = clip(value.summary, ARCHIVE_LIMIT);
    if (!summary) return { ok: false, error: '归档回复缺少 summary' };
    return {
      ok: true,
      archive: {
        title: cleanTitle(value.title).replace(/[《》]/g, ''),
        summary: summary,
        hooks: (Array.isArray(value.hooks) ? value.hooks : []).map(function (item) { return clip(item, 120); }).filter(Boolean).slice(0, 4),
        entries: (Array.isArray(value.entries) ? value.entries : []).filter(isObject).map(function (item) {
          return { name: str(item.name).trim().slice(0, 100), keep: item.keep !== false, why: clip(item.why, 120) };
        }).filter(function (item) { return item.name; })
      }
    };
  }

  /* 归档模型不可用时的兜底：把进度摘要与硬事实拼成档案，不让「完结」卡在一次失败的请求上。 */
  function fallbackArchive(index, state) {
    var normalized = normalizeState(state);
    var text = [normalized.progress].concat(normalized.facts).filter(Boolean).join('；');
    return { title: index && index.title || '', summary: clip(text || '（这一卷没有留下可用的记录）', ARCHIVE_LIMIT), hooks: [], entries: [], fallback: true };
  }

  /* ---------- 勘察资料的预算 ---------- */

  /*
   * 勘察资料最多带多少字：模型窗口的一半折成字（中文按 1.4 token 一个字算），落在 6K–36K 之间。
   * 单会话探索结果、正文与可能发生的自检重写都会留在上下文里，所以再用「窗口 − 固定部分 − 两倍输出上限」卡一道，给工具查阅与成稿留足余量。
   */
  function reconBudget(contextWindow, fixedTokens, outputTokens) {
    var windowSize = Number(contextWindow) > 0 ? Number(contextWindow) : 32768;
    var half = Math.max(6000, Math.min(36000, Math.floor(windowSize * 0.5 / 1.4)));
    var room = Math.floor((windowSize - (Number(fixedTokens) || 0) - (Number(outputTokens) || 0) * 2 - 512) / 1.4);
    return Math.max(2000, Math.min(half, room));
  }

  /*
   * 把 total 个字按权重分给各段。parts: [{ key, weight, size }]（size 是这一段实际有多少字）。
   * 要得比份额少的先按实数给足，省下的再按权重分给其余的——近期楼层很短时，世界书就能多带一些。
   */
  function allocateBudget(total, parts) {
    var result = {};
    var pending = (Array.isArray(parts) ? parts : []).filter(function (part) { return part && part.size > 0 && part.weight > 0; });
    var remaining = Math.max(0, Math.floor(total));
    var settled = true;
    while (pending.length && settled) {
      settled = false;
      var weights = pending.reduce(function (sum, part) { return sum + part.weight; }, 0);
      for (var index = 0; index < pending.length; index += 1) {
        var part = pending[index];
        if (part.size <= Math.floor(remaining * part.weight / weights)) {
          result[part.key] = part.size;
          remaining -= part.size;
          pending.splice(index, 1);
          settled = true;
          break;
        }
      }
    }
    var rest = pending.reduce(function (sum, part) { return sum + part.weight; }, 0);
    pending.forEach(function (part) { result[part.key] = Math.floor(remaining * part.weight / rest); });
    return result;
  }

  /* 按字数截取：tail 为 true 留结尾（最近的正文更要紧），否则留开头。 */
  function clipChars(text, max, tail) {
    var source = str(text);
    if (max <= 0) return '';
    if (source.length <= max) return source;
    return tail ? '…' + source.slice(source.length - Math.max(1, max - 1)) : source.slice(0, Math.max(1, max - 1)) + '…';
  }

  /* 一楼正文太长时掐掉中间：开头交代场面，结尾是最新的落点，两头都要。 */
  function clipMiddle(text, max) {
    var source = str(text);
    if (max <= 0) return '';
    if (source.length <= max) return source;
    var head = Math.floor((max - 3) * 0.35), tail = max - 3 - head;
    return source.slice(0, head) + '\n…\n' + source.slice(source.length - tail);
  }

  /*
   * 把收集到的资料拼成一段。sections: [{ key, title, text, weight, tail, preserve }]；空的段不出现。
   * preserve 为 true 的高优先级轻索引段（如世界书全量目录地图、变量全景探测）先按实数保底，
   * 避免被正文或小权重截断丢弃绿灯条目；只有在极端小窗口下合计超过总预算 72% 时才按权重缩放。
   * 返回 { text, used: { key: 字数 } }。
   */
  function composeMaterials(sections, budget) {
    var list = (Array.isArray(sections) ? sections : []).map(function (section) {
      return {
        key: section.key, title: section.title, text: str(section.text).trim(),
        weight: section.weight || 1, tail: section.tail === true, preserve: section.preserve === true,
        render: typeof section.render === 'function' ? section.render : null
      };
    }).filter(function (section) { return section.text; });
    var totalBudget = Math.max(0, Math.floor(Number(budget) || 0));
    var preserved = list.filter(function (section) { return section.preserve; });
    var flexible = list.filter(function (section) { return !section.preserve; });
    var shares = {};
    if (preserved.length) {
      var preservedSize = preserved.reduce(function (sum, item) { return sum + item.text.length; }, 0);
      var preservedCap = flexible.length ? Math.floor(totalBudget * 0.72) : totalBudget;
      if (preservedSize <= preservedCap) {
        preserved.forEach(function (item) { shares[item.key] = item.text.length; });
        totalBudget = Math.max(0, totalBudget - preservedSize);
      } else {
        var preservedShares = allocateBudget(preservedCap, preserved.map(function (item) { return { key: item.key, weight: item.weight, size: item.text.length }; }));
        Object.keys(preservedShares).forEach(function (key) { shares[key] = preservedShares[key]; });
        totalBudget = Math.max(0, totalBudget - preservedCap);
      }
    }
    var flexShares = allocateBudget(totalBudget, flexible.map(function (section) { return { key: section.key, weight: section.weight, size: section.text.length }; }));
    Object.keys(flexShares).forEach(function (key) { shares[key] = flexShares[key]; });
    var used = {};
    var text = list.map(function (section) {
      var limit = shares[section.key] || 0;
      var body = section.render && section.text.length > limit
        ? clipChars(str(section.render(limit)).trim(), limit, section.tail)
        : clipChars(section.text, limit, section.tail);
      used[section.key] = body.length;
      return body ? '### ' + section.title + '\n' + body : '';
    }).filter(Boolean).join('\n\n');
    return { text: text, used: used };
  }

  function encodeSegment(name) {
    if (typeof modules.vfsEnc === 'function') return modules.vfsEnc(name);
    return String(name).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23');
  }
  function decodeSegment(name) {
    if (typeof modules.vfsDec === 'function') return modules.vfsDec(name);
    try { return decodeURIComponent(String(name)); } catch (error) { return String(name); }
  }
  function escapePointer(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function worldbookActiveItems(bookName, entries) {
    var list = Array.isArray(entries) ? entries : [];
    var book = str(bookName).trim();
    if (!book || !list.length) return [];
    var counts = Object.create(null);
    list.forEach(function (entry) {
      if (!entry) return;
      var name = str(entry.name);
      counts[name] = (counts[name] || 0) + 1;
    });
    var encBook = encodeSegment(book);
    var active = [];
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (!entry || entry.enabled === false) continue;
      var content = str(entry.content);
      if (!content.trim()) continue;
      var rawName = str(entry.name);
      /*
       * 与 providers.js 的 uniqueNames() 同一口径：空名、重名、名字含 '#'、以空白结尾（vfs.parse 会 trim 路径末尾）时追加 #uid。
       * pick() 先按唯一全名精确匹配、再按最后一个 '#' 后的 uid 匹配，所以目录、ls、grep 给出的路径 read 回去都命中同一条。
       */
      var needUid = !rawName || counts[rawName] > 1 || rawName.indexOf('#') >= 0 || /\s$/.test(rawName);
      var seg = needUid ? rawName + '#' + entry.uid : rawName;
      var strategy = entry.strategy || {}, place = entry.position || {};
      var type = strategy.type === 'constant' ? 'constant' : strategy.type === 'vectorized' ? 'vectorized' : 'selective';
      var keys = Array.isArray(strategy.keys) ? strategy.keys.map(function (k) { return str(k).trim(); }).filter(Boolean) : [];
      var secondary = strategy.keys_secondary && Array.isArray(strategy.keys_secondary.keys)
        ? strategy.keys_secondary.keys.map(function (k) { return str(k).trim(); }).filter(Boolean) : [];
      active.push({
        path: 'wb:/' + encBook + '/' + encodeSegment(seg),
        name: rawName.trim() || '（未命名#' + entry.uid + '）',
        type: type,
        constant: type === 'constant' ? 1 : 0,
        order: Number(place.order) || 0,
        at: i,
        keys: keys,
        secondary: secondary,
        chars: content.length
      });
    }
    active.sort(function (left, right) {
      return (right.constant - left.constant) || (right.order - left.order) || (left.at - right.at);
    });
    return active;
  }

  function formatWorldbookRow(item, mode) {
    var typeLabel = item.type === 'constant' ? '常驻' : item.type === 'vectorized' ? '向量' : '关键词';
    if (mode === 'minimal') return '- ' + item.path + ' ｜ ' + typeLabel;
    if (mode === 'compact') {
      var shortKeys = item.keys.length ? item.keys.slice(0, 3).join('/') + (item.keys.length > 3 ? '+' : '') : '';
      return '- ' + item.path + ' ｜ ' + typeLabel + (shortKeys ? '(' + shortKeys + ')' : '') + ' ｜ ' + item.chars + '字';
    }
    var keyText = '';
    if (item.keys.length) {
      keyText = item.keys.slice(0, 8).join('、') + (item.keys.length > 8 ? '…共' + item.keys.length + '词' : '');
    }
    if (item.secondary.length) {
      var sec = item.secondary.slice(0, 4).join('、') + (item.secondary.length > 4 ? '…' : '');
      keyText = keyText ? keyText + '；次词：' + sec : '次词：' + sec;
    }
    return '- ' + item.path + ' ｜ ' + item.name + ' ｜ ' + typeLabel + (keyText ? '（' + keyText + '）' : '') + ' ｜ ' + item.chars + ' 字';
  }

  /*
   * 世界书全量条目目录地图：与 providers.js 完全一致地计算 VFS 条目路径（空名/重名/含#/尾空格带 #uid），
   * 列出全部启用条目的准确 wb:/ 路径、触发类型、关键词与字数，不再砍成 150 字或截丢绿灯条目。
   * options: { tag, mode: 'full' | 'compact' | 'minimal' }
   */
  function indexWorldbook(bookName, entries, options) {
    var book = str(bookName).trim();
    var active = worldbookActiveItems(book, entries);
    if (!active.length) return '';
    var tag = options && str(options.tag).trim();
    var mode = options && (options.mode === 'compact' || options.mode === 'minimal') ? options.mode : 'full';
    var header = '【' + book + '】' + (tag ? ' ' + tag : '') + '（启用 ' + active.length + ' 条）';
    return header + '\n' + active.map(function (item) { return formatWorldbookRow(item, mode); }).join('\n');
  }

  /*
   * 多本世界书分级目录渲染（消除大卡 72% 预算硬截断且自称未截断的矛盾）：
   * 依次尝试 full → compact → minimal 直到全量零省略装入 budget；
   * 若极端超大规模连 minimal 仍超 budget，按书均匀分配行额并在每本末尾与总附注诚实标明省略条数与 ls/grep 补查指令。
   * books: [{ name, tag, entries }]；返回 { text, mode, truncated, omitted, total }。
   */
  function formatWorldbookCatalog(books, budget) {
    var list = (Array.isArray(books) ? books : []).map(function (item) {
      var name = str(item && item.name).trim();
      var active = worldbookActiveItems(name, item && item.entries);
      return active.length ? { name: name, encBook: encodeSegment(name), tag: str(item && item.tag).trim(), active: active } : null;
    }).filter(Boolean);
    if (!list.length) return { text: '', mode: 'full', truncated: false, omitted: 0, total: 0 };
    var total = list.reduce(function (sum, b) { return sum + b.active.length; }, 0);
    var cap = Number(budget) > 0 ? Math.floor(Number(budget)) : Infinity;

    var notes = {
      full: '（注：以上为当前全部已启用条目的完整目录，未截断；请使用只读工具 read("wb:/书名/条目") 或 grep("wb:/", "关键词") 按需查阅正文全文。）',
      compact: '（注：以上为当前全部已启用条目的紧凑目录，未截断；请使用 read("wb:/书名/条目") 或 grep("wb:/", "关键词") 按需查阅正文全文。）',
      minimal: '（注：以上为当前全部已启用条目的精简路径目录，未截断；请使用 read("wb:/书名/条目") 或 grep("wb:/", "关键词") 按需查阅正文全文。）'
    };
    var modes = ['full', 'compact', 'minimal'];
    for (var m = 0; m < modes.length; m += 1) {
      var mode = modes[m];
      var blocks = list.map(function (b) {
        var header = '【' + b.name + '】' + (b.tag ? ' ' + b.tag : '') + '（启用 ' + b.active.length + ' 条）';
        return header + '\n' + b.active.map(function (item) { return formatWorldbookRow(item, mode); }).join('\n');
      });
      var assembled = blocks.join('\n\n') + '\n\n' + notes[mode];
      if (assembled.length <= cap) {
        return { text: assembled, mode: mode, truncated: false, omitted: 0, total: total };
      }
    }

    /* 极端规模（即使 minimal 仍超预算）：严格遵守 cap 上限，保证诚实总附注与 ls/grep 补查指令永远完整留在末尾。 */
    function makeHonestFooter(omittedEntries, omittedBooks) {
      if (!omittedEntries && !omittedBooks) return notes.minimal;
      return '（注：因窗口预算有限，以上目录已省略共 ' + omittedEntries + ' / ' + total + ' 条'
        + (omittedBooks ? '（含未展开的 ' + omittedBooks + ' 本书）' : '')
        + '；请务必用 ls("wb:/") 或 grep("wb:/", "关键词") 补充查阅，切勿假设目录已全覆盖。）';
    }
    var maxFooterLen = makeHonestFooter(total, list.length).length;
    if (cap <= maxFooterLen + 24) {
      var tinyFooter = makeHonestFooter(total, list.length);
      return { text: tinyFooter.slice(0, cap), mode: 'minimal', truncated: true, omitted: total, total: total };
    }

    var bodyBudget = Math.max(0, cap - maxFooterLen - 2);
    var rawSizes = list.map(function (b, idx) {
      var header = '【' + b.name + '】' + (b.tag ? ' ' + b.tag : '') + '（启用 ' + b.active.length + ' 条）';
      var compactHead = '【' + b.name + '】' + (b.tag ? ' ' + b.tag : '') + '（启用 ' + b.active.length + ' 条；ls("wb:/' + b.encBook + '")）';
      var rows = b.active.map(function (item) { return formatWorldbookRow(item, 'minimal'); });
      return { key: String(idx), weight: Math.max(1, b.active.length), size: header.length + 1 + rows.join('\n').length, header: header, compactHead: compactHead, rows: rows, book: b };
    });
    var totalMin = rawSizes.reduce(function (sum, x) { return sum + x.compactHead.length; }, 0) + Math.max(0, rawSizes.length - 1) * 2;
    var bookShares = Object.create(null);
    if (totalMin <= bodyBudget) {
      /* 先保证每本书至少保底出现（不让靠后的全局/附书被大书按权重挤掉），再将余量按条目比例分配。 */
      var extraBudget = bodyBudget - totalMin;
      var extraShares = allocateBudget(extraBudget, rawSizes.map(function (x) {
        return { key: x.key, weight: x.weight, size: Math.max(0, x.size - x.compactHead.length) };
      }));
      rawSizes.forEach(function (x) {
        bookShares[x.key] = x.compactHead.length + Math.floor(extraShares[x.key] || 0);
      });
    } else {
      rawSizes.forEach(function (x) { bookShares[x.key] = x.compactHead.length; });
    }

    var blocks = [];
    var blockEntries = [];
    var usedTotal = 0;
    var omittedTotal = 0;
    var omittedBooks = 0;

    function shortTail(encBook, left) {
      return '…（余 ' + left + ' 条，用 ls("wb:/' + encBook + '") 查）';
    }

    for (var bi = 0; bi < rawSizes.length; bi += 1) {
      var x = rawSizes[bi];
      var sep = blocks.length ? 2 : 0;
      var rem = bodyBudget - usedTotal - sep;
      if (rem < x.compactHead.length) {
        for (var rest = bi; rest < rawSizes.length; rest += 1) {
          omittedTotal += rawSizes[rest].rows.length;
          omittedBooks += 1;
        }
        break;
      }
      var share = Math.min(rem, Math.max(x.compactHead.length, Math.floor(bookShares[x.key] || 0)));
      var out = [x.header];
      var used = x.header.length;
      var shown = 0;
      for (var r = 0; r < x.rows.length; r += 1) {
        var row = x.rows[r];
        var leftAfter = x.rows.length - r - 1;
        var tailStr = leftAfter > 0 ? '\n' + shortTail(x.book.encBook, leftAfter) : '';
        if (used + 1 + row.length + tailStr.length > share) break;
        out.push(row);
        used += 1 + row.length;
        shown += 1;
      }
      var blockText = '';
      var omittedHere = x.rows.length - shown;
      if (shown > 0) {
        if (omittedHere > 0) out.push(shortTail(x.book.encBook, omittedHere));
        blockText = out.join('\n');
      }
      if (!blockText || blockText.length > rem) {
        blockText = x.compactHead;
        omittedHere = x.rows.length;
      }
      omittedTotal += omittedHere;
      blocks.push(blockText);
      blockEntries.push(x.rows.length - omittedHere);
      usedTotal += sep + blockText.length;
    }

    var honestFooter = makeHonestFooter(omittedTotal, omittedBooks);
    var assembledFinal = (blocks.length ? blocks.join('\n\n') + '\n\n' : '') + honestFooter;
    while (blocks.length && assembledFinal.length > cap) {
      blocks.pop();
      omittedTotal += blockEntries.pop() || 0;
      omittedBooks += 1;
      honestFooter = makeHonestFooter(omittedTotal, omittedBooks);
      assembledFinal = (blocks.length ? blocks.join('\n\n') + '\n\n' : '') + honestFooter;
    }
    return {
      text: assembledFinal.length > cap ? assembledFinal.slice(0, cap) : assembledFinal,
      mode: 'minimal', truncated: omittedTotal > 0 || omittedBooks > 0, omitted: omittedTotal, total: total
    };
  }

  /* 过滤 Reader-II / 夜梦助手内部配置与状态键，避免污染变量全景探测。 */
  var INTERNAL_VAR_KEY = /^(?:reader_ii(?:_|$)|dream_(?:persona|user_address|visual_theme|appearance|custom_persona(?:_id)?|extra_settings|independent_api))/i;
  var MVU_META_KEYS = ['stat_data', 'display_data', 'delta_data', 'schema', 'initialized_lorebooks', 'is_during_extra_analysis'];

  function isInternalVarKey(key) {
    return INTERNAL_VAR_KEY.test(str(key).trim());
  }

  function probeShape(value, depth) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'boolean' || type === 'number') return String(value);
    if (type === 'string') {
      var trimmed = value.trim();
      if ((trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') && trimmed.length > 2) {
        try {
          var parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') return 'JSON文本→' + probeShape(parsed, depth);
        } catch (error) { /* 普通字符串 */ }
      }
      var flat = value.replace(/\s+/g, ' ').trim();
      if (!flat) return '""';
      return flat.length <= 42 ? JSON.stringify(flat) : JSON.stringify(flat.slice(0, 38) + '…') + '（' + value.length + ' 字）';
    }
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      if (depth <= 0) return '[' + value.length + ' 项]';
      var sample = probeShape(value[0], depth - 1);
      return '[' + value.length + ' 项，首项：' + sample + ']';
    }
    if (type === 'object') {
      var keys = Object.keys(value);
      if (!keys.length) return '{}';
      var shown = keys.slice(0, 10);
      var suffix = keys.length > 10 ? '…共 ' + keys.length + ' 键' : '';
      if (depth <= 0) return '{' + shown.join('、') + suffix + '}';
      if (keys.length <= 4) {
        return '{' + shown.map(function (k) { return k + ': ' + probeShape(value[k], depth - 1); }).join('；') + '}';
      }
      return '{' + shown.join('、') + suffix + '}';
    }
    return str(value).slice(0, 40);
  }

  function formatObjectEntries(basePath, pointerPrefix, obj, options) {
    var keys = Object.keys(obj || {}).filter(function (key) {
      if (options && options.skip && options.skip.indexOf(key) >= 0) return false;
      if (options && options.filterInternal && isInternalVarKey(key)) return false;
      return true;
    });
    if (!keys.length) return [];
    var maxKeys = options && options.maxKeys > 0 ? options.maxKeys : 40;
    var lines = keys.slice(0, maxKeys).map(function (key) {
      var pointer = pointerPrefix + '/' + escapePointer(key);
      return '  - ' + basePath + '#' + pointer + ' ｜ ' + key + '：' + probeShape(obj[key], 1);
    });
    if (keys.length > maxKeys) {
      lines.push('  - …其余 ' + (keys.length - maxKeys) + ' 个顶层键（用 read("' + basePath + (pointerPrefix ? '#' + pointerPrefix : '') + '") 查看完整列表）');
    }
    return lines;
  }

  /*
   * 全类型变量全景探测索引：接收多个变量源 [{ path, label, data }]（覆盖 mvu.json、chat.json 含小白X、
   * character.json、global.json 等），自动过滤 reader_ii_* 内部噪点键，输出可用文件、顶层键结构与精确 JSON Pointer 读取路径。
   */
  function indexVariableSources(sources) {
    var list = Array.isArray(sources) ? sources : [];
    var blocks = [];
    list.forEach(function (source) {
      if (!source || !isObject(source.data)) return;
      var path = str(source.path).trim();
      var label = str(source.label).trim();
      var data = source.data;
      if (path === 'var:/mvu.json') {
        var mvuLines = [];
        if (isObject(data.stat_data) && Object.keys(data.stat_data).length) {
          mvuLines.push('  [stat_data]（' + Object.keys(data.stat_data).length + ' 个顶层键）：');
          mvuLines = mvuLines.concat(formatObjectEntries('var:/mvu.json', '/stat_data', data.stat_data, { filterInternal: false }));
        }
        var metaPresent = ['display_data', 'delta_data', 'schema'].filter(function (k) {
          return data[k] !== undefined && data[k] !== null && (!isObject(data[k]) || Object.keys(data[k]).length > 0);
        });
        if (metaPresent.length) {
          mvuLines.push('  [其他 MVU 分区] ' + metaPresent.map(function (k) { return 'var:/mvu.json#/' + k; }).join('、'));
        }
        var extraLines = formatObjectEntries('var:/message/latest.json', '', data, { filterInternal: true, skip: MVU_META_KEYS });
        if (extraLines.length) {
          mvuLines.push('  [最新楼层其他变量]：');
          mvuLines = mvuLines.concat(extraLines);
        }
        if (mvuLines.length) blocks.push('【' + (label || 'MVU / 最新楼层变量') + '】`var:/mvu.json`\n' + mvuLines.join('\n'));
        return;
      }
      var lines = formatObjectEntries(path, '', data, { filterInternal: true });
      if (!lines.length) return;
      blocks.push('【' + (label || path) + '】`' + path + '`（' + lines.length + ' 项）\n' + lines.join('\n'));
    });
    if (!blocks.length) return '';
    return blocks.join('\n\n') + '\n\n（需要查看任意键的完整数值、子项或深层结构时，直接调用 read("<路径>#/<键名>") 钻取，或 grep var:/。）';
  }

  function displayVfsPath(rawPath) {
    var source = str(rawPath).trim();
    var match = /^([A-Za-z][\w-]*):\/?(.*)$/.exec(source);
    if (!match) return source;
    var rest = match[2], pointer = '';
    var hash = rest.indexOf('#/');
    if (hash >= 0) { pointer = rest.slice(hash); rest = rest.slice(0, hash); }
    var segs = rest.split('/').filter(Boolean).map(decodeSegment);
    return match[1] + ':/' + segs.join('/') + pointer;
  }

  /* 将总导演的只读工具调用格式化为给用户看的探索轨迹文案。 */
  function describeToolCall(name, args) {
    var tool = str(name).trim();
    var a = isObject(args) ? args : {};
    var path = displayVfsPath(a.path || '');
    var mount = /^([A-Za-z][\w-]*):/.exec(path);
    var id = mount ? mount[1] : '';
    if (tool === 'read') {
      var pageNote = Number(a.offset) > 1 ? '（第 ' + Math.trunc(Number(a.offset)) + ' 行起）' : '';
      if (id === 'wb') return '查阅世界书 ' + path + pageNote;
      if (id === 'var') return '查看变量 ' + path + pageNote;
      if (id === 'chat') return '翻看历史楼层 ' + path + pageNote;
      if (id === 'card' || id === 'cards') return '查阅角色卡 ' + path + pageNote;
      if (id === 'mem') return '查阅记忆 ' + path + pageNote;
      return '读取 ' + (path || '资料') + pageNote;
    }
    if (tool === 'ls') {
      if (!path) return '浏览可用资料目录';
      if (id === 'wb') return '浏览世界书目录 ' + path;
      if (id === 'var') return '浏览变量目录 ' + path;
      if (id === 'chat') return '浏览历史楼层目录 ' + path;
      if (id === 'card' || id === 'cards') return '浏览角色卡目录 ' + path;
      if (id === 'mem') return '浏览记忆目录 ' + path;
      return '浏览目录 ' + path;
    }
    if (tool === 'grep') {
      var kw = clip(a.pattern, 30);
      if (id === 'chat') return '搜索历史 ' + path + ' 关键词「' + kw + '」';
      if (id === 'wb') return '搜索世界书 ' + path + ' 关键词「' + kw + '」';
      if (id === 'var') return '搜索变量 ' + path + ' 关键词「' + kw + '」';
      if (id === 'card' || id === 'cards') return '搜索角色卡 ' + path + ' 关键词「' + kw + '」';
      return '检索 ' + (path || '资料') + ' 关键词「' + kw + '」';
    }
    if (tool === 'mvu_inspect') return '查看 MVU 变量' + (a.path ? ' ' + a.path : a.category ? '（' + a.category + '）' : '');
    if (tool === 'lwb_schema' || tool === 'lwb_v3_inspect' || tool === 'lwb_v3_export_rules') return '查看小白X变量结构';
    if (tool === 'baibai_query') return '查询柏宝书（' + str(a.resource || 'state') + '）';
    if (tool === 'shujuku_tables') return '查阅数据库表格';
    if (tool === 'ejs_variables') return '查看 EJS 可见变量' + (a.path ? ' ' + a.path : '');
    if (tool === 'tt_search_chat') return '搜索聊天记录「' + clip(a.query, 30) + '」';
    if (tool === 'memory_search' || tool === 'memory_list') return '检索记忆' + (a.query ? '「' + clip(a.query, 30) + '」' : '');
    return '查阅 ' + tool;
  }

  /* 世界书条目的摘要（保留兼容旧调用）：启用的条目里常驻的排前面，其余按顺序值从大到小；每条一行「名字：正文开头」。 */
  function summarizeWorldbook(entries, perEntry) {
    var size = perEntry > 0 ? perEntry : 160;
    return (Array.isArray(entries) ? entries : []).filter(function (entry) { return entry && entry.enabled !== false && str(entry.content).trim(); })
      .map(function (entry, order) {
        var strategy = entry.strategy || {}, place = entry.position || {};
        return { constant: strategy.type === 'constant', order: Number(place.order) || 0, at: order, name: str(entry.name).trim() || '（未命名）', content: str(entry.content) };
      })
      .sort(function (left, right) { return (right.constant - left.constant) || (right.order - left.order) || (left.at - right.at); })
      .map(function (entry) { return '- ' + (entry.constant ? '[常驻] ' : '') + entry.name + '：' + clipChars(entry.content.replace(/\s+/g, ' ').trim(), size); })
      .join('\n');
  }

  /* 变量树的精简写法（保留兼容旧调用）：只下到 depth 层，长字符串与长数组掐短。 */
  function summarizeVariables(value, depth, budget) {
    function walk(node, level) {
      if (node === null || node === undefined) return null;
      if (typeof node === 'string') return node.length > 60 ? node.slice(0, 59) + '…' : node;
      if (typeof node !== 'object') return node;
      if (Array.isArray(node)) {
        if (level <= 0) return '[' + node.length + ' 项]';
        var items = node.slice(0, 6).map(function (item) { return walk(item, level - 1); });
        if (node.length > 6) items.push('…共 ' + node.length + ' 项');
        return items;
      }
      var keys = Object.keys(node);
      if (level <= 0) return '{' + keys.slice(0, 6).join('、') + (keys.length > 6 ? '…' : '') + '}';
      var out = {};
      keys.slice(0, 24).forEach(function (key) { out[key] = walk(node[key], level - 1); });
      if (keys.length > 24) out['…'] = '共 ' + keys.length + ' 项';
      return out;
    }
    var text = '';
    try { text = JSON.stringify(walk(value, depth > 0 ? depth : 3)); } catch (error) { text = ''; }
    return clipChars(text === 'null' ? '' : text, budget > 0 ? budget : 1200);
  }

  modules.directorCore = {
    SKILL_ROLES: SKILL_ROLES, SKILL_NAMES: SKILL_NAMES, SKILL_LABELS: SKILL_LABELS, ARCHIVE_PROTOCOL: ARCHIVE_PROTOCOL, WORLDBOOK_PROMPT: WORLDBOOK_PROMPT,
    BRIEF_LIMIT: BRIEF_LIMIT, RING_LIMIT: RING_LIMIT, ARCHIVE_LIMIT: ARCHIVE_LIMIT, TAIL_WINDOW: TAIL_WINDOW, LEAK_SPAN: LEAK_SPAN,
    BRIEF_COLUMNS: BRIEF_COLUMNS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings, hashId: hashId, skillBody: skillBody,
    expandUser: expandUser, neutralizeMacros: neutralizeMacros, hiddenTruth: hiddenTruth, removeLeaks: removeLeaks, clampBrief: clampBrief,
    sanitizeBrief: sanitizeBrief, sanitizeBriefDetailed: sanitizeBriefDetailed,
    createChatView: createChatView, injectionAnchor: injectionAnchor, anchorOf: anchorOf,
    initialState: initialState, normalizeState: normalizeState, emptySnapshots: emptySnapshots, normalizeSnapshots: normalizeSnapshots,
    makeSnapshot: makeSnapshot, snapshotMatches: snapshotMatches, pickSnapshot: pickSnapshot, pushSnapshot: pushSnapshot, pruneVersions: pruneVersions,
    latestVersion: latestVersion, addVersion: addVersion,
    inferPhases: inferPhases, normalizeIndex: normalizeIndex, parseFinalOutline: parseFinalOutline, inspectSelfCheck: inspectSelfCheck,
    validateFinalDelivery: validateFinalDelivery, buildRevisionPrompt: buildRevisionPrompt, isSelfCheckOnly: isSelfCheckOnly, mergeSelfCheck: mergeSelfCheck, phaseTitle: phaseTitle,
    parseVerdict: parseVerdict, applyVerdict: applyVerdict,
    mergePreferences: mergePreferences, buildPlannerSystem: buildPlannerSystem, buildPlannerMessages: buildPlannerMessages,
    buildInterjectionMessage: buildInterjectionMessage,
    buildJudgeSystem: buildJudgeSystem, buildJudgeUser: buildJudgeUser, buildJudgeMessages: buildJudgeMessages,
    buildRestructureMessages: buildRestructureMessages, buildArchiveMessages: buildArchiveMessages, parseArchive: parseArchive, fallbackArchive: fallbackArchive,
    reconBudget: reconBudget, allocateBudget: allocateBudget, clipChars: clipChars, clipMiddle: clipMiddle, composeMaterials: composeMaterials,
    indexWorldbook: indexWorldbook, formatWorldbookCatalog: formatWorldbookCatalog, indexVariableSources: indexVariableSources, isInternalVarKey: isInternalVarKey, describeToolCall: describeToolCall,
    summarizeWorldbook: summarizeWorldbook, summarizeVariables: summarizeVariables
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
