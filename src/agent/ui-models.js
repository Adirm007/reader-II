(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var EFFORT = { auto: '跟随模型', none: '关闭', minimal: '最低 · minimal', low: '低 · low', medium: '中 · medium', high: '高 · high', xhigh: '极高 · xhigh', max: '最高 · max' };
  var SOURCES = { custom: '自定义（OpenAI 兼容）', openai: 'OpenAI', claude: 'Anthropic Claude', makersuite: 'Google Gemini', openrouter: 'OpenRouter' };

  function createModelUi(llm, agent, view) {
    var esc = view.esc, $ = view.$;
    var serial = 0;
    function opt(value, label, current) {
      return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(label) + '</option>';
    }
    function choices(values, selected) {
      return Object.keys(values).map(function (key) { return opt(key, values[key], selected); }).join('');
    }
    function presets() { return llm.getAgentConnection().presets; }
    function activeModel() { return llm.getModelCapabilities('agent').model || llm.getBackendSummary('agent').model || '酒馆当前模型'; }
    function mediaStatus(config) {
      var attached = config.selected !== 'agent' && llm.getConnectionPreset(config.selected);
      return config.enabled ? '当前启用 · ' + (config.model || (attached && attached.model) || activeModel()) : '当前关闭';
    }
    function hasKey(object, key) {
      return !!object && Object.prototype.hasOwnProperty.call(object, key);
    }
    function presetOptions(selected, base) {
      var items = presets();
      var html = choices(base, selected) + items.map(function (p) { return opt(p.id, p.name + (p.name === p.model ? '' : ' · ' + p.model), selected); }).join('');
      if (selected && !hasKey(base, selected) && !items.some(function (p) { return p.id === selected; })) html += opt(selected, '方案已移除 · ' + selected, selected);
      return html;
    }
    function field(label, control) { return '<label class="ra-model-field"><span>' + label + '</span>' + control + '</label>'; }
    function modelPicker(model, required) {
      return '<div class="ra-model-picker">' + field(required ? '模型名称' : '使用的模型', '<input data-model-name type="text" maxlength="200" spellcheck="false" placeholder="' + (required ? '模型 ID 或代理别名' : '留空沿用连接模型，可填代理别名') + '" value="' + esc(model || '') + '">')
        + '<button type="button" class="ra-btn is-small" data-act="models-fetch">拉取模型列表</button>'
        + '<select data-model-results aria-label="从接口返回的模型中选择" hidden></select>'
        + '<span class="ra-note" data-model-hint role="status"></span></div>';
    }
    function sourceOptions(value) { return choices(SOURCES, value) + (!hasKey(SOURCES, value) && value ? opt(value, value, value) : ''); }
    function presetForm(p) {
      p = p || {};
      return '<div class="ra-model-grid" data-editor="preset" data-preset-id="' + esc(p.id || '') + '">'
        + field('方案名称', '<input type="text" data-preset-name maxlength="40" value="' + esc(p.name || '') + '">')
        + field('接口类型', '<select data-preset-source>' + sourceOptions(p.source || 'custom') + '</select>')
        + field('API 地址', '<input type="text" inputmode="url" spellcheck="false" data-preset-url placeholder="https://example.com/v1" value="' + esc(p.apiurl || '') + '">')
        + field('API Key', '<input data-preset-key type="password" autocomplete="new-password" placeholder="' + (p.hasKey ? '同一地址留空保留原密钥' : '按接口需要填写') + '">')
        + (p.hasKey ? '<label class="ra-check"><input type="checkbox" data-forget-key><span class="ra-switch" aria-hidden="true"></span><span>清除已保存的密钥</span></label>' : '')
        + modelPicker(p.model, true) + '<div class="ra-row"><button type="button" class="ra-btn" data-act="models-preset-save">保存方案</button></div></div>';
    }
    function connectionsHtml() {
      var active = llm.getAgentConnection();
      var chev = view.icon ? view.icon('chevron') : '';
      return view.card('ra-connections-card', '模型连接', '<div data-editor="main">'
        + field('主助手使用', '<select id="ra-agent-route" data-preset-options="main">' + presetOptions(active.selected, { default: '跟随默认方案', tavern: '酒馆当前连接' }) + '</select>')
        + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="models-main-save">应用主助手连接</button>'
        + '<span class="ra-note" id="ra-model-active">当前使用 · ' + esc(activeModel()) + '</span></div></div>'
        + '<details class="ra-fold" id="ra-preset-manager"><summary>' + chev + '新增或编辑独立 API 方案</summary><div class="ra-fold-body">'
        + field('编辑方案', '<select id="ra-preset-choice" data-preset-options="edit">' + presetOptions('', { '': '新建独立方案' }) + '</select>')
        + '<div id="ra-preset-form">' + presetForm() + '</div></div></details>', '单独保存');
    }
    function roleHtml(rule) {
      var rid = rule.id || ('role-' + Date.now().toString(36) + '-' + (++serial).toString(36));
      return '<fieldset class="ra-role" data-editor="role" data-role-id="' + esc(rid) + '"><legend>' + esc(rule.name || '新角色') + '</legend>'
        + '<div class="ra-model-grid">'
        + field('角色名', '<input type="text" data-role-name maxlength="64" value="' + esc(rule.name || '') + '" placeholder="例：资料研究员">')
        + field('擅长或优先承接的任务', '<textarea data-role-task rows="2" maxlength="600" placeholder="例：查资料、交叉核对来源并列出分歧">' + esc(rule.task || '') + '</textarea>')
        + field('连接', '<select data-source-select data-preset-options="role">' + presetOptions(rule.presetId || '', { '': '继承主助手连接' }) + '</select>')
        + modelPicker(rule.model, false) + field('思考档位', '<select data-role-effort>' + choices(EFFORT, rule.effort || 'auto') + '</select>')
        + '<div class="ra-row"><button type="button" class="ra-btn is-small is-ghost" data-act="models-role-remove">移除角色</button></div></div></fieldset>';
    }
    function delegationHtml() {
      var conf = agent.getSettings().subagents;
      return view.card('ra-delegation-card', '子代理', '<div data-delegation>'
        + '<label class="ra-check"><input type="checkbox" id="ra-subagents-enabled"' + (conf.enabled ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>允许主助手派发子代理</span></label>'
        + '<div class="ra-model-grid ra-mt">'
        + field('派发选模方式', '<select data-s="sub.mode" id="ra-delegate-mode">'
          + choices({ current: '始终沿用主助手模型', rules: '按任务倾向选择角色', smart: '智能代理（从模型列表选择）' }, conf.mode) + '</select>')
        + field('沿用主模型时的思考档位', '<select data-s="sub.effort">' + choices(EFFORT, conf.effort || 'auto') + '</select>')
        + '</div>'
        + '<p class="ra-note" id="ra-delegation-note"></p>'
        + '<div id="ra-roles"><div id="ra-role-rows">' + conf.rules.map(roleHtml).join('') + '</div>'
        + '<button type="button" class="ra-btn is-small" data-act="models-role-add">新增任务角色</button></div></div>', '开关立即生效');
    }
    function syncMode() {
      var mode = $('#ra-delegate-mode');
      if (!mode) return;
      var roles = $('#ra-roles');
      if (roles) roles.hidden = mode.value !== 'rules';
      var enabledBox = $('#ra-subagents-enabled');
      var enabled = !!(enabledBox && enabledBox.checked);
      var note = $('#ra-delegation-note');
      if (note) note.textContent = !enabled ? '状态：已关闭派发' : mode.value === 'smart'
        ? '状态：智能选模（不可用时回退主助手）'
        : mode.value === 'rules' ? '状态：按任务角色分工（无匹配时回退主助手）' : '状态：沿用主助手连接与模型';
    }
    function readDelegation() {
      var rules = [];
      var enabled = $('#ra-subagents-enabled').checked, mode = $('#ra-delegate-mode').value;
      var savedRules = agent.getSettings().subagents.rules;
      Array.from($('#ra-role-rows').children).forEach(function (node, i) {
        var name = node.querySelector('[data-role-name]').value.trim(), task = node.querySelector('[data-role-task]').value.trim();
        var model = node.querySelector('[data-model-name]').value.trim(), presetId = node.querySelector('[data-source-select]').value;
        if (!name && !task && (!enabled || mode !== 'rules' || !model && !presetId)) {
          var saved = savedRules.find(function (item) { return item.id === node.dataset.roleId; });
          if (saved) rules.push(saved);
          return;
        }
        if (!name && !task) throw new Error('请为第 ' + (i + 1) + ' 个子代理填写角色名或任务说明。');
        rules.push({ id: node.dataset.roleId, name: name || task.slice(0, 64), task: task || name, presetId: presetId,
          model: model, effort: node.querySelector('[data-role-effort]').value });
      });
      return { enabled: enabled, mode: mode, effort: $('[data-s="sub.effort"]').value, rules: rules };
    }
    function mediaHtml() {
      var html = ['image', 'video'].map(function (kind) {
        var config = llm.getTaskConnection(kind), label = kind === 'image' ? '图片' : '视频';
        return '<fieldset class="ra-role" data-editor="' + kind + '"><legend>' + label + '生成</legend>'
          + '<label class="ra-check"><input type="checkbox" data-media-enabled' + (config.enabled ? ' checked' : '') + '><span class="ra-switch" aria-hidden="true"></span><span>允许主助手调用' + label + '工具</span></label>'
          + '<div class="ra-model-grid">' + field('连接', '<select data-source-select data-preset-options="media">' + presetOptions(config.selected, { agent: '继承主助手连接' }) + '</select>')
          + modelPicker(config.model, false) + '<div class="ra-row"><button type="button" class="ra-btn is-small" data-act="models-media-save">应用' + label + '设置</button><span class="ra-note" data-media-status>' + esc(mediaStatus(config)) + '</span></div></div></fieldset>';
      }).join('');
      return view.card('ra-media-card', '媒体工具', html, '单独保存');
    }
    function presetValue(box) {
      var clear = box.querySelector('[data-forget-key]');
      return { id: box.dataset.presetId || undefined, name: box.querySelector('[data-preset-name]').value.trim(), source: box.querySelector('[data-preset-source]').value,
        apiurl: box.querySelector('[data-preset-url]').value.trim(), key: box.querySelector('[data-preset-key]').value, clearKey: !!(clear && clear.checked), model: box.querySelector('[data-model-name]').value.trim() };
    }
    function refreshOptions(savedId) {
      var scope = $('#ra-connections-card').parentNode;
      scope.querySelectorAll('[data-preset-options]').forEach(function (select) {
        var kind = select.dataset.presetOptions, selected = kind === 'edit' ? savedId : select.value;
        var base = kind === 'main' ? { default: '跟随默认方案', tavern: '酒馆当前连接' } : kind === 'edit' ? { '': '新建独立方案' } : kind === 'role' ? { '': '继承主助手连接' } : { agent: '继承主助手连接' };
        select.innerHTML = presetOptions(selected, base);
      });
    }
    function refreshStatus() {
      var main = $('#ra-model-active');
      if (main) main.textContent = '当前使用 · ' + activeModel();
      var card = $('#ra-media-card');
      if (card) card.querySelectorAll('[data-media-status]').forEach(function (node) {
        node.textContent = mediaStatus(llm.getTaskConnection(node.closest('[data-editor]').dataset.editor));
      });
    }
    function invalidateList(box) {
      box.dataset.query = String(++serial);
      var list = box.querySelector('[data-model-results]');
      if (list) { list.hidden = true; list.innerHTML = ''; box.querySelector('[data-model-hint]').textContent = ''; }
    }
    function input(target) {
      if (target.matches('[data-preset-url],[data-preset-key]')) invalidateList(target.closest('[data-editor]'));
    }
    async function fetchModels(button, box) {
      invalidateList(box);
      var requestId = box.dataset.query, kind = box.dataset.editor;
      var hint = box.querySelector('[data-model-hint]'), result = box.querySelector('[data-model-results]');
      var request = kind === 'preset' ? { selected: box.dataset.presetId || 'default', dedicated: presetValue(box) } : { selected: box.querySelector('[data-source-select]').value || 'agent' };
      hint.textContent = '正在读取模型…';
      button.disabled = true;
      try {
        var records = await llm.listTaskModels(kind === 'preset' ? 'agent' : kind === 'role' ? 'delegate' : kind, request);
        if (!box.isConnected || box.dataset.query !== requestId) return;
        result.innerHTML = opt('', '选择模型', '') + records.map(function (record) {
          var name = record.id + (record.contextWindow ? ' · ' + record.contextWindow.toLocaleString() + ' tokens' : '');
          return opt(record.id, name, '');
        }).join('');
        result.hidden = records.length === 0;
        hint.textContent = records.length ? '返回 ' + records.length + ' 个模型，也可手填别名。' : '接口没有返回模型，可手填模型名称。';
      } catch (error) {
        if (box.dataset.query === requestId) hint.textContent = String(error && error.message || error) + '。可手填模型名称。';
      } finally { button.disabled = false; }
    }
    function change(target) {
      var box = target.closest('[data-editor]');
      if (target.id === 'ra-preset-choice') { $('#ra-preset-form').innerHTML = presetForm(target.value ? llm.getConnectionPreset(target.value) : null); return; }
      if (target.id === 'ra-subagents-enabled') {
        try { agent.saveSettings({ subagents: Object.assign(agent.getSettings().subagents, { enabled: target.checked }) }); }
        catch (error) { target.checked = !target.checked; view.toast(String(error && error.message || error), true); }
        syncMode();
      }
      if (target.matches('[data-s="sub.mode"]')) syncMode();
      if (!box) return;
      if (target.matches('[data-preset-url],[data-preset-source],[data-preset-key],[data-source-select],[data-forget-key]')) invalidateList(box);
      if (target.matches('[data-model-results]') && target.value) { box.querySelector('[data-model-name]').value = target.value; }
      if (box.dataset.editor === 'role') view.dirty(true);
    }
    function action(name, actor) {
      var box = actor.closest('[data-editor]');
      try {
        if (name === 'models-fetch') { fetchModels(actor, box); return; }
        if (name === 'models-role-add') {
          $('#ra-role-rows').insertAdjacentHTML('beforeend', roleHtml({}));
          $('#ra-role-rows').lastElementChild.querySelector('input').focus();
          view.dirty(true);
        } else if (name === 'models-role-remove') {
          box.remove(); view.dirty(true);
        } else if (name === 'models-media-save') {
          var selected = box.querySelector('[data-source-select]').value, model = box.querySelector('[data-model-name]').value.trim(), enabled = box.querySelector('[data-media-enabled]').checked;
          llm.saveTaskConnection(box.dataset.editor, { selected: selected, model: model, enabled: enabled });
          refreshStatus();
          view.toast(box.dataset.editor === 'image' ? '图片工具设置已应用' : '视频工具设置已应用');
        } else if (name === 'models-preset-save') {
          var preset = presetValue(box);
          if (!preset.name || !preset.apiurl || !preset.model) throw new Error('请填写方案名称、API 地址和模型名称。');
          if (preset.id && llm.resolveApi('agent')?.presetId === preset.id && !view.canChangeProfile()) return;
          var saved = llm.saveConnectionPreset(preset);
          $('#ra-preset-form').innerHTML = presetForm(saved);
          refreshOptions(saved.id);
          view.profileChanged();
          refreshStatus();
          view.toast('方案「' + saved.name + '」已保存');
        } else if (name === 'models-main-save') {
          if ($('#ra-agent-route').value !== llm.getAgentConnection().selected && !view.canChangeProfile()) return;
          llm.saveAgentConnection({ selected: $('#ra-agent-route').value });
          view.profileChanged();
          refreshStatus();
          view.toast('主助手连接已应用');
        }
      } catch (error) { view.toast(String(error && error.message || error), true); }
    }
    return { connectionsHtml: connectionsHtml, delegationHtml: delegationHtml, mediaHtml: mediaHtml, readDelegation: readDelegation,
      syncMode: syncMode, refreshStatus: refreshStatus, change: change, input: input, action: action, effortOptions: function (value) { return choices(EFFORT, value); } };
  }
  modules.createModelUi = createModelUi;
})(typeof globalThis !== 'undefined' ? globalThis : window);
