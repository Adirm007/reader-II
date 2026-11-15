---
name: reader-ii
description: Reader-II 自己：FP、语义槽、轻信、大厅、抽卡各是什么，出问题看哪里
---
# Reader-II

Reader-II 是「读者系统」：九十九夜梦作为故事外的读者，给用户写信（正文里的 `<dream>…</dream>`）、发放与消费 FP（命运点数）、提供大厅、书架、抽卡等功能。它由两部分组成：

- **扩展（你所在的这部分）**：夜梦助手、记忆（夜之洋）、知识库、插件对接。
- **卡内组件**：一个酒馆助手脚本 + 世界书条目 + 三条正则。负责语义层、轻信、大厅、抽卡。用户没装它时，`reader` 工具箱里的工具会报「主系统未就绪」。

**语义槽**：Reader 不认死路径，而是把「当前地点、重要角色、任务、技能、状态、货币、背包」七个槽位映射到宿主卡自己的变量上；没映射的用 Reader 自带的后备（`stat_data.READER`）。`toolbox reader` 之后：`reader_state` 看各槽位现状，`adapt_variables` 一键适配，`unbind_slot` 解绑。绑定了货币槽时，FP 的增减直接作用于宿主卡的货币。

**记忆**：`toolbox memory`。记忆存在当前聊天或《夜之洋》世界书（跨存档）。默认你的记忆不会注入正文。

**出问题看哪里**
- 信没显示：渲染正则是否启用（`ls regex:/`）、正文里有没有 `<dream>`、`page:/errors`。
- FP 不对：`read var:/mvu.json#/stat_data/READER`，以及货币槽绑到了哪里（`reader_state`）。
- 大厅 / 抽卡打不开：卡内组件的脚本是否启用（`ls script:/`）。
