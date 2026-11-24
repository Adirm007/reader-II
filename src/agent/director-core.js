(function (root) {
  'use strict';

  /*
   * 分卷导演的纯逻辑：Skill 切片、简报净化、楼层指纹与快照环、判定解析与三级路由、编纲 / 巡检 / 重构 / 归档的提示词。
   * 这里不碰 DOM、不读写存储、不发请求——那些在 director.js；这里只做「给定输入算出输出」，所以能在 Node 里直接测。
   *
   * 几条贯穿全文件的约定：
   *   · 提示词一律「静态在前、动态在后」。编纲四步共用同一份 System 与同一段勘察资料；场记每轮的 System
   *     （Skill 运行期切片 + 偏好 + 角色简介 + 大纲）在两次结构重构之间一字不变，变的只有末尾那条 User。
   *   · 大纲（outline）在两次 L2 之间只读。L1 的局部改写是一条「补丁」，跟着楼层快照走、只出现在动态尾部，
   *     所以既不打掉前缀缓存，也会随 Swipe / 删楼自动回滚。
   *   · 交给正文模型的简报是「惰性文本」：主角名已经换成实名，其余宏与 EJS 记号全部失活。酒馆的两条注入通道
   *     拿到的是同一份，比对得上，模型写出来的 {{setvar::…}}、<% … %> 也不会被执行。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  var SKILL_NAME = 'volume-director';
  var BRIEF_LIMIT = 550;      /* 每轮导演简报的字数上限（Skill 阶段五·甲） */
  var RING_LIMIT = 20;        /* 快照环留多少条 */
  var ARCHIVE_LIMIT = 400;    /* 已完结卷档案的字数上限（Skill 阶段五·丙） */
  var TAIL_WINDOW = 4;        /* 指纹里带上前面几楼 */
  var LEAK_SPAN = 18;         /* 简报与「后台完整实情」连续重合到这么多字，就当成泄密 */
  var FACT_LIMIT = 48;
  var PATCH_LIMIT = 4;
  var BRIEF_COLUMNS = ['【当前阶段与承接】', '【在场角色意图（仅表现层）】', '【本轮细节与暗压】', '【节奏与情绪红线】', '【本轮防 AI 味忌口】'];

  var DEFAULT_SETTINGS = {
    enabled: false,           /* 总开关；每个聊天还可以单独开关（聊天变量），没设过的跟这里 */
    injectEvery: 1,           /* 每几个回合注入一次简报 */
    patrolEvery: 1,           /* 每几个回合巡检一次 */
    planMode: 'auto',         /* auto 一口气编完 ｜ review 第 2 步后停下等用户过目 */
    wbPolicy: 'preview',      /* 新角色建档：preview 列出来等用户点 ｜ auto 权限允许时直接写 ｜ none 不建档 */
    wbTemplateId: '',         /* 角色条目用哪份模板；空 = 模板库的默认模板 */
    autoArchive: false,       /* 满足完结条件后不等用户确认，直接归档 */
    floatMode: 'all',         /* 状态浮窗：all 全部后台任务 ｜ major 只显示编纲、重构、归档这类大活 */
    plannerMaxTokens: 8192,
    judgeMaxTokens: 3072,
    timeoutMs: 120000,
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
      planMode: oneOf(['auto', 'review'], s.planMode, DEFAULT_SETTINGS.planMode),
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

  /* ---------- Skill 切片 ---------- */

  /*
   * 导演 Skill 的七个必需段。heading 是内置正文里的原样标题（构建时核对，见 build.mjs 的 DIRECTOR_SKILL_HEADINGS）；
   * 切片时只认开头几个字（test）：用户改了标题后半句、加了副标题，照样切得开。
   */
  var SECTION_DEFS = [
    { key: 'principles', test: /^最高原则/, heading: '## 最高原则与第一性原理' },
    { key: 'stage1', test: /^阶段一/, heading: '## 阶段一：全景勘察与工况定性（动笔前必做）' },
    { key: 'stage2', test: /^阶段二/, heading: '## 阶段二：十条 AI 弊病绝杀红线（针对抽象劣质特质，不限题材）' },
    { key: 'stage3', test: /^阶段三/, heading: '## 阶段三：反平直叙事引擎工具箱（发散菜单，按需组合）' },
    { key: 'stage4', test: /^阶段四/, heading: '## 阶段四：单卷动态大纲产出规范' },
    { key: 'stage5', test: /^阶段五/, heading: '## 阶段五：后台运行期执导协议（适用于多轮互动实时导演）' },
    { key: 'stage6', test: /^阶段六/, heading: '## 阶段六：交付前铁血自检闭环（以不违背用户偏好为前提）' }
  ];
  var REQUIRED_HEADINGS = SECTION_DEFS.map(function (item) { return item.heading; });
  var SECTION_LABEL = { principles: '最高原则', stage1: '阶段一', stage2: '阶段二', stage3: '阶段三', stage4: '阶段四', stage5: '阶段五', stage6: '阶段六' };

  /* 阶段二的十条红线读不出来时用的速记（运行期只需要标题那一行）。 */
  var FALLBACK_REDLINES = [
    '严禁为剧情量身定做的塑料道具、机制与体质',
    '严禁功能拼接式命名与高频罐头人名',
    '严禁旁白解说潜台词、角色喊口号',
    '严禁凑天数硬拉时间轴、一笔跳过高压余波',
    '严禁机械降神式补丁与全员硬塞打卡',
    '严禁零阻力过场与反派降智站桩',
    '严禁没活硬整内部冲突、为显深刻硬凑代价',
    '严禁演技透风（提前写破心思）与转眼失忆翻篇',
    '严禁全员围着主角公转、只会对主角做反应',
    '严禁百科式注水建档与无必要的世界书污染'
  ];
  var ARCHIVE_HEAD = '你是单卷群像导演的归档员：一卷落幕之后，把它沉淀成一份简短、可靠、下一卷拿来就能用的档案。\n'
    + '只写正文里已经发生的事，不新编剧情、不替角色补心理；用户偏好与显式指令永远优先。';
  var ARCHIVE_FALLBACK = ARCHIVE_HEAD + '\n\n'
    + '### 归档与清理原则\n'
    + '- 产出不超过 ' + ARCHIVE_LIMIT + ' 字的《已完结卷档案》：发生过的硬事实 + 人物关系变化；\n'
    + '- 另列 2–3 条沉淀进跨卷钩子库的具体伏笔（一笔未清的人情、一件转手的旧物、一条传开的风声、一个尚未深究的异常）；\n'
    + '- 本卷新建的世界书条目：一次性场景 / 事件 / 龙套条目建议停用（只关不删）；与主角结下真实羁绊或留有长线余波的新角色条目建议保留启用，交由用户确认。';
  var WORLDBOOK_PROMPT = '你在为分卷导演新引入的角色写世界书条目，它会在后续聊天里被关键词触发、交给正文模型看。\n'
    + '- 只写这位角色在前台已经公开、或一登场就看得见的东西：身份与生活质感、性格与矛盾、说话习惯、与旁人的关系。\n'
    + '- 严禁写进后台尚未揭晓的秘密、隐藏身份、真实目的与结局安排——条目一旦触发，等于直接剧透给正文。\n'
    + '- 人要像活人：有自己的日子、习惯与小毛病，不是为某段剧情量身定做的部件；不用功能拼接式的名字与罐头人名。\n'
    + '- 不为了填满字段去发明新的组织、地名与世界规则；资料没有的宁可写得朴素。';

  function stripFrontmatter(text) {
    return str(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
  }

  /* 去掉一段末尾的空行与分隔线（--- 只是段与段之间的装饰，拼接时我们自己加）。 */
  function trimSection(text) {
    var out = str(text).replace(/\s+$/, '');
    var rule = /(?:^|\n)[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
    while (rule.test(out)) out = out.replace(rule, '').replace(/\s+$/, '');
    return out.replace(/^\n+/, '');
  }

  /* 按代码块之外的二级标题切段。返回 { body, preamble, sections: [{ key, heading, title, text }] }。 */
  function splitSkill(raw) {
    var body = stripFrontmatter(raw);
    var chunks = [{ heading: '', lines: [] }];
    var fence = '';
    body.split('\n').forEach(function (line) {
      var mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (mark) {
        if (!fence) fence = mark[1].charAt(0);
        else if (mark[1].charAt(0) === fence) fence = '';
      } else if (!fence && /^##[ \t]+\S/.test(line)) {
        chunks.push({ heading: line.trim(), lines: [] });
        return;
      }
      chunks[chunks.length - 1].lines.push(line);
    });
    var sections = chunks.slice(1).map(function (chunk) {
      var title = chunk.heading.replace(/^##[ \t]+/, '');
      var def = SECTION_DEFS.filter(function (item) { return item.test.test(title); })[0];
      return { key: def ? def.key : '', heading: chunk.heading, title: title, text: trimSection(chunk.heading + '\n' + chunk.lines.join('\n')) };
    });
    return { body: body.trim(), preamble: trimSection(chunks[0].lines.join('\n')), sections: sections };
  }

  /* 阶段二里「1. **严禁……**」这样的编号加粗标题。 */
  function redlineTitles(sectionText) {
    var titles = [];
    str(sectionText).split('\n').forEach(function (line) {
      var match = /^\s*\d{1,2}[.、．)）]\s*\*\*(.+?)\*\*\s*$/.exec(line);
      if (match && titles.length < 12) titles.push(match[1].trim());
    });
    return titles;
  }

  /* 一个二级段里的某个三级小节：从匹配的 ### 行到下一个 ### / ## 之前。 */
  function subsection(sectionText, test) {
    var lines = str(sectionText).split('\n'), picked = [], on = false;
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      if (/^#{2,3}[ \t]+/.test(line)) {
        if (on) break;
        if (/^###[ \t]+/.test(line) && test.test(line.replace(/^###[ \t]+/, ''))) on = true;
      }
      if (on) picked.push(line);
    }
    return trimSection(picked.join('\n'));
  }

  /*
   * 按用途切出 Skill 的一部分。返回 { text, degraded, missing }：
   *   planner    编纲：导语 + 最高原则 + 阶段一～四 + 阶段六 + 用户自己加的段（不带阶段五：那是运行期的协议）
   *   runtime    巡检：最高原则 + 阶段五 + 十条红线的标题（细则在编纲时已经用过，每轮都带太费）
   *   archive    归档：只要阶段五·丙那一小节
   *   worldbook  建档：一段固定的短提示
   * 必需的段缺了（用户把标题改得认不出来）就降级：planner / runtime 退回整篇正文——宁可多花些 token，也不让导演
   * 在缺了半本手册的情况下干活；archive 用内置的短提示，绝不回退全文（归档是个小活，不值得带一整本）。
   */
  function sliceDirectorSkillDetailed(raw, mode) {
    var parts = splitSkill(raw);
    var by = {};
    parts.sections.forEach(function (section) { if (section.key && !by[section.key]) by[section.key] = section; });
    function lack(keys) { return keys.filter(function (key) { return !by[key]; }).map(function (key) { return SECTION_LABEL[key]; }); }
    var missing;

    if (mode === 'worldbook') return { text: WORLDBOOK_PROMPT, degraded: false, missing: [] };

    if (mode === 'archive') {
      var protocol = by.stage5 ? subsection(by.stage5.text, /^丙/) : '';
      if (!protocol) return { text: ARCHIVE_FALLBACK, degraded: true, missing: ['阶段五·丙'] };
      return { text: ARCHIVE_HEAD + '\n\n' + protocol, degraded: false, missing: [] };
    }

    if (mode === 'runtime') {
      missing = lack(['principles', 'stage5']);
      if (missing.length) return { text: parts.body, degraded: true, missing: missing };
      var titles = by.stage2 ? redlineTitles(by.stage2.text) : [];
      var redlines = titles.length >= 3 ? titles : FALLBACK_REDLINES;
      return {
        text: [by.principles.text, by.stage5.text,
          '## 红线速记（运行期只列标题）\n' + redlines.map(function (title, index) { return (index + 1) + '. ' + title; }).join('\n')].join('\n\n---\n\n'),
        degraded: false, missing: []
      };
    }

    missing = lack(['principles', 'stage1', 'stage2', 'stage3', 'stage4', 'stage6']);
    if (missing.length) return { text: parts.body, degraded: true, missing: missing };
    var kept = parts.sections.filter(function (section) { return section.key !== 'stage5'; }).map(function (section) { return section.text; });
    return { text: (parts.preamble ? [parts.preamble] : []).concat(kept).join('\n\n---\n\n'), degraded: false, missing: [] };
  }

  function sliceDirectorSkill(raw, mode) { return sliceDirectorSkillDetailed(raw, mode).text; }

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
   * 编纲第 4 步（以及结构重构）的交付物 → { ok, outline, index, firstBrief, note } 或 { ok: false, truncated, error }。
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
    if (indexTag.found && indexTag.body && modules.agentKernel) {
      var parsed = modules.agentKernel.extractJson(indexTag.body);
      if (parsed.ok) parsedIndex = parsed.value;
    }
    var briefTag = tagBody(text, 'first_brief');
    var noteTag = tagBody(text, 'restructure_note');
    return {
      ok: true, outline: outline, index: normalizeIndex(parsedIndex, outline), firstBrief: briefTag.found ? briefTag.body : '',
      note: noteTag.found ? clip(noteTag.body, 200) : '', lenient: lenient
    };
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

  /* ---------- 提示词：编纲四步 ---------- */

  /*
   * 编纲四步共用的 System：Skill 的编纲切片 + 运行环境补充。四步里一个字都不变，后面三步的请求能吃到前缀缓存。
   * 结构重构也用它（同一位总导演、同一本手册）。
   */
  function buildPlannerSystem(skillRaw, preferences, userName) {
    return [
      expandUser(sliceDirectorSkill(skillRaw, 'planner'), userName),
      '---',
      '## 运行环境补充（Reader-II 分卷导演 · 编纲）',
      environmentNotes('- 你正以「插件运行模式」工作：程序分几步向你要产出，每一步只交这一步要的东西；不寒暄、不复述要求、不解释你用了什么写作技巧。', userName, preferences)
    ].join('\n\n');
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

  var PLANNER_STEPS = [
    ['【步骤 1/4 · 全景勘察】',
      '按 Skill「阶段一」对上面的资料做工况定性，只交一张《勘察卡》，不超过 600 字：',
      '0. 原件：从资料里抓出 2–4 个具体的、带烟火气或有张力的原件（一句没展开的旧话、一份已经结下的默契、一个没人深究的细节）；',
      '1. 世界土壤肥瘠：既有设定与前文够不够本卷生长，要不要引入外部变量；',
      '2. 既有关系温度：主角与核心 NPC 眼下的信任走到了哪一步，哪些关系必须保护、不许硬造内讧；',
      '3. 主角位阶与不可替代性：主角在这个世界的实力位置，本卷的戏眼为什么非这个人不可；',
      '4. 长线连续性与偏好校准：已完结的卷留下了哪些可回收的钩子，用户偏好对本卷的题材、气质、节奏提了什么硬要求。',
      '只写结论与依据，不展开剧情，不提大纲。'].join('\n'),
    ['【步骤 2/4 · 卷核立意与关系网】',
      '基于勘察卡，交 400–700 字：',
      '- 卷核：本卷是什么味道的故事，焦点张力与人心火花在哪（2–3 句）；从 Skill「阶段三」的工具箱里挑 1–3 件真正贴合这个世界的，各用一句话说怎么用——不要全用。',
      '- 关系网：3–5 位核心人物，逐位标 [既有] 或 [新增]，各写一行：眼前最想保住或做成的事 ｜ 与另一位 NPC 不经过主角的联系 ｜ 与主角的化学反应方向。',
      '- [新增] 的角色先过「阶段二」的红线 1、2、10：不造为剧情量身定做的塑料件，不起功能拼接名与罐头名，没必要就不新增。'].join('\n'),
    ['【步骤 3/4 · 单卷动态大纲】',
      '按 Skill「阶段四」写出完整大纲，颗粒度以「现场能直接演起来」为准。下面几条格式是程序要解析的，务必照做：',
      '- 五个板块各以单独一行的三级标题开头，例如「### 板块 A：全景勘察与卷核定性」（A–E 的标题用 Skill 原文）；',
      '- 板块 C 里「后台完整实情」与「客观推进时钟」各自单独起一行、以这几个字开头：前者只有导演能看，后者的节点可以在简报里露出；',
      '- 板块 D 的每个阶段以单独一行的「#### Phase N：阶段名」开头，N 从 1 连续编号，共 3–5 个；每个 Phase 写齐五项（时间与物理承接、核心场面与暗压、生活细节与伏笔落点、玩家分岔口、本段执导忌口）；',
      '- 板块 B 有 [新增] 角色时，在板块 B 末尾附「待建档角色要点」。',
      '直接写大纲正文：不自评，不解释用了什么技巧。'].join('\n'),
    ['【步骤 4/4 · 自检与交付】',
      '按 Skill「阶段六」的 8 项逐条自检上一步的大纲，查出问题就直接改正文。然后只输出下面四段，标签之外不要有任何内容：',
      '',
      '<self_check>',
      '（8 行以内：每项一行，写「通过」或「已修正：改了什么」）',
      '</self_check>',
      DELIVERY_NOTES].join('\n')
  ];
  var PLANNER_STEP_NAMES = ['全景勘察', '卷核立意与关系网', '单卷动态大纲', '自检与交付'];

  function feedbackBlock(items) {
    var list = (Array.isArray(items) ? items : []).map(function (item) { return str(item).trim(); }).filter(Boolean);
    if (!list.length) return '';
    return '\n\n【用户意见（最高优先级：与上面任何默认做法冲突时，以这里为准）】\n' + list.map(function (item) { return '- ' + item; }).join('\n');
  }

  /*
   * 第 stepIndex 步（1–4）要发的消息。ctx:
   *   system     buildPlannerSystem 的结果
   *   materials  勘察资料（四步共用，只在第一条 User 里出现一次）
   *   outputs    前几步的产出 [第 1 步, 第 2 步, 第 3 步]
   *   feedback   [{ step, text }] 用户在哪一步插的话，就跟在哪一步的要求后面（之后各步都看得到，前缀也不变）
   *   revise     { previous, text }：这一步已经交过一版，用户提了意见，要求修订重出
   * 消息是「一问一答往后接」的：第 k 步的请求以第 k-1 步的请求为前缀。
   */
  function buildPlannerStepMessages(stepIndex, ctx) {
    var context = ctx || {};
    var step = clampInt(stepIndex, 1, PLANNER_STEPS.length, 1);
    var outputs = Array.isArray(context.outputs) ? context.outputs : [];
    var feedback = Array.isArray(context.feedback) ? context.feedback : [];
    var messages = [{ role: 'system', content: str(context.system) }];
    for (var n = 1; n <= step; n += 1) {
      var notes = feedback.filter(function (item) { return item && item.step === n; }).map(function (item) { return item.text; });
      var instruction = PLANNER_STEPS[n - 1] + feedbackBlock(notes);
      messages.push({ role: 'user', content: n === 1 ? '## 勘察资料（程序自动收集）\n\n' + str(context.materials).trim() + '\n\n---\n\n' + instruction : instruction });
      if (n < step) messages.push({ role: 'assistant', content: str(outputs[n - 1]) });
    }
    if (context.revise && str(context.revise.previous).trim()) {
      messages.push({ role: 'assistant', content: str(context.revise.previous) });
      messages.push({ role: 'user', content: '【修订这一步】用户看过上面这一版后提了意见（最高优先级）：\n' + str(context.revise.text).trim()
        + '\n\n请据此把这一步完整地重出一遍：格式与篇幅要求不变，只交修订后的全文，不要解释改了哪里。' });
    }
    return messages;
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
   * 场记的 System（静态）：Skill 运行期切片 + 环境补充 + 角色简介 + 大纲 + 输出契约。
   * 只要 Skill、偏好、主角名、角色简介、大纲这五样没变，它就逐字节相同；L1 的补丁、进度、最新正文都不在这里。
   */
  function buildJudgeSystem(input) {
    var source = input || {};
    return [
      expandUser(sliceDirectorSkill(source.skillRaw, 'runtime'), source.userName),
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

  /* input: { system（编纲的 System）, outline, index, state, recent, userName, reason, feedback, manual } */
  function buildRestructureMessages(input) {
    var source = input || {};
    var state = normalizeState(source.state);
    var progress = '原大纲 ' + progressLine(source.index, state) + '；' + (state.progress || '（没有进度摘要）');
    if (state.patches.length) progress += '\n此前的局部补丁：\n' + bullets(state.patches.map(function (patch) { return '[Phase ' + patch.phase + '] ' + patch.text; }));
    var user = joinBlocks([
      block('## 结构重构', source.manual
        ? '这一卷正在后台执导中，用户要求修订大纲。请在尊重既成事实的前提下重写后续。'
        : '这一卷正在后台执导中，正文的实际发展已经让原大纲的冲突前提不再成立。请在尊重既成事实的前提下重写后续。'),
      block('### 重构原因', str(source.reason).trim() || '（场记判定为结构破局）'),
      block('### 用户的修订意见（最高优先级）', source.feedback),
      block('### 原大纲', source.outline),
      block('### 迄今硬事实（不可推翻）', state.facts.length ? bullets(state.facts) : '（暂无）'),
      block('### 当前进度', progress),
      block('### 最近的正文（# 后面是楼层号）', floorsText(source.recent, source.userName) || '（没有读到正文）'),
      block('### 要求', [
        '- 完全尊重既成事实，严禁把玩家拗回原来的轨道；保留仍有活力的角色关系与客观时钟，顺着玩家的选择长出新的展开。',
        '- 板块 A、B、C、E 只改必须改的地方；板块 D 从当前时点起重新推演，Phase 从 1 重新连续编号（已经演完的阶段不再列入，在板块 A 用两三句交代前情）。',
        '- 仍按 Skill「阶段四」的格式与「阶段六」的自检标准。只输出下面四段，标签之外不要有任何内容：'
      ].join('\n')),
      ['<restructure_note>', '（80 字以内：为什么改、改了什么）', '</restructure_note>', DELIVERY_NOTES].join('\n')
    ]);
    return [{ role: 'system', content: str(source.system) }, { role: 'user', content: user }];
  }

  /* ---------- 提示词：归档 ---------- */

  /* input: { skillRaw, preferences, userName, outline, index, state, recent, entries: [{ name, roleKind }] } */
  function buildArchiveMessages(input) {
    var source = input || {};
    var state = normalizeState(source.state);
    var entries = (Array.isArray(source.entries) ? source.entries : []).filter(function (item) { return item && item.name; });
    var system = [
      expandUser(sliceDirectorSkill(source.skillRaw, 'archive'), source.userName),
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
   * 四步的产出会一直留在上下文里，所以再用「窗口 − 固定部分 − 两倍输出上限」卡一道，窗口小的模型不至于第 3 步就满。
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
   * 把收集到的资料拼成一段。sections: [{ key, title, text, weight, tail }]；空的段不出现。
   * 返回 { text, used: { key: 字数 } }。
   */
  function composeMaterials(sections, budget) {
    var list = (Array.isArray(sections) ? sections : []).map(function (section) {
      return { key: section.key, title: section.title, text: str(section.text).trim(), weight: section.weight || 1, tail: section.tail === true };
    }).filter(function (section) { return section.text; });
    var shares = allocateBudget(budget, list.map(function (section) { return { key: section.key, weight: section.weight, size: section.text.length }; }));
    var used = {};
    var text = list.map(function (section) {
      var body = clipChars(section.text, shares[section.key] || 0, section.tail);
      used[section.key] = body.length;
      return body ? '### ' + section.title + '\n' + body : '';
    }).filter(Boolean).join('\n\n');
    return { text: text, used: used };
  }

  /* 世界书条目的摘要：启用的条目里常驻的排前面，其余按顺序值从大到小；每条一行「名字：正文开头」。 */
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

  /* 变量树的精简写法：只下到 depth 层，长字符串与长数组掐短。给模型看个大概，不是要它逐项核对。 */
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
    SKILL_NAME: SKILL_NAME, BRIEF_LIMIT: BRIEF_LIMIT, RING_LIMIT: RING_LIMIT, ARCHIVE_LIMIT: ARCHIVE_LIMIT, TAIL_WINDOW: TAIL_WINDOW, LEAK_SPAN: LEAK_SPAN,
    BRIEF_COLUMNS: BRIEF_COLUMNS, DEFAULT_SETTINGS: DEFAULT_SETTINGS, REQUIRED_HEADINGS: REQUIRED_HEADINGS, PLANNER_STEP_NAMES: PLANNER_STEP_NAMES,
    normalizeSettings: normalizeSettings, hashId: hashId,
    splitSkill: splitSkill, sliceDirectorSkill: sliceDirectorSkill, sliceDirectorSkillDetailed: sliceDirectorSkillDetailed,
    expandUser: expandUser, neutralizeMacros: neutralizeMacros, hiddenTruth: hiddenTruth, removeLeaks: removeLeaks, clampBrief: clampBrief,
    sanitizeBrief: sanitizeBrief, sanitizeBriefDetailed: sanitizeBriefDetailed,
    createChatView: createChatView, injectionAnchor: injectionAnchor, anchorOf: anchorOf,
    initialState: initialState, normalizeState: normalizeState, emptySnapshots: emptySnapshots, normalizeSnapshots: normalizeSnapshots,
    makeSnapshot: makeSnapshot, snapshotMatches: snapshotMatches, pickSnapshot: pickSnapshot, pushSnapshot: pushSnapshot, pruneVersions: pruneVersions,
    latestVersion: latestVersion, addVersion: addVersion,
    inferPhases: inferPhases, normalizeIndex: normalizeIndex, parseFinalOutline: parseFinalOutline, phaseTitle: phaseTitle,
    parseVerdict: parseVerdict, applyVerdict: applyVerdict,
    mergePreferences: mergePreferences, buildPlannerSystem: buildPlannerSystem, buildPlannerStepMessages: buildPlannerStepMessages,
    buildJudgeSystem: buildJudgeSystem, buildJudgeUser: buildJudgeUser, buildJudgeMessages: buildJudgeMessages,
    buildRestructureMessages: buildRestructureMessages, buildArchiveMessages: buildArchiveMessages, parseArchive: parseArchive, fallbackArchive: fallbackArchive,
    reconBudget: reconBudget, allocateBudget: allocateBudget, clipChars: clipChars, clipMiddle: clipMiddle, composeMaterials: composeMaterials,
    summarizeWorldbook: summarizeWorldbook, summarizeVariables: summarizeVariables
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
