---
name: card-workflow
description: 制卡工作流：从设定到角色卡、世界书、开场白、变量系统，再在当前酒馆里试跑验证
---
# 制卡工作流

用 `todo` 列出下面的步骤逐步推进，每完成一个阶段先和用户确认再进入下一步：

1. **明确需求**：确定题材与基调、主要角色、玩家身份、是否需要变量系统（MVU / 小白X 2.0 / 小白X 3.0 / 纯文字）以及是否需要前端美化。把需求草稿写入 `ws:/drafts/<卡名>/brief.md`。
2. **撰写设定稿**：整理角色（外貌、性格、说话方式、能力）、世界观、关键地点与势力。先落盘到 `ws:/drafts/<卡名>/`，待用户确认后再写入角色卡。
3. **写入角色卡主体**：将常驻核心信息写入 `card:/description.md`、`scenario.md`、`first_mes.md` 与 `greetings/`，扩展设定拆分到世界书。
4. **构建世界书**：按人物、地点、规则拆分条目，用 `write wb:/<书名>/<条目>` 创建并在 `.meta.json` 配置触发词与位置（常驻设为 `constant`）。需要随状态动态展开的条目先读 `skill ejs-prompt-template`，写完后用 `ejs_check_syntax` 检查语法。
5. **变量与界面（按需）**：
   - MVU / MVUzod：读 `skill mvu`，配齐 `[InitVar]`、Zod 4 Schema 脚本、`[mvu_update]`、变量列表与隐藏正则，并用 `mvu_test_update` 试跑更新命令。
   - 小白X 2.0 / 3.0：读 `skill lwb-variables`，3.0 规则包草案用 `lwb_v3_check_draft` 校验并试算开局与关键动作。
   - 状态栏等前端美化：写入 `regex:/card/<名>/`，纯逻辑先在 `run_js target=sandbox` 中验证。
6. **试跑与回归**：请用户发一条消息或重新生成，然后查看 `chat:/latest`、`var:/mvu.json`（或 `lwb_v3_inspect`）、`page:/errors`，按结果定位修复。
7. **交付清单**：列出改动摘要、文件路径与仍需玩家实测的项目。

## 自定义工作流

可将常用流程保存为工作区知识 `ws:/skills/<名字>/SKILL.md`：

```markdown
---
name: my-workflow
description: 一句话说明适用场景
---
正文写具体步骤。
```

保存后下次启动会自动出现在【知识】目录中，用 `skill <名字>` 按需读取。
