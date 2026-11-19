(function (root) {
  'use strict';

  /*
   * 权限 = 档位 × 确认方式 + 规则。
   *
   * 档位（能写到哪里）：
   *   readonly  只读      什么都不改
   *   card      单卡      当前聊天、当前角色卡以及绑在这张卡上的世界书 / 正则 / 脚本
   *   tavern    酒馆全权  酒馆里的一切（其他卡、全局世界书、预设、斜杠命令、页面脚本、对外推送）
   *   device    设备全权  再加上后端伴侣：跑命令、读写设备文件、无头浏览器
   * 读：酒馆内不受档位限制；设备上的读需要 device。她自己的工作区任何档位都可写。
   *
   * 确认方式：ask 每次写入都问 ｜ auto 档位内直接做、危险操作仍问 ｜ yolo 全部直接做。
   * 规则：按路径通配的 allow / ask / deny，先于上面的判断；deny 永远生效，allow 不能越过档位。
   *
   * 每次调用给出 { effect: read | note | write | danger | net, scope: workspace | chat | card | tavern | external | device, path, tool, key }。
   * note 指她自己的记事（记忆、计划）：单卡及以上直接放行。
   * net 指联网：向外发请求、但不改酒馆里的东西（抓一个没见过的网站、调用 MCP 工具）。它不受档位限制，但默认每次都问：
   *   卡里、网页里的文字可能诱导她把聊天内容发到别处，所以「发往哪里」要让用户看一眼。
   *   免问的办法：确认卡上的「本次对话都允许」（按 key 记，例如同一个主机）、权限规则里的免问、或「全部直接执行」。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var MODE_RANK = { readonly: 0, card: 1, tavern: 2, device: 3 };
  var SCOPE_RANK = { workspace: 0, chat: 1, card: 1, tavern: 2, external: 2, device: 3 };
  var MODE_LABEL = { readonly: '只读', card: '单卡', tavern: '酒馆全权', device: '设备全权' };
  var SCOPE_NEEDS = { chat: 'card', card: 'card', tavern: 'tavern', external: 'tavern', device: 'device' };

  function globToRegExp(pattern) {
    var source = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + source + '$');
  }

  function normalizeRules(input) {
    return (Array.isArray(input) ? input : []).map(function (rule) {
      if (!rule || typeof rule.pattern !== 'string' || !rule.pattern.trim()) return null;
      return {
        effect: ['allow', 'ask', 'deny'].indexOf(rule.effect) >= 0 ? rule.effect : 'deny',
        action: ['read', 'write', '*'].indexOf(rule.action) >= 0 ? rule.action : '*',
        pattern: rule.pattern.trim().slice(0, 300)
      };
    }).filter(Boolean).slice(0, 100);
  }

  function createPermissions(getSettings) {
    var session = Object.create(null);

    function settings() {
      var source = getSettings() || {};
      return {
        mode: MODE_RANK[source.mode] === undefined ? 'card' : source.mode,
        approval: ['ask', 'auto', 'yolo'].indexOf(source.approval) >= 0 ? source.approval : 'ask',
        rules: normalizeRules(source.rules)
      };
    }

    function matchRule(rules, request) {
      var target = String(request.path || request.tool || '');
      var action = request.effect === 'read' ? 'read' : 'write';
      var hit = null;
      for (var index = 0; index < rules.length; index += 1) {
        var rule = rules[index];
        if (rule.action !== '*' && rule.action !== action) continue;
        if (!(globToRegExp(rule.pattern).test(target) || rule.pattern === request.tool)) continue;
        if (rule.effect === 'deny') return rule;   /* 禁止优先；其余取第一条匹配的 */
        if (!hit) hit = rule;
      }
      return hit;
    }

    function sessionKey(request) { return request.key ? 'key|' + String(request.key) : String(request.tool || '') + '|' + String(request.scope || ''); }

    function evaluate(request) {
      var current = settings();
      var effect = request.effect || 'read';
      var scope = SCOPE_RANK[request.scope] === undefined ? 'tavern' : request.scope;
      var rule = matchRule(current.rules, request);
      if (rule && rule.effect === 'deny') return { decision: 'deny', code: 'rule_denied', reason: '权限规则「' + rule.pattern + '」禁止了这项操作。' };

      var needsMode = (effect === 'read' || effect === 'net') ? scope === 'device' && current.mode !== 'device'
        : SCOPE_RANK[scope] > MODE_RANK[current.mode];
      if (needsMode) {
        var required = SCOPE_NEEDS[scope];
        return { decision: 'deny', code: 'mode_required', currentMode: current.mode, requiredMode: required,
          reason: '当前权限档位是「' + MODE_LABEL[current.mode] + '」，此操作需要「' + MODE_LABEL[required] + '」。档位可在「设置 → 助手 → 权限」中调整。' };
      }

      if (effect === 'read') {
        return { decision: rule && rule.effect === 'ask' ? 'ask' : 'allow' };
      }
      if (effect === 'net') {
        if (rule && rule.effect === 'allow') return { decision: 'allow' };
        if (rule && rule.effect === 'ask') return { decision: 'ask' };
        if (current.approval === 'yolo' || session[sessionKey(request)]) return { decision: 'allow' };
        return { decision: 'ask' };
      }
      if (rule && rule.effect === 'ask') return { decision: 'ask' };
      if (scope === 'workspace') return { decision: 'allow' };
      if (rule && rule.effect === 'allow') return { decision: 'allow' };
      if (effect === 'note') return { decision: 'allow' };
      if (current.approval === 'yolo') return { decision: 'allow' };
      if (effect === 'danger') return { decision: 'ask' };
      if (current.approval === 'auto' || session[sessionKey(request)]) return { decision: 'allow' };
      return { decision: 'ask' };
    }

    return {
      evaluate: evaluate,
      allowSession: function (request) { if (request.effect !== 'danger') session[sessionKey(request)] = true; },
      resetSession: function () { session = Object.create(null); },
      describe: function () {
        var current = settings();
        return '权限档位「' + MODE_LABEL[current.mode] + '」；' + (current.mode === 'readonly' ? '可查看酒馆资料、在自己的工作区 ws:/ 写草稿，修改酒馆数据需要更高档位'
          : current.approval === 'ask' ? '每次写入前会请用户确认' : current.approval === 'auto' ? '档位内的写入直接执行，危险操作仍会请用户确认' : '所有操作直接执行');
      },
      mode: function () { return settings().mode; }
    };
  }

  modules.AGENT_MODES = MODE_LABEL;
  modules.normalizePermissionRules = normalizeRules;
  modules.createPermissions = createPermissions;
})(typeof globalThis !== 'undefined' ? globalThis : window);
