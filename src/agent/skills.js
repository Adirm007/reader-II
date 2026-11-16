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
    { name: 'debugging', summary: '排查「爆红 / 不渲染 / 变量不更新 / 脚本没反应」的固定步骤' },
    { name: 'ejs-prompt-template', summary: '写与排查酒馆 EJS（提示词模板 ST-Prompt-Template 的 <% %> 语法）', files: {
      'reference.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/reference_cn.md',
      'features.md': 'https://cdn.jsdelivr.net/gh/zonde306/ST-Prompt-Template@main/docs/features_cn.md'
    } },
    { name: 'mvu', summary: 'MVU 变量框架：stat_data 结构、<UpdateVariable> 更新、初始化与常见故障' },
    { name: 'lwb-variables', summary: '小白X 的变量：存放位置、<state> 写法、模板与约束' },
    { name: 'card-workflow', summary: '制卡工作流：从设定到角色卡、世界书、开场白，再在当前酒馆里试跑；也说明怎么自定义工作流' },
    { name: 'connector-authoring', summary: '给没有预置对接的插件写对接：找接口、起草 connector.json、试调、启用' },
    { name: 'reader-ii', summary: 'Reader-II 自己：FP、语义槽、轻信、大厅、抽卡各是什么，出问题看哪里' },
    { name: 'web-github', summary: '联网与 GitHub：抓网页、读仓库（gh:/）、搜代码、把工作区里做好的东西推送上去' },
    { name: 'mcp', summary: 'MCP 服务器：怎么接入、工具箱怎么用、连不上时怎么排查' },
    { name: 'device', summary: '在设备上做事（要后端伴侣）：dev:/ 文件、跑命令与后台任务、装依赖、无头浏览器、给酒馆写扩展的流程' }
  ];

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

    BUILTIN.forEach(function (item) {
      registry.registerSkill({
        name: item.name, summary: item.summary, files: item.files || null, source: 'builtin',
        load: async function () { return parseFrontmatter(await fetchText(base() + 'knowledge/' + item.name + '/SKILL.md')).body; }
      });
    });

    /* 工作区里的知识：ws:/skills/<名>/SKILL.md，frontmatter 里的 description 作为一句话说明。 */
    async function loadUserSkills() {
      var listing;
      try { listing = await vfs.list('ws:/skills', { offset: 0, limit: 200 }); } catch (error) { return 0; }
      var count = 0;
      for (var index = 0; index < listing.items.length; index += 1) {
        var name = listing.items[index].name;
        if (!listing.items[index].dir || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) continue;
        var text = await vfs.readText('ws:/skills/' + name + '/SKILL.md').catch(function () { return null; });
        if (text === null) continue;
        var parsed = parseFrontmatter(text);
        registry.registerSkill({ name: name, summary: parsed.meta.description || parsed.body.trim().split('\n')[0].slice(0, 120), body: parsed.body, source: 'user' });
        count += 1;
      }
      return count;
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

    return { loadUserSkills: loadUserSkills, builtin: BUILTIN.map(function (item) { return item.name; }) };
  }

  modules.parseSkillFrontmatter = parseFrontmatter;
  modules.installSkills = installSkills;
})(typeof globalThis !== 'undefined' ? globalThis : window);
