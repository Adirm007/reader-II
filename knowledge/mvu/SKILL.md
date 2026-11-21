---
name: mvu
description: MVU Beta 与 MVUzod 变量框架：Zod 4 Schema、[InitVar]、[mvu_update]/[mvu_plot]、命令与 JSON Patch、$meta 与排错
---
# MVU 变量框架（MVU Beta & MVUzod）

MVU（MagVarUpdate）把角色卡的数值与状态按楼层存放在酒馆助手的消息变量中（每次回复独立一份快照，切楼层/重 roll/删楼自动同步）。本指南覆盖 **MVU Beta 原生机制** 与 **MVUzod（Zod 4 Schema）** 两种主流做法。

需要查看上游原始文档时，可直接读取 `kb:/mvu/stat_var.md` 与 `kb:/mvu/supplementary-tutorial.md`。

## 1. 数据布局与路径对照

MVU 存放在每楼消息变量里，顶层包含：
- `stat_data`：核心状态树（AI 与脚本读写的主数据）
- `display_data`：展示用副本（原生 MVU 会保留变化前→变化后展示值；**使用 MVUzod 时会被清除**）
- `delta_data`：本楼层差分（**使用 MVUzod 时会被清除**）
- `schema`：结构元信息（MVU Beta 维护 `$meta`；MVUzod 会写成 `'没有用别管这个'`）
- `initialized_lorebooks`：已初始化的世界书记录

| 使用场景 | 写法示例 | 说明 |
|---|---|---|
| MVU 命令（`_.set` / `_.add` 等） | `_.set('角色.艾琳.好感度', 40);` | 相对 `stat_data`，**省略** `stat_data.` |
| JSON Patch（`<JSONPatch>`） | `{"op":"replace","path":"/角色/艾琳/好感度","value":40}` | 相对 `stat_data`，以 `/` 开头，键内 `/` 转 `~1`、`~` 转 `~0` |
| EJS 读取（`getvar`） | `getvar('stat_data.角色.艾琳.好感度', { defaults: 0 })` | **必须带** `stat_data.` 前缀 |
| 酒馆宏 | `{{format_message_variable::stat_data}}` / `{{get_message_variable::stat_data.地点}}` | **必须带** `stat_data.` 前缀 |
| Reader-II VFS | `read var:/mvu.json#/stat_data/角色/艾琳/好感度` | JSON Pointer，含 `/stat_data` |

### 特殊变量前缀
- `_变量名`（下划线开头）：AI 可见但**只读**，AI 发出的更新命令会被 MVU / MVUzod 忽略（适合系统/脚本维护的值）。
- `$变量名`（美元符开头）：对 AI 隐藏（`{{format_message_variable::stat_data}}` 过滤掉），供脚本或 `$meta` 内部使用。

## 2. MVU 更新命令与 JSON Patch

AI 在回复末尾输出 `<UpdateVariable>` 块（具体格式以当前卡 `[mvu_update]` 条目为准）：

1. **函数命令写法**：
   - `_.set('路径', 新值);`（兼容旧 3 参 `_.set('路径', 旧值, 新值);`）
   - `_.add('路径', 增减数值);`（仅用于数字，正加负减）
   - `_.assign('路径', 键, 值);` 或 `_.assign('路径', 值);`（向对象加键或向数组末尾追加元素；数组插入索引传数字或 `'-'`）
   - `_.remove('路径', 键或值);` 或 `_.remove('路径');`（删除对象键或数组下标/元素）
   - `_.move('源路径', '目标路径');`（MVUzod 支持移动键）
2. **JSON Patch（RFC 6902）写法**：
   ```xml
   <UpdateVariable>
   <Analysis>简要分析本轮变化</Analysis>
   <JSONPatch>
   [
     {"op": "replace", "path": "/地点", "value": "图书馆"},
     {"op": "add", "path": "/背包/钥匙", "value": {"数量": 1}},
     {"op": "remove", "path": "/任务/临时委托"}
   ]
   </JSONPatch>
   </UpdateVariable>
   ```

## 3. 制卡五件套（MVUzod 推荐架构）

制作完整的 MVUzod 变量卡通常包含 5 个协同部分：

### (1) `[InitVar]` 初始化条目（世界书，关闭/蓝灯按需）
- 条目名包含 `[InitVar]`（如 `[InitVar]初始化`），内容用 YAML 或 JSON 写 `stat_data` 初始值（无需包一层 `stat_data:`）。
- **多开场白差异覆写**：在对应开场白末尾写 `<UpdateVariable><initvar>...</initvar></UpdateVariable>`，只覆写与主 `[InitVar]` 不同的字段。

### (2) Zod 4 Schema 局部脚本（酒馆助手角色卡脚本）
将变量结构与边界校验注册给 MVUzod（酒馆助手已内置全局 `z`（Zod 4）与 `_`（Lodash），无需 import 它们）：

