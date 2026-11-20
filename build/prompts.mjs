// 提示词模板（交接 0.9）：更新规则、读者核心、变量列表三份 EJS 在构建时编译成函数，随扩展包走，
// 由 src/reader-prompt.js 在每次生成前渲染并注入。模板本身仍由 build/worldbook.mjs 从上游世界书变换而来。
// 好处：不用再装世界书，也不依赖提示词模板（ST-Prompt-Template）来执行 EJS。
import { buildWorldbook, ENTRY_NAMES, ejsSource, assertEjs } from './worldbook.mjs';

export const PROMPTS_MODULE = 'reader-prompts';
export const PROMPT_NAMES = ['rules', 'core', 'list'];

export function promptTemplates({ version = 'dev' } = {}) {
  const built = buildWorldbook({ version });
  const entries = Object.values(built.json.entries);
  const templates = {};
  for (const name of PROMPT_NAMES) {
    const entry = entries.find((item) => item.comment === ENTRY_NAMES[name]);
    if (!entry) throw new Error(`世界书变换里没有条目 ${ENTRY_NAMES[name]}`);
    templates[name] = assertEjs(entry.content, name);
  }
  return { templates, upstreamVersion: built.upstreamVersion, upstreamLines: built.upstreamLines };
}

// 生成的模块不能用严格模式：编译出的模板靠 with (locals) 取宿主函数（getvar 等）。
export function promptsModule(templates) {
  // 正文与设置编辑器共用上游的「核心概念、开场白、人设」原文，外观、机制和变量继续独立渲染。
  const start = templates.core.indexOf("<% if (_persona_mode === 'kuromaku') { %>\n哀怜的少女:\n  核心概念:");
  const end = templates.core.indexOf("<%\nlet _dreamAppearance", start);
  if (start < 0 || end < 0) throw new Error('读者核心里找不到可编辑的人格段落');
  const profile = templates.core.slice(start, end);
  const theme = templates.core.match(/let _dream_theme_value =[^\n]*\n[\s\S]*?let _dream_letter_limit_re =[^\n]+/);
  if (!theme) throw new Error('读者核心里找不到主题和来信设置');
  const source = { ...templates, core: templates.core.slice(0, start)
    + "<%- (typeof getPersonaPrompt === 'function' && getPersonaPrompt(_persona_mode)) || defaultPersonaPrompt(_persona_mode, _custom_persona, getLocalVar) %>"
    + templates.core.slice(end) };
  const body = PROMPT_NAMES.map((name) => `    ${JSON.stringify(name)}: async function (locals, __esc) {\n${ejsSource(source[name])}\n    }`).join(',\n');
  return [
    '(function (root) {',
    '  /* 构建生成（node build.mjs），不要手改：提示词模板（更新规则、读者核心、变量列表）编译成的函数，reader-prompt.js 渲染。',
    '   * 这一段不用严格模式：模板靠 with (locals) 取宿主函数。源头是 build/worldbook.mjs（上游世界书的变换）。 */',
    '  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};',
    '  function defaultPersonaPrompt(id, custom, getLocalVar) {',
    theme[0],
    '    function field(key, fallback) { var s = custom && custom[key]; return typeof s === "string" && s.trim() ? s.trim() : fallback; }',
    '    var locals = { _persona_mode: id, _custom_system_name: field("systemName", field("name", "")), _custom_text: field };',
    ejsSource(profile),
    '  }',
    '  modules.defaultReaderPersonaPrompt = defaultPersonaPrompt;',
    '  modules.READER_PROMPT_TEMPLATES = {',
    body,
    '  };',
    "})(typeof globalThis !== 'undefined' ? globalThis : window);",
  ].join('\n');
}
