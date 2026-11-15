---
name: mvu
description: MVU 变量框架：stat_data 结构、<UpdateVariable> 更新、初始化与常见故障
---
# MVU（MagVarUpdate）

- **数据在哪**：每一楼的楼层变量里。`read var:/mvu.json` 看最新楼；主体是 `stat_data`（真实数值），另有 `display_data` / `delta_data` 供显示。历史楼层用 `var:/message/<楼层>.json`。
- **怎么更新**：正文模型在回复末尾输出 `<UpdateVariable>…</UpdateVariable>`，MVU 解析后写入本楼变量。块里的写法各卡不同（`_.set('路径', 旧值, 新值);//原因` 一类的命令，或 JSON Patch），**以这张卡世界书里的「变量更新规则」条目为准**：`grep UpdateVariable wb:/`。
- **初始化**：由世界书里名字带 `[InitVar]` / `initvar` 的条目提供初值，开场时写入第 0 楼。`grep -i initvar wb:/` 找到它。
- **你来改变量**：直接 `edit` / `write` `var:/mvu.json#/stat_data/…`（写的是最新楼的变量）。改之前读出原值；数值保持原来的类型（数字别写成字符串）。有的卡给变量定了校验（类型、取值范围、不许新增键），不合规的写入会被整批拒绝——改完一定回读确认。
- **常见故障**
  - 状态栏不变：模型没输出更新块，或块的格式写坏了（少闭合标签、路径多写了一层 `stat_data`）。看该楼正文末尾。
  - 变量整个没有：这一楼没继承到上一楼的变量，多半是初始化条目没触发，或 MVU 脚本没加载（`read page:/env.json`、`read page:/errors`）。
  - 改了又被改回去：之后生成的楼层会基于各自的上一楼重新计算；要让改动延续，改最新楼。
