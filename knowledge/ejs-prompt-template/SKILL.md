---
name: ejs-prompt-template
description: 酒馆 EJS（ST-Prompt-Template）语法、@@ 装饰器、作用域、多阶段动态世界书与排错
---
# 酒馆 EJS（ST-Prompt-Template）

用于编写和排查酒馆世界书、角色卡、预设和正则中的 `<% ... %>` 动态模板。
需要查阅上游完整语法表与全部装饰器清单时，按需读取：
- `kb:/ejs-prompt-template/reference.md`（中文语法与函数参考）
- `kb:/ejs-prompt-template/features.md`（中文功能与装饰器）
- `kb:/ejs-prompt-template/features_en.md`（最新英文功能与装饰器）

## 1. 标签与空白控制

| 标签 | 作用 |
|---|---|
| `<% code %>` | 执行 JS 代码，无输出 |
| `<%_ code _%>` | 执行 JS 代码，并吃掉同行前置空白与后置空白/换行（写逻辑块优先用它，避免在提示词中留下大片空行） |
| `<%- expr %>` | **原样输出**（提示词与 HTML 内容首选，不做 HTML 转义） |
| `<%= expr %>` | HTML 转义后输出（`< > & "` 会被转义） |
| `<%# comment %>` | 注释，不输出也不执行 |
| `-%>` | 仅吃掉标签后的一个换行 |

## 2. 作用域与变量读写

EJS 变量分布在五个常见作用域中，默认读取顺序为本地/消息优先于全局：
- `message`：楼层变量（MVU 的 `stat_data` 位于此）
- `local`：当前聊天局部变量（`chat_metadata.variables`）
- `global`：酒馆全局变量
- `cache`：单次生成/渲染周期内的临时缓存（不落盘）
- `initial`：由 `@@initial_variables` 或 `[InitialVariables]` 声明的初始值

### 读取 MVU / 聊天变量的稳妥写法
- **总是给 `defaults`**，并补全 `stat_data.` 前缀（读取 MVU 时）：
  ```ejs
  <%_
  var affection = Number(getvar('stat_data.角色.艾琳.好感度', { defaults: 0 }));
  var flags = getvar('stat_data.事件标记', { defaults: {} });
  _%>
  ```
- **不要在路径里写 `[0]` 索引**：先把数组取出再按 JS 下标访问。
- **防跨条目重复声明报错**：同一轮生成中多个世界书条目共享模板作用域。用 `var` 或包一层 `{ let ... }` 块作用域，或给条目加上 `@@private` 装饰器隔离作用域；需要跨条目复用变量时先判断 `typeof x === 'undefined'`。
- 写变量：`setvar('路径', 值, { scope: 'local' })`、`incvar`、`decvar`、`addvar`、`mulvar` 等（详见 `kb:/ejs-prompt-template/reference.md`）。

### 自定义函数（`define`）
跨条目共享辅助函数时，**必须使用 `function`，不要用箭头函数**，且函数内通过 `this.getvar` / `this.setvar` 访问上下文：
```ejs
<%_
define('stageOf', function (name) {
  var v = Number(this.getvar('stat_data.角色.' + name + '.好感度', { defaults: 0 }));
  return v >= 60 ? '亲密' : v >= 20 ? '熟识' : '初识';
});
_%>
```

## 3. `@@` 装饰器规则

装饰器写在世界书条目的**最顶部**，必须严格满足以下格式：
1. **从第 1 行开始，每行一个装饰器，装饰器之间绝不能插空行**（遇到第一个非装饰器行即结束解析）。
2. 未知的 `@@xxx` 会被静默忽略，拼错名字不会报错。
3. 需要输出字面量 `@@` 时，写成 `@@@`。

