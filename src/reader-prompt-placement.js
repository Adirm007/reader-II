(function (root) {
  'use strict';
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var localKey = 'reader_ii_story_prompt_placement_v1';
  var world = 'reader-ii://story-prompts';
  var sections = [
    { key: 'core', label: '夜梦核心与开场白', uid: 2, position: 0, depth: 0, order: 100 },
    { key: 'rules', label: '变量更新规则', uid: 1, position: 4, depth: 4, order: 100 },
    { key: 'list', label: '变量列表', uid: 3, position: 4, depth: 1, order: 200 }
  ];
  var positions = [
    [0, '角色定义之前'], [1, '角色定义之后'], [5, '示例消息之前'], [6, '示例消息之后'],
    [2, '作者注释之前'], [3, '作者注释之后'], [4, '聊天内指定深度'], [7, '宏出口（Outlet）']
  ];

  function integer(value, fallback, max) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return fallback;
    var n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
  }

  function normalize(values) {
    var result = {};
    sections.forEach(function (section) {
      var v = values && values[section.key] || {};
      result[section.key] = {
        enabled: v.enabled !== false,
        position: integer(v.position, section.position, 7),
        order: integer(v.order, section.order, 9999),
        depth: integer(v.depth, section.depth, 9999),
        role: integer(v.role, 0, 2),
        outletName: typeof v.outletName === 'string' ? v.outletName.trim() : ''
      };
    });
    return result;
  }

  function placements(ctx) {
    if (ctx && ctx.extensionSettings) {
      var settings = ctx.extensionSettings.reader_ii;
      return normalize(settings && settings.storyPromptPlacement);
    }
    try { return normalize(JSON.parse(root.localStorage.getItem(localKey))); }
    catch (error) { return normalize(); }
  }

  function save(ctx, value) {
    var next = normalize(value);
    if (ctx && ctx.extensionSettings) {
      ctx.extensionSettings.reader_ii = Object.assign({}, ctx.extensionSettings.reader_ii, { storyPromptPlacement: next });
      if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } else {
      root.localStorage.setItem(localKey, JSON.stringify(next));
    }
  }

  // world-info.js uses an ordinary object to collect outlets by name.
  function validOutlet(name) { return !!name && name !== '__proto__'; }

  function entries(config, output) {
    var result = [];
    sections.forEach(function (section) {
      var v = config[section.key];
      var content = output[section.key];
      if (!v.enabled || !content || (v.position === 7 && !validOutlet(v.outletName))) return;
      result.push({
        world: world, uid: section.uid, comment: section.label, content: content,
        constant: true, disable: false, key: [], keysecondary: [], triggers: [],
        excludeRecursion: true, preventRecursion: true, ignoreBudget: true, useProbability: false,
        position: v.position, depth: v.depth, order: v.order, role: v.role, outletName: v.outletName
      });
    });
    return result;
  }

  modules.readerPromptPlacement = {
    world: world, sections: sections, positions: positions, placements: placements, save: save, entries: entries, validOutlet: validOutlet
  };
})(globalThis);
