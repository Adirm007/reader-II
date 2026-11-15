(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

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

  function renderHostVariableTree(tree, selectedRef) {
    function renderNode(node) {
      var item = node.item;
      var selected = item.ref === selectedRef;
      var expanded = selected || node.children.some(function (child) { return treeContainsRef(child, selectedRef); });
      var searchable = [item.path, item.label, item.preview, item.valueType].join(' ').toLowerCase();
      var toggle = node.children.length
        ? '<button type="button" class="reader-ui-tree-toggle" data-reader-tree-toggle aria-label="'
          + (expanded ? '收起：' : '展开：') + escapeHtml(item.path) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">'
          + (expanded ? '−' : '+') + '</button>'
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

  var READER_UI_CSS = [
    '[data-reader-core-panel]{--reader-ink:#0b1118;--reader-deep:#121c27;--reader-panel:#172330;--reader-line:#2b3a47;--reader-copper:#c08a5a;--reader-teal:#5fa7a2;--reader-text:#e7e2d8;--reader-muted:#94a0aa;--reader-danger:#d07868;position:fixed!important;inset:0!important;height:100vh!important;height:100dvh!important;min-height:100vh!important;min-height:100dvh!important;z-index:2147483000!important;display:flex!important;align-items:center!important;justify-content:center!important;overflow:hidden!important;padding:clamp(10px,2vw,24px)!important;background:linear-gradient(rgba(5,9,13,.82),rgba(5,9,13,.94)),repeating-linear-gradient(90deg,transparent 0,transparent 79px,rgba(95,167,162,.05) 80px)!important;backdrop-filter:blur(10px) saturate(.8);font-family:Inter,"Microsoft YaHei","PingFang SC",sans-serif!important;color:var(--reader-text)!important;line-height:1.5!important;color-scheme:dark;}',
    '[data-reader-core-panel] *{box-sizing:border-box;}',
    '[data-reader-core-panel] .reader-ui-shell{position:relative;width:min(1120px,100%)!important;height:min(900px,calc(100vh - 20px))!important;height:min(900px,calc(100dvh - 20px))!important;max-height:min(900px,calc(100vh - 20px))!important;max-height:min(900px,calc(100dvh - 20px))!important;min-height:0!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;background:var(--reader-ink)!important;color:var(--reader-text)!important;border:1px solid #344654!important;border-radius:14px!important;box-shadow:0 30px 100px rgba(0,0,0,.68),inset 0 1px rgba(255,255,255,.035)!important;}',
    '[data-reader-core-panel] .reader-ui-shell::before{content:"";position:absolute;z-index:2;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--reader-copper) 0 31%,transparent 31% 33%,var(--reader-teal) 33% 100%);}',
    '[data-reader-core-panel] button{appearance:none!important;-webkit-appearance:none!important;min-height:38px!important;margin:0!important;padding:9px 14px!important;background:transparent!important;background-image:none!important;color:var(--reader-text)!important;border:1px solid #415462!important;border-radius:7px!important;font-family:inherit!important;font-size:13px!important;font-weight:700!important;line-height:1.2!important;text-shadow:none!important;box-shadow:none!important;cursor:pointer!important;opacity:1!important;transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease!important;}',
    '[data-reader-core-panel] button:hover{background:#21313e!important;color:#fff!important;border-color:#67808f!important;transform:translateY(-1px);}',
    '[data-reader-core-panel] button:active{transform:translateY(0);}',
    '[data-reader-core-panel] button:focus-visible,[data-reader-core-panel] summary:focus-visible,[data-reader-core-panel] input:focus-visible{outline:2px solid var(--reader-teal)!important;outline-offset:2px!important;}',
    '[data-reader-core-panel] .reader-ui-header{position:relative;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:24px 28px 20px!important;border-bottom:1px solid var(--reader-line);background:linear-gradient(90deg,rgba(192,138,90,.07),transparent 48%)!important;}',
    '[data-reader-core-panel] .reader-ui-brand{display:flex;align-items:center;gap:16px;min-width:0;}',
    '[data-reader-core-panel] .reader-ui-brand-mark{flex:0 0 48px;width:48px;height:48px;display:grid;place-items:center;border:1px solid rgba(192,138,90,.7);border-radius:50%;color:#e1b98f;font-family:"Iowan Old Style","STZhongsong","Songti SC",serif;font-size:18px;letter-spacing:-.05em;box-shadow:inset 0 0 0 4px var(--reader-ink),inset 0 0 0 5px rgba(192,138,90,.22);}',
    '[data-reader-core-panel] .reader-ui-kicker{color:var(--reader-copper)!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;font-weight:700!important;letter-spacing:.2em!important;text-transform:uppercase;}',
    '[data-reader-core-panel] .reader-ui-title{margin:1px 0 0!important;color:#f3eee4!important;font-family:"Iowan Old Style","STZhongsong","Songti SC",serif!important;font-size:30px!important;font-weight:650!important;letter-spacing:.04em!important;line-height:1.15!important;}',
    '[data-reader-core-panel] .reader-ui-subtitle{margin:4px 0 0!important;color:var(--reader-muted)!important;font-size:12px!important;}',
    '[data-reader-core-panel] .reader-ui-close{width:42px!important;min-width:42px!important;height:42px!important;min-height:42px!important;padding:0!important;border-radius:50%!important;background:#101922!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:22px!important;font-weight:400!important;}',
    '[data-reader-core-panel] .reader-ui-layout{display:grid;grid-template-columns:248px minmax(0,1fr);flex:1 1 auto!important;min-height:0!important;height:0!important;overflow:hidden!important;}',
    '[data-reader-core-panel] .reader-ui-rail{min-width:0;overflow:auto;padding:24px 20px!important;background:#0e1720!important;border-right:1px solid var(--reader-line);}',
    '[data-reader-core-panel] .reader-ui-rail-label{margin:0 0 8px;color:var(--reader-muted)!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;font-weight:700!important;letter-spacing:.16em!important;text-transform:uppercase;}',
    '[data-reader-core-panel] .reader-ui-balance{position:relative;margin-bottom:22px;padding:18px 16px 16px!important;background:#15222c!important;border:1px solid #344856;border-radius:10px;overflow:hidden;}',
    '[data-reader-core-panel] .reader-ui-balance::after{content:"FP";position:absolute;right:10px;bottom:-13px;color:rgba(192,138,90,.08);font-family:"Iowan Old Style",serif;font-size:68px;font-weight:800;line-height:1;}',
    '[data-reader-core-panel] .reader-ui-balance-value{position:relative;z-index:1;display:flex;align-items:baseline;gap:7px;color:#f0c79f!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:31px!important;font-weight:700!important;letter-spacing:-.05em!important;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-balance-unit{color:var(--reader-copper);font-size:11px;letter-spacing:.12em;}',
    '[data-reader-core-panel] .reader-ui-rail-block{padding-top:20px;border-top:1px solid var(--reader-line);}',
    '[data-reader-core-panel] .reader-ui-health{display:flex;align-items:flex-start;gap:9px;color:#c9d1d5!important;font-size:12px!important;line-height:1.65!important;}',
    '[data-reader-core-panel] .reader-ui-health-dot{flex:0 0 7px;width:7px;height:7px;margin-top:6px;border-radius:50%;background:var(--reader-teal);box-shadow:0 0 0 4px rgba(95,167,162,.1);}',
    '[data-reader-core-panel] .reader-ui-rail-note{margin:20px 0 0!important;padding:13px 0 0!important;border-top:1px dashed #344450;color:#7f8d97!important;font-size:11px!important;line-height:1.7!important;}',
    '[data-reader-core-panel] .reader-ui-main{min-width:0;overflow:auto;padding:26px 28px 30px!important;background:radial-gradient(circle at 100% 0,rgba(95,167,162,.055),transparent 34%),var(--reader-deep)!important;}',
    '[data-reader-core-panel] .reader-ui-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:18px;}',
    '[data-reader-core-panel] .reader-ui-eyebrow{margin:0 0 4px;color:var(--reader-teal)!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;font-weight:700!important;letter-spacing:.17em!important;text-transform:uppercase;}',
    '[data-reader-core-panel] .reader-ui-section-title{margin:0!important;color:#f2ede4!important;font-family:"Iowan Old Style","STZhongsong","Songti SC",serif!important;font-size:23px!important;font-weight:650!important;letter-spacing:.03em!important;}',
    '[data-reader-core-panel] .reader-ui-muted{margin:7px 0 0!important;color:var(--reader-muted)!important;font-size:12px!important;line-height:1.7!important;}',
    '[data-reader-core-panel] .reader-ui-route-count{flex:0 0 auto;padding:5px 8px;border:1px solid #344957;border-radius:4px;color:#82939e;font-family:"Cascadia Code",Consolas,monospace;font-size:10px;letter-spacing:.12em;}',
    '[data-reader-core-panel] .reader-ui-section-tools{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;}',
    '[data-reader-core-panel] .reader-ui-batch-meter{color:#7f919c;font-family:"Cascadia Code",Consolas,monospace;font-size:10px;letter-spacing:.08em;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-batch-status{flex-basis:100%;color:#70918f;font-size:10px;line-height:1.55;text-align:right;white-space:pre-line;}',
    '[data-reader-core-panel] .reader-ui-batch-status.is-error{color:#d59083;}',
    '[data-reader-core-panel] button:disabled{cursor:not-allowed!important;opacity:.42!important;transform:none!important;}',
    '[data-reader-core-panel] .reader-ui-llm-console{position:relative;display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:13px;margin:0 0 18px;padding:13px 14px;background:linear-gradient(90deg,rgba(95,167,162,.08),transparent 56%),#101b24;border:1px solid #304551;border-radius:9px;overflow:hidden;}',
    '[data-reader-core-panel] .reader-ui-llm-console[data-reader-llm-mode="custom"]{background:linear-gradient(90deg,rgba(192,138,90,.1),transparent 56%),#101b24;border-color:#574738;}',
    '[data-reader-core-panel] .reader-ui-llm-signal{position:relative;width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(95,167,162,.58);border-radius:50%;color:#8bc4c0;font-family:"Cascadia Code",Consolas,monospace;font-size:9px;font-weight:800;letter-spacing:.06em;}',
    '[data-reader-core-panel] .reader-ui-llm-console[data-reader-llm-mode="custom"] .reader-ui-llm-signal{border-color:rgba(192,138,90,.72);color:#e0b181;}',
    '[data-reader-core-panel] .reader-ui-llm-signal::after{content:"";position:absolute;left:100%;top:50%;width:13px;height:1px;background:#3b5962;}',
    '[data-reader-core-panel] .reader-ui-llm-copy{min-width:0;display:flex;flex-direction:column;gap:2px;}',
    '[data-reader-core-panel] .reader-ui-llm-copy strong{color:#e8e4dc;font-size:13px;}',
    '[data-reader-core-panel] .reader-ui-llm-copy span{overflow:hidden;color:#7f919b;font-family:"Cascadia Code",Consolas,monospace;font-size:10px;text-overflow:ellipsis;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-llm-settings{margin:-10px 0 18px;padding:16px;background:#0e1821;border:1px solid #30434f;border-radius:0 0 9px 9px;}',
    '[data-reader-core-panel] .reader-ui-llm-settings[hidden],[data-reader-core-panel] [data-reader-custom-api-fields][hidden],[data-reader-core-panel] [data-reader-model-list][hidden]{display:none!important;}',
    '[data-reader-core-panel] .reader-ui-mode-switch{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:4px;background:#0a1219;border:1px solid #2c3e49;border-radius:8px;}',
    '[data-reader-core-panel] .reader-ui-mode-switch button{min-height:34px!important;border-color:transparent!important;color:#84949d!important;}',
    '[data-reader-core-panel] .reader-ui-mode-switch button[aria-pressed="true"]{background:#1c303a!important;border-color:#45636e!important;color:#e7ece9!important;}',
    '[data-reader-core-panel] .reader-ui-api-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(180px,.75fr);gap:12px;margin-top:14px;}',
    '[data-reader-core-panel] .reader-ui-api-field{display:flex;flex-direction:column;gap:6px;color:#9ca9b0;font-size:11px;}',
    '[data-reader-core-panel] .reader-ui-api-field-wide{grid-column:1/-1;}',
    '[data-reader-core-panel] .reader-ui-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;}',
    '[data-reader-core-panel] .reader-ui-model-list{margin-top:7px!important;}',
    '[data-reader-core-panel] .reader-ui-api-status{min-height:18px;margin:10px 0 0;color:#81929c;font-size:11px;}',
    '[data-reader-core-panel] .reader-ui-api-status.is-error{color:#d59083;}',
    '[data-reader-core-panel] .reader-ui-route-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
    '[data-reader-core-panel] .reader-ui-route{min-width:0;background:#14202a!important;border:1px solid #2d3d4a;border-radius:9px;overflow:hidden;transition:border-color .16s ease,background .16s ease;}',
    '[data-reader-core-panel] .reader-ui-route[open]{grid-column:1/-1;background:#15232e!important;border-color:#46616f;}',
    '[data-reader-core-panel] .reader-ui-route-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto 18px;align-items:center;gap:11px;min-height:76px;padding:13px 15px!important;list-style:none!important;cursor:pointer!important;user-select:none;}',
    '[data-reader-core-panel] .reader-ui-route-head::-webkit-details-marker{display:none;}',
    '[data-reader-core-panel] .reader-ui-route-head:hover{background:rgba(95,167,162,.045)!important;}',
    '[data-reader-core-panel] .reader-ui-route-index{display:grid;place-items:center;width:34px;height:34px;border:1px solid #3a4d5b;border-radius:50%;color:var(--reader-copper);font-family:"Cascadia Code",Consolas,monospace;font-size:11px;}',
    '[data-reader-core-panel] .reader-ui-route-copy{min-width:0;display:flex;flex-direction:column;gap:3px;}',
    '[data-reader-core-panel] .reader-ui-route-copy strong{color:#ebe6dd!important;font-size:14px!important;}',
    '[data-reader-core-panel] .reader-ui-route-backend{overflow:hidden;color:#82919b!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;font-weight:400!important;text-overflow:ellipsis;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-route-state{padding:4px 7px;border:1px solid #465965;border-radius:999px;color:#9eabb3;font-size:10px;font-weight:700;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-state-active{border-color:rgba(95,167,162,.58);background:rgba(95,167,162,.1);color:#83c4c0;}',
    '[data-reader-core-panel] .reader-ui-state-draft{border-color:rgba(192,138,90,.65);background:rgba(192,138,90,.1);color:#dda976;}',
    '[data-reader-core-panel] .reader-ui-state-broken{border-color:rgba(208,120,104,.65);background:rgba(208,120,104,.1);color:#e18e80;}',
    '[data-reader-core-panel] .reader-ui-route-chevron{color:#70828d;font-size:17px;transition:transform .16s ease;}',
    '[data-reader-core-panel] .reader-ui-route[open] .reader-ui-route-chevron{transform:rotate(180deg);color:var(--reader-teal);}',
    '[data-reader-core-panel] .reader-ui-route-body{padding:4px 16px 17px!important;border-top:1px solid #2b3d49;}',
    '[data-reader-core-panel] .reader-ui-route-note{display:flex;justify-content:space-between;gap:18px;margin:13px 0 0!important;color:#8c9aa4!important;font-size:11px!important;line-height:1.65!important;}',
    '[data-reader-core-panel] .reader-ui-requirement{color:#b7c1c6!important;text-align:right;}',
    '[data-reader-core-panel] .reader-ui-search{position:relative;display:block;margin-top:13px;}',
    '[data-reader-core-panel] .reader-ui-search-icon{position:absolute;z-index:1;left:12px;top:50%;transform:translateY(-50%);color:#6f818d;font-family:"Cascadia Code",Consolas,monospace;font-size:15px;pointer-events:none;}',
    '[data-reader-core-panel] input,[data-reader-core-panel] select{width:100%!important;margin:0!important;padding:10px 12px!important;background:#0c151d!important;color:var(--reader-text)!important;border:1px solid #334753!important;border-radius:7px!important;font-family:inherit!important;font-size:12px!important;box-shadow:none!important;}',
    '[data-reader-core-panel] .reader-ui-search input{padding-left:36px!important;}',
    '[data-reader-core-panel] input::placeholder{color:#60727d!important;opacity:1!important;}',
    '[data-reader-core-panel] input[type="checkbox"]{width:15px!important;height:15px!important;margin:0 7px 0 0!important;accent-color:var(--reader-teal);}',
    '[data-reader-core-panel] .reader-ui-tree{max-height:310px;overflow:auto;margin-top:8px;padding:8px!important;background:#0c151d!important;border:1px solid #2f424e;border-radius:7px;scrollbar-color:#455d69 #101a22;}',
    '[data-reader-core-panel] .reader-ui-tree-node[hidden],[data-reader-core-panel] .reader-ui-tree-children[hidden]{display:none!important;}',
    '[data-reader-core-panel] .reader-ui-tree-row{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:stretch;gap:5px;margin:2px 0;}',
    '[data-reader-core-panel] .reader-ui-tree-toggle{width:28px!important;min-width:28px!important;min-height:34px!important;padding:0!important;background:transparent!important;border-color:transparent!important;border-radius:50%!important;color:#78909b!important;box-shadow:none!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:15px!important;font-weight:400!important;}',
    '[data-reader-core-panel] .reader-ui-tree-toggle:hover{background:#192934!important;color:var(--reader-teal)!important;border-color:#304653!important;transform:none!important;}',
    '[data-reader-core-panel] .reader-ui-tree-spacer{width:28px;}',
    '[data-reader-core-panel] .reader-ui-tree-pick{display:grid!important;grid-template-columns:minmax(110px,.85fr) minmax(0,1.5fr)!important;align-items:center!important;gap:14px!important;min-width:0!important;min-height:34px!important;padding:6px 9px!important;text-align:left!important;background:transparent!important;border-color:transparent!important;border-radius:5px!important;box-shadow:none!important;}',
    '[data-reader-core-panel] .reader-ui-tree-pick:hover{background:#14232d!important;border-color:#263a46!important;transform:none!important;}',
    '[data-reader-core-panel] .reader-ui-tree-pick.is-selected,[data-reader-core-panel] .reader-ui-tree-pick[aria-pressed="true"]{background:rgba(95,167,162,.11)!important;border-color:rgba(95,167,162,.55)!important;box-shadow:inset 3px 0 var(--reader-teal)!important;}',
    '[data-reader-core-panel] .reader-ui-tree-name{min-width:0;display:flex;align-items:center;gap:8px;color:#dfe1dc!important;font-size:12px!important;overflow-wrap:anywhere;}',
    '[data-reader-core-panel] .reader-ui-tree-node-mark{flex:0 0 5px;width:5px;height:5px;border:1px solid #657a86;border-radius:50%;}',
    '[data-reader-core-panel] .reader-ui-tree-pick.is-selected .reader-ui-tree-node-mark{border-color:var(--reader-teal);background:var(--reader-teal);}',
    '[data-reader-core-panel] .reader-ui-tree-meta{min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;color:#71828d!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;font-weight:400!important;overflow:hidden;}',
    '[data-reader-core-panel] .reader-ui-tree-type{flex:0 0 auto;padding:2px 5px;border:1px solid #30434f;border-radius:3px;color:#87a0ad;}',
    '[data-reader-core-panel] .reader-ui-tree-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '[data-reader-core-panel] .reader-ui-tree-children{position:relative;margin-left:14px;padding-left:7px;border-left:1px solid #263945;}',
    '[data-reader-core-panel] .reader-ui-selection{margin-top:9px;padding-left:2px;color:#a9bbbF!important;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;overflow-wrap:anywhere;}',
    '[data-reader-core-panel] .reader-ui-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;}',
    '[data-reader-core-panel] .reader-ui-action-status{min-height:17px;margin-top:9px;color:#70918f;font-size:10px;line-height:1.55;white-space:pre-line;}',
    '[data-reader-core-panel] .reader-ui-action-status.is-error{color:#d59083;}',
    '[data-reader-core-panel] .reader-ui-button-primary{background:#2b5555!important;border-color:#4e8d89!important;color:#eef8f6!important;}',
    '[data-reader-core-panel] .reader-ui-button-primary:hover{background:#356865!important;border-color:#6eb1ac!important;}',
    '[data-reader-core-panel] .reader-ui-button-copper{border-color:#775a42!important;color:#deb288!important;}',
    '[data-reader-core-panel] .reader-ui-button-danger{margin-left:auto!important;border-color:#62434a!important;color:#cf8e86!important;}',
    '[data-reader-core-panel] .reader-ui-check{display:inline-flex;align-items:center;margin:0!important;color:#a8b3b9!important;font-size:11px!important;cursor:pointer;}',
    '[data-reader-core-panel] .reader-ui-preview{max-height:170px;overflow:auto;margin:10px 0 0!important;padding:11px!important;background:#0a1219!important;color:#aab7bd!important;border:1px solid #2e404b;border-radius:6px;font-family:"Cascadia Code",Consolas,monospace!important;font-size:10px!important;line-height:1.65!important;white-space:pre-wrap;word-break:break-word;}',
    '[data-reader-core-panel] .reader-ui-request{margin-top:10px;border:1px solid #293c47;border-radius:6px;background:#0d171f;}',
    '[data-reader-core-panel] .reader-ui-request summary{padding:8px 10px;color:#8299a4;font-family:"Cascadia Code",Consolas,monospace;font-size:10px;cursor:pointer;}',
    '[data-reader-core-panel] .reader-ui-request pre{max-height:230px;overflow:auto;margin:0;padding:11px;border-top:1px solid #293c47;color:#9baab1;font-family:"Cascadia Code",Consolas,monospace;font-size:10px;line-height:1.65;white-space:pre-wrap;word-break:break-word;}',
    '[data-reader-core-panel] .reader-ui-warning{margin-top:10px!important;padding:8px 10px!important;border-left:2px solid var(--reader-danger);background:rgba(208,120,104,.07);color:#d59a8f!important;}',
    '[data-reader-core-panel] .reader-ui-sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;}',
    '@media(max-width:760px){[data-reader-core-panel]{padding:8px!important;align-items:stretch!important;}[data-reader-core-panel] .reader-ui-shell{height:calc(100vh - 16px)!important;height:calc(100dvh - 16px)!important;max-height:calc(100vh - 16px)!important;max-height:calc(100dvh - 16px)!important;}[data-reader-core-panel] .reader-ui-header{padding:20px 18px 16px!important;}[data-reader-core-panel] .reader-ui-layout{display:block!important;flex:1 1 auto!important;height:0!important;overflow:auto!important;}[data-reader-core-panel] .reader-ui-rail{display:grid;grid-template-columns:1fr 1fr;gap:14px;overflow:visible;padding:18px!important;border-right:0;border-bottom:1px solid var(--reader-line);}[data-reader-core-panel] .reader-ui-balance{margin:0;}[data-reader-core-panel] .reader-ui-rail-block{padding:0;border:0;}[data-reader-core-panel] .reader-ui-rail-note{grid-column:1/-1;margin:0!important;}[data-reader-core-panel] .reader-ui-main{overflow:visible;padding:21px 18px 25px!important;}}',
    '@media(max-width:540px){[data-reader-core-panel] .reader-ui-brand-mark{display:none;}[data-reader-core-panel] .reader-ui-title{font-size:25px!important;}[data-reader-core-panel] .reader-ui-subtitle{display:none;}[data-reader-core-panel] .reader-ui-llm-console{grid-template-columns:36px minmax(0,1fr);}[data-reader-core-panel] .reader-ui-llm-console>button{grid-column:1/-1;}[data-reader-core-panel] .reader-ui-api-grid{grid-template-columns:1fr;}[data-reader-core-panel] .reader-ui-api-field-wide{grid-column:auto;}[data-reader-core-panel] .reader-ui-section-tools{justify-content:flex-start;}[data-reader-core-panel] .reader-ui-route-grid{grid-template-columns:1fr;}[data-reader-core-panel] .reader-ui-route[open]{grid-column:auto;}[data-reader-core-panel] .reader-ui-section-head{align-items:flex-start;flex-direction:column;}[data-reader-core-panel] .reader-ui-route-count{display:none;}[data-reader-core-panel] .reader-ui-route-head{grid-template-columns:34px minmax(0,1fr) auto 14px;padding:11px 12px!important;}[data-reader-core-panel] .reader-ui-route-body{padding:3px 12px 14px!important;}[data-reader-core-panel] .reader-ui-route-note{display:block;}[data-reader-core-panel] .reader-ui-requirement{display:block;margin-top:5px;text-align:left;}[data-reader-core-panel] .reader-ui-tree-pick{grid-template-columns:minmax(90px,1fr) minmax(0,1fr)!important;gap:7px!important;}[data-reader-core-panel] .reader-ui-tree-preview{display:none;}[data-reader-core-panel] .reader-ui-button-danger{margin-left:0!important;}}',
    '@media(prefers-reduced-motion:reduce){[data-reader-core-panel] *,[data-reader-core-panel] *::before,[data-reader-core-panel] *::after{scroll-behavior:auto!important;transition:none!important;animation:none!important;}}'
  ].join('');

  function ensureUiStyles(doc) {
    if (!doc || !doc.createElement) return;
    var existing = doc.querySelector('[data-reader-ui-style]');
    if (existing) {
      existing.textContent = READER_UI_CSS;
      return;
    }
    var style = doc.createElement('style');
    style.setAttribute('data-reader-ui-style', 'true');
    style.textContent = READER_UI_CSS;
    var target = doc.head || doc.documentElement || doc.body;
    if (target) target.appendChild(style);
  }

  function createUiBridge(api, env) {
    function documentRoot() {
      return env.document || (env.host && env.host.document) || null;
    }

    async function openPanel() {
      var doc = documentRoot();
      if (!doc || !doc.createElement) throw new Error('当前环境无法打开Reader面板');
      ensureUiStyles(doc);
      var existing = doc.querySelector('[data-reader-core-panel]');
      if (existing) existing.remove();
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
          ? '<p class="reader-ui-muted reader-ui-warning">绑定后宿主系统接管任务创建、监控、完成、奖励与删除；Reader只在章节触发时读取任务名防重复。</p>'
          : definition.key === 'inventory'
            ? '<p class="reader-ui-muted">命运抽卡抽到的东西放进这里；未绑定时放进 Reader 后备背包（READER.背包）。宿主条目里没有的字段（品质、标签等）会并进描述。</p>'
            : '';
        var broken = route.status === 'broken'
          ? '<p class="reader-ui-muted reader-ui-warning">绑定损坏：' + escapeHtml(route.brokenReason || '请重新选择并适配') + '</p>'
          : '';
        var actions = '<button class="reader-ui-button-primary" data-reader-select="' + definition.key + '">锁定所选路径</button>';
        if (definition.container && route.status === 'draft') actions += '<button class="reader-ui-button-copper" data-reader-analyze="' + definition.key + '">让 LLM 分析结构</button>';
        if (route.status === 'draft' && (!definition.container || preview)) {
          actions += '<label class="reader-ui-check"><input type="checkbox" data-reader-confirm-check="' + definition.key + '">我已核对预览</label>'
            + '<button class="reader-ui-button-primary" data-reader-confirm="' + definition.key + '">确认启用</button>';
        }
        if (route.status !== 'unbound') actions += '<button class="reader-ui-button-danger" data-reader-unbind="' + definition.key + '">解绑并重建默认值</button>';
        var expanded = routeIndex === attentionRouteIndex;
        return '<details class="reader-ui-route" data-reader-route="' + definition.key + '"' + (expanded ? ' open' : '') + '>'
          + '<summary class="reader-ui-route-head">'
          + '<span class="reader-ui-route-index">' + String(routeIndex + 1).padStart(2, '0') + '</span>'
          + '<span class="reader-ui-route-copy"><strong>' + escapeHtml(definition.label) + '</strong><span class="reader-ui-route-backend">' + escapeHtml(backendLabel) + '</span></span>'
          + '<span class="reader-ui-route-state reader-ui-state-' + escapeHtml(route.status) + '">' + escapeHtml(routeStateLabels[route.status] || route.status) + '</span>'
          + '<span class="reader-ui-route-chevron" aria-hidden="true">⌄</span></summary>'
          + '<div class="reader-ui-route-body">'
          + broken + warning
          + '<p class="reader-ui-route-note"><span>从宿主根节点逐级展开，每一级都可选。</span><span class="reader-ui-requirement">要求：' + escapeHtml(definition.requirement) + '</span></p>'
          + '<label class="reader-ui-search"><span class="reader-ui-sr-only">搜索' + escapeHtml(definition.label) + '的宿主路径</span><span class="reader-ui-search-icon" aria-hidden="true">⌕</span><input data-reader-route-search="' + definition.key + '" placeholder="搜索路径、类型或内容"></label>'
          + '<div class="reader-ui-tree" data-reader-tree="' + definition.key + '">' + (treeMarkup || '<div class="reader-ui-muted">没有可用的宿主节点</div>') + '</div>'
          + '<input type="hidden" data-reader-root="' + definition.key + '" value="' + escapeHtml(route.rootRef || '') + '">'
          + '<div class="reader-ui-selection" data-reader-selected-path="' + definition.key + '">' + (selectedDescriptor ? '已选：' + escapeHtml(selectedDescriptor.path) : '尚未选择路径') + '</div>'
          + (adaptationRequest ? '<details class="reader-ui-request"><summary>' + (adaptationRequest.error ? '分析请求尚不可用' : '查看本次发给 LLM 的内置知识与结构') + '</summary><pre>'
            + escapeHtml(adaptationRequest.error || adaptationRequest.prompt) + '</pre></details>' : '')
          + (preview ? '<pre class="reader-ui-preview">' + escapeHtml(JSON.stringify(preview, null, 2)) + '</pre>' : '')
          + (definition.container && route.status === 'draft' ? '<div class="reader-ui-action-status" data-reader-action-status="' + definition.key + '" role="status"></div>' : '')
          + '<div class="reader-ui-actions">' + actions + '</div></div></details>';
      }).join('');
      var llmEndpointLabel = llmBackend.mode === 'custom'
        ? (llmBackend.model + ' · ' + llmBackend.apiurl)
        : '所有 Reader 生成使用当前酒馆连接';
      var llmConsole = '<div class="reader-ui-llm-console" data-reader-llm-mode="' + escapeHtml(llmBackend.mode) + '">'
        + '<span class="reader-ui-llm-signal" aria-hidden="true">LLM</span><div class="reader-ui-llm-copy"><strong>' + escapeHtml(llmBackend.label) + '</strong><span>' + escapeHtml(llmEndpointLabel) + '</span></div>'
        + '<button type="button" data-reader-llm-settings-toggle>配置调用源</button></div>'
        + '<section class="reader-ui-llm-settings" data-reader-llm-settings data-reader-api-mode="' + (llmSettings.enabled ? 'custom' : 'main') + '" hidden>'
        + '<div class="reader-ui-mode-switch" role="group" aria-label="Reader LLM 调用源"><button type="button" data-reader-api-mode="main" aria-pressed="' + (llmSettings.enabled ? 'false' : 'true') + '">酒馆主 API</button><button type="button" data-reader-api-mode="custom" aria-pressed="' + (llmSettings.enabled ? 'true' : 'false') + '">独立 API</button></div>'
        + '<div data-reader-custom-api-fields' + (llmSettings.enabled ? '' : ' hidden') + '><div class="reader-ui-api-grid">'
        + '<label class="reader-ui-api-field reader-ui-api-field-wide"><span>API 地址</span><input data-reader-api-url value="' + escapeHtml(llmSettings.apiurl) + '" placeholder="https://example.com/v1" inputmode="url"></label>'
        + '<label class="reader-ui-api-field"><span>API Key</span><input type="password" data-reader-api-key value="' + escapeHtml(llmSettings.key) + '" placeholder="可留空" autocomplete="off"></label>'
        + '<label class="reader-ui-api-field"><span>模型名</span><span class="reader-ui-model-row"><input data-reader-api-model value="' + escapeHtml(llmSettings.model) + '" placeholder="手动填写模型名"><button type="button" data-reader-fetch-models>拉取列表</button></span><select class="reader-ui-model-list" data-reader-model-list hidden><option value="">选择拉取到的模型…</option></select></label>'
        + '</div></div><div class="reader-ui-api-status" data-reader-api-status>手动模型名与拉取列表可二选一；列表选择会回填模型名。此调用源统一用于结构适配、定调书架、人格草稿与模板生成。</div>'
        + '<div class="reader-ui-actions"><button type="button" class="reader-ui-button-primary" data-reader-api-save>保存调用源</button><button type="button" data-reader-api-cancel>收起</button></div></section>';
      var overlay = doc.createElement('div');
      overlay.setAttribute('data-reader-core-panel', 'true');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Reader-II 语义航图');
      overlay.innerHTML = ''
        + '<section class="reader-ui-shell">'
        + '<header class="reader-ui-header"><div class="reader-ui-brand"><span class="reader-ui-brand-mark" aria-hidden="true">RⅡ</span><div><div class="reader-ui-kicker">READER II · ROUTING DESK</div><h2 class="reader-ui-title">语义航图</h2><p class="reader-ui-subtitle">将叙事能力接入当前世界的变量结构</p></div></div><button class="reader-ui-close" data-reader-close aria-label="关闭面板">×</button></header>'
        + '<div class="reader-ui-layout">'
        + '<aside class="reader-ui-rail"><div><p class="reader-ui-rail-label">FATE POINTS</p><div class="reader-ui-balance"><div class="reader-ui-balance-value"><span data-reader-balance>' + escapeHtml(balance) + '</span><span class="reader-ui-balance-unit">FP</span></div><p class="reader-ui-muted">当前生效的货币后端</p></div></div>'
        + '<div class="reader-ui-rail-block"><p class="reader-ui-rail-label">HOST MVU</p><div class="reader-ui-health"><span class="reader-ui-health-dot" aria-hidden="true"></span><span>' + escapeHtml(summary.status) + '<br>' + summary.roots + ' 个顶层节点 · ' + summary.nodes + ' 个可选节点</span></div></div>'
        + '</aside>'
        + '<main class="reader-ui-main">' + llmConsole + '<div class="reader-ui-section-head"><div><div class="reader-ui-eyebrow">SEMANTIC ROUTES</div><h3 class="reader-ui-section-title">语义路由</h3><p class="reader-ui-muted">展开一个槽位，选择路径并完成核对。</p></div><div class="reader-ui-section-tools"><button type="button" class="reader-ui-button-primary" data-reader-auto-adapt title="自动寻找各槽位对应的宿主变量并绑定；已启用的槽位保持不变">一键适配</button><span class="reader-ui-batch-meter">待分析容器 ' + containerDraftCount + ' / 5</span><button type="button" class="reader-ui-button-copper" data-reader-analyze-all' + (batchReady ? '' : ' disabled') + '>批量分析已锁定容器' + (containerDraftCount ? '（' + containerDraftCount + '）' : '') + '</button><span class="reader-ui-route-count">07 ROUTES</span><span class="reader-ui-batch-status' + (batchRequestError ? ' is-error' : '') + '" data-reader-batch-status role="status">' + escapeHtml(batchStatusText) + '</span></div></div>'
        + '<div class="reader-ui-route-grid">' + routeCards + '</div></main></div>'
        + '</section>';
      doc.body.appendChild(overlay);

      overlay.querySelector('[data-reader-close]').onclick = function () { overlay.remove(); };
      overlay.addEventListener('click', function (event) { if (event.target === overlay) overlay.remove(); });
      function refreshAfter(action, errorTarget, errorPrefix) {
        var promise = typeof action === 'function' ? Promise.resolve().then(action) : Promise.resolve(action);
        return promise.then(function () { overlay.remove(); return openPanel(); }).catch(function (error) {
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
        }).then(function () { overlay.remove(); return openPanel(); }).catch(function (error) {
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
        if (toggle) {
          toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          toggle.textContent = expanded ? '−' : '+';
        }
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
            if (toggle) {
              toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
              toggle.textContent = expanded ? '−' : '+';
            }
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
          var slot = card.getAttribute('data-reader-route');
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
          if (!value) return;
          refreshAfter(api.selectSemanticRoot(slot, value));
        };
      });
      overlay.querySelectorAll('[data-reader-analyze]').forEach(function (button) {
        button.onclick = function () {
          var slot = button.getAttribute('data-reader-analyze');
          var actionStatus = overlay.querySelector('[data-reader-action-status="' + slot + '"]');
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
          if (!checkbox || !checkbox.checked) {
            if (env.toastr && env.toastr.warning) env.toastr.warning('请先勾选确认已核对预览');
            return;
          }
          refreshAfter(api.confirmSemanticBinding(slot));
        };
      });
      overlay.querySelectorAll('[data-reader-unbind]').forEach(function (button) {
        button.onclick = function () { refreshAfter(api.unbindSemanticSlot(button.getAttribute('data-reader-unbind'))); };
      });
      return overlay;
    }

    return { openPanel: openPanel };
  }

  modules.buildHostVariableTree = buildHostVariableTree;
  modules.renderHostVariableTree = renderHostVariableTree;
  modules.createUiBridge = createUiBridge;
})(typeof globalThis !== 'undefined' ? globalThis : window);