```js
import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

export const Schema = z.object({
  时间: z.string().prefault('第1天 08:00'),
  角色: z.record(z.string(), z.object({
    好感度: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(20),
    状态: z.string().prefault('正常'),
  })).prefault({}),
  背包: z.record(z.string(), z.object({
    数量: z.coerce.number().transform(v => Math.max(0, Math.trunc(v))).prefault(1),
    描述: z.string().prefault(''),
  })).prefault({}),
});

$(() => { registerMvuSchema(Schema); });
```

编写 Schema 的核心要点：
- **用 `z.coerce.number()`**：兼容模型输出字符串数字（如 `"50"`）。
- **用 `.prefault(...)` 替代 `.default(...)`**：Zod 4 中 `prefault` 会再走一次 `transform` / 校验流程。
- **用 `.transform(v => _.clamp(v, min, max))` 做幂等夹逼**：超出范围时自动归到边界，而不是因 `.min()` / `.max()` 直接整条报错拒收。
- **动态集合优先用 `z.record(z.string(), ...)` 替代 `z.array(...)`**：按名称索引（如角色名、物品名），模型改删更稳且不易错位。
- **对象不要写 `.strict()` 或 `.passthrough()`**：`registerMvuSchema` 会在顶层使用 `z.looseObject` 保留第三方扩展键（如 `READER`）。
- 避免对象内出现重复键名；`transform` 保持幂等（重复执行结果相同）。

### (3) 变量列表与 `[mvu_update]` 更新规则（世界书）
- **变量列表条目**（常驻，通常放聊天末尾附近深度 1）：用 `{{format_message_variable::stat_data}}` 把当前变量完整展示给 AI。
- **`[mvu_update]` 更新规则条目**（条目名带 `[mvu_update]`）：用 YAML 风格描述每个变量的 `type`、`range`、`category`、`format`、`check`（条件）与更新格式示例；多变量共有规则可用 `${变量A|变量B}` 合并书写。
- **`[mvu_plot]` 双模型分流（可选）**：当玩家启用 MVU 分步/额外模型总结更新时，带 `[mvu_plot]` 的条目只在正文阶段生效，带 `[mvu_update]` 的条目只在变量更新阶段生效。

### (4) 正则脚本（角色卡局部正则）
- 隐藏 `<UpdateVariable>[\s\S]*?</UpdateVariable>`（勾选「仅格式显示」与「仅格式提示词」，防止旧更新块污染上下文与界面）。
- 如需状态栏，在正文末尾用固定占位标签触发美化正则，脚本里通过 `Mvu.getMvuData({ type: 'message', message_id: getCurrentMessageId() })` 读取当前楼层数据（若无 MVUzod，优先读 `display_data`，回退 `stat_data`）。

### (5) 原生 MVU Beta `$meta`（不用 MVUzod 时）
可在 `[InitVar]` 的对象内写 `$meta` 控制扩展与必填：
- `extensible: true`（允许新增键）、`recursiveExtensible: true`（递归允许新增）
- `required: ['字段A']`（不可删除的必填键）
- `template: { ... }` / `strictTemplate: true`（新增子项遵循的模板）
- `strictSet: true`（禁止类型变更）
- 数组允许增删时在数组首项放标记 `"$__META_EXTENSIBLE__$"`。

## 4. 工具箱与排查

打开 `toolbox mvu` 后可使用：
- `mvu_inspect`：按楼层与分类（`stat_data` / `display_data` / `delta_data` / `schema` / `all`）及可选 `path` 读取 MVU 状态。
- `mvu_test_update`：**只读试跑** `<UpdateVariable>`、命令或 `<JSONPatch>`，返回实际变更 diff，不修改聊天。写完规则或修 bug 前先用它验证。
- `mvu_apply_update`：经 MVU 解析器执行更新并写回指定楼层（走完整的 `$meta` 与 Zod 校验）。

### 常见故障定位
1. **变量完全没初始化**：确认安装了 MVU 脚本且聊天里至少有一楼；检查 `[InitVar]` 世界书条目是否有效 YAML/JSON；查看 `page:/errors` 是否有 Zod 初始化报错。
2. **输出了 `<UpdateVariable>` 但变量没变**：
   - 先读 `chat:/latest` 核对原始输出格式（标签是否闭合、路径是否多写了 `stat_data.`）。
   - 用 `mvu_test_update` 试跑该段文本，看是否被 `$meta` / Zod / `_` 只读前缀拦截，再查 `page:/errors`。
   - 检查是否装了两份冲突的 MVU 脚本或存在额外正则把 `<UpdateVariable>` 提前删掉了。
3. **重 roll 或切楼层后数据错乱**：确认前端脚本使用的是楼层变量（`type: 'message'` + `getCurrentMessageId()`），而非把状态错写到 `chat` 级变量。
4. **与 Reader-II 配合**：Reader-II 的自有数据放在 `stat_data.READER` 下；如果角色卡使用 MVUzod，确保顶层未设 `.strict()`。
