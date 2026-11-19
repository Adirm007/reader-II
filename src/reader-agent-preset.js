(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  async function selectedPrompts(env, ctx) {
    if (ctx.mainApi && ctx.mainApi !== 'openai') {
      var power = ctx.powerUserSettings || {};
      var system = power.sysprompt;
      if (!system && power.instruct && power.instruct.enabled) system = { enabled: true, content: power.instruct.system_prompt };
      return system && system.enabled ? [
        { content: system.content }, { identifier: 'chatHistory', marker: true }, { content: system.post_history }
      ] : [];
    }
    var openai;
    if (env.hostImport) {
      try { openai = await env.hostImport('/scripts/openai.js'); } catch (_) { /* 旧版可从设置读取 */ }
    }
    var manager = openai && openai.promptManager;
    if (manager && manager.activeCharacter && typeof manager.getPromptsForCharacter === 'function') {
      return manager.getPromptsForCharacter(manager.activeCharacter, true);
    }
    var settings = ctx.chatCompletionSettings || (openai && openai.oai_settings) || {};
    if (Array.isArray(settings.prompts)) {
      var groups = settings.prompt_order || [];
      var active = groups.find(function (g) { return String(g.character_id) === String(ctx.characterId); })
        || groups.find(function (g) { return Number(g.character_id) === 100001; }) || groups[0];
      if (active && Array.isArray(active.order)) {
        var byId = new Map(settings.prompts.map(function (p) { return [p.identifier, p]; }));
        return active.order.filter(function (entry) { return entry.enabled === true; })
          .map(function (entry) { return byId.get(entry.identifier); }).filter(Boolean);
      }
      return settings.prompts.filter(function (p) { return p.enabled !== false; });
    }
    var helper = env.host.TavernHelper;
    if (helper && typeof helper.getPreset === 'function') {
      var current = await helper.getPreset('in_use');
      if (current && Array.isArray(current.prompts)) return current.prompts.filter(function (p) { return p.enabled !== false; });
    }
    return [{ content: settings.main_prompt }, { content: settings.nsfw_prompt },
      { identifier: 'chatHistory', marker: true }, { content: settings.jailbreak_prompt }];
  }

  // 仅在用户启用后调用。宏按预设顺序每项求值一次，工具循环复用同一份结果。
  modules.prepareAgentPreset = async function (env, personaName) {
    var tavern = env.host && env.host.SillyTavern;
    var ctx = tavern && typeof tavern.getContext === 'function' && tavern.getContext();
    if (!ctx) return [];
    var entries = await selectedPrompts(env, ctx);
    var output = [], afterHistory = false;
    entries.forEach(function (p) {
      if (!p) return;
      if ((p.identifier || p.id) === 'chatHistory') { afterHistory = true; return; }
      if (p.marker || !p.content || typeof p.content !== 'string') return;
      var triggers = p.injection_trigger || p.extra && p.extra.injection_trigger;
      if (Array.isArray(triggers) && triggers.length && !triggers.includes('normal') && !triggers.includes('quiet')) return;
      var text = p.content;
      if (typeof ctx.substituteParams === 'function') text = ctx.substituteParams(text, ctx.name1, personaName);
      else if (typeof ctx.substituteParamsExtended === 'function') text = ctx.substituteParamsExtended(text, { char: personaName, user: ctx.name1 });
      if (!text || !text.trim()) return;
      output.push({
        message: { role: p.role === 'user' || p.role === 'assistant' ? p.role : 'system', content: text },
        afterHistory: afterHistory, position: Number(p.injection_position || (p.position && p.position.type === 'in_chat' ? 1 : 0)),
        depth: p.injection_depth ?? p.position?.depth ?? 4, order: p.injection_order ?? p.position?.order ?? 100,
        target: p.attach_role, index: p.attach_index, side: p.attach_side
      });
    });
    return output;
  };

  // 只在初始对话中定位条目；之后追加的 assistant.tool_calls 和 tool 回执始终相邻。
  modules.applyAgentPreset = function (messages, entries) {
    if (!entries.length) return messages;
    var system = messages[0], history = messages.slice(1).map(function (m) { return Object.assign({}, m); });
    var before = [], after = [], depths = new Map();
    entries.forEach(function (item) {
      if (item.position === 2) {
        var matches = history.filter(function (m) { return m.role === item.target; });
        var index = Number(item.index) || 1;
        var target = matches[Math.max(0, Math.min(matches.length - 1, index > 0 ? index - 1 : matches.length + index))];
        if (target) {
          target.content = item.side === 'start' ? item.message.content + '\n\n' + target.content : target.content + '\n\n' + item.message.content;
        } else if (item.target === 'system') before.push({ role: 'system', content: item.message.content });
      } else if (item.position === 1) {
        var at = Math.max(0, history.length - Math.max(0, Number(item.depth) || 0));
        if (!depths.has(at)) depths.set(at, []);
        depths.get(at).push(item);
      } else {
        (item.afterHistory ? after : before).push(item.message);
      }
    });
    var assembled = [system].concat(before);
    for (var i = 0; i <= history.length; i++) {
      var group = depths.get(i);
      if (group) group.sort(function (a, b) { return b.order - a.order; }).forEach(function (item) { assembled.push(item.message); });
      if (i < history.length) assembled.push(history[i]);
    }
    return assembled.concat(after);
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
