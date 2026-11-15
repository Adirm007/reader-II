---
name: card-workflow
description: 制卡工作流：从设定到角色卡、世界书、开场白，再在当前酒馆里试跑；也说明怎么自定义工作流
---
# 制卡工作流

用 `todo` 列出下面的步骤，逐步推进；每一步做完向用户确认再往下。

1. **问清需求**：题材与基调、主要角色、用户扮演谁、要不要变量系统（MVU / 小白X / 不要）、要不要美化界面。草稿记在 `ws:/drafts/<卡名>/brief.md`。
2. **设定稿**：角色（外貌、性格、语言风格、能力）、世界观、关键地点与势力。先写进 `ws:/drafts/<卡名>/`，用户点头后再落到卡里。
3. **落到角色卡**：`card:/description.md`（角色本体）、`scenario.md`、`first_mes.md` 与 `greetings/`。只写常驻必要的内容，细节放世界书。
4. **世界书**：人物、地点、规则各一条，`write wb:/<卡的世界书>/<条目>`，再改 `.meta.json` 设触发词；总是需要的设为 `constant`。需要随状态变化的条目用 EJS（先 `skill ejs-prompt-template`）。
5. **变量与界面（可选）**：变量规则与初始值条目（`skill mvu` 或 `skill lwb-variables`）；状态栏之类的美化写成正则（`regex:/card/<名>/`），HTML 可以先在 `run_js target=sandbox` 里验证脚本逻辑。
6. **试跑**：请用户发一条消息或重新生成；然后 `read chat:/latest`、`read var:/mvu.json`、`read page:/errors` 检查输出格式、变量更新、有没有报错，按结果回到对应步骤修改。
7. **收尾**：列出做了什么、每个文件在哪、还有哪些没验证。

## 自定义工作流

用户可以把自己的流程写成一份知识：`ws:/skills/<名字>/SKILL.md`，开头加

```
---
name: my-workflow
description: 一句话说明什么时候用
---
```

正文写步骤。下次启动后它会出现在【知识】目录里，用 `skill <名字>` 读取并照做。用户口述流程时，你可以替他写好这份文件。
