(function (root) {
  'use strict';

  /*
   * 分卷导演写世界书的那一部分：给本卷新引入的角色建档，完结时把一次性的条目停用。
   *
   * 模板不另起一套：读者的条目模仿、抽卡的角色条目用的是同一个模板库（本机键 reader_ii_template_library_v1），
   * 这里也读它；模板库还没建起来（用户从没打开过读者大厅）时，用随包内联的那份通用角色条目模板兜底。
   * 输出协议同样照抄抽卡的（gacha/src/gacha/entry.ts）：四个 <reader_*> 标签，正文标签只有开头没有结尾就是被截断。
   *
   * 写入不走后门：
   *   · 先问权限（助手的那一套：只读档位写不了，「禁止」规则永远生效）；用户选了「每次写入前询问」时，
   *     只有用户亲手点了「写入」才算数，后台自动建档会停下来等。
   *   · 写入经过 VFS 的 wb:/ 挂载点并带着运行日志：在「设置 → 改动记录」里能看到这一笔，也能撤销。
   *   · 每个条目的 extra.reader_ii_director 记着它是哪一卷、为谁建的：不重复建，完结时找得回来。
   * 防泄密：交给模型的大纲去掉了板块 C 的「后台完整实情」；写出来的正文再比对一遍，沾了后台实情的句子拿掉。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var LIBRARY_KEY = 'reader_ii_template_library_v1';
  var DEFAULT_TEMPLATE_ID = 'reader-default-generic-character';
  var DEFAULT_BOOK = 'Reader生成条目';
  var EXTRA_KEY = 'reader_ii_director';
  var MIN_LENGTH = { npc: 120, temp_event: 40 };
  var STRATEGIES = ['constant', 'selective', 'vectorized'];
  var ROLES = ['system', 'assistant', 'user'];
  var LOGICS = ['and_any', 'and_all', 'not_all', 'not_any'];
  var KEYWORD_MODES = ['smart', 'manual', 'none'];
  var DEFAULT_INSTRUCTION = '依据模板中的字段、占位符说明和参考资料编写一份完整内容。必须保留模板的字段顺序、层级、列表形状与整体格式；用具体内容替换占位符。模板里的说明性注释只用于理解，不要照抄。不要输出 Markdown 代码块标记。';
  var DEFAULT_NAME_RULE = '使用角色的中文名作为条目名，不带原文写法、括号与书名号。';
  var DEFAULT_KEYWORD_RULE = '主要关键词：这位角色会在聊天里自然出现的各种叫法——全名、姓或名单独的写法、昵称、绰号、头衔，每行一个，三到八个；不要整句，也不要会误触发的泛称。次要关键词留空。';

  /* 一次性的龙套与事件用不着三四千字的人物志：一张小卡片，够正文模型认得出、写不歪就行。 */
  var COMPACT_TEMPLATE = [
    '# 格式：严格照下面的字段与顺序写，直接输出内容；不要输出 Markdown 代码块标记，也不要输出这几行以 # 开头的写作要求。',
    '# 篇幅：全文 200–320 字。只写前台看得见的东西。',
    '',
    '名称: ${名字}',
    '定位: ${这个人或这件事在眼下的局面里是什么；30–50 字}',
    '样子: ${一眼认得出的外貌或现场特征；40–70 字}',
    '言行: ${说话与行事的一两个具体习惯；50–80 字}',
    '与主角: ${眼下的态度与交集；30–60 字}'
  ].join('\n');

  function str(value) { return value == null ? '' : String(value); }
  function text(value, max) { return str(value).trim().slice(0, max); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function rec(value) { return isObject(value) ? value : {}; }
  function pick(list, value, fallback) { return list.indexOf(value) >= 0 ? value : fallback; }
  function int(value, fallback) { var number = parseInt(str(value), 10); return Number.isFinite(number) ? number : fallback; }
  function uniq(list) {
    var seen = {};
    return list.map(function (item) { return str(item).trim(); }).filter(function (item) { if (!item || seen[item]) return false; seen[item] = true; return true; });
  }
  function lines(value) { return uniq(str(value).split(/[\r\n,，;；]+/)); }
  function enc(name) { return str(name).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23'); }
  function sanitizeName(name) { return str(name).replace(/[\r\n<>\/:"\\|?*#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); }

  /* 模板从别的条目反推出来时带着的透传设置：关键词、过滤器与条目自身的名字、正文不透传（与抽卡包同一条规矩）。 */
  function excludedSetting(key, top) {
    var k = key.replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (k.indexOf('filter') >= 0) return true;
    if (/^(key|keys|keysecondary|keyssecondary|keys_secondary|keywords|primarykeywords|secondarykeywords|selectivelogic)$/.test(k)) return true;
    return top && /^(uid|id|name|comment|content|displayindex)$/.test(k);
  }
  function sanitizeSettings(value, top) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(function (item) { return sanitizeSettings(item, false); });
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (!excludedSetting(key, top) && typeof value[key] !== 'function') out[key] = sanitizeSettings(value[key], false);
    });
    return out;
  }

  function normalizeOutput(raw) {
    var o = rec(raw);
    var strategyType = pick(STRATEGIES, o.strategyType, 'selective');
    var keywordMode = pick(KEYWORD_MODES, o.keywordMode, 'smart');
    if (strategyType !== 'selective') keywordMode = 'none';
    else if (keywordMode === 'none') keywordMode = 'smart';
    return {
      targetWorldbook: text(o.targetWorldbook, 120) || DEFAULT_BOOK, strategyType: strategyType,
      positionType: text(o.positionType, 40) || 'after_character_definition', role: pick(ROLES, o.role, 'system'),
      depth: Math.max(0, int(o.depth, 0)), order: int(o.order, o.order === undefined ? 601 : 100),
      probability: Math.max(0, Math.min(100, int(o.probability, 100))),
      scanDepth: str(o.scanDepth == null ? 'same_as_global' : o.scanDepth) === 'same_as_global' ? 'same_as_global' : Math.max(1, int(o.scanDepth, 1)),
      keywordMode: keywordMode, keywordRule: text(o.keywordRule, 2000) || DEFAULT_KEYWORD_RULE,
      manualPrimary: text(o.manualPrimary, 2000), manualSecondary: text(o.manualSecondary, 2000),
      secondaryLogic: pick(LOGICS, o.secondaryLogic, 'and_any'), preventIncoming: o.preventIncoming !== false, preventOutgoing: o.preventOutgoing !== false,
      passthroughSettings: rec(sanitizeSettings(rec(o.passthroughSettings), true))
    };
  }

  function normalizeTemplate(raw) {
    var r = rec(raw);
    var id = text(r.id, 120), name = text(r.name, 80), templateText = str(r.templateText).trim().slice(0, 40000);
    if (!id || !name || !templateText) return null;
    return {
      id: id, name: name, templateText: templateText,
      generationInstruction: text(r.generationInstruction, 8000) || DEFAULT_INSTRUCTION,
      entryNameRule: text(r.entryNameRule, 2000) || DEFAULT_NAME_RULE,
      output: normalizeOutput(r.output),
      builtin: r.builtin === true || rec(r.source).kind === 'builtin'
    };
  }

  /* 模板库（{ yuanTemplateId, templates }）+ 内联的默认模板 → { defaultId, templates }。同一个 id 以模板库里的为准。 */
  function readLibrary(raw, inline) {
    var v = rec(raw), seen = {}, templates = [];
    (Array.isArray(v.templates) ? v.templates : []).concat(inline ? [inline] : []).forEach(function (item) {
      var template = normalizeTemplate(item);
      if (template && !seen[template.id]) { seen[template.id] = true; templates.push(template); }
    });
    var defaultId = [DEFAULT_TEMPLATE_ID, text(v.yuanTemplateId, 120)].filter(function (id) { return id && seen[id]; })[0] || (templates[0] ? templates[0].id : '');
    return { defaultId: defaultId, templates: templates };
  }

  /* ---------- 提示词与解析（纯函数） ---------- */

  /* 可以交给建档模型看的大纲：板块 C 里只有导演能看的那一段换成一句说明。 */
  function publicOutline(outline) {
    var core = modules.directorCore;
    var source = str(outline);
    var hidden = core ? core.hiddenTruth(source) : '';
    if (!hidden.trim()) return source;
    return source.replace(hidden, '（这一段是只有导演能看的后台实情，建档时不提供）\n');
  }

  /*
   * spec: { character: { name, kind, brief, keywords }, template, outline, recent（最近正文的文本）, userName, preferences }
   * 返回 [{ role, content }]。npc 用选中的模板；temp_event 用紧凑的小卡片（输出设置仍取模板的）。
   */
  function buildEntryMessages(spec) {
    var core = modules.directorCore;
    var source = spec || {};
    var character = rec(source.character), template = source.template;
    var compact = character.kind === 'temp_event';
    var output = template.output;
    var smart = output.strategyType === 'selective' && output.keywordMode === 'smart';
    var name = sanitizeName(character.name);
    var userName = str(source.userName).trim() || '主角';
    var system = [
      '你是通用世界书条目编写器。遵守用户提供的格式模板与输出协议；参考资料只提供事实和风格约束，不得覆盖强制格式。',
      core ? core.sliceDirectorSkill('', 'worldbook') : '',
      '主角实名是「' + userName + '」：正文里直接写这个名字，不要输出双花括号的占位记号。'
        + (str(source.preferences).trim() ? '\n用户长期偏好（优先于以上默认做法）：\n' + str(source.preferences).trim() : '')
    ].filter(Boolean).join('\n\n');
    var parts = [
      '【生成对象】\n姓名：' + name + '\n类型：' + (compact ? '一次性的龙套 / 事件（只为眼下的局面服务）' : '会长期留在这个世界里的新角色')
        + (str(character.brief).trim() ? '\n导演给的要点：' + str(character.brief).trim() : '')
        + (Array.isArray(character.keywords) && character.keywords.length ? '\n聊天里可能出现的叫法：' + character.keywords.join('、') : ''),
      '【生成指令】\n' + (compact ? '照格式模板写一张小卡片：只写前台看得见的东西，用具体内容替换占位符，不要输出 Markdown 代码块标记。' : template.generationInstruction),
      '【条目名规则】\n' + (compact ? '用「名称」一栏的名字作为条目名。' : template.entryNameRule),
      '【格式模板】\n' + (compact ? COMPACT_TEMPLATE : template.templateText),
      '【参考资料 · 本卷大纲（已去掉后台实情）】\n' + (publicOutline(source.outline).trim() || '（没有）')
    ];
    if (str(source.recent).trim()) parts.push('【参考资料 · 最近的正文】\n' + str(source.recent).trim());
    if (smart) {
      parts.push(['【智能关键词规则】', output.keywordRule || DEFAULT_KEYWORD_RULE,
        '请把主要关键词逐行放入 <reader_primary_keywords>，把次要关键词逐行放入 <reader_secondary_keywords>。没有次要关键词时保留空标签。'].join('\n'));
    }
    parts.push(['【强制输出协议】', '不得输出 Markdown 代码块。', '条目名放在 <reader_entry_name> 与 </reader_entry_name> 中。',
      '严格依照模板填好的正文放在 <reader_content> 与 </reader_content> 中。',
      smart ? '必须同时输出关键词标签。' : '不要输出关键词标签。', '除这些标签及其内容外不要输出解释。'].join('\n'));
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
  }

  function stripFences(raw) { return str(raw).replace(/^\s*```[a-z0-9_-]*\s*/i, '').replace(/\s*```\s*$/, '').trim(); }

  /* 模型的回复 → { entryName, content, primary, secondary }。正文标签只有开头没有结尾 = 被截断，不写进世界书。 */
  function parseEntryReply(raw, fallbackName, roleKind) {
    var body = stripFences(raw);
    function tag(name) {
      var match = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i').exec(body);
      return match ? match[1] : undefined;
    }
    var content = tag('reader_content');
    if (content === undefined) {
      if (/<reader_content>/i.test(body)) throw Object.assign(new Error('模型的回复没有写完就断了（可以调大导演模型的回复上限后重试）'), { code: 'truncated' });
      content = body.replace(/<reader_entry_name>[\s\S]*?<\/reader_entry_name>/gi, '')
        .replace(/<reader_(?:primary|secondary)_keywords>[\s\S]*?<\/reader_(?:primary|secondary)_keywords>/gi, '');
    }
    content = stripFences(content);
    var minimum = MIN_LENGTH[roleKind === 'temp_event' ? 'temp_event' : 'npc'];
    if (content.length < minimum) throw new Error(content ? '模型返回的条目太短' : '模型没有返回条目正文');
    var named = /(?:^|\n)\s*(?:姓名|名称|name)\s*[:：]\s*["']?([^"'\n#（(]+)/i.exec(content);
    var entryName = sanitizeName(tag('reader_entry_name')) || sanitizeName(named && named[1]) || sanitizeName(fallbackName) || '未命名条目';
    return { entryName: entryName, content: content, primary: lines(tag('reader_primary_keywords')), secondary: lines(tag('reader_secondary_keywords')) };
  }

  /* 模板的输出设置 + 模型写出的正文 → 酒馆助手形状的世界书条目。marker 是 extra.reader_ii_director 里的记号。 */
  function buildEntry(template, parsed, marker, hints) {
    var o = template.output, selective = o.strategyType === 'selective';
    var primary = [], secondary = [];
    if (selective) {
      if (o.keywordMode === 'manual') { primary = lines(o.manualPrimary); secondary = lines(o.manualSecondary); }
      else { primary = parsed.primary; secondary = parsed.secondary; }
      if (!primary.length) primary = uniq([parsed.entryName, marker.name].concat(Array.isArray(hints) ? hints : []));
    }
    var entry = rec(sanitizeSettings(o.passthroughSettings, true));
    var position = rec(entry.position);
    entry.name = parsed.entryName;
    entry.enabled = true;
    entry.strategy = Object.assign({}, rec(entry.strategy), { type: o.strategyType, keys: selective ? uniq(primary) : [],
      keys_secondary: { logic: o.secondaryLogic, keys: selective ? uniq(secondary) : [] }, scan_depth: o.scanDepth });
    entry.position = Object.assign({}, position, { type: o.positionType, order: o.order });
    if (o.positionType === 'at_depth') Object.assign(entry.position, { role: o.role, depth: o.depth });
    else Object.assign(entry.position, { role: position.role === undefined ? o.role : position.role, depth: position.depth === undefined ? o.depth : position.depth });
    entry.content = parsed.content;
    entry.probability = o.probability;
    entry.recursion = Object.assign({ delay_until: null }, rec(entry.recursion), { prevent_incoming: o.preventIncoming, prevent_outgoing: o.preventOutgoing });
    entry.effect = Object.assign({ sticky: null, cooldown: null, delay: null }, rec(entry.effect));
    var extra = Object.assign({}, rec(entry.extra));
    extra[EXTRA_KEY] = { v: 1, chatKey: str(marker.chatKey), volumeId: str(marker.volumeId), floorAnchor: Number(marker.floorAnchor) || 0,
      roleKind: marker.roleKind === 'temp_event' ? 'temp_event' : 'npc', name: str(marker.name) };
    entry.extra = extra;
    return entry;
  }

  function markerOf(entry) {
    var mark = rec(rec(entry && entry.extra)[EXTRA_KEY]);
    return mark.v ? mark : null;
  }

  /* ---------- 运行时 ---------- */

  /* deps: { vfs, permissions, journal } */
  function createDirectorWorldbook(env, kit, llm, deps) {
    var vfs = deps.vfs, journal = deps.journal || null;
    var kernel = modules.agentKernel;
    var core = modules.directorCore;

    function permissions() { return typeof deps.permissions === 'function' ? deps.permissions() : deps.permissions; }

    function library() {
      var saved = null;
      try { saved = kit.localRead(LIBRARY_KEY, null); } catch (error) { saved = null; }
      return readLibrary(saved, modules.READER_DEFAULT_ENTRY_TEMPLATE || null);
    }

    function listTemplates() {
      var lib = library();
      return lib.templates.map(function (template) {
        return { id: template.id, name: template.name, builtin: template.builtin === true, targetWorldbook: template.output.targetWorldbook, isDefault: template.id === lib.defaultId };
      });
    }

    /* 指定的模板；没有指定或已经不在了，就用模板库的默认模板。一份都没有时返回 null（内联资料也没带上的极端情况）。 */
    function pickTemplate(id) {
      var lib = library();
      return lib.templates.filter(function (template) { return template.id === id; })[0]
        || lib.templates.filter(function (template) { return template.id === lib.defaultId; })[0] || lib.templates[0] || null;
    }

    /*
     * 这次写入让不让做。返回 { decision: allow | ask | deny, reason }。
     * 作用域按「当前卡」算：导演只往挂在当前卡（或当前聊天）上的那本书里写。
     */
    function checkPermission(book, name) {
      var guard = permissions();
      if (!guard || typeof guard.evaluate !== 'function') return { decision: 'allow', reason: '' };
      var verdict = guard.evaluate({ effect: 'write', scope: 'card', path: 'wb:/' + book + '/' + name, tool: 'director_wb' });
      return { decision: verdict.decision, reason: verdict.reason || (verdict.decision === 'ask' ? '当前确认方式是「每次写入前询问」：需要你亲手点一次写入。' : '') };
    }

    async function readBook(book) {
      await kit.prepareWorldbooks();
      if (kit.worldbookNames().indexOf(book) < 0) return null;
      var entries = await kit.readWorldbook(book, { optional: true });
      return Array.isArray(entries) ? entries : [];
    }

    /* 这个聊天是不是已经给这位角色建过档。 */
    async function findExisting(book, chatKey, name) {
      var entries = await readBook(book);
      if (!entries) return null;
      return entries.filter(function (entry) {
        var mark = markerOf(entry);
        return mark && mark.chatKey === chatKey && mark.name === name;
      })[0] || null;
    }

    /*
     * 让模型写出一个条目（不落盘）。spec 同 buildEntryMessages，另有 signal、maxTokens、timeoutMs、volumeId、chatKey、floorAnchor。
     * 返回 { entry, book, template, leaks }。
     */
    async function draftEntry(spec) {
      var template = spec.template || pickTemplate(spec.templateId);
      if (!template) throw new Error('没有可用的条目模板：请先在读者大厅的「条目模仿」里建一份模板');
      var character = rec(spec.character);
      var roleKind = character.kind === 'temp_event' ? 'temp_event' : 'npc';
      var messages = buildEntryMessages(Object.assign({}, spec, { template: template }));
      var reply = await llm.chatTask({
        kind: roleKind === 'temp_event' ? 'director_judge' : 'director', messages: messages, signal: spec.signal,
        maxTokens: spec.maxTokens, timeoutMs: spec.timeoutMs, retries: 1, cacheMs: 600000, generationId: 'reader-director-entry'
      });
      var parsed = parseEntryReply(reply, character.name, roleKind);
      /* 写出来的正文再比一遍后台实情：沾了的句子拿掉。 */
      var checked = core && spec.outline ? core.removeLeaks(parsed.content, spec.outline) : { text: parsed.content, leaks: 0 };
      parsed.content = checked.text;
      var entry = buildEntry(template, parsed, {
        chatKey: spec.chatKey, volumeId: spec.volumeId, floorAnchor: spec.floorAnchor, roleKind: roleKind, name: sanitizeName(character.name)
      }, character.keywords);
      return { entry: entry, book: template.output.targetWorldbook, template: template, leaks: checked.leaks };
    }

    /*
     * 把一个条目写进世界书。spec: { book, entry, confirmed（用户亲手点的）, mount（默认挂到当前卡） }
     * 返回 { ok, skipped, book, name, uid, runId, mounted, notes }；权限不允许时抛错（error.code: permission_denied / needs_confirm）。
     */
    async function writeEntry(spec) {
      var book = text(spec.book, 120) || DEFAULT_BOOK;
      var entry = Object.assign({}, spec.entry);
      var mark = markerOf(entry) || {};
      var name = sanitizeName(entry.name) || '未命名条目';
      var permission = checkPermission(book, name);
      if (permission.decision === 'deny') throw Object.assign(new Error(permission.reason || '权限不允许写入世界书'), { code: 'permission_denied' });
      if (permission.decision === 'ask' && spec.confirmed !== true) throw Object.assign(new Error(permission.reason), { code: 'needs_confirm' });

      var before = await readBook(book);
      var duplicate = (before || []).filter(function (item) {
        var other = markerOf(item);
        return other && other.chatKey === mark.chatKey && other.name === mark.name;
      })[0];
      if (duplicate) return { ok: true, skipped: true, book: book, name: str(duplicate.name), uid: duplicate.uid, runId: '', mounted: false, notes: ['这位角色在这个聊天里已经建过档，没有重复写入'] };

      /* 书里已有同名的别的条目：换个名字，不去覆盖别人的。 */
      var taken = {};
      (before || []).forEach(function (item) { taken[str(item.name)] = true; });
      if (taken[name]) {
        var alternative = name + '（导演建档）', final = alternative;
        for (var n = 2; taken[final]; n += 1) final = alternative + n;
        name = final;
      }
      var meta = Object.assign({}, entry);
      delete meta.name; delete meta.content; delete meta.uid;
      var notes = [], mounted = false;
      var path = 'wb:/' + enc(book) + '/' + enc(name);
      var run = journal ? journal.begin({ chat: kit.chatKey(), title: '导演 · 新角色建档：' + name }) : null;
      try {
        await vfs.write(path, str(entry.content), run);
        await vfs.write(path + '.meta.json', JSON.stringify(meta), run);
        if (spec.mount !== false && !kit.isWorldbookActive(book)) {
          var group = kernel && kernel.chatOwner(kit.context()).group;
          if (group) notes.push('群聊没有单独的角色卡可挂：请在世界书面板里把「' + book + '」设为全局启用，或绑定到这个聊天');
          else {
            try { await kit.mountWorldbook(book, 'character'); mounted = true; }
            catch (error) { notes.push('没能自动把「' + book + '」挂到这张卡上（' + str(error && error.message || error) + '）：请在世界书面板里手动启用'); }
          }
          if (mounted && journal && run) journal.note(run, '已把世界书「' + book + '」挂到当前角色卡');
        }
        if (journal && run) await journal.end(run, 'done');
      } catch (error) {
        if (journal && run) { try { await journal.end(run, 'error'); } catch (ignored) { /* 日志写不进去不盖过原来的错 */ } }
        throw error;
      }
      var after = await readBook(book) || [];
      var written = after.filter(function (item) { return str(item.name) === name; }).pop();
      return { ok: true, skipped: false, book: book, name: name, uid: written ? written.uid : undefined, runId: run ? run.id : '', mounted: mounted, notes: notes };
    }

    /* 本卷建过档、现在还在书里的条目：[{ id, book, uid, name, roleKind, enabled }]。books 不给时只看默认目标书与各模板的目标书。 */
    async function listVolumeEntries(volumeId, books) {
      var names = uniq((Array.isArray(books) ? books : []).concat(library().templates.map(function (template) { return template.output.targetWorldbook; }), [DEFAULT_BOOK]));
      var found = [];
      for (var index = 0; index < names.length; index += 1) {
        var entries = null;
        try { entries = await readBook(names[index]); } catch (error) { entries = null; }
        (entries || []).forEach(function (entry) {
          var mark = markerOf(entry);
          if (!mark || mark.volumeId !== volumeId) return;
          found.push({ id: names[index] + '::' + entry.uid, book: names[index], uid: entry.uid, name: str(entry.name), roleKind: mark.roleKind === 'temp_event' ? 'temp_event' : 'npc', enabled: entry.enabled !== false });
        });
      }
      return found;
    }

    async function toggle(item, enabled, run) {
      await vfs.write('wb:/' + enc(item.book) + '/' + enc(item.name + '#' + item.uid) + '.meta.json', JSON.stringify({ enabled: enabled }), run);
    }

    /*
     * 完结分流。temp_event（一次性的场面、龙套）一律停用——只关不删；npc 默认留着，keepIds 是数组时，不在里面的才停用。
     * options: { books, confirmed }。返回 { changed: [{ id, book, uid, name, roleKind }], notes }；changed 可以交给 restoreTriagedEntries 恢复。
     */
    async function triageVolumeEntries(volumeId, keepIds, options) {
      var opts = options || {};
      var entries = await listVolumeEntries(volumeId, opts.books);
      var keep = Array.isArray(keepIds) ? keepIds.map(String) : null;
      var targets = entries.filter(function (item) {
        if (!item.enabled) return false;
        return item.roleKind === 'temp_event' || (keep !== null && keep.indexOf(item.id) < 0);
      });
      var changed = [], notes = [];
      if (!targets.length) return { changed: changed, notes: notes };
      var run = journal ? journal.begin({ chat: kit.chatKey(), title: '导演 · 完结分流：停用本卷的一次性条目' }) : null;
      try {
        for (var index = 0; index < targets.length; index += 1) {
          var item = targets[index];
          var permission = checkPermission(item.book, item.name);
          if (permission.decision === 'deny' || (permission.decision === 'ask' && opts.confirmed !== true)) {
            notes.push('「' + item.name + '」没有停用：' + (permission.reason || '权限不允许'));
            continue;
          }
          try { await toggle(item, false, run); changed.push({ id: item.id, book: item.book, uid: item.uid, name: item.name, roleKind: item.roleKind }); }
          catch (error) { notes.push('「' + item.name + '」没有停用：' + str(error && error.message || error)); }
        }
      } finally {
        if (journal && run) { try { await journal.end(run, 'done'); } catch (error) { /* ignore */ } }
      }
      return { changed: changed, notes: notes };
    }

    /* 把分流时停用的条目重新启用（恢复上次归档用）。条目被用户删了、改了名的跳过。返回恢复了几条。 */
    async function restoreTriagedEntries(list) {
      var items = (Array.isArray(list) ? list : []).filter(function (item) { return item && item.book && item.uid !== undefined; });
      if (!items.length) return 0;
      var run = journal ? journal.begin({ chat: kit.chatKey(), title: '导演 · 恢复上次归档：重新启用条目' }) : null;
      var restored = 0;
      try {
        for (var index = 0; index < items.length; index += 1) {
          var item = items[index];
          if (checkPermission(item.book, item.name).decision === 'deny') continue;
          var entries = null;
          try { entries = await readBook(item.book); } catch (error) { entries = null; }
          var live = (entries || []).filter(function (entry) { return entry.uid === item.uid && markerOf(entry); })[0];
          if (!live || live.enabled !== false) continue;
          try { await toggle({ book: item.book, uid: live.uid, name: str(live.name) }, true, run); restored += 1; } catch (error) { /* 这一条恢复不了，继续下一条 */ }
        }
      } finally {
        if (journal && run) { try { await journal.end(run, 'done'); } catch (error) { /* ignore */ } }
      }
      return restored;
    }

    return {
      listTemplates: listTemplates, pickTemplate: pickTemplate, checkPermission: checkPermission, findExisting: findExisting,
      draftEntry: draftEntry, writeEntry: writeEntry, listVolumeEntries: listVolumeEntries,
      triageVolumeEntries: triageVolumeEntries, restoreTriagedEntries: restoreTriagedEntries
    };
  }

  modules.directorWorldbook = {
    LIBRARY_KEY: LIBRARY_KEY, DEFAULT_TEMPLATE_ID: DEFAULT_TEMPLATE_ID, DEFAULT_BOOK: DEFAULT_BOOK, EXTRA_KEY: EXTRA_KEY, COMPACT_TEMPLATE: COMPACT_TEMPLATE,
    normalizeTemplate: normalizeTemplate, readLibrary: readLibrary, publicOutline: publicOutline,
    buildEntryMessages: buildEntryMessages, parseEntryReply: parseEntryReply, buildEntry: buildEntry, markerOf: markerOf, sanitizeName: sanitizeName
  };
  modules.createDirectorWorldbook = createDirectorWorldbook;
})(typeof globalThis !== 'undefined' ? globalThis : window);
