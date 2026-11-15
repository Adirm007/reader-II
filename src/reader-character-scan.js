(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};
  var PROMPT_ID = 'reader-ii-character-keywords';

  modules.createCharacterKeywordScanner = function (semanticRouter, env) {
    var installed = false;
    var revision = 0;

    function normalizeNames(values) {
      var seen = Object.create(null);
      return (Array.isArray(values) ? values : []).map(function (value) {
        return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : '';
      }).filter(function (value) {
        if (!value || seen[value]) return false;
        seen[value] = true;
        return true;
      }).slice(0, 100);
    }

    async function refresh() {
      var ticket = ++revision;
      var names = [];
      try {
        names = normalizeNames(await semanticRouter.listCharacterNames());
      } catch (error) {
        if (env.console && typeof env.console.warn === 'function') {
          env.console.warn('[ReaderCore] 角色关键词刷新失败', error);
        }
      }
      if (ticket !== revision) return names;
      if (typeof env.injectPrompts === 'function') {
        await env.injectPrompts([{
          id: PROMPT_ID,
          content: names.join('\n'),
          position: 'none',
          depth: 0,
          role: 'user',
          should_scan: true
        }]);
      }
      return names;
    }

    function install(mvu, eventTarget) {
      if (!installed) {
        installed = true;
        if (typeof env.eventOn === 'function' && mvu && mvu.events) {
          function refreshSafely() {
            Promise.resolve(refresh()).catch(function (error) {
              if (env.console && typeof env.console.warn === 'function') {
                env.console.warn('[ReaderCore] 角色关键词注入失败', error);
              }
            });
          }
          if (mvu.events.VARIABLE_INITIALIZED) env.eventOn(mvu.events.VARIABLE_INITIALIZED, refreshSafely);
          if (mvu.events.VARIABLE_UPDATE_ENDED) env.eventOn(mvu.events.VARIABLE_UPDATE_ENDED, refreshSafely);
          if (eventTarget && typeof eventTarget.addEventListener === 'function') {
            eventTarget.addEventListener('reader-core-changed', refreshSafely);
          }
        }
      }
      return refresh();
    }

    return {
      refresh: refresh,
      install: install,
      promptId: PROMPT_ID
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
