# Reader-II 容器映射 DSL v1

五类宿主容器（重要角色、任务、技能、状态、背包）使用受限 JSON 数据描述，不执行模板、函数、JavaScript、EJS 或任意表达式。

## 公共字段

```json
{
  "version": 1,
  "slot": "characters | tasks | skills | statuses | inventory",
  "rootRef": "hostref:...",
  "containerKind": "object | array",
  "name": { "from": "key" },
  "fields": {}
}
```

`entryKind` 只有背包映射可以声明（见下文「背包」），其他槽位带上它会被拒绝。

- `rootRef` 必须逐字等于用户锁定的根，LLM 无权改变。
- `name.from=key` 仅适用于对象表；内部字段名字使用 `{"from":"path","path":["meta","名称"]}`。
- `name.from=key` 的规范形式不含 `path`；部分结构化输出模型附带的空 `path: []` 会被安全归一化，非空冲突路径仍会拒绝。
- 所有相对路径都是路径段数组，因而支持中文键、点号、方括号和数组下标；危险原型段会被拒绝。

## 重要角色

```json
{
  "fields": {
    "favor": {
      "path": ["关系", "好感"],
      "transform": { "type": "linear", "scale": 100, "offset": 0 }
    },
    "present": { "path": ["在场"] },
    "identity": { "path": ["身份"] }
  }
}
```

`transform` 只允许：

- `identity`：宿主已经是 0～100。
- `linear`：有限的 `原值 × scale + offset`，例如 0～1 转 0～100。
- `enum`：显式枚举，例如 `{"type":"enum","values":{"陌生":10,"挚友":90}}`。

结果必须是有限的 0～100；无法换算的条目不进入候选，所有样例均失败时映射验证失败。

`present` 指向角色是否在场的字段，支持布尔值、0/1，以及明确的“是/否、在场/离场”文本。`identity` 指向身份文本或文本数组。它们供 Reader 内部语义功能使用；角色槽 `active` 后，Reader 变量列表完全隐藏该槽，由宿主卡自行展示宿主关系变量。未适配而使用 Reader 后备关系列表时，只有明确在场角色展示完整变量，其他角色只展示名称与身份。旧版已保存映射没有这两个字段时仍可读取，重新分析角色容器即可补齐。

## 任务与技能

两者 `fields` 必须为空。任务只读取任务名，技能只读取技能名。状态、详情、目标、奖励、品质、类型、等级等字段既不读取也不映射。

## 状态

```json
{
  "fields": {
    "effect": { "path": ["内容", "效果"] },
    "duration": { "path": ["内容", "持续"] },
    "source": { "path": ["来源"] }
  },
  "construct": {
    "constants": [
      { "path": ["类型"], "value": "特殊" },
      { "path": ["层数"], "value": 1 }
    ]
  }
}
```

`effect` 与 `duration` 必需，`source` 可选。新增状态会使用相同名字/字段路径构造宿主条目；对象表使用状态名作为安全键，数组追加条目。`constants` 只允许有限数量的 JSON 标量，不能覆盖 Reader 标准语义字段。

验证会在深克隆容器上执行“构造 → 插入 → 重新读取”往返测试。真实写入采用 `ifAbsent`，同名存在时拒绝覆盖。

## 背包

背包多一个字段 `entryKind`，说明宿主背包每一项长什么样（不写时按 `object`）：

| `entryKind` | 宿主的样子 | `containerKind` 与 `name` | `fields` / `construct` |
|---|---|---|---|
| `object` | `{"回复药": {"数量": 3, "品质": "普通"}}` 或对象数组 | 对象表用 `{"from":"key"}`，数组用 `{"from":"path","path":[...]}` | 可映射下列字段；`construct` 同状态 |
| `count` | `{"回复药": 3}`（物品名: 数量） | 必须是对象表，`{"from":"key"}` | 不需要，写了会被拒绝 |
| `name` | `["回复药", "钥匙"]`（字符串数组） | 必须是数组，`{"from":"value"}`（条目本身就是名字） | 不需要，写了会被拒绝 |

`object` 形状可映射的字段（都可选）：

```json
{
  "fields": {
    "count": { "path": ["数量"] },
    "quality": { "path": ["品质"] },
    "type": { "path": ["类型"] },
    "tags": { "path": ["标签"] },
    "effect": { "path": ["效果"] },
    "description": { "path": ["描述"] }
  }
}
```

`{"from":"value"}` 只有 `name` 形状可用。`count` 与映射了 `count` 字段的 `object` 形状可以叠加数量，其余每件单独一项。命运抽卡按映射里声明了哪些字段，决定把品质等信息写进哪里。未绑定时使用 Reader 后备背包 `READER.背包`，它就是一份 `object` 形状、以物品名为键的映射。

## 安全与指纹

映射拒绝根路径变化、根外或危险路径、未知字段、错误类型、缺失必需语义、代码形态字符串、重复状态名和空容器幻觉。确认时保存结构指纹；结构变化后只做确定性复验，失败转 `broken`，不会自动再次调用 LLM。
