(function (root) {
  'use strict';

  /*
   * 语义适配面板（大厅「彩蛋服务台 → 语义适配」）：把读者的七个语义槽接到宿主卡的变量上。
   * 样式、主题与外框和夜梦助手窗口是同一套，都在 agent/ui-theme.js（它排在本模块之后加载，所以到打开面板时才去取）。
   * 标记里的 data-reader-* 是本文件自己的接线，也是冒烟脚本认的约定；类名只管样式，可以放心改。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var PANEL_ID = 'reader-core-panel';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildHostVariableTree(items) {
    var byRef = Object.create(null);
    var nodes = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || typeof item.ref !== 'string' || !item.ref) return;
      var node = { item: item, children: [] };
      byRef[item.ref] = node;
      nodes.push(node);
    });
    var roots = [];
    nodes.forEach(function (node) {
      var parent = node.item.parentRef && byRef[node.item.parentRef];
      if (parent) parent.children.push(node);
      else roots.push(node);
    });
    return roots;
  }

  function treeContainsRef(node, ref) {
    if (!ref) return false;
    if (node.item.ref === ref) return true;
    return node.children.some(function (child) { return treeContainsRef(child, ref); });
  }

  /* 展开 / 收起用一枚会转向的小箭头（样式按 aria-expanded 转），所以接线里不再改按钮的文字。 */
  function themeIcon(name) {
    return modules.readerTheme ? modules.readerTheme.icon(name) : '';
  }

  function renderHostVariableTree(tree, selectedRef) {
    function renderNode(node) {
      var item = node.item;
      var selected = item.ref === selectedRef;
      var expanded = selected || node.children.some(function (child) { return treeContainsRef(child, selectedRef); });
      var searchable = [item.path, item.label, item.preview, item.valueType].join(' ').toLowerCase();
      var toggle = node.children.length
        ? '<button type="button" class="reader-ui-tree-toggle" data-reader-tree-toggle aria-label="展开或收起：' + escapeHtml(item.path)
          + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' + themeIcon('caret') + '</button>'
        : '<span class="reader-ui-tree-spacer" aria-hidden="true"></span>';
      var children = node.children.length
        ? '<div class="reader-ui-tree-children" data-reader-tree-children data-reader-expanded="' + (expanded ? 'true' : 'false') + '"' + (expanded ? '' : ' hidden') + '>'
          + node.children.map(renderNode).join('') + '</div>'
        : '';
      return '<div class="reader-ui-tree-node" data-reader-node-ref="' + escapeHtml(item.ref) + '" data-reader-search-text="' + escapeHtml(searchable) + '">'
        + '<div class="reader-ui-tree-row">' + toggle
        + '<button type="button" class="reader-ui-tree-pick' + (selected ? ' is-selected' : '') + '" data-reader-tree-pick="' + escapeHtml(item.ref)
        + '" data-reader-tree-path="' + escapeHtml(item.path) + '" aria-pressed="' + (selected ? 'true' : 'false') + '">'
        + '<span class="reader-ui-tree-name"><span class="reader-ui-tree-node-mark" aria-hidden="true"></span>' + escapeHtml(item.name) + '</span>'
        + '<span class="reader-ui-tree-meta"><span class="reader-ui-tree-type">' + escapeHtml(item.valueType) + '</span>'
        + (item.preview ? '<span class="reader-ui-tree-preview">' + escapeHtml(item.preview) + '</span>' : '') + '</span></button></div>'
        + children + '</div>';
    }
    return (Array.isArray(tree) ? tree : []).map(renderNode).join('');
  }

  function createUiBridge(api, env) {
    function documentRoot() {
      return env.document || (env.host && env.host.document) || null;
    }

    function lobbyApi() {
      try {
        var readerII = (env.host || root).ReaderII;
        return readerII && readerII.lobby ? readerII.lobby : null;
      } catch (error) { return null; }
    }

    /*
     * restore：面板每做完一步都整块重画（数据要重新取）。重画前记下滚动位置与展开着的槽位，画完放回去，
     * 不然每点一下「锁定」「确认」都会跳回页顶、手上的那一格也合上了。
     */
    async function openPanel(restore) {
      var doc = documentRoot();
      if (!doc || !doc.createElement) throw new Error('当前环境无法打开Reader面板');
      var theme = modules.readerTheme || null;
      var icon = themeIcon;
      if (theme) theme.ensure(doc);
      var summary = await api.getHostTreeSummary();
      var routing = api.getSemanticRouting();
      var hostVariables = await api.listHostVariables();
      var llmSettings = api.getLlmSettings();
      var llmBackend = api.getLlmBackendSummary();
      var balance;
      try { balance = await api.getFpBalance(); } catch (error) { balance = '不可用'; }
      var slotDefinitions = [
        { key: 'location', label: '当前地点', requirement: '字符串，或包含地点文本的对象/数组', container: false },
        { key: 'characters', label: '重要角色', requirement: '对象或数组根', container: true },
        { key: 'tasks', label: '任务', requirement: '对象或数组根', container: true },
        { key: 'skills', label: '用户技能', requirement: '对象或数组根', container: true },
        { key: 'statuses', label: '用户当前状态', requirement: '对象或数组根', container: true },
        { key: 'currency', label: '货币（Reader FP）', requirement: '有限数值叶节点', container: false },
        { key: 'inventory', label: '背包（命运抽卡入包）', requirement: '对象或数组根', container: true }
      ];
      var routeStateLabels = { unbound: '未绑定', draft: '待确认', active: '已启用', broken: '需修复' };
      var hostTree = buildHostVariableTree(hostVariables);
      var adaptationRequests = {};
      for (var definitionIndex = 0; definitionIndex < slotDefinitions.length; definitionIndex += 1) {
        var requestDefinition = slotDefinitions[definitionIndex];
        if (!requestDefinition.container || !routing[requestDefinition.key] || routing[requestDefinition.key].status !== 'draft') continue;
        try { adaptationRequests[requestDefinition.key] = await api.getSemanticAdaptationRequest(requestDefinition.key); }
        catch (error) { adaptationRequests[requestDefinition.key] = { error: error.message || String(error) }; }
      }
      var containerDraftCount = ['characters', 'tasks', 'skills', 'statuses', 'inventory'].filter(function (slot) {
        return routing[slot] && routing[slot].status === 'draft';
      }).length;
      var batchRequest = null;
      var batchRequestError = '';
      if (containerDraftCount >= 2) {
        try { batchRequest = await api.getSemanticBatchAdaptationRequest(); }
        catch (error) { batchRequestError = error.message || String(error); }
      }
      var batchReady = !!(batchRequest && batchRequest.slots && batchRequest.slots.length >= 2);
      var batchStatusText = batchReady
        ? '已就绪：' + batchRequest.slots.length + ' 个锁定容器将合并为 1 次 API 请求'
        : batchRequestError || '至少锁定两个容器后可批量分析';
      var attentionRouteIndex = slotDefinitions.findIndex(function (definition) {
        var status = routing[definition.key] && routing[definition.key].status;
        return status === 'draft' || status === 'broken';
      });
      var routeCards = slotDefinitions.map(function (definition, routeIndex) {
        var route = routing[definition.key];
        var treeMarkup = renderHostVariableTree(hostTree, route.rootRef);
        var preview = definition.container ? api.getSemanticMappingPreview(definition.key) : null;
        var adaptationRequest = adaptationRequests[definition.key];
        var selectedDescriptor = hostVariables.find(function (item) { return item.ref === route.rootRef; });
        var backendLabel = route.status === 'active'
          ? (selectedDescriptor ? selectedDescriptor.path : route.rootRef)
          : route.status === 'broken' ? '已停用' : 'Reader 后备变量';
        var warning = definition.key === 'tasks'
          ? '<p class="rp-warn">绑定后宿主系统接管任务创建、监控、完成、奖励与删除；Reader只在章节触发时读取任务名防重复。</p>'
          : definition.key === 'inventory'
            ? '<p class="ra-note">命运抽卡抽到的东西放进这里；未绑定时放进 Reader 后备背包（READER.背包）。宿主条目里没有的字段（品质、标签等）会并进描述。</p>'
            : '';
        var broken = route.status === 'broken'
          ? '<p class="rp-warn">绑定损坏：' + escapeHtml(route.brokenReason || '请重新选择并适配') + '</p>'
          : '';
        var canConfirm = route.status === 'draft' && (!definition.container || preview);
        /* 一格里只留一枚主按钮：能确认时是「确认启用」，否则是「锁定所选路径」。 */
        var actions = '<button type="button" class="ra-btn' + (canConfirm ? '' : ' is-main') + '" data-reader-select="' + definition.key + '">锁定所选路径</button>';
        if (definition.container && route.status === 'draft') actions += '<button type="button" class="ra-btn" data-reader-analyze="' + definition.key + '">让 LLM 分析结构</button>';
        if (canConfirm) {
          actions += '<label class="ra-check"><input type="checkbox" data-reader-confirm-check="' + definition.key + '"><span class="ra-tick" aria-hidden="true">' + icon('check') + '</span><span>我已核对预览</span></label>'
            + '<button type="button" class="ra-btn is-main" data-reader-confirm="' + definition.key + '">确认启用</button>';
        }
        if (route.status !== 'unbound') actions += '<button type="button" class="ra-btn is-bad" data-reader-unbind="' + definition.key + '">解绑并重建默认值</button>';
        var expanded = restore && restore.open ? restore.open[definition.key] === true : routeIndex === attentionRouteIndex;
        return '<details class="rp-route" data-reader-route="' + definition.key + '"' + (expanded ? ' open' : '') + '>'
          + '<summary><span class="rp-num">' + String(routeIndex + 1).padStart(2, '0') + '</span>'
          + '<span class="rp-copy"><strong>' + escapeHtml(definition.label) + '</strong><span>' + escapeHtml(backendLabel) + '</span></span>'
          + '<span class="ra-badge rp-state" data-state="' + escapeHtml(route.status) + '">' + escapeHtml(routeStateLabels[route.status] || route.status) + '</span>'
          + '<span class="rp-chev" aria-hidden="true">' + icon('chevron') + '</span></summary>'
          + '<div class="rp-route-body">'
          + broken + warning
          + '<p class="rp-req"><span>从宿主根节点逐级展开，每一级都可选。</span><span>要求：' + escapeHtml(definition.requirement) + '</span></p>'
          + '<label class="ra-search">' + icon('search') + '<input type="search" data-reader-route-search="' + definition.key + '" placeholder="搜索路径、类型或内容" aria-label="搜索' + escapeHtml(definition.label) + '的宿主路径"></label>'
          + '<div class="reader-ui-tree" data-reader-tree="' + definition.key + '">' + (treeMarkup || '<p class="ra-note">没有可用的宿主节点</p>') + '</div>'
          + '<input type="hidden" data-reader-root="' + definition.key + '" value="' + escapeHtml(route.rootRef || '') + '">'
          + '<div class="rp-selected" data-reader-selected-path="' + definition.key + '">' + (selectedDescriptor ? '已选：' + escapeHtml(selectedDescriptor.path) : '尚未选择路径') + '</div>'
          + (adaptationRequest ? '<details class="rp-request"><summary>' + icon('chevron') + (adaptationRequest.error ? '分析请求尚不可用' : '查看发给 LLM 的结构与提示') + '</summary><pre>'
            + escapeHtml(adaptationRequest.error || adaptationRequest.prompt) + '</pre></details>' : '')
          + (preview ? '<pre class="rp-pre">' + escapeHtml(JSON.stringify(preview, null, 2)) + '</pre>' : '')
          + '<div class="rp-status" data-reader-action-status="' + definition.key + '" role="status"></div>'
          + '<div class="rp-actions">' + actions + '</div></div></details>';
      }).join('');
      var llmEndpointLabel = llmBackend.mode === 'custom'
        ? (llmBackend.model + ' · ' + llmBackend.apiurl)
        : '所有 Reader 生成使用当前酒馆连接';
      var llmConsole = '<section class="ra-card rp-llm" data-reader-llm-mode="' + escapeHtml(llmBackend.mode) + '">'
        + '<div class="rp-copy"><strong>调用源：' + escapeHtml(llmBackend.label) + '</strong><span>' + escapeHtml(llmEndpointLabel) + '</span></div>'
        + '<button type="button" class="ra-btn" data-reader-llm-settings-toggle>配置调用源</button>'
        + '<div class="rp-llm-settings" data-reader-llm-settings data-reader-api-mode="' + (llmSettings.enabled ? 'custom' : 'main') + '"' + (restore && restore.llmOpen ? '' : ' hidden') + '>'
        + '<div class="rp-seg" role="group" aria-label="Reader LLM 调用源"><button type="button" data-reader-api-mode="main" aria-pressed="' + (llmSettings.enabled ? 'false' : 'true') + '">酒馆主 API</button><button type="button" data-reader-api-mode="custom" aria-pressed="' + (llmSettings.enabled ? 'true' : 'false') + '">独立 API</button></div>'
        + '<div data-reader-custom-api-fields' + (llmSettings.enabled ? '' : ' hidden') + '><div class="rp-api">'
        + '<label class="rp-field is-wide"><span>API 地址</span><input data-reader-api-url value="' + escapeHtml(llmSettings.apiurl) + '" placeholder="https://example.com/v1" inputmode="url" spellcheck="false"></label>'
        + '<label class="rp-field"><span>API Key</span><input type="password" data-reader-api-key value="' + escapeHtml(llmSettings.key) + '" placeholder="可留空" autocomplete="off"></label>'
        + '<label class="rp-field"><span>模型名</span><span class="rp-model"><input data-reader-api-model value="' + escapeHtml(llmSettings.model) + '" placeholder="手动填写模型名" spellcheck="false"><button type="button" class="ra-btn" data-reader-fetch-models>拉取列表</button></span><select data-reader-model-list style="margin-top:6px" hidden><option value="">选择拉取到的模型…</option></select></label>'
        + '</div></div><div class="rp-status" data-reader-api-status>手动模型名与拉取列表可二选一；列表选择会回填模型名。此调用源统一用于结构适配、定调书架、人格草稿与模板生成。</div>'
        + '<div class="rp-actions"><button type="button" class="ra-btn is-main" data-reader-api-save>保存调用源</button><button type="button" class="ra-btn is-ghost" data-reader-api-cancel>收起</button></div></div></section>';
      var overlay = doc.createElement('div');
      overlay.id = PANEL_ID;
      overlay.setAttribute('data-reader-core-panel', 'true');
      overlay.setAttribute('data-theme', theme ? theme.name(env, api.kit) : 'cafe');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Reader-II 语义适配');
      overlay.innerHTML = ''
        + '<section class="ra-shell" tabindex="-1">'
        + '<header class="ra-head">'
        + '<button type="button" class="ra-back" data-reader-back title="回到彩蛋服务台" hidden>' + icon('back') + '<span>服务台</span></button>'
        + '<div class="ra-id"><span class="ra-seal" aria-hidden="true"><i>夜</i><i>梦</i></span><div class="ra-name"><b>语义适配</b><i>把读者的能力接到这张卡的变量上</i></div></div>'
        + '<span class="ra-head-gap"></span>'
        + '<button type="button" class="ra-close" data-reader-close aria-label="关闭面板" title="关闭">' + icon('close') + '</button></header>'
        + '<div class="rp-body">'
        + '<aside class="rp-rail">'
        + '<div class="rp-stat"><span class="rp-label">命运点数</span><div class="rp-balance"><b data-reader-balance>' + escapeHtml(balance) + '</b><span>FP</span></div></div>'
        + '<div class="rp-stat"><span class="rp-label">宿主变量</span><p class="rp-health"><span class="rp-dot" aria-hidden="true"></span><span>' + escapeHtml(summary.status) + '</span></p><p class="ra-note">' + escapeHtml(summary.roots) + ' 个顶层节点 · ' + escapeHtml(summary.nodes) + ' 个可选节点</p></div>'
        + '</aside>'
        + '<main class="rp-main">' + llmConsole
        + '<div class="rp-head"><div><h3>语义路由</h3></div>'
        + '<div class="rp-tools"><button type="button" class="ra-btn is-main" data-reader-auto-adapt title="自动寻找各槽位对应的宿主变量并绑定；已启用的槽位保持不变">一键适配</button>'
        + '<button type="button" class="ra-btn" data-reader-analyze-all' + (batchReady ? '' : ' disabled') + '>批量分析已锁定容器' + (containerDraftCount ? '（' + containerDraftCount + '）' : '') + '</button>'
        + '<span class="ra-tag">待分析容器 ' + containerDraftCount + ' / 5</span></div>'
        + '<div class="rp-batch' + (batchRequestError ? ' is-error' : '') + '" data-reader-batch-status role="status">' + escapeHtml(batchStatusText) + '</div></div>'
        + routeCards + '</main></div>'
        + '</section>';
      /* 到这一步才换掉旧面板：前面取数据要等一会儿，先摘掉的话中间会闪一下底下的页面。 */
      Array.prototype.forEach.call(doc.querySelectorAll('[data-reader-core-panel]'), function (node) { node.remove(); });
      doc.body.appendChild(overlay);
      var mainPane = overlay.querySelector('.rp-main');
      var bodyPane = overlay.querySelector('.rp-body');
      if (restore) {
        if (mainPane) mainPane.scrollTop = restore.main || 0;
        if (bodyPane) bodyPane.scrollTop = restore.body || 0;
      }

      function closePanel() { overlay.remove(); }
      function snapshot() {
        var open = {};
        Array.prototype.forEach.call(overlay.querySelectorAll('[data-reader-route]'), function (node) {
          if (node.open) open[node.getAttribute('data-reader-route')] = true;
        });
        return { main: mainPane ? mainPane.scrollTop : 0, body: bodyPane ? bodyPane.scrollTop : 0, open: open, llmOpen: !llmSettingsPanel.hidden };
      }

      overlay.querySelector('[data-reader-close]').onclick = closePanel;
      overlay.addEventListener('click', function (event) { if (event.target === overlay) closePanel(); });
      overlay.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); closePanel(); }
        /* 按键不冒泡到酒馆：聊天页的快捷键不该在面板里触发。 */
        event.stopPropagation();
      });
      /* 「服务台」：这张卡启用了 Reader-II 才有大厅可回。 */
      var backButton = overlay.querySelector('[data-reader-back]');
      var lobby = lobbyApi();
      var lobbyOn = false;
      try { lobbyOn = !!(lobby && typeof lobby.open === 'function' && lobby.isEnabled()); } catch (error) { lobbyOn = false; }
      backButton.hidden = !lobbyOn;
      backButton.onclick = function () {
        closePanel();
        Promise.resolve().then(function () { return lobby.open('eggs'); }).catch(function (error) {
          if (env.console && env.console.warn) env.console.warn('[Reader-II UI] 回不到服务台', error);
        });
      };
      /* 焦点放进面板里，Esc 才收得到；不抢输入框，免得手机上弹出键盘。 */
      try { overlay.querySelector('.ra-shell').focus({ preventScroll: true }); } catch (error) { /* 旧浏览器不认参数也无妨 */ }

      /* 面板的遮罩盖着酒馆的提示条（toastr 在它下面），所以提醒与出错都写在那一格自己的状态行里。 */
      function slotStatus(slot) { return overlay.querySelector('[data-reader-action-status="' + slot + '"]'); }
      function refreshAfter(action, errorTarget, errorPrefix) {
        var promise = typeof action === 'function' ? Promise.resolve().then(action) : Promise.resolve(action);
        return promise.then(function () { return openPanel(snapshot()); }).catch(function (error) {
          if (errorTarget) {
            errorTarget.classList.add('is-error');
            errorTarget.textContent = (errorPrefix || '操作失败') + '：' + (error.message || String(error));
          }
          if (env.toastr && env.toastr.error) env.toastr.error(error.message || String(error));
          else if (env.console && env.console.warn) env.console.warn('[Reader-II UI]', error);
        });
      }
      function busyRefresh(button, action, pendingText, errorTarget, errorPrefix) {
        var oldText = button.textContent;
        button.disabled = true;
        button.textContent = pendingText;
        if (errorTarget) {
          errorTarget.classList.remove('is-error');
          errorTarget.textContent = pendingText;
        }
        return refreshAfter(action, errorTarget, errorPrefix).then(function () {
          if (button && button.isConnected) {
            button.disabled = false;
            button.textContent = oldText;
          }
        });
      }
      var llmSettingsPanel = overlay.querySelector('[data-reader-llm-settings]');
      function setApiMode(mode) {
        var next = mode === 'custom' ? 'custom' : 'main';
        llmSettingsPanel.setAttribute('data-reader-api-mode', next);
        llmSettingsPanel.querySelectorAll('[data-reader-api-mode]').forEach(function (button) {
          button.setAttribute('aria-pressed', button.getAttribute('data-reader-api-mode') === next ? 'true' : 'false');
        });
        llmSettingsPanel.querySelector('[data-reader-custom-api-fields]').hidden = next !== 'custom';
      }
      overlay.querySelector('[data-reader-llm-settings-toggle]').onclick = function () { llmSettingsPanel.hidden = !llmSettingsPanel.hidden; };
      llmSettingsPanel.querySelectorAll('[data-reader-api-mode]').forEach(function (button) {
        button.onclick = function () { setApiMode(button.getAttribute('data-reader-api-mode')); };
      });
      llmSettingsPanel.querySelector('[data-reader-api-cancel]').onclick = function () { llmSettingsPanel.hidden = true; };
      llmSettingsPanel.querySelector('[data-reader-model-list]').onchange = function () {
        if (this.value) llmSettingsPanel.querySelector('[data-reader-api-model]').value = this.value;
      };
      llmSettingsPanel.querySelector('[data-reader-fetch-models]').onclick = async function () {
        var button = this;
        var status = llmSettingsPanel.querySelector('[data-reader-api-status]');
        var select = llmSettingsPanel.querySelector('[data-reader-model-list]');
        button.disabled = true;
        status.classList.remove('is-error');
        status.textContent = '正在拉取模型列表…';
        try {
          var models = await api.listLlmModels({
            apiurl: llmSettingsPanel.querySelector('[data-reader-api-url]').value,
            key: llmSettingsPanel.querySelector('[data-reader-api-key]').value
          });
          select.innerHTML = '<option value="">选择拉取到的模型…</option>' + models.map(function (model) {
            return '<option value="' + escapeHtml(model) + '">' + escapeHtml(model) + '</option>';
          }).join('');
          select.hidden = false;
          status.textContent = '已拉取 ' + models.length + ' 个模型。从列表选择，或继续手动填写。';
        } catch (error) {
          status.classList.add('is-error');
          status.textContent = '拉取失败：' + (error.message || String(error)) + '。仍可手动填写模型名。';
        } finally { button.disabled = false; }
      };
      llmSettingsPanel.querySelector('[data-reader-api-save]').onclick = function () {
        var button = this;
        var status = llmSettingsPanel.querySelector('[data-reader-api-status]');
        var custom = llmSettingsPanel.getAttribute('data-reader-api-mode') === 'custom';
        button.disabled = true;
        status.classList.remove('is-error');
        status.textContent = '正在保存调用源…';
        Promise.resolve().then(function () {
          return api.saveLlmSettings({
            enabled: custom,
            apiurl: llmSettingsPanel.querySelector('[data-reader-api-url]').value,
            key: llmSettingsPanel.querySelector('[data-reader-api-key]').value,
            model: llmSettingsPanel.querySelector('[data-reader-api-model]').value,
            source: 'openai'
          });
        }).then(function () {
          var state = snapshot();
          state.llmOpen = false;
          return openPanel(state);
        }).catch(function (error) {
          button.disabled = false;
          status.classList.add('is-error');
          status.textContent = '保存失败：' + (error.message || String(error));
        });
      };
      function directTreeChildren(node) {
        for (var index = 0; index < node.children.length; index += 1) {
          if (node.children[index].hasAttribute && node.children[index].hasAttribute('data-reader-tree-children')) return node.children[index];
        }
        return null;
      }
      function setTreeExpanded(node, expanded) {
        var children = directTreeChildren(node);
        if (!children) return;
        children.hidden = !expanded;
        children.setAttribute('data-reader-expanded', expanded ? 'true' : 'false');
        var toggle = node.children[0] && node.children[0].querySelector('[data-reader-tree-toggle]');
        if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      }
      function applyTreeSearch(tree, query) {
        var normalized = String(query || '').trim().toLowerCase();
        function visit(node) {
          var children = directTreeChildren(node);
          var descendantMatches = false;
          if (children) {
            Array.prototype.forEach.call(children.children, function (child) {
              if (child.hasAttribute && child.hasAttribute('data-reader-node-ref') && visit(child)) descendantMatches = true;
            });
          }
          var selfMatches = !normalized || String(node.getAttribute('data-reader-search-text') || '').indexOf(normalized) >= 0;
          var visible = !normalized || selfMatches || descendantMatches;
          node.hidden = !visible;
          if (children) {
            var expanded = normalized ? descendantMatches : children.getAttribute('data-reader-expanded') === 'true';
            children.hidden = !expanded;
            var toggle = node.children[0] && node.children[0].querySelector('[data-reader-tree-toggle]');
            if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          }
          return visible;
        }
        Array.prototype.forEach.call(tree.children, function (node) {
          if (node.hasAttribute && node.hasAttribute('data-reader-node-ref')) visit(node);
        });
      }
      overlay.querySelectorAll('[data-reader-tree-toggle]').forEach(function (button) {
        button.onclick = function () {
          var node = button.parentNode.parentNode;
          var children = directTreeChildren(node);
          setTreeExpanded(node, !children || children.hidden);
        };
      });
      overlay.querySelectorAll('[data-reader-tree-pick]').forEach(function (button) {
        button.onclick = function () {
          var card = button.closest('[data-reader-route]');
          var ref = button.getAttribute('data-reader-tree-pick');
          card.querySelector('[data-reader-root]').value = ref;
          card.querySelectorAll('[data-reader-tree-pick]').forEach(function (item) {
            item.classList.remove('is-selected');
            item.setAttribute('aria-pressed', 'false');
          });
          button.classList.add('is-selected');
          button.setAttribute('aria-pressed', 'true');
          card.querySelector('[data-reader-selected-path]').textContent = '已选：' + button.getAttribute('data-reader-tree-path');
          setTreeExpanded(button.parentNode.parentNode, true);
        };
      });
      overlay.querySelectorAll('[data-reader-route-search]').forEach(function (input) {
        input.oninput = function () {
          var slot = input.getAttribute('data-reader-route-search');
          applyTreeSearch(overlay.querySelector('[data-reader-tree="' + slot + '"]'), input.value);
        };
      });
      overlay.querySelectorAll('[data-reader-select]').forEach(function (button) {
        button.onclick = function () {
          var slot = button.getAttribute('data-reader-select');
          var value = overlay.querySelector('[data-reader-root="' + slot + '"]').value;
          var status = slotStatus(slot);
          if (!value) {
            if (status) { status.classList.add('is-error'); status.textContent = '先在上面的树里点选一个路径'; }
            return;
          }
          refreshAfter(function () { return api.selectSemanticRoot(slot, value); }, status, '锁定失败');
        };
      });
      overlay.querySelectorAll('[data-reader-analyze]').forEach(function (button) {
        button.onclick = function () {
          var slot = button.getAttribute('data-reader-analyze');
          var actionStatus = slotStatus(slot);
          busyRefresh(button, function () { return api.analyzeSemanticMapping(slot); }, '正在分析并等待 API 返回…', actionStatus, '分析失败');
        };
      });
      var autoAdaptButton = overlay.querySelector('[data-reader-auto-adapt]');
      if (autoAdaptButton) autoAdaptButton.onclick = function () {
        if (autoAdaptButton.disabled || typeof api.autoAdapt !== 'function') return;
        var adaptStatus = overlay.querySelector('[data-reader-batch-status]');
        busyRefresh(autoAdaptButton, function () {
          return api.autoAdapt({ useLlm: true }).then(function (report) {
            if (env.toastr && env.toastr.info) env.toastr.info('一键适配：已启用 ' + report.boundCount + ' / ' + report.slotCount + ' 个槽位');
            return report;
          });
        }, '正在寻找宿主变量…', adaptStatus, '一键适配失败');
      };
      var analyzeAllButton = overlay.querySelector('[data-reader-analyze-all]');
      if (analyzeAllButton) analyzeAllButton.onclick = function () {
        if (analyzeAllButton.disabled) return;
        var batchStatus = overlay.querySelector('[data-reader-batch-status]');
        busyRefresh(analyzeAllButton, function () {
          return typeof api.analyzeLockedSemanticMappings === 'function'
            ? api.analyzeLockedSemanticMappings()
            : api.analyzeAllSemanticMappings();
        }, '正在发送 ' + containerDraftCount + ' 个容器…', batchStatus, '批量分析失败');
      };
      overlay.querySelectorAll('[data-reader-confirm]').forEach(function (button) {
        button.onclick = function () {
          var slot = button.getAttribute('data-reader-confirm');
          var checkbox = overlay.querySelector('[data-reader-confirm-check="' + slot + '"]');
          var status = slotStatus(slot);
          if (!checkbox || !checkbox.checked) {
            if (status) { status.classList.add('is-error'); status.textContent = '请先勾选「我已核对预览」'; }
            else if (env.toastr && env.toastr.warning) env.toastr.warning('请先勾选确认已核对预览');
            return;
          }
          refreshAfter(function () { return api.confirmSemanticBinding(slot); }, status, '启用失败');
        };
      });
      overlay.querySelectorAll('[data-reader-unbind]').forEach(function (button) {
        button.onclick = function () {
          var slot = button.getAttribute('data-reader-unbind');
          refreshAfter(function () { return api.unbindSemanticSlot(slot); }, slotStatus(slot), '解绑失败');
        };
      });
      return overlay;
    }

    /* 对外的 openPanel 不收参数：别人传进来的东西（比如点击事件）不能被当成 restore。 */
    return { openPanel: function () { return openPanel(null); } };
  }


  modules.buildHostVariableTree = buildHostVariableTree;
  modules.renderHostVariableTree = renderHostVariableTree;
  modules.createUiBridge = createUiBridge;
})(typeof globalThis !== 'undefined' ? globalThis : window);
