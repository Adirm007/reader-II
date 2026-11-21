---
name: lwb-variables
description: 小白X（LittleWhiteBox）变量 2.0 与 3.0：宏、<varevent>、V2 <state>/$schema/JSON apply、V3 卡规则包/动作/结算/扩展
---
# 小白X（LittleWhiteBox）变量系统（2.0 & 3.0）

小白X 3.2.6+ 同时提供 **变量 2.0**（字段模板与约束）与 **变量 3.0**（卡内玩法框架与原子结算）。**同一张卡选定一套体系，不要混用 1.0、2.0、3.0 或 MVU 语法。**

需要查阅上游完整用户文档时，按需读取：
- `kb:/lwb-variables/variables.md`（总览与 2.0 / 3.0 选型）
- `kb:/lwb-variables/variables-v2.md`（变量 2.0 完整手册）
- `kb:/lwb-variables/variables-v3.md`（变量 3.0 玩法框架手册）
- `kb:/lwb-variables/variables-v3-external.md`（变量 3.0 外部制卡格式与离线工具）

## 1. 共同底座：存储、读取宏与 `<varevent>`

### 存储位置
- 变量存在酒馆聊天局部变量 `chat_metadata.variables`（VFS：`var:/chat.json`），对象与数组在底层以 JSON 字符串序列化存储。
- 2.0 的规则/楼层快照存在 `chat_metadata` 的 `LWB_RULES_V2` / `LWB_SNAP` 等键；3.0 的聊天进度存在 `chat_metadata['lwb-state3']`，卡规则包存在角色卡 `data.extensions['lwb-state3']`。
- 修改受管变量统一走小白X 接口（`LWB_StateV2` / `LWB_StateV3`），保证楼层快照、撤销与约束一致。

### 世界书/提示词读取宏与斜杠命令
- `{{xbgetvar::路径}}`：标量原样展开，对象/数组展开为紧凑 JSON（如 `{{xbgetvar::数据.主角.金币}}`）。
- `{{xbgetvar_yaml::路径}}`：以 YAML 格式展开，便于正文模型阅读。
- `{{xbgetvar_yaml_idx::路径}}`：带数组下标注释的 YAML 展开。
- `{{xbvardesc::视图名}}`（3.0 专用）：展开该视图对应的字段含义、规则、动作、触发与约束说明（不含当前数值）；`{{xbvardesc}}` 展开全部视图。
- 斜杠命令：`/xbgetvar`、`/xbsetvar`、`/xbaddvar`、`/xbdelvar`、`/xbpushvar`。

### `<varevent>` 条件事件块（世界书/提示词中）
按当前变量条件动态注入文本或执行脚本：
```text
<varevent>
[event.夜半钟声]
condition = var(`数据.时间`) == "深夜" && var(`数据.主角.好感`) >= 50
display = 夜半钟声敲响，她在门廊停下脚步。
js_execute = console.log('triggered');
</varevent>
```
- 块内可写多个 `[event.名称]`，支持嵌套依赖；条件中用 `` var(`路径`) `` 读变量、`` val(`值`) `` 取字面量；`js_execute` 在 AI 回复完成后执行。

---

## 2. 变量 2.0（`LWB_StateV2`）

适合「字段模板 + 范围/步长/枚举约束 + 独立更新器或正文 `<state>` 块」的角色卡。

### (1) 两种更新方式
- **结构化 JSON（独立更新器 / 工具首选）**：调用 `lwb_state_apply_json`（底层 `LWB_StateV2.apply({ ops })`）：
  ```json
  {
    "ops": [
      { "op": "set", "path": "数据.主角.金币", "value": 100 },
      { "op": "inc", "path": "数据.主角.好感度", "delta": -5 },
      { "op": "push", "path": "数据.主角.物品", "value": "铜钥匙" },
      { "op": "remove", "path": "数据.主角.物品", "value": "旧地图" },
      { "op": "del", "path": "数据.临时标记" }
    ]
  }
  ```
  路径支持 `物品[0]` 与特殊键 `角色["Lv.3"]`；同批不要对同一数组做会移动后续下标的冲突删除。
