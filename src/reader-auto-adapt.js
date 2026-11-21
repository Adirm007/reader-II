(function (root) {
  'use strict';

  /*
   * 一键适配：自动为七个语义槽寻找宿主 MVU 变量并绑定。
   *
   *   1. 结构启发式：按键名近义词 + 条目形状，为每个槽列出若干候选路径；
   *   2. 语义寻路（可选，一次 LLM 调用）：把宿主变量的结构大纲交给模型，按“语义”而非字面指认路径与字段；
   *   3. 逐槽逐候选尝试：锁定根 → 生成映射 → 主系统 DSL 校验（含往返测试）→ 启用；
   *      候选在副本上试，只有通过校验才替换当前路由。
   *
   * 已启用的槽位不动。所有绑定都经语义路由的公开接口完成，与在面板里手动绑定完全等价。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var SLOTS = ['location', 'characters', 'tasks', 'skills', 'statuses', 'currency', 'inventory'];
  var CONTAINER_SLOTS = ['characters', 'tasks', 'skills', 'statuses', 'inventory'];
  var LABELS = {
    location: '当前地点', characters: '重要角色', tasks: '任务', skills: '用户技能',
    statuses: '用户当前状态', currency: '货币（Reader FP）', inventory: '背包'
  };
  var ROOT_SYNONYMS = {
    location: ['当前地点', '当前位置', '所在地', '地点', '位置', '所在位置', '当前场景', '场景', '所在', '地图', 'location', 'place', 'position'],
    currency: ['命运点数', '命运点', 'fp', '金币', '金钱', '货币', '通用币', '资金', '钱', '余额', '点数', '积分', '信用点', '灵石', '银两', '银币', '铜币', '魔晶', 'gold', 'money', 'coin', 'coins', 'currency', 'credits'],
    characters: ['关系列表', '羁绊列表', '人物关系', '重要角色', '角色列表', '人物列表', '同伴列表', '关系', '羁绊', '人物', '角色', '同伴', '队友', '伙伴', 'npc', 'npcs', 'characters', 'relationships', 'companions'],
    tasks: ['任务列表', '任务', '委托列表', '委托', '待办', '目标列表', 'quests', 'quest', 'tasks', 'missions'],
    skills: ['技能列表', '技能', '能力列表', '术式', '技艺', '专长', '法术', '招式', 'skills', 'abilities', 'spells'],
    statuses: ['状态效果', '状态列表', '当前状态', '效果列表', '增益减益', '状态', 'buff', 'buffs', 'debuff', 'statuses', 'effects', 'conditions'],
    inventory: ['背包', '物品栏', '物品列表', '道具栏', '道具', '物品', '行囊', '库存', '持有物', '收纳', '储物', 'inventory', 'items', 'bag', 'backpack']
  };
  var FIELD_SYNONYMS = {
    name: ['名称', '名字', '姓名', '任务名', '任务名称', '技能名', '技能名称', '物品名', '物品名称', '标题', 'name', 'title'],
    favor: ['好感度', '好感', '好感值', '亲密度', '亲密', '羁绊值', '信赖度', '信任度', '喜爱', 'favor', 'favorability', 'affection', 'affinity'],
    present: ['在场', '是否在场', '在场状态', '登场', 'present'],
    identity: ['身份', '职业', '地位', '称号', 'identity', 'role'],
    effect: ['效果', '效果描述', '描述', '说明', '详情', 'effect', 'description'],
    duration: ['剩余时间', '持续时间', '持续', '时长', '剩余', '倒计时', '期限', 'duration', 'remaining'],
    source: ['来源', '出处', 'source'],
    count: ['数量', '个数', '件数', '持有数', 'count', 'amount', 'quantity', 'qty'],
    quality: ['品质', '稀有度', '品阶', '等阶', '星级', 'quality', 'rarity', 'grade'],
    type: ['类型', '种类', '类别', '分类', 'type', 'category', 'kind'],
    tags: ['标签', '词条', 'tags'],
    description: ['描述', '说明', '简介', '介绍', '备注', 'description', 'desc']
  };
  var PROTAGONIST_HINT = /主角|玩家|user|protagonist|自己|自身|本人|player|我的|角色状态/i;
  var DANGEROUS = { __proto__: true, prototype: true, constructor: true };

  function keysOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value).filter(function (key) { return !DANGEROUS[key]; });
  }

  function norm(text) {
    return String(text == null ? '' : text).replace(/[\s_\-—·()（）【】\[\]<>《》:：]+/g, '').toLowerCase();
  }

  /* 键名与近义词表的匹配度：完全相同 3，包含 2，被包含 1。 */
  function matchScore(key, synonyms) {
    var target = norm(key);
    if (!target) return 0;
    var best = 0;
    for (var index = 0; index < synonyms.length; index += 1) {
      var synonym = norm(synonyms[index]);
      if (!synonym) continue;
      if (target === synonym) return 3 - index * 0.001;
      if (target.indexOf(synonym) >= 0 && synonym.length >= 2) best = Math.max(best, 2 - index * 0.001);
      else if (synonym.indexOf(target) >= 0 && target.length >= 2) best = Math.max(best, 1 - index * 0.001);
    }
    return best;
  }

  function kindOf(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value === 'object' ? 'object' : typeof value;
  }

  function sampleItems(value) {
    if (Array.isArray(value)) return value.slice(0, 30);
    return keysOf(value).slice(0, 30).map(function (key) { return value[key]; });
  }

  /* 在条目里（至多下探一层）找某个语义字段，返回相对路径。 */
  function findField(items, synonyms, accept) {
    var best = null;
    items.forEach(function (item) {
      if (!modules.isObject(item)) return;
      keysOf(item).forEach(function (key) {
        var value = item[key];
        var score = matchScore(key, synonyms);
        if (score > 0 && (!accept || accept(value)) && (!best || score > best.score)) best = { path: [key], score: score };
        if (modules.isObject(value)) keysOf(value).forEach(function (inner) {
          var innerScore = matchScore(inner, synonyms) - 0.5;
          if (innerScore > 0 && (!accept || accept(value[inner])) && (!best || innerScore > best.score)) best = { path: [key, inner], score: innerScore };
        });
      });
    });
    return best ? best.path : null;
  }

  var isText = function (value) { return typeof value === 'string'; };
  var isNumberLike = function (value) { return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))); };

  /* 「背包: { 通用币: 10, 道具: {...} }」里的道具表才是物品容器。 */
  function inventoryWrapper(value) {
    var keys = keysOf(value);
    return keys.some(function (key) {
      var child = value[key];
      if (!child || typeof child !== 'object' || matchScore(key, ROOT_SYNONYMS.inventory) < 2.9) return false;
      return keys.some(function (sibling) {
        return sibling !== key && typeof value[sibling] === 'number' && matchScore(sibling, ROOT_SYNONYMS.currency) > 0;
      }) || (keys.length === 1 && sampleItems(child).some(modules.isObject));
    });
  }

  /* 好感换算：样例都在 0～1 之间按百分比放大；有负值时把 -100～100 线性折算。 */
  function favorTransform(items, path) {
    var values = [];
    items.forEach(function (item) {
      var cursor = item;
      for (var index = 0; index < path.length && cursor && typeof cursor === 'object'; index += 1) cursor = cursor[path[index]];
      var number = Number(cursor);
      if (cursor !== null && cursor !== '' && cursor !== undefined && Number.isFinite(number)) values.push(number);
    });
    if (!values.length) return { type: 'identity' };
    var minimum = Math.min.apply(null, values), maximum = Math.max.apply(null, values);
    if (minimum < 0 && minimum >= -100 && maximum <= 100) return { type: 'linear', scale: 0.5, offset: 50 };
    if (minimum >= 0 && maximum <= 1 && values.some(function (value) { return value > 0 && value < 1; })) return { type: 'linear', scale: 100, offset: 0 };
    if (minimum >= 0 && maximum <= 10 && values.length >= 2 && maximum > 1 && values.every(function (value) { return value <= 10; })) return { type: 'linear', scale: 10, offset: 0 };
    return { type: 'identity' };
  }

  function cleanFieldPath(input) {
    if (!Array.isArray(input) || !input.length || input.length > 6) return null;
    for (var index = 0; index < input.length; index += 1) {
      var segment = input[index];
      if (typeof segment === 'number' ? !Number.isInteger(segment) || segment < 0 : typeof segment !== 'string' || !segment || DANGEROUS[segment]) return null;
    }
    return input.slice();
  }

  /* 由样例条目（以及模型指认的字段，若有）生成 DSL v1 映射；缺必需语义时返回 error。 */
  function buildMapping(slot, rootRef, value, hint) {
    var kind = kindOf(value);
    var items = sampleItems(value);
    var hinted = modules.isObject(hint) ? hint : {};
    var pick = function (field, accept) {
      var path = cleanFieldPath(hinted[field]);
      if (path && items.some(function (item) {
        var value = item;
        for (var part of path) {
          if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return false;
          value = value[part];
        }
        return !accept || accept(value);
      })) return path;
      return findField(items, FIELD_SYNONYMS[field], accept);
    };
    var mapping = { version: 1, slot: slot, rootRef: rootRef, containerKind: kind, name: null, fields: {} };

    if (slot === 'inventory') {
      var objects = items.filter(modules.isObject).length;
      if (!items.length) return { error: '空背包需要物品条目的结构或已核对的映射' };
      if (kind === 'object' && items.length && items.every(function (item) { return typeof item === 'number'; })) {
        mapping.entryKind = 'count';
        mapping.name = { from: 'key' };
        return { mapping: mapping };
      }
      if (kind === 'array' && items.length && items.every(isText)) {
        mapping.entryKind = 'name';
        mapping.name = { from: 'value' };
        return { mapping: mapping };
      }
      if (objects !== items.length) return { error: '背包含不同类型的值，请选择实际物品清单' };
      mapping.entryKind = 'object';
    }

    if (kind === 'object') mapping.name = { from: 'key' };
    else {
      var namePath = pick('name', isText);
      if (!namePath) return { error: '数组容器的条目里没有找到名字字段' };
      mapping.name = { from: 'path', path: namePath };
    }

    if (slot === 'characters') {
      var favor = pick('favor', isNumberLike) || pick('favor');
      if (!favor) return { error: '条目里没有好感度一类的字段，无法换算 0～100 好感' };
      mapping.fields.favor = { path: favor, transform: modules.isObject(hinted.favorTransform) ? hinted.favorTransform : favorTransform(items, favor) };
      var present = pick('present');
      var identity = pick('identity');
      if (present) mapping.fields.present = { path: present };
      if (identity) mapping.fields.identity = { path: identity };
    } else if (slot === 'statuses') {
      var effect = pick('effect', isText);
      var duration = pick('duration', isText);
      if (!effect || !duration) return { error: '条目里没有同时找到“效果”和“持续时间”文本字段' };
      mapping.fields.effect = { path: effect };
      mapping.fields.duration = { path: duration };
      var source = pick('source', isText);
      if (source && JSON.stringify(source) !== JSON.stringify(effect)) mapping.fields.source = { path: source };
      mapping.construct = { constants: statusConstants(items, mapping) };
    } else if (slot === 'inventory') {
      var used = Object.create(null);
      if (mapping.name.from === 'path') used[JSON.stringify(mapping.name.path)] = true;
      [['count', isNumberLike], ['quality', isText], ['type', isText], ['tags', null], ['effect', null], ['description', isText]].forEach(function (pair) {
        var path = pick(pair[0], pair[1]);
        if (!path || used[JSON.stringify(path)]) return;
        used[JSON.stringify(path)] = true;
        mapping.fields[pair[0]] = { path: path };
      });
      mapping.construct = { constants: [] };
    }
    return { mapping: mapping };
  }

  /* 宿主每个状态条目都带着的同值标量字段（如 类型: "特殊"、层数: 1），新增状态时照样带上。 */
  function statusConstants(items, mapping) {
    var objects = items.filter(modules.isObject);
    if (objects.length < 2) return [];
    var occupied = Object.create(null);
    if (mapping.name.from === 'path') occupied[mapping.name.path[0]] = true;
    Object.keys(mapping.fields).forEach(function (field) { occupied[mapping.fields[field].path[0]] = true; });
    var output = [];
    keysOf(objects[0]).forEach(function (key) {
      if (occupied[key] || output.length >= 6) return;
      var first = objects[0][key];
      if (!(first === null || typeof first === 'string' || typeof first === 'boolean' || (typeof first === 'number' && Number.isFinite(first)))) return;
      if (typeof first === 'string' && first.length > 40) return;
      if (objects.every(function (item) { return Object.prototype.hasOwnProperty.call(item, key) && item[key] === first; })) output.push({ path: [key], value: first });
    });
    return output;
  }

  /* ---------- 结构启发式 ---------- */
  function discoverHeuristic(statData) {
    var found = {};
    SLOTS.forEach(function (slot) { found[slot] = []; });
    var stack = [];
    keysOf(statData).forEach(function (key) {
      if (key !== 'READER') stack.push({ segs: ['stat_data', key], value: statData[key], depth: 1, underCharacters: false, protagonist: PROTAGONIST_HINT.test(key) });
    });
    var visited = 0;
    while (stack.length && visited < 4000) {
      visited += 1;
      var node = stack.pop();
      var key = node.segs[node.segs.length - 1];
      var kind = kindOf(node.value);
      var depthPenalty = (node.depth - 1) * 0.25;
      var bonus = node.protagonist ? 0.4 : 0;

      if (kind === 'string') {
        var locationScore = matchScore(key, ROOT_SYNONYMS.location);
        if (locationScore > 0 && !node.underCharacters && node.value.trim()) {
          found.location.push({ segs: node.segs, score: locationScore - depthPenalty + bonus, source: '结构启发式' });
        }
        continue;
      }
      if (kind === 'number') {
        var currencyScore = matchScore(key, ROOT_SYNONYMS.currency);
        if (currencyScore > 0 && !node.underCharacters && Number.isFinite(node.value)) {
          found.currency.push({ segs: node.segs, score: currencyScore - depthPenalty + bonus, source: '结构启发式' });
        }
        continue;
      }
      if (kind !== 'object' && kind !== 'array') continue;

      /* 地点也可以是“大陆 / 区域 / 场所”这样的小对象。 */
      if (kind === 'object' && !node.underCharacters) {
        var objectLocation = matchScore(key, ROOT_SYNONYMS.location);
        var children = keysOf(node.value);
        if (objectLocation >= 2 && children.length && children.length <= 8 && children.every(function (child) { return typeof node.value[child] === 'string'; })) {
          found.location.push({ segs: node.segs, score: objectLocation - depthPenalty - 0.3 + bonus, source: '结构启发式' });
        }
      }

      var items = sampleItems(node.value);
      var isCharacters = false;
      CONTAINER_SLOTS.forEach(function (slot) {
        var score = matchScore(key, ROOT_SYNONYMS[slot]);
        if (score <= 0) return;
        /* 角色条目里各自带的 技能 / 状态 / 背包 属于那个角色，不是主角的。 */
        if (node.underCharacters && slot !== 'characters') return;
        if (slot === 'inventory' && inventoryWrapper(node.value)) return;
        var shape = buildMapping(slot, '', node.value, null);
        var empty = !items.length;
        if (shape.error && !empty) {
          if (slot !== 'tasks' && slot !== 'skills') return;
        }
        var total = score - depthPenalty + bonus + (shape.error ? -1 : 0.5) + (empty ? -0.4 : 0);
        if (slot === 'characters' && !shape.error) { total += 0.5; isCharacters = true; }
        found[slot].push({ segs: node.segs, score: total, source: '结构启发式' });
      });

      if (node.depth >= 4) continue;
      var childKeys = kind === 'array' ? [] : keysOf(node.value);
      /* 条目数量很多的表只下探前几项：结构相同，足以判断。 */
      var deep = childKeys.length > 40 ? childKeys.slice(0, 6) : childKeys;
      deep.forEach(function (child) {
        stack.push({
          segs: node.segs.concat([child]),
          value: node.value[child],
          depth: node.depth + 1,
          underCharacters: node.underCharacters || isCharacters,
          protagonist: node.protagonist || PROTAGONIST_HINT.test(child)
        });
      });
    }
    SLOTS.forEach(function (slot) {
      found[slot].sort(function (left, right) { return right.score - left.score; });
      found[slot] = found[slot].slice(0, 4);
    });
    return found;
  }

  /* ---------- 语义寻路（LLM） ---------- */
  function outline(value, depth, limit) {
    var kind = kindOf(value);
    if (kind === 'string') return value.length > 36 ? value.slice(0, 36) + '…(' + value.length + '字)' : value;
    if (kind !== 'object' && kind !== 'array') return value;
    if (depth >= limit) return kind === 'array' ? '[数组 ' + value.length + ' 项]' : '{对象 ' + keysOf(value).length + ' 键: ' + keysOf(value).slice(0, 12).join(', ') + '}';
    if (kind === 'array') {
      var list = value.slice(0, 2).map(function (item) { return outline(item, depth + 1, limit); });
      if (value.length > 2) list.push('…共 ' + value.length + ' 项');
      return list;
    }
    var keys = keysOf(value);
    var output = {};
    var objectChildren = keys.filter(function (key) { return modules.isObject(value[key]); });
    /* 同构条目表：列出全部键名，只展开前两项。 */
    var homogeneous = keys.length > 6 && objectChildren.length === keys.length;
    keys.forEach(function (key, index) {
      if (homogeneous && index >= 2) return;
      output[key] = outline(value[key], depth + 1, limit);
    });
    if (homogeneous) output['…其余条目键'] = keys.slice(2, 60).join(', ') + (keys.length > 60 ? ' …共 ' + keys.length + ' 项' : '');
    return output;
  }

  function hostOutline(statData) {
    var host = {};
    keysOf(statData).forEach(function (key) { if (key !== 'READER') host[key] = statData[key]; });
    for (var limit = 6; limit >= 2; limit -= 1) {
      var text = JSON.stringify(outline(host, 0, limit));
      if (text.length <= 28000 || limit === 2) return text.length > 60000 ? text.slice(0, 60000) + '…' : text;
    }
    return '{}';
  }

  var DISCOVER_SYSTEM = [
    '你是 Reader-II 语义适配的路径发现器。',
    '任务：在宿主角色卡的变量树（MVU 或小白X）中，按语义为以下七个槽位匹配真实存在的路径与条目字段。',
    '只选用输入中明确存在的路径；无对应语义的槽位填 null。直接输出单个纯 JSON 对象。',
    '',
    '槽位语义：',
    '- location 当前地点：主角此刻所在地点（字符串或地点文本对象）。',
    '- currency 货币：主角持有的通用货币或点数（单个数值字段，区别于等级、经验、生命值等属性）。',
    '- characters 重要角色：角色对象表或含角色名字段的数组；提取好感 favor（数值），可选在场 present、身份 identity。',
    '- tasks 任务：当前任务/委托清单（名称为键的对象表或含名称字段的数组）。',
    '- skills 用户技能：主角自身的技能/能力清单（区分于同伴技能、物品、装备或基础属性）。',
    '- statuses 用户当前状态：主角身上的状态效果清单；提取效果文本 effect 与持续时间 duration，可选来源 source。',
    '- inventory 背包：主角持有的物品清单（对象表、“名称: 数量”表或名称数组）；按实际字段提取 count / quality / type / tags / effect / description。',
    '',
    '输出格式（path 为从 stat_data 之下开始的路径段数组；字段路径为条目内相对路径段数组，不存在则省略）：',
    '{"location":{"path":["世界","地点"]},"currency":null,"characters":{"path":["关系列表"],"fields":{"favor":["好感度"],"present":["在场"],"identity":["身份"]}},"tasks":null,"skills":{"path":["主角","技能"]},"statuses":{"path":["主角","状态效果"],"fields":{"effect":["效果"],"duration":["剩余时间"],"source":["来源"]}},"inventory":{"path":["主角","背包"],"fields":{"count":["数量"],"description":["描述"]}}}'
  ].join('\n');

  function looseJson(text) {
    var source = String(text || '').replace(/```(?:json)?/gi, '').trim();
    var start = source.indexOf('{');
    var end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    var body = source.slice(start, end + 1);
    try { return JSON.parse(body); } catch (error) { /* try a light repair */ }
    /* 用函数替换：主脚本里不能出现「$」加数字（酒馆助手嵌脚本时可能当成替换串，见 build.mjs 的 assertEmbeddable）。 */
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, function (match, close) { return close; })); } catch (error) { return null; }
  }

  function displayPath(input) {
    var segs = input;
    if (typeof input === 'string' && input.indexOf('hostref:') === 0) {
      try { segs = JSON.parse(decodeURIComponent(input.slice(8))); } catch (error) { return ''; }
    }
    if (!Array.isArray(segs)) return '';
    var output = '';
    segs.forEach(function (segment, index) {
      if (index === 0) output = String(segment);
      else if (typeof segment === 'number') output += '[' + segment + ']';
      else if (/^[^.[\]]+$/.test(segment)) output += '.' + segment;
      else output += '[' + JSON.stringify(segment) + ']';
    });
    return output;
  }

  function createAutoAdapt(api, llm, compiler, router) {

    function valueAt(statData, segs) {
      var cursor = { stat_data: statData };
      for (var index = 0; index < segs.length; index += 1) {
        if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, segs[index])) return undefined;
        cursor = cursor[segs[index]];
      }
      return cursor;
    }

    async function discoverLlm(statData, signal) {
      var text = await llm.chat({
        messages: [
          { role: 'system', content: DISCOVER_SYSTEM },
          { role: 'user', content: '【宿主变量结构大纲（stat_data 之下；字符串只留开头，同构条目表只展开前两项，其余列出键名）】\n' + hostOutline(statData) }
        ],
        route: 'adapt',
        temperature: 0.1,
        maxTokens: 1500,
        timeoutMs: 120000,
        retries: 1,
        signal: signal,
        generationId: 'reader-adapt-discover'
      });
      var parsed = looseJson(text);
      if (!modules.isObject(parsed)) throw new Error('语义寻路没有返回 JSON');
      var output = {};
      SLOTS.forEach(function (slot) {
        var item = parsed[slot];
        if (!modules.isObject(item) || !Array.isArray(item.path) || !item.path.length || item.path.length > 8) return;
        var segs = ['stat_data'];
        for (var index = 0; index < item.path.length; index += 1) {
          var segment = item.path[index];
          if (index === 0 && segment === 'stat_data') continue;
          if (typeof segment === 'number' ? !Number.isInteger(segment) || segment < 0 : typeof segment !== 'string' || !segment || DANGEROUS[segment]) return;
          segs.push(segment);
        }
        if (segs.length < 2 || segs[1] === 'READER') return;
        output[slot] = { segs: segs, fields: modules.isObject(item.fields) ? item.fields : null, source: '语义寻路' };
      });
      return output;
    }

    async function tryCandidate(slot, candidate, statData, options, getRules, stillCurrent) {
      var value = valueAt(statData, candidate.segs);
      if (value === undefined) throw new Error('路径不存在');
      var kind = kindOf(value);
      var container = CONTAINER_SLOTS.indexOf(slot) >= 0;
      if (container && kind !== 'object' && kind !== 'array') throw new Error('不是对象或数组');
      if (slot === 'currency' && (kind !== 'number' || !Number.isFinite(value))) throw new Error('不是有限数值');
      if (slot === 'location' && kind !== 'string' && kind !== 'object' && kind !== 'array') throw new Error('不是地点文本');
      var ref = api.createHostRef(candidate.segs);
      if (!ref) throw new Error('路径引用无效');
      var note = '';
      var mapping;
      if (container) {
        if (slot === 'inventory' && inventoryWrapper(value)) throw new Error('这是背包外层，请选择内部物品清单');
        var empty = !sampleItems(value).length;
        var supplied = options.mappings && options.mappings[slot];
        if (supplied) {
          mapping = Object.assign({ version: 1, slot: slot, rootRef: ref, containerKind: kind }, supplied);
          note = '按指定映射校验';
        } else {
          var evidence = null;
          if (empty && !(kind === 'object' && (slot === 'tasks' || slot === 'skills'))) {
            evidence = compiler.evidenceFor(candidate.segs, kind, await getRules());
            stillCurrent();
          }
          var sample = evidence && evidence.sample || value;
          var built = buildMapping(slot, ref, sample, empty ? null : candidate.fields);
          if (!built.error) {
            try { mapping = modules.validateSemanticMapping(slot, built.mapping, ref, sample, { allowEmpty: true }).mapping; }
            catch (error) { built.error = String(error.message || error); }
          }
          if (!mapping) {
            if (options.useLlm === false) throw new Error((built.error || '缺少有效映射') + (empty ? '；可指定条目映射或按变量更新规则分析' : ''));
            mapping = await compiler.compile(slot, ref, evidence);
            stillCurrent();
          }
          if (empty) note = evidence && evidence.source ? '当前为空，依据' + evidence.source + '验证映射' : '当前为空，按对象键读取名称';
        }
      }
      stillCurrent();
      await router.activateCandidate(slot, ref, mapping, stillCurrent);
      return note;
    }

    /*
     * roots 指定槽位的路径段（可省略 stat_data），只替换指定根。mappings 可给对应容器的已核对 DSL。
     * 其余选项：useLlm、slots、rebind、signal、onProgress(slot, message)。
     */
    async function run(options) {
      var opts = modules.isObject(options) ? options : {};
      if (typeof api.hasChat === 'function' && !api.hasChat()) throw new Error('请先打开要适配的角色卡聊天');
      if (typeof api.isEnabled === 'function' && !api.isEnabled()) throw new Error('当前角色卡尚未启用 Reader-II。可在助手「设置 → 这张卡」启用后继续适配');
      var roots = opts.roots || {};
      var targeted = Object.keys(roots);
      targeted.forEach(function (slot) {
        if (SLOTS.indexOf(slot) < 0 || !Array.isArray(roots[slot]) || !roots[slot].length) throw new Error('无效的指定槽位或路径：' + slot);
      });
      Object.keys(opts.mappings || {}).forEach(function (slot) {
        if (CONTAINER_SLOTS.indexOf(slot) < 0) throw new Error(slot + ' 不接受容器映射。地点和货币只需 roots；请省略对应的 mappings 后重试。');
        if (targeted.indexOf(slot) < 0 || !modules.isObject(opts.mappings[slot])) throw new Error('指定容器映射时需要同时指定其根路径：' + slot);
      });
      var slots = Array.isArray(opts.slots) && opts.slots.length ? opts.slots : targeted.length ? targeted : SLOTS;
      if (targeted.some(function (slot) { return slots.indexOf(slot) < 0; })) throw new Error('指定根路径的槽位没有列入本次 slots');
      function checkAbort() {
        if (opts.signal && opts.signal.aborted) { var error = new Error('适配已取消'); error.name = 'AbortError'; throw error; }
      }
      var checks = {};
      slots.forEach(function (slot) {
        if (SLOTS.indexOf(slot) < 0) throw new Error('未知语义槽位：' + slot);
        var checkBinding = router.bindingGuard(slot);
        checks[slot] = function () { checkAbort(); checkBinding(); };
      });
      var rules;
      var restricted = false;
      function getRules() {
        if (!rules) rules = compiler.readRules(opts.canReadRule && function (book, entry) {
          var allowed = opts.canReadRule(book, entry);
          if (!allowed) restricted = true;
          return allowed;
        });
        return rules;
      }
      checkAbort();
      var snapshot = await api.getSnapshot();
      var statData = snapshot && modules.isObject(snapshot.stat_data) ? snapshot.stat_data : {};
      var hostRoots = keysOf(statData).filter(function (key) { return key !== 'READER'; });
      var known = api.getSemanticRouting() || {};
      var wanted = SLOTS.filter(function (slot) {
        return Object.prototype.hasOwnProperty.call(known, slot) && slots.indexOf(slot) >= 0;
      });
      var report = { slotCount: wanted.length, boundCount: 0, hostRoots: hostRoots, llm: { used: false, error: '' }, slots: [] };
      if (!hostRoots.length && !targeted.length) {
        var routingNow = api.getSemanticRouting();
        wanted.forEach(function (slot) {
          var active = routingNow[slot] && routingNow[slot].status === 'active';
          if (active) report.boundCount += 1;
          report.slots.push({ slot: slot, label: LABELS[slot], status: active ? 'active' : 'unbound', changed: false, reason: active ? '' : '宿主没有 MVU 变量，继续使用 Reader 后备变量' });
        });
        report.note = '这张卡没有宿主 MVU 变量（纯文字卡）：Reader 使用自带的后备变量即可，无需适配。';
        return report;
      }
      var heuristic = discoverHeuristic(statData);
      var semantic = {};
      if (opts.useLlm !== false && wanted.some(function (slot) { return !roots[slot] && (known[slot].status !== 'active' || opts.rebind === true); })) {
        try { semantic = await discoverLlm(statData, opts.signal); report.llm.used = true; }
        catch (error) {
          if (error && error.name === 'AbortError') throw error;
          report.llm.error = String(error && error.message || error).slice(0, 200);
        }
      }
      for (var index = 0; index < wanted.length; index += 1) {
        var slot = wanted[index];
        var before = api.getSemanticRouting()[slot];
        checks[slot]();
        if (before && before.status === 'active' && opts.rebind !== true && !roots[slot]) {
          report.boundCount += 1;
          report.slots.push({ slot: slot, label: LABELS[slot], status: 'active', changed: false, path: displayPath(before.rootRef), note: '已启用，保持不变' });
          continue;
        }
        var candidates = [];
        var seen = Object.create(null);
        var choices = (semantic[slot] ? [semantic[slot]] : []).concat(heuristic[slot] || []);
        if (roots[slot]) {
          var segments = roots[slot][0] === 'stat_data' ? roots[slot] : ['stat_data'].concat(roots[slot]);
          choices = [{ segs: segments, source: '指定路径' }];
        }
        choices.forEach(function (candidate) {
          var key = JSON.stringify(candidate.segs);
          if (seen[key]) return;
          seen[key] = true;
          candidates.push(candidate);
        });
        if (typeof opts.onProgress === 'function') opts.onProgress(slot, '正在适配' + LABELS[slot]);
        var failures = [];
        var bound = null;
        for (var candidateIndex = 0; candidateIndex < candidates.length && !bound; candidateIndex += 1) {
          var candidate = candidates[candidateIndex];
          var display = displayPath(candidate.segs) || candidate.segs.join('.');
          try {
            var note = await tryCandidate(slot, candidate, statData, opts, getRules, checks[slot]);
            bound = { path: display, source: candidate.source, note: note };
          } catch (error) {
            if (error && error.name === 'AbortError') throw error;
            failures.push(display + '：' + String(error && error.message || error).slice(0, 160));
            checks[slot]();
          }
        }
        if (bound) {
          report.boundCount += 1;
          report.slots.push({ slot: slot, label: LABELS[slot], status: 'active', changed: true, path: bound.path, source: bound.source, note: bound.note || '' });
        } else {
          if (before.status === 'active') report.boundCount += 1;
          report.slots.push({
            slot: slot, label: LABELS[slot], status: before.status, changed: false, path: displayPath(before.rootRef),
            reason: candidates.length ? '候选都没有通过校验（' + failures.join('；') + '）' : '宿主变量里没有找到语义相符的路径',
            fallback: before.status === 'active' ? '继续使用原绑定' : before.status === 'broken' ? '原绑定需要修复' : '继续使用 Reader 后备变量'
          });
        }
      }
      if (targeted.length && !report.slots.some(function (item) { return targeted.includes(item.slot) && item.changed; })) report.ok = false;
      report.note = 'active 使用所列宿主路径，unbound 或 draft 使用后备变量，broken 需要修复。可在语义适配面板核对。';
      if (restricted) report.evidenceNote = '部分世界书或变量规则受读取权限限制，已跳过。需要确认的条目可用 read 单独请求读取，再按已核实的字段提供 mappings。';
      return report;
    }

    return { run: run, discoverHeuristic: discoverHeuristic, buildMapping: buildMapping, hostOutline: hostOutline };
  }

  modules.READER_ADAPT_SLOT_LABELS = LABELS;
  modules.readerOutlineValue = outline;
  modules.readerHostDisplayPath = displayPath;
  modules.createAutoAdapt = createAutoAdapt;
})(typeof globalThis !== 'undefined' ? globalThis : window);
