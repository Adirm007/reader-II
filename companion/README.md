# Reader-II 后端伴侣

可选组件。装上并放行之后，夜梦助手可以在**你的设备**上做事：跑命令、读写文件、检索目录、开无头浏览器、启动命令类（stdio）的 MCP 服务器，以及替浏览器去取那些不允许跨域的网址。

不装它，Reader-II 的其他功能（夜梦助手、记忆、抓网页、GitHub、HTTP 类的 MCP、卡内组件）都照常工作。

只用 Node 标准库（Node 18 及以上），**不需要 `npm install`**。

## 哪些环境能用

| 环境 | 能不能用 | 怎么装 |
|---|---|---|
| 电脑上的原生酒馆 | 能 | 酒馆后端插件（下面的方法一） |
| 手机上的原生酒馆（Termux） | 能，但不强求 | 同上；无头浏览器多半没有 |
| 电脑上的 TauriTavern | 能 | TauriTavern 装不了酒馆后端插件：用独立运行（方法二） |
| 手机上的 TauriTavern | 不能 | — |

## 方法一：装成酒馆后端插件

在酒馆的根目录（有 `config.yaml` 的那个目录）里：

```bash
git clone https://github.com/Adirm007/reader-II plugins/reader-ii
```

然后把 `config.yaml` 里的 `enableServerPlugins` 改成 `true`，重启酒馆。

Termux 上是同样的两步；一条命令的写法：

```bash
cd ~/SillyTavern && git clone https://github.com/Adirm007/reader-II plugins/reader-ii && sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' config.yaml
```

也可以不克隆整个仓库，只把 `companion/` 这个目录拷成 `plugins/reader-ii-companion/`。

酒馆启动时，控制台里会出现两行：

```
[Reader-II 伴侣] 已启动（酒馆后端插件），版本 …
[Reader-II 伴侣] 管理页（在这台设备的浏览器里打开；放行「设备全权」要在这里点）：http://127.0.0.1:8790/#key=…
```

## 方法二：独立运行

```bash
node companion/standalone.mjs            # 默认端口 8790，只听本机
node companion/standalone.mjs --port 8791
```

然后在夜梦助手的「设置 → 后端伴侣」里，把「伴侣地址」填成 `http://127.0.0.1:8790`。

## 放行

1. 夜梦助手的「设置」里把权限档位调到「设备全权」并保存。
2. 「设置 → 后端伴侣」点「检测」，再点「申请放行」。面板上会出现一个 4 位**配对码**。
3. 在**装着伴侣的那台设备**上，用浏览器打开控制台里打印的管理页地址（带 `#key=…` 的那个；同一个地址也写在数据目录的 `admin-url.txt` 里）。
4. 核对管理页上的配对码、来源与面板上的一致，选一个期限：**放行 2 小时** / **放行到伴侣重启** / **长期放行**。

之后助手在设备上的每一步，仍然按她自己的权限设置请你确认（命令算危险操作，默认每条都问）。管理页上可以随时撤销，也能看到最近做过的操作。

## 安全模型：为什么要绕到另一个页面去点

酒馆页面里除了夜梦助手，还跑着别的扩展和角色卡自带的脚本。它们与助手**同源**：助手能发的请求，它们也能发；助手存在页面里的任何东西，它们也读得到。所以「页面知道一个密码」拦不住它们。

伴侣的做法是把「同意」这一步放到页面脚本够不着的地方：

- 管理页在**另一个端口**上（另一个源）。酒馆页面里的脚本读不到它的内容，也没法替你点按钮。
- 管理页的接口要**管理密钥**（只在控制台输出与本机磁盘上），要求自定义请求头，只认发给本机地址的请求，不给任何跨源许可，也不允许被嵌进别的页面。
- 放行有**期限**。到期、被撤销、或伴侣重启（选了「到伴侣重启」时）之后，页面手里的令牌就失效了。
- 操作接口还会核对请求的来源与放行时记下的一致。

需要你清楚的一点：**放行期间，那个酒馆页面（连同里面装的所有扩展与角色卡脚本）等同于拿到了这台设备。** 所以：

- 只在确实要让助手做设备上的事时放行，用完可以在管理页上撤销；
- 「长期放行」只适合你信得过这个酒馆里装的所有东西的情况；
- 来路不明的角色卡，不要在放行期间导入并启用它带的脚本。

管理页上还有三个限制：关掉命令执行、关掉无头浏览器、把文件访问限定在几个目录里。注意只要还允许运行命令，命令本身不受目录限制。

## 数据放在哪

`~/.reader-ii-companion/`（可用环境变量 `READER_II_COMPANION_HOME` 改）：

| 文件 | 内容 |
|---|---|
| `config.json` | 管理页端口、三个限制 |
| `admin.key`、`admin-url.txt` | 管理密钥与带密钥的管理页地址 |
| `grants.json` | 有期限与长期的放行（只存令牌的哈希） |
| `audit.log` | 操作记录 |
| `workspace/` | 伴侣的工作目录（`dev:/@ws/`）：命令的默认目录、截图 |

更新伴侣（`git pull`）不会动这个目录。这个目录本身不能经文件接口读写（`workspace/` 除外）。

## 提供的操作（给开发者）

接口：`GET /status`、`POST /pair`、`GET /pair/<id>`、`POST /release`、`POST /op/<名字>`（要 `X-Reader-II-Token`）。

| 操作 | 作用 |
|---|---|
| `env` | 系统、Node、常用工具的版本与安装命令 |
| `exec` / `job` | 运行命令（超时转后台）；查看、读取输出、停掉任务 |
| `fs_list` `fs_read` `fs_write` `fs_remove` `fs_grep` | 文件：列目录、读、写（原文件是 CRLF 时写回 CRLF）、删、在设备上检索 |
| `http` | 代发 HTTP 请求（没有跨域限制；MCP 的流式回应拿到结果就返回） |
| `browser` | 无头浏览器：`open` `text` `eval` `click` `type` `console` `screenshot` `close` |
| `mcp_start` `mcp_send` `mcp_stop` | 启动命令类的 MCP 服务器并转发 JSON-RPC |

源码：`core.mjs`（放行、接口、管理页的服务端）、`ops.mjs`（各操作）、`browser.mjs`（调试协议走管道，不开调试端口）、`mcp-stdio.mjs`、`admin.mjs`（管理页）、`index.mjs`（酒馆插件入口）、`standalone.mjs`（独立运行）。

测试：`node --test tests/companion.test.mjs`。
