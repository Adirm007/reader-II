(function (root) {
  'use strict';
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function createConnectorUi(agent, view) {
    var $ = view.$, esc = view.esc;
    var catalog = [];
    var scanProblems = [];

    function scan() { catalog = agent.scanConnectors(); }
    function connectionStatus(row) {
      if (row.problem) return '无法接入';
      if (!row.present) return '尚未检测到';
      if (row.detectionOnly) return '已检测到，待提供接口';
      if (row.enabled) return '已接入';
      return row.origin === 'builtin' || row.custom ? '已停用' : '未接入';
    }
    function rowHtml(row) {
      var abilities = [];
      if (row.hasBrief) abilities.push('可提供剧情记忆');
      if (row.tools) abilities.push(row.tools + ' 个工具');
      return '<div class="ra-item" data-conn="' + esc(row.id) + '"><div class="ra-item-main"><b>' + esc(row.title) + '</b> <span class="ra-badge">' + connectionStatus(row) + '</span>'
        + '<p class="ra-note">' + esc([row.summary].concat(abilities).filter(Boolean).join(' · ')) + '</p>'
        + (row.problem ? '<p class="ra-note is-bad">' + esc(row.problem) + '</p>' : '') + '</div><div class="ra-row">'
        + (row.present && !row.detectionOnly && !row.problem ? '<button type="button" class="ra-btn is-small" data-act="conn-toggle">' + (row.enabled ? '停用' : '接入') + '</button>' : '')
        + (row.custom ? '<button type="button" class="ra-btn is-small" data-act="conn-view">查看或编辑</button><button type="button" class="ra-btn is-small is-bad" data-act="conn-del">删除对接</button>' : '')
        + '</div></div>';
    }
    function rowsHtml() {
      var listed = catalog.filter(function (row) { return row.present || row.origin !== 'builtin'; });
      var missing = catalog.filter(function (row) { return !row.present && row.origin === 'builtin'; });
      return (listed.length ? listed.map(rowHtml).join('') : '<p class="ra-note">当前未检测到已安装的插件接口。</p>')
        + (missing.length ? '<details class="ra-fold"><summary>' + view.icon('chevron') + '支持但未检测到的插件（' + missing.length + '）</summary><div class="ra-fold-body">' + missing.map(rowHtml).join('') + '</div></details>' : '');
    }
    function problemsHtml() {
      if (!scanProblems.length) return '';
      return '<details class="ra-fold"><summary>' + view.icon('chevron') + '有 ' + scanProblems.length + ' 项插件资料未能读取</summary><div class="ra-fold-body"><ul class="ra-list">'
        + scanProblems.map(function (problem) { return '<li>' + esc(problem) + '</li>'; }).join('') + '</ul></div></details>';
    }
    function cardHtml() {
      return view.card('ra-conn-card', '插件对接',
        '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-scan">重新扫描</button></div>'
        + '<div id="ra-conn-problems">' + problemsHtml() + '</div>'
        + '<div id="ra-conn-list" class="ra-mt">' + rowsHtml() + '</div>'
        + '<details class="ra-fold" id="ra-conn-import"><summary>' + view.icon('chevron') + '导入插件对接配置（connector.json）</summary><div class="ra-fold-body">'
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="conn-file">选择 JSON 文件</button><input type="file" id="ra-conn-file" accept=".json,application/json" hidden></div>'
        + '<div class="ra-field-stack ra-mt"><label for="ra-conn-json">对接 JSON</label>'
        + '<textarea id="ra-conn-json" class="is-code" spellcheck="false" placeholder="粘贴完整的 connector.json 内容"></textarea></div>'
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn is-small" data-act="conn-save">导入或更新对接</button></div></div></details>'
        + '<details class="ra-fold" id="ra-conn-source"><summary>' + view.icon('chevron') + '添加其他插件的剧情记忆来源</summary><div class="ra-fold-body">'
        + '<div class="ra-form"><label for="ra-source-name">显示名称</label><input id="ra-source-name" type="text" placeholder="例如：我的剧情笔记">'
        + '<label for="ra-source-method">摘要读取函数</label><input id="ra-source-method" type="text" spellcheck="false" placeholder="例如：window.MyNotes.getSummary"></div>'
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn is-small" data-act="conn-source-add">添加来源</button>'
        + '<button type="button" class="ra-btn is-small" data-act="conn-goto-plot">回到剧情记忆来源</button></div></div></details>'
        + '<p class="ra-status" role="status" id="ra-conn-note"></p>', '立即生效');
    }

    function checkedIds() {
      return Array.from($('#ra-plot-options').querySelectorAll('input:checked'), function (input) { return input.value; });
    }
    function selection() { return $('#ra-plot-mode').value === 'auto' ? 'auto' : checkedIds(); }
    function sourceChoices(ids) {
      var sources = catalog.filter(function (row) { return row.hasBrief; });
      ids.forEach(function (id) {
        if (!sources.some(function (row) { return row.id === id; })) sources.push({ id: id, title: id, present: false });
      });
      var items = sources.map(function (row) {
        var checked = ids.includes(row.id);
        var usable = row.present && row.enabled;
        var needsConnection = row.present && !row.enabled && !row.problem;
        return '<div class="ra-row" data-plot-connector="' + esc(row.id) + '"><label class="ra-check"><input type="checkbox" value="' + esc(row.id) + '" data-plot-source'
          + (checked ? ' checked' : (needsConnection || row.problem ? ' disabled' : '')) + '><span class="ra-switch" aria-hidden="true"></span><span>' + esc(row.title)
          + (usable ? '' : ' <small class="ra-note">（' + (row.problem ? esc(row.problem) : connectionStatus(row) + '，可用后读取') + '）</small>') + '</span></label>'
          + (needsConnection ? '<button type="button" class="ra-btn is-small" data-act="conn-toggle">接入并选用</button>' : '') + '</div>';
      });
      return items.join('') || '<p class="ra-note">还没有可选的剧情记忆来源。</p>';
    }
    function plotHtml(selected) {
      var automatic = selected === 'auto';
      return '<div class="ra-form ra-mt"><label for="ra-plot-mode">剧情记忆来源</label><select id="ra-plot-mode">'
        + '<option value="auto"' + (automatic ? ' selected' : '') + '>自动选用首份可用摘要</option>'
        + '<option value="manual"' + (automatic ? '' : ' selected') + '>手动多选来源</option></select></div>'
        + '<div id="ra-plot-options" class="ra-mt"' + (automatic ? ' hidden' : '') + '>'
        + '<div id="ra-plot-choices">' + sourceChoices(automatic ? [] : selected) + '</div></div>'
        + '<div class="ra-row ra-mt"><button type="button" class="ra-btn is-small" data-act="conn-goto-source">添加剧情记忆来源</button></div>';
    }
    function refresh(deletedId) {
      var ids = checkedIds().filter(function (id) { return id !== deletedId; });
      scan();
      var list = $('#ra-conn-list'), fold = list.querySelector('details');
      var wasOpen = !!fold && fold.open;
      list.innerHTML = rowsHtml();
      if (wasOpen && list.querySelector('details')) list.querySelector('details').open = true;
      $('#ra-plot-choices').innerHTML = sourceChoices(ids);
    }
    function note(text, bad) {
      var el = $('#ra-conn-note');
      el.classList.toggle('is-bad', !!bad);
      el.textContent = text;
    }
    async function discover(force) {
      var container = $('#ra-conn-list');
      if (force) note('正在扫描酒馆里的插件…');
      try {
        var failures = await agent.discoverConnectors({ force: force });
        if (container !== $('#ra-conn-list') || !container) return;
        scanProblems = failures || [];
        $('#ra-conn-problems').innerHTML = problemsHtml();
        refresh();
        if (force) note('扫描完成，检测到 ' + catalog.filter(function (item) { return item.present; }).length + ' 个插件。');
      } catch (error) {
        if (container && container === $('#ra-conn-list')) note('部分插件资料未能读取，可以重新扫描。' + String(error.message || error), true);
      }
    }
    function importText(text) {
      var manifest;
      try { manifest = JSON.parse(text.trim()); } catch { throw new Error('没有读到完整的 JSON。请使用作者提供的原文件，或复制包含最外层大括号的整段内容。'); }
      var checked = agent.importConnector(manifest);
      refresh();
      note('已保存「' + checked.title + '」' + (checked.detected ? '，可以在上方查看。' : '。启用对应的酒馆插件后，请重新扫描。'));
    }
    function action(name, actor) {
      try {
        var node = actor.closest('[data-conn],[data-plot-connector]');
        var id = node && (node.dataset.conn || node.dataset.plotConnector);
        var row = id && catalog.find(function (item) { return item.id === id; });
        if (name === 'conn-goto-source') {
          $('#ra-conn-source').open = true;
          view.gotoSection('ra-conn-card', false);
          $('#ra-source-name').focus();
        } else if (name === 'conn-goto-plot') {
          view.gotoSection('ra-agent-card', false);
          $('#ra-plot-mode').focus();
        } else if (name === 'conn-scan') discover(true);
        else if (name === 'conn-toggle' && row) {
          agent.setConnectorEnabled(id, !row.enabled);
          if (node.hasAttribute('data-plot-connector') && !row.enabled) {
            node.querySelector('input').checked = true;
            view.setDirty(true);
          }
          refresh();
          note('已' + (row.enabled ? '停用' : '接入') + '「' + row.title + '」。');
        } else if (name === 'conn-view' && row) {
          var manifest = agent.getSettings().connectors.find(function (item) { return item.id === id; });
          if (manifest) { $('#ra-conn-import').open = true; $('#ra-conn-json').value = JSON.stringify(manifest, null, 2); $('#ra-conn-json').focus(); }
        } else if (name === 'conn-del' && row) {
          if (!actor.dataset.armed) { actor.dataset.armed = '1'; actor.textContent = '再点一次删除'; return; }
          agent.removeConnector(id);
          refresh(id);
          note('已删除「' + row.title + '」的对接。');
        } else if (name === 'conn-file') $('#ra-conn-file').click();
        else if (name === 'conn-save') importText($('#ra-conn-json').value);
        else if (name === 'conn-source-add') {
          var added = agent.addMemorySource($('#ra-source-name').value.trim(), $('#ra-source-method').value.trim());
          refresh();
          $('#ra-source-name').value = '';
          $('#ra-source-method').value = '';
          note('「' + added.title + '」已列入剧情记忆来源。选择「自己选择」即可勾选。');
        }
      } catch (error) { note(String(error.message || error), true); }
    }
    async function importFile(input) {
      var file = input.files[0];
      input.value = '';
      if (!file) return;
      try { importText(await file.text()); } catch (error) { note(String(error.message || error), true); }
    }
    function change(input) {
      if (input.id === 'ra-conn-file') importFile(input);
      if (input.id === 'ra-plot-mode') $('#ra-plot-options').hidden = input.value === 'auto';
      if (input.id === 'ra-plot-mode' || input.hasAttribute('data-plot-source')) view.setDirty(true);
    }
    return { scan: scan, discover: discover, cardHtml: cardHtml, plotHtml: plotHtml, selection: selection, change: change, action: action };
  }
  modules.createConnectorUi = createConnectorUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
