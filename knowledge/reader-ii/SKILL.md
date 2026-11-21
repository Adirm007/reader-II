---
name: reader-ii
description: Reader-II 自己：FP、语义槽、轻信、大厅、抽卡各是什么，出问题看哪里
---
# Reader-II

Reader-II 是「读者系统」：九十九夜梦作为故事外的读者，给用户写信（正文里的 `<dream>…</dream>`）、发放与消费 FP（命运点数）、提供大厅、书架、抽卡等功能。只需安装一个扩展，语义层、轻信、大厅、抽卡、提示词、助手与记忆都在其中；没有酒馆助手或 MVU 时由原生宿主层兜底。后端伴侣仅在需要操作设备时选装。

扩展菜单「Reader-II」与不带内容的 `/yume` 共用一个入口。角色卡默认启用并打开大厅。无卡或当前卡已停用时打开助手。大厅的彩蛋服务台提供和夜梦说说话、助手设置、语义适配、记忆四个入口。可在助手设置的「这张卡」里启停，或用 `ReaderII.lobby.isEnabled() / enable() / disable()`。`ReaderII.lobby.open('eggs')` 在启用的卡上打开服务台。

**语义槽**：Reader 不认死路径，而是把「当前地点、重要角色、任务、技能、状态、货币、背包」七个槽位映射到宿主卡自己的变量上；没映射的用 Reader 自带的后备（`stat_data.READER`）。`toolbox reader` 之后：`reader_state` 看各槽位现状，`adapt_variables` 一键适配，`unbind_slot` 解绑。绑定了货币槽时，FP 的增减直接作用于宿主卡的货币。

用户已说明正确路径时，直接调用 `adapt_variables`，例如参数 `{"roots":{"inventory":["人物","背包","道具"]}}`。这会复核并替换指定槽，其他槽保持原配置。空表可从本卡变量更新规则取字段证据，也可在核对定义后同时给出该槽的 `mappings`。读取返回的逐槽 `status`、`changed`、`reason`，再用 `reader_state` 回读生效路径及数据。只有实际成功的改绑才报告为已完成。

需要记住与用户在助手窗口的交流时，使用 `toolbox memory`。记忆存在当前聊天或《夜之洋》世界书（跨存档）。前文剧情由用户选择的外部插件提供，只供本次助手回答参考。开启「助手夜梦 = 正文夜梦」后，正文夜梦可以回忆与现实用户的交流。

**出问题看哪里**
- 信没显示：当前卡是否启用、正文里有没有 `<dream>`、`page:/errors`；显示由扩展格式化钩子或两条内置正则处理。
- FP 不对：`read var:/mvu.json#/stat_data/READER`，以及货币槽绑到了哪里（`reader_state`）。
- 大厅 / 抽卡打不开：当前卡是否启用（`ReaderII.lobby.isEnabled()`），再看 `page:/errors`。
- 助手只说不做：在助手设置「工具调用」点「测试工具调用」，或调 `agent.probeTools()`；`agent.toolStatus()` 看当前协议。设置 `toolProtocol` 可选 auto / native / text。
- 版本更新：助手设置里只检查远端 manifest.json 版本；在酒馆扩展管理里更新后刷新。旧 alpha 组件由扩展自动接管，不要求用户另装。