- **正文 `<state>` 文本块**：调用 `lwb_state_apply`（底层 `LWB_StateV2.applyText`）：
  - 赋值：`数据.主角.地点: "港口"`、`数据.主角.金币: 100`
  - **绝对负数必须加括号**：`数据.主角.声望: (-10)`（裸 `-10` 会被解析为相对减 10！）
  - 相对增减：`数据.主角.金币: +20` / `-15`
  - 数组操作：`+"道具"`、`+["a","b"]`、`-"道具"`、`-[...]`
  - 删除字段：`数据.临时: null`
  - 注意：`applyText` 对同一楼层完全相同的 `<state>` 文本会跳过（`skipped: true`），程序化修改优先用 `lwb_state_apply_json`。

### (2) `$schema` 模板与约束
在初始化 `<state>` 块中声明 `$schema` 模板与约束：
- 类型占位：`""`（字符串）、`0`（数字）、`true`（布尔）、`[]`（数组）、`{}`（对象）、`"*"`（通配键，约束动态子对象统一结构）。
- 约束关键字：
  - `$range=[下限, 上限]`（数值范围，超界夹逼/校验）
  - `$step=步长`（单次变动上限）
  - `$enum={值A, 值B}`（枚举白名单）
  - `$ro`（只读字段；初始化时先建值，再在第二次调用里加 `$ro` 锁定）
- 查看当前聊天的生效模板与约束：调用 `lwb_schema`；排查约束拒绝原因看错误返回或 `LWB_STATE_ERRORS`。

---

## 3. 变量 3.0（`LWB_StateV3`）

适合有**商店、装备、战斗、经营、多步骤联动、回复前先结算再写正文**的玩法型角色卡。核心思想：**模型只提交发生了什么动作或允许直改的字段，结算引擎按固定顺序整批计算，全部通过结构与约束校验才原子生效，失败整批回滚。**

### (1) 规则包结构与载体
- 角色卡内存储位置：`card.data.extensions['lwb-state3']`（JSON 字符串），格式为完整规则包 `{ definition, functions, tools?, scripts? }`。
- 卡片工作区 / 外部制卡目录结构：
  - `variables/definition.json`（主定义，`format: 1`）
  - `variables/functions/<name>.js`（纯计算 JS 函数表达式，隔离运行）
  - `variables/tools/<name>.js`（更新模型可调用的自定义查资料工具）
  - `variables/scripts/{prepare,calculate,committed}.js`（三阶段钩子脚本）

### (2) `definition.json` 核心字段
| 字段 | 必填 | 作用 |
|---|---|---|
| `format` | 是 | 固定为 `1` |
| `name` | 是 | 规则名称 |
| `updates` | 是 | 更新阶段数组：`["before"]`、`["after"]` 或 `["before", "after"]` |
| `schema` | 是 | 根状态的 JSON Schema（严格校验，不自动补默认值、不隐式类型转换） |
| `initial` | 是 | 共用开局值对象（每个顶层键对应一个原生聊天变量根） |
| `openings` | 否 | 各条开场白的差异覆写数组（按主开场→备选开场顺序排列） |
| `access` | 是 | 数组：`{ path, direct, stages?, description, update? }`；`direct: false` 的字段只能经由动作或规则改变 |
| `rules` | 是 | 规则数组：`kind: "derive"`（自动派生，禁止被动作或直接改值覆盖）或 `"correct"`（越界修正，须幂等稳定） |
| `actions` | 是 | 动作数组：`{ id, title, stages?, parameters, description, requires, effects, conversions }`；`requires` 须严格求值为 `true` |
| `triggers` | 否 | 条件触发器：`{ id, description, timing?: "batch"\|"action", when, effects }` |
| `constraints` | 是 | 最终状态约束：`{ id, test, description }`，不通过则整批拒绝 |
| `functions` | 是 | 声明自定义 JS 函数的 `{ reads: Path[], description }` |
| `views` | 是 | 给 `{{xbvardesc::视图名}}` 使用的分组：`{ paths, description }` |
| `extensions` | 否 | 声明 `tools`（模型工具）与 `scripts`（`prepare` / `calculate` / `committed`） |

