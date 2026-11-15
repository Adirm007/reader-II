---
name: ejs-prompt-template
description: 写与排查酒馆 EJS（提示词模板 ST-Prompt-Template 的 <% %> 语法）
---
# 酒馆 EJS（提示词模板扩展）

需要用户装了「提示词模板」（ST-Prompt-Template）扩展；`read page:/env.json` 的插件列表里有它时，`ejs` 工具箱可以试渲染。

**语法**（标准 EJS）：`<% 代码 %>` 只执行；`<%= 表达式 %>` 输出（HTML 转义）；`<%- 表达式 %>` 原样输出；`<%# 注释 %>`。模板可以写在世界书条目、预设提示词、角色卡字段和楼层正文里。

**内置函数（都可直接调用，多数是异步的，前面写 await）**
- 变量：`getvar(key)` `setvar(key, value)` `incvar(key, n)` `decvar(key, n)` `delvar(key)` `insvar(key, value)` `patchVariables(key, change)`；各有 `…LocalVar / …GlobalVar / …MessageVar` 版本指定作用域；`key` 支持 `a.b.c` 路径。
- 取内容：`getwi(世界书, 条目名, data)`（读条目并当模板渲染）、`getchar(角色名)`、`getpreset(提示词名)`、`getqr(集合, 标签)`、`getChatMessage(idx)` / `getChatMessages(…)`、`matchChatMessages(pattern)`。
- 控制：`activewi(世界书, 条目名)` 触发原生世界书激活、`injectPrompt(key, prompt, order)` 注入、`define(name, value)` 定义全局可用的值或函数、`execute('/斜杠命令')`、`evalTemplate(content, data)`、`print(…)`。
- 数据：`getCharData()` `getWorldInfoData(名)` `getEnabledWorldInfoEntries()` `parseJSON(text)` `jsonPatch(dest, change)`。

**写之前先查原文，不要凭印象写参数**：
- `grep <函数名> kb:/ejs-prompt-template/reference.md`：每个函数的参数、返回值、示例；另有「内置常量」「特殊变量」（如 `variables`、`this_chid`）与导出函数（`EjsTemplate.evalTemplate / prepareContext / getSyntaxErrorInfo`）。
- `kb:/ejs-prompt-template/features.md`：「内容注入」（`[GENERATE]` `[RENDER]` `@INJECT` 这类特殊条目）、「楼层渲染」、「装饰器」、「激活正则」、「设置选项」。

**做法**
1. 先 `read` 目标条目的现状，弄清它在生成时执行还是在楼层渲染时执行（两者能用的函数与时机不同，见 features.md）。
2. 写好后用 `ejs_render` 试渲染（会真的执行 setvar，注意别弄乱变量；必要时先记下原值）。
3. 报语法错误时，错误信息里有行号；常见原因是 `<%` 没闭合、在 `<%= %>` 里写了语句、忘了 `await`、条件块的花括号跨标签没配对。
4. 变量读不到：先 `read var:/chat.json` / `var:/mvu.json` 看真实路径，MVU 卡的数据在 `stat_data` 下。
