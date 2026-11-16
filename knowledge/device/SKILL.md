---
name: device
description: 在设备上做事（要后端伴侣）：dev:/ 文件、跑命令与后台任务、装依赖、无头浏览器、给酒馆写扩展的流程
---
# 在设备上做事

## 前提

三件事都满足才行，缺哪件工具会直接告诉你，照实转告用户即可，不要换办法硬做：

1. 装了后端伴侣（酒馆后端插件，或独立运行）。TauriTavern 装不了插件，只能独立运行；手机上不强求。
2. 用户在「设置 → 后端伴侣」里申请了放行，并在设备本机的管理页上批准（有期限，会过期）。
3. 权限档位是「设备全权」。

【当前环境】里有一行「后端伴侣：已连接并放行」才算就绪。

## 设备上的文件：`dev:/`

核心工具直接可用，和别的挂载点一样：`ls` 看目录、`grep` 定位、`read` 分段读、`edit` 精确替换、`write` 新建。

- `dev:/~/…` 用户目录；`dev:/@ws/…` 伴侣的工作目录（草稿、克隆下来的仓库放这里）。
- 绝对路径：Windows 写 `dev:/C:/Users/…`，其他系统写 `dev:/home/…`、`dev:/data/data/com.termux/files/home/…`。`ls dev:/` 能看到有哪些盘与根目录。
- 检索是在设备上做的，自动跳过 `.git`、`node_modules` 这类目录；范围太大时会提示你缩小。
- 读到的换行统一是 `\n`；原文件是 Windows 换行（CRLF）时，写回去会自动还原，你不用管。
- 文件的改动有记录，用户可以按轮撤销。删除只能删文件与空目录；删整个目录要用命令，先跟用户确认。
- 二进制文件读不了，会得到一句说明；需要处理就用命令。

## 命令：`device_exec`

打开 `device` 工具箱。动手之前先 `device_env` 看一眼系统与工具。

- 命令是**非交互**的：不能等人输入。带确认的命令加 `-y` 之类的参数；要密码的（`sudo`）你做不了，请用户自己在终端里跑。
- Windows 上默认是 cmd（`shell=powershell` 可换），其他系统是 sh。写命令前先看 `device_env` 里的 `platform`，不要想当然。
- `cwd` 可以是 `dev:/…` 路径；不写就是伴侣的工作目录。
- 超过 `timeout`（默认 60 秒）还没结束会转成后台任务并返回任务号。明知道要跑很久（装依赖、起开发服务器）就直接 `background=true`，然后用 `device_job action=log id=…` 看输出、`action=status` 看是否结束、`action=kill` 停掉。
- 命令**撤销不了**。每条命令都会请用户确认；删除、覆盖、改系统设置这类命令，先用一句话说清要做什么、会影响什么。
- 只在用户交代的范围里活动。不要顺手清理、升级、改别的东西。

## 装依赖

`device_env` 的结果里：`tools` 是已有的工具与版本，`missing` 是缺的（各自的用途与安装命令），`packageManager` 是这台设备的包管理器。

1. 先把缺什么、各自做什么用告诉用户，问清要不要装、装哪些。
2. 用 `missing` 里给的命令装，`background=true`；装完 `device_env refresh=true` 复查。
3. 带 `sudo` 的命令请用户自己跑；Windows 上没有 winget 时请用户去官网下载。
4. 装不上就如实说明卡在哪一步，把输出里的关键几行给用户看。

## git

设备上有 git 时用它（克隆到 `dev:/@ws/`、提交、推送）。推送要用户在设备上配好凭据；没配的话，改用 `web` 工具箱的 `github_push`（只要令牌，见知识 web-github）。

## 无头浏览器：`device_browser`

用来试你做的页面，或看要跑脚本才出内容的网页。它用的是设备上的 Chrome / Chromium / Edge，独立的临时资料目录，不碰用户自己的浏览器。

```
device_browser action=open url=http://127.0.0.1:5173
device_browser action=text                  （取整页文字；selector=… 只取一部分）
device_browser action=console               （看报错）
device_browser action=eval code=return document.querySelectorAll('.card').length
device_browser action=click selector=#save
device_browser action=type selector=#name text=夜梦
device_browser action=screenshot            （存进 dev:/@ws/screenshots/，你看不到图，是给用户看的）
device_browser action=close
```

改完前端之后的检查顺序：`open` → `console` 没有报错 → `text` / `eval` 确认内容对 → 必要时 `click` / `type` 走一遍操作。没有找到浏览器时如实说明。

## 给酒馆写一个扩展

1. 读知识 tavern-anatomy；参考别人的写法就用 `gh:/` 读几个现成的扩展（见知识 web-github）。
2. 在工作区或 `dev:/@ws/<名字>/` 里写：`manifest.json`（`display_name`、`js`、`css`、`version`、`author`）与入口脚本。
3. 试装：酒馆的第三方扩展目录是 `<酒馆>/data/<用户>/extensions/<名字>/`（旧版在 `<酒馆>/public/scripts/extensions/third-party/`）。把文件写进去，请用户刷新酒馆页面。
4. 看现场：`page:/errors` 有没有新的报错；`run_js target=page` 检查扩展挂出来的对象。
5. 没问题后推到 GitHub（`github_push` 或 git），用户就能用链接安装、以后也能更新。

不要直接改 Reader-II 自己的扩展目录：更新时会被冲掉。要扩展夜梦助手，另写一个扩展，用 `window.ReaderII.agent.registerTool` 等接口（开发者指南在 `gh:/Adirm007/reader-II/docs/开发者指南.md`）。