常用装饰器：
- `@@activate` / `@@dont_activate`：强制激活或强制不激活当前条目（常与 `@@if <JS表达式>` 配合，或在代码里结合条件控制）。
- `@@if <表达式>`：仅当条件为真时激活该条目。
- `@@private`：将本条目包裹在独立作用域中，避免 `let`/`const` 与其他条目冲突。
- `@@preload` / `@@only_preload` / `@@dont_preload`：控制条目是否在主体世界书激活之前预加载（放共用 `define()` 或初始化逻辑）。
- `@@initial_variables`：将条目内容解析为初始变量定义。
- `@@generate_before` / `@@generate_after`：在生成提示词前/后执行。
- `@@render_before` / `@@render_after`：在渲染聊天楼层前/后执行。
- `@@message_formatting`：作为消息格式化模板运行。
- `@@preprocessing`：预处理阶段运行（**不能**与 `@@generate_before` / `@@generate_after` 同时用于同一条目）。
- `@@always_enabled`：即使条目本身在世界书中关闭也参与处理。
- `@@iframe [标题]`：在消息渲染时把输出包进 iframe。

## 4. 生命周期条目与动态按需加载（MVU + EJS 常见架构）

世界书特殊命名条目（也可用对应 `@@` 装饰器替代）：
- `[InitialVariables]`：声明初始变量。
- `[GENERATE:BEFORE]` / `[GENERATE:AFTER]`：提示词生成前后钩子。
- `[RENDER:BEFORE]` / `[RENDER:AFTER]`：楼层渲染前后钩子。
- `@INJECT`：向提示词注入内容。

### 多阶段动态世界书模式（减少无关 Token）
把各阶段/各角色的详细剧情条目在世界书中设为 **关闭（disabled）**，只留一个常驻的「总控条目」按当前变量状态用 **`await getwi(...)`** 动态拉取：
```ejs
<%_ {
  var chapter = Number(getvar('stat_data.章节', { defaults: 1 }));
  var loc = String(getvar('stat_data.地点', { defaults: '' }));
_%>
<%- await getwi(undefined, '主线_第' + chapter + '章') %>
<%_ if (loc === '钟楼') { _%>
<%- await getwi(undefined, '场景_钟楼秘密') %>
<%_ } _%>
<%_ } _%>
```
- **`getwi` 是异步函数，必须写 `await`**，否则会输出 `[object Promise]`。
- 第一参数可传世界书名，传 `undefined` 或省略书名格式时请按当前插件版本查 `kb:/ejs-prompt-template/reference.md`。
- 模板内置常用工具库（如 Lodash `_` 等），可直接用于数据处理。

## 5. 工具箱与排查

打开 `toolbox ejs` 后可使用：
- `ejs_check_syntax`：**只读**检查模板语法（不执行、不改变量），修改世界书条目后优先用它排查括号/标签遗漏。
- `ejs_variables`：**只读**查看 EJS 当前可见的完整合并变量表（支持 `path` 如 `stat_data.角色`），核对变量路径是否存在。
- `ejs_features`：**只读**读取插件开关配置（`enabled`、`generate_enabled`、`render_enabled`、`sandbox`、`invert_enabled`、`depth_limit` 等）。
- `ejs_render`：在当前聊天上下文试渲染模板（支持传临时 `data` 和 `last_message_id`）。模板内的 `setvar` 会实际生效。

### 常见故障定位
1. **提示词里直接出现了原始 `<% ... %>`**：先调 `ejs_features` 确认 `enabled` 和 `generate_enabled`（楼层显示看 `render_enabled`）是否开启；若使用 `[GENERATE:*]`/`[RENDER:*]`/`@INJECT`，核对 `invert_enabled`（旧版兼容反转开关）。
2. **输出 `[object Promise]`**：漏写了 `await`（常见于 `getwi`、`evalTemplate`、`activateRegex`）。
3. **`Identifier 'xxx' has already been declared`**：多个条目顶层用了同名 `let`/`const`；改为 `var`、`<%_ { let ... } _%>` 或在条目第 1 行加 `@@private`。
4. **变量读出来总是 `undefined`**：用 `ejs_variables` 核对真实键名，检查是否漏了 `stat_data.` 前缀。
5. **语法报错**：用 `ejs_check_syntax` 定位精确行号与上下文，常见原因是 `<%` 未闭合、中文标点、或表达式末尾在 `<%- ... %>` 里带了分号。
6. **前端脚本互操作**：页面或正则脚本可通过 `window.EjsTemplate.prepareContext()` + `window.EjsTemplate.evalTemplate()` 按需渲染模板。