- 路径统一使用**字符串数组**（如 `["hero", "coins"]`）。
- 表达式节点：`{ literal }`、`{ get }`、`{ before }`、`{ param }`、`{ prepared }`（仅动作内）、`{ op, args }`（`add/subtract/multiply/divide/min/max/eq/ne/lt/lte/gt/gte/and/or/not/if/length/includes`）、`{ call, args }`。
- `updates` 同时包含 `before` 与 `after` 时，每个动作和 `direct: true` 的 `access` 项都要声明 `stages`；`rules`、`triggers`、`constraints` 共用一套，不区分阶段。

### (3) 提交输入格式（`preview` / `apply` / `tryDefinition`）
操作数组，每项为以下之一：
- 调用动作：`{ "action": "buy", "params": { "item": "铁剑" } }`
- 直接设值：`{ "op": "set", "path": ["hero", "mood"], "value": "兴奋" }`
- 数值增减：`{ "op": "inc", "path": ["hero", "coins"], "delta": -20 }`
- 删除字段：`{ "op": "remove", "path": ["hero", "tempBuff"] }`
（可附带 `reason` / `old` 注释说明本轮原因，不参与执行与落盘历史。）

### (4) 离线制卡 CLI（外部制作或接入后端伴侣时）
在 LittleWhiteBox 目录提供离线工具 `node dist/tools/state3.cjs`：
- `init`：初始化空规则工程
- `unpack <card.png|json>`：从角色卡解包 `variables/`
- `check`：静态检查定义与开局初始化
- `try`：离线试算动作/改值
- `pack`：打包写回角色卡
- `schema`：输出 `definition.json` 的 JSON Schema

---

## 4. 工具箱与排查

打开 `toolbox lwb` 后可使用：
- **变量 2.0**：`lwb_schema`（读模板约束）、`lwb_state_apply_json`（结构化 JSON 写入，优先使用）、`lwb_state_apply`（`<state>` 文本写入）。
- **变量 3.0**：
  - `lwb_v3_inspect`：查当前聊天 V3 状态、规则摘要、更新设置、扩展信任与上次结算结果。
  - `lwb_v3_preview`：**只读试算**动作或直接改值，不改聊天进度。
  - `lwb_v3_apply`：经 V3 引擎结算并写回当前聊天。
  - `lwb_v3_export_rules`：导出当前卡保存的完整 V3 规则包。
  - `lwb_v3_check_draft`：**只读校验并试算**任意 V3 规则包草案（支持指定 `opening`、`state`、`stage`、`input`），不改动角色卡与聊天。
  - `lwb_v3_undo`：撤销 V3 结算记录。

### 常见排查要点
1. **模式不匹配**：检查小白X 设置中选中的是 2.0 还是 3.0；3.0 规则仅在 3.0 模式下运行，2.0 的 `<state>` 不会在 3.0 生效。
2. **2.0 改负值变成扣减**：`<state>` 文本里 `-5` 是相对减 5，设绝对负值需写 `(-5)` 或改用 `lwb_state_apply_json`。
3. **2.0 同楼重复写入被跳过**：`applyText` 对相同内容幂等跳过，改用 `lwb_state_apply_json`。
4. **3.0 整批失败**：先用 `lwb_v3_inspect` 看 `lastResult.diagnostics`，再用 `lwb_v3_preview` 单独试算动作或字段，核对 `requires` 是否严格返回 `true`、目标字段是否被 `derive` 规则保护或 `direct: false`。
5. **与 Reader-II 配合**：Reader-II 自动检测小白X 2.0 / 3.0 变量宿主并解码 JSON 聊天变量；货币/背包/角色等槽位绑定后，增减均经小白X 官方 API 写入，Reader 自有的 `READER` 命名空间继续保存在楼层变量中。
