---
name: lwb-variables
description: 小白X 的变量：存放位置、<state> 写法、模板与约束
---
# 小白X（LittleWhiteBox）的变量

- **存放位置**：酒馆的聊天变量。`read var:/chat.json`，通常有一个根变量（常叫 `数据`）装着整份状态；`#/数据/角色/生命值` 取子树。
- **变量 2.0（state）**：角色卡用 `<state>…</state>` 文本管理状态。
  - `$schema 根变量` 规定结构与类型；`$range=[0,999] 路径`、`$step=50 路径` 等加约束；`$ro 路径` 设只读。
  - 赋值写 `数据.角色.金币: +10`（相对）或 `数据.当前地点: "王都"`（绝对）；也可以写成缩进的 YAML 结构。
  - 模板里有的字段，初始数据必须写全，否则整份都不会写入。
  - 每楼记着自己对变量做了什么，删楼、切 swipe 会按记录恢复。
- **你来改变量**：打开 `lwb` 工具箱，用 `lwb_state_apply` 提交 `<state>` 文本——它会走小白X 自己的校验和楼层记账。**不要直接 write `var:/chat.json` 改它管的变量**，那样它的记录会对不上，切 swipe 后可能被还原或重复计算。`lwb_schema` 可以读当前模板。
- **排查**：变量没变 → 用户在小白X 设置里开了「变量管理」并选了 `2.0 (state)` 吗；写入被挡 → 看 `lwb_state_apply` 返回的 errors，以及 `page:/errors`。
- 斜杠命令 `/xbgetvar` `/xbsetvar` `/xbaddvar` `/xbdelvar` `/xbpushvar` 支持带路径的读写（`tavern` 工具箱的 `slash_run`）。
