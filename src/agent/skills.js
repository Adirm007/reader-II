(function (root) {
  'use strict';

  /*
   * 知识库：提示词里只列名字与一句话，用到才读正文（skill 工具），参考文件再按需 grep / read（kb:/）。
   *
   * 内置知识的正文是扩展目录里的 knowledge/<名>/SKILL.md；参考文件可以指向上游仓库的原始文档
   * （例如提示词模板的语法手册，许可证与本仓库不同，所以不随仓库分发，按需拉取并缓存七天）。
   * 用户与助手自己写的知识放在工作区 ws:/skills/<名>/SKILL.md，启动时登记。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var CACHE_MS = 7 * 86400000;
  var FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/Adirm007/reader-II@main/';

  var BUILTIN = [
    { name: 'tavern-anatomy', summary: '酒馆里各样东西在哪：角色卡、世界书、正则、酒馆助手脚本、预设、变量各自的路径与写法要点' },
    { name: 'debugging', summary: '排查「爆红 / 不渲染 / 变量不更新 / 脚本没反应」的标准定位步骤' },
    { name: 'ejs-prompt-template', summary: '酒馆 EJS（ST-Prompt-Template）语法、@@ 装饰器、作用域、多阶段动态世界书与排错', files: {
      'reference.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/reference_cn.md',
      'features.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/features_cn.md',
      'features_en.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/features.md'
    } },
    { name: 'mvu', summary: 'MVU Beta 与 MVUzod 变量框架：Zod 4 Schema、[InitVar]、[mvu_update]/[mvu_plot]、命令与 JSON Patch、$meta 与排错', files: {
      'stat_var.md': 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/doc/stat_var.md',
      'supplementary-tutorial.md': 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/doc/supplementary-tutorial.md'
    } },
    { name: 'lwb-variables', summary: '小白X（LittleWhiteBox）变量 2.0 与 3.0：宏、<varevent>、V2 <state>/$schema/JSON apply、V3 卡规则包/动作/结算/扩展', files: {
      'variables.md': 'https://cdn.jsdelivr.net/gh/RT15548/LittleWhiteBox@main/docs/user/variables.md',
      'variables-v2.md': 'https://cdn.jsdelivr.net/gh/RT15548/LittleWhiteBox@main/docs/user/variables-v2.md',
      'variables-v3.md': 'https://cdn.jsdelivr.net/gh/RT15548/LittleWhiteBox@main/docs/user/variables-v3.md',
      'variables-v3-external.md': 'https://cdn.jsdelivr.net/gh/RT15548/LittleWhiteBox@main/docs/user/variables-v3-external.md'
    } },
    { name: 'card-workflow', summary: '制卡工作流：从设定到角色卡、世界书、开场白、变量系统，再在当前酒馆里试跑验证' },
    { name: 'connector-authoring', summary: '给没有预置对接的插件写对接：找接口、起草 connector.json、试调、启用' },
    { name: 'reader-ii', summary: 'Reader-II 自身结构：FP、七槽语义适配、轻信、大厅、抽卡与排错入口' },
    { name: 'web-github', summary: '联网与 GitHub：抓网页、读仓库（gh:/）、搜代码、把工作区成果推送到仓库' },
    { name: 'mcp', summary: 'MCP 服务器：接入、使用工具箱与连接排查' },
    { name: 'device', summary: '通过后端伴侣在本地设备工作：dev:/ 文件、命令与后台任务、无头浏览器与酒馆扩展开发' },
    /* 导演的两份 Skill 物理独立、各管各的角色（「导演」页的后台子功能读的就是它们，可在「导演 → 配置」里分别编辑）。 */
    { name: 'director-planner', summary: '单卷群像导演 · 总导演（编纲与重构）的方法论：第 0 原则、全景勘察、十条红线、叙事引擎、五板块动态大纲与交付前自检' },
    { name: 'director-patrol', summary: '单卷群像导演 · 场记（每轮巡检与简报）的协议：导演简报五栏与防剧透、L0 / L1 / L2 三级偏移判定、双保险完结条件' }
  ];
  var NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;

  /* 随包内联的内置正文（构建时生成，见 build.mjs 的 defaultsModule）：有它就不必联网，离线、单文件加载时也读得到。 */
  function inlineSkill(name) {
    var table = modules.READER_BUILTIN_SKILLS;
    var text = table && typeof table[name] === 'string' ? table[name] : '';
    return text.trim() ? text : '';
  }

  function parseFrontmatter(text) {
    var source = String(text || '');
    var match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    var meta = {};
    if (match) {
      match[1].split(/\r?\n/).forEach(function (line) {
        var pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
      });
    }
    return { meta: meta, body: match ? source.slice(match[0].length) : source };
  }

  function installSkills(registry, vfs, env, store) {
    function base() {
      var configured = '';
      try { configured = env.host.__ReaderIIBase || ''; } catch (error) { configured = ''; }
      return String(configured || FALLBACK_BASE).replace(/\/?$/, '/');
    }

    async function fetchText(url, cacheKey) {
      if (cacheKey) {
        var cached = await store.get('kv', cacheKey);
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.text;
      }
      var response = await env.host.fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error('读取失败（HTTP ' + response.status + '）：' + url);
      var text = await response.text();
      if (cacheKey) await store.put('kv', cacheKey, { at: Date.now(), text: text });
      return text;
    }

    function registerBuiltin(item) {
      registry.registerSkill({
        name: item.name, summary: item.summary, files: item.files || null, source: 'builtin',
        load: async function () {
          var inline = inlineSkill(item.name);
          return parseFrontmatter(inline || await fetchText(base() + 'knowledge/' + item.name + '/SKILL.md')).body;
        }
      });
    }
    BUILTIN.forEach(registerBuiltin);

    function registerUser(name, text) {
      var parsed = parseFrontmatter(text);
      registry.registerSkill({ name: name, summary: parsed.meta.description || parsed.body.trim().split('\n')[0].slice(0, 120), body: parsed.body, source: 'user' });
    }

    /* 工作区里的知识：ws:/skills/<名>/SKILL.md，frontmatter 里的 description 作为一句话说明。 */
    async function loadUserSkills() {
      var listing;
      try { listing = await vfs.list('ws:/skills', { offset: 0, limit: 200 }); } catch (error) { return 0; }
      var count = 0;
      for (var index = 0; index < listing.items.length; index += 1) {
        var name = listing.items[index].name;
        if (!listing.items[index].dir || !NAME.test(name)) continue;
        var text = await vfs.readText('ws:/skills/' + name + '/SKILL.md').catch(function () { return null; });
        if (text === null) continue;
        registerUser(name, text);
        count += 1;
      }
      return count;
    }

    /*
     * 按名字重新登记一份知识，返回现在生效的是哪一份：user（工作区里的）/ builtin（内置的）/ none。
     * 工作区里的同名文件覆盖内置；文件被删掉或清空后回到内置（没有内置的就从目录里去掉）。
     * 启动时只扫一次工作区是不够的：她自己写了一份新知识、用户在面板里改了导演的某一份 Skill 或点了「恢复内置默认」，都要当场生效。
     */
    async function reload(name) {
      var key = String(name || '');
      if (!NAME.test(key)) return 'none';
      var text = await vfs.readText('ws:/skills/' + key + '/SKILL.md').catch(function () { return null; });
      if (typeof text === 'string' && text.trim()) { registerUser(key, text); return 'user'; }
      var builtin = BUILTIN.filter(function (item) { return item.name === key; })[0];
      if (builtin) { registerBuiltin(builtin); return 'builtin'; }
      registry.unregisterSkill(key);
      return 'none';
    }

    if (typeof vfs.onWrite === 'function') {
      vfs.onWrite(function (event) {
        if (event.mount !== 'ws' || event.segs.length !== 3 || event.segs[0] !== 'skills' || event.segs[2] !== 'SKILL.md') return;
        reload(event.segs[1]).catch(function () { /* 下次启动时会再扫一遍 */ });
      });
    }

    vfs.mount({
      id: 'kb', title: '知识库的参考文件（只读）', hint: 'kb:/<知识名>/…；先用 skill 读正文', readonly: true,
      scope: function () { return 'workspace'; },
      list: function (segs) {
        if (!segs.length) return registry.skills().map(function (skill) { return { name: skill.name, dir: true, note: skill.summary }; });
        var skill = registry.skills().filter(function (item) { return item.name === segs[0]; })[0];
        if (!skill) return [];
        return [{ name: 'SKILL.md' }].concat(Object.keys(skill.files || {}).map(function (file) { return { name: file, note: '参考文件，首次读取时联网获取' }; }));
      },
      read: async function (segs) {
        if (segs.length < 2) return null;
        var skill = await registry.loadSkill(segs[0]);
        if (!skill) return null;
        if (segs[1] === 'SKILL.md') return String(skill.body || '');
        var url = skill.files && skill.files[segs[1]];
        return url ? fetchText(url, 'kb:' + segs[0] + '/' + segs[1]) : null;
      }
    });

    return {
      loadUserSkills: loadUserSkills, reload: reload, builtin: BUILTIN.map(function (item) { return item.name; }),
      /* 内置正文的原文（带 frontmatter）：先用随包内联的，没有再去扩展目录取。 */
      builtinText: async function (name) {
        if (!BUILTIN.some(function (item) { return item.name === name; })) return null;
        return inlineSkill(name) || fetchText(base() + 'knowledge/' + name + '/SKILL.md');
      }
    };
  }

  modules.parseSkillFrontmatter = parseFrontmatter;
  modules.inlineBuiltinSkill = inlineSkill;
  modules.installSkills = installSkills;
})(typeof globalThis !== 'undefined' ? globalThis : window);
