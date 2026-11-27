# 叙页 · PRD Agent

叙页是给产品经理使用的单人在线工作台。把需求文档、交互 HTML、原型画布放在同一棵文件树里，在任一文件中打开 Agent 对话，就可以围绕当前内容提问、跨文件修改，或创建一组新的交付物。Agent 基于 Pi Durable，文档使用 Tiptap，画布使用 Excalidraw。

## 本地启动

使用 Node.js 24 和 npm。在仓库根目录执行：

```sh
npm ci
npm ci --prefix server
npm run build
npm start
```

浏览器打开 [本地工作台](http://127.0.0.1:4317/)。首次启动账号为 `admin`，随机密码在 `.private/首次登录密码.txt`。首次启动前可设置 `XUYE_USERNAME` 和 `XUYE_PASSWORD`。已有账号继续使用数据库中的凭据。

前端构建产物为根目录的 `叙页产品需求工作台.html`。每次修改前端后重新运行 `npm run build`，修改服务端后重启 Node。完整的模型、存储与分享能力通过登录版使用。Linux 的 Bash 和原型截图分别需要 bubblewrap 和 Chromium，安装与托管方式见[部署说明](部署说明.md)。

## 连接模型

1. 打开**工作区设置 → 供应商管理**，列表会显示已保存的供应商、接口地址和模型数量。点击一条记录可重新编辑；点击「新增供应商」打开空白表单，填写名称、Base URL 和 API Key。Base URL 应包含供应商要求的版本前缀，例如 `https://api.example.com/v1`。远程地址使用 HTTPS，本机兼容服务也支持 loopback HTTP。
2. 点击「获取模型列表」从该地址的 `GET /models` 发现模型，或每行手动填写一个模型 ID。可测试首个模型后保存。保存后会回到供应商列表。
3. 在 Agent 输入框下方选择对话模型，在文档的 AI 补全开关旁选择补全模型。列表按 Base URL 分组，可按名称、模型 ID 或地址搜索。同名模型通过供应商区分。两处选择独立保存，下一次请求使用新选择。
4. 修改供应商时，密钥留空可沿用同一地址的凭据。更换地址时需要重新输入密钥。删除模型后，默认选择会移到仍可用的模型。

新工作区的供应商列表为空。供应商密钥用 AES-256-GCM 加密后写入工作区数据库，解密密钥在数据目录的 `master.key`。浏览器获取的是配置元数据与模型 ID。升级旧工作区时，服务按接口地址和原有凭据合并旧配置，并迁移原有模型选择。

兼容接口使用 `POST /chat/completions`。Agent 需要流式响应及工具调用能力，图片问答还需要模型支持图像输入。测试首个模型检查普通文本调用。自行设置模型输出上限时，请与实际供应商的窗口和输出限制匹配。

## 在工作台中工作

- **文档**支持图文、表格、标题目录、行级工具栏、划词与框选格式化。打开 AI 补全后，输入会触发 Markdown 续写建议。快速连按两次 Tab 可在光标处立即生成或换一版，单按 Tab 采纳，Esc 关闭。标题、列表和代码块按文档格式插入。
- **HTML** 是单文件原型。Raw Text 编辑源码并展示 Agent 提议的差异，渲染模式预览修改效果。可以逐处保留或放弃修改。
- **原型画布**支持编辑图形和连线。Agent 可以用文件路径或 ID 定位画布，修改内容可在工作台预览。
- **Agent 对话**默认携带当前文件上下文，可以粘贴图片，或点击回形针一次上传多个图片、PDF、Word、Excel 附件。在文件目录点击文件旁的引用按钮或将文件拖入对话，可将其作为当前会话的引用。外部 API 的请求地址和要求可直接写在消息中。工具执行详情可展开查看。正在处理时仍可发送消息，待发送队列显示在输入框上方。默认按发送顺序执行。点击任一条的「立即发送」会中断当前执行，保留工具记录并优先处理该条消息。其余消息保持原有顺序。若产生待采纳修改，处理后队列继续。
- **划词提问**支持文档正文和 HTML 的 Raw Text。选中文字后点击「针对选区提问」，输入框会显示选区摘要。服务端核对源文件版本和字符区间，修改建议只应用到这段选区。
- **会话**归属于发起对话的文件。同一文件可以开多个会话；从 A 修改 B 时，在 B 中审阅修改，执行记录留在 A。输入框上边缘可拖动调高，输入 Markdown 后可点击「预览」。
- **分享**通过「分享」中的开关控制。关闭立即撤销链接访问，重新开启可继续使用原链接。
- **技能**在「工作区设置 → Agent 工具与技能」管理。仓库附带可替换的 `prd-writing` 技能，指导 Agent 交付可交互 HTML 和图文 PRD。用户可导入其他技能包。

## 代码结构和二次开发

前端从 `src/main.js` 启动。文档编辑与补全在 `src/editor/`，对话在 `src/chat/`，文件目录、画布和供应商界面在 `src/workspace/`，分享评审在 `src/review/`。前后端共用的文件类型、引用和画布模型在 `shared/`。

服务端从 `server/index.mjs` 启动。Agent 循环、队列和历史在 `server/agent/`，模型请求在 `server/models/`，文件生成和修改在 `server/workspace/`，附件解析在 `server/attachments/`，任务环境和网络代理在 `server/runtime/`。

| 需要修改的行为 | 入口 |
| --- | --- |
| Agent 系统指令、文件上下文、用户消息、错误纠正和截断续写提示 | [server/agent/prompts.mjs](server/agent/prompts.mjs) 中的 `agentInstructions`、`agentInput`、`continuationInput` |
| 文档行内补全提示 | [server/models/completion.mjs](server/models/completion.mjs) 的 `completionMessages`，调用端在 [src/editor/document-completion.js](src/editor/document-completion.js) |
| 工具循环及重试、压缩策略 | [server/agent/policy.mjs](server/agent/policy.mjs) 的 `loopPolicy`，以及 [server/agent/run.mjs](server/agent/run.mjs) 的 `runAgent` |
| 模型协议、上下文窗口、输出 token 和供应商适配 | [server/agent/model.mjs](server/agent/model.mjs)；普通补全和模型发现在 [server/models/client.mjs](server/models/client.mjs) |
| 工具清单、参数与执行 | [shared/agent-catalog.mjs](shared/agent-catalog.mjs) 的描述和 [server/agent/tools.mjs](server/agent/tools.mjs) 的注册。文件与画布操作分别见 `server/workspace/create-file.mjs`、`server/workspace/canvas-tools.mjs` |
| 技能发现、导入、按需加载 | [server/skills.mjs](server/skills.mjs)、[skills/prd-writing/SKILL.md](skills/prd-writing/SKILL.md) |
| 图片、附件和临时任务目录 | `server/agent/context.mjs`、`server/attachments/attachment-parser.mjs`、`server/runtime/task-environment.mjs` |
| 会话续接、持久化记录和流式展示 | `server/agent/queue.mjs`、`src/chat/chat-queue.js`、`server/agent/conversation.mjs`、`server/agent/history.mjs`、`server/agent/stream.mjs`、`src/chat/chat-trace.js` |
| 供应商存储、选择与管理界面 | `server/models/providers.mjs`、`server/models/routes.mjs`、`src/workspace/providers.js` |
| HTTP 入口、登录和工作区版本 | `server/index.mjs`、`server/storage.mjs`、`src/service.js` |
| 编辑器、HTML、画布和工作区布局 | `src/main.js`、`src/workspace/html-source.js`、`src/workspace/board.js`、`src/shell.html`、`src/style.css` |

**修改循环。** Pi 的 `maxTurns` 默认为 `null`，工具串行执行，启用原生重试与上下文压缩。应用另有针对错误工具结果、纯文本截断和无进展续写的限制。循环策略集中在 `loopPolicy`。一次输出被截断与上下文总窗口溢出走不同的处理路径。

### 工具如何选择

| 操作对象 | 工具 | 标识和用途 |
| --- | --- | --- |
| 在线工作区 | `list_online_files`、`read_online_file`、`write_online_file`、`edit_online_file` | 使用在线文件 ID 或相对整个工作区根目录的路径，例如 `需求/原型`。从 A 开启会话也可以读写 B。读取和修改省略目标时定位 A；在 A 下创建子文件时指定 `parent_id` 为 A 的 ID。 |
| 在线画布和 PRD | `draw_online_canvas`、`embed_view_screenshots` | 按在线文件定位画布，或把配套 HTML 截图嵌入指定文档。 |
| 本次任务的文件系统 | Pi 的 `read`、`write`、`edit`、`bash` | 使用任务目录路径。用 `read` 读取附件解析文本、图片及激活技能的资料，用 `write` 和 `edit` 制作本地草稿，用 Bash 运行脚本或解析二进制原件。 |
| 草稿导入 | `import_task_file_to_workspace` | 将本次任务根目录中指定的 UTF-8 草稿提交至一个在线文档或 HTML，可指定目标 ID。 |
| 技能与会话 | `skill_load`、`install_skill`、`compact_context` | 加载技能入口、按清单安装任务内的技能包、请求 Pi 压缩上下文。 |

工作区使用数据库保存文件树。在线工具只在这棵树里解析名称和 ID；操作系统绝对路径和 `..` 会被拒绝。比如 `read_online_file({path:"需求/说明"})` 读取在线文件，而 `read({path:"upload-….txt"})` 读取本次任务的附件。用 `write({path:"draft.html",content:"…"})` 保存任务草稿后，用 `import_task_file_to_workspace({id:"A",source:"draft.html"})` 将其提交到在线文件 A。直接修改在线正文可用 `edit_online_file({id:"A",old_text:"原句",content:"新句"})`。

从 v1.0.3 迁移自定义技能时，请将 `read_file`、`write_file`、`edit_file`、`list_file`、`draw_canvas` 分别改为 `read_online_file`、`write_online_file`、`edit_online_file`、`list_online_files`、`draw_online_canvas`。已有会话的执行记录保留当时的工具名。

新增工具时，在 `shared/agent-catalog.mjs` 声明用途和分组，并在 `server/agent/tools.mjs` 注册。在线文件工具由 `server/workspace/` 实现；Pi 原生文件工具的任务路径适配在 `server/runtime/file-tools.mjs`。工具错误进入 Pi 工具结果，模型可据此修正并重试。

### 添加技能

每个技能以 `SKILL.md` 为入口，YAML frontmatter 至少包含 `name` 和 `description`。发现阶段只提供元数据。匹配后，`skill_load` 返回入口正文和基准路径。Agent 可按入口说明用 `read` 打开 `skills/<name>/references/…`，用 Bash 执行 `skills/<name>/scripts/…`。显式指定 `/skill:名称` 会随当前请求加载入口。已加载的技能包以只读方式提供，编写新技能时在任务目录下建立草稿并用 `install_skill` 保存。额外技能搜索路径通过 `XUYE_SKILL_DIRS` 配置。

## HTTP 接口

以下均相对工作台的部署前缀。写请求使用 JSON，附件上传使用文件字节。所有者接口使用登录后获得的 HttpOnly Cookie。

| 方法与路径 | 输入与返回 |
| --- | --- |
| POST `api/login`、`api/logout` | 登录字段为 `username`、`password`、可选 `remember` |
| GET / POST `api/workspace` | 获取工作区与版本，保存时发送 `{revision,data}`。其他窗口已更新时返回 409 |
| GET `api/models` | 返回 `providers` 和 `selections.agent/completion`；兼容字段 `profiles/active` 仍可读取 |
| POST `api/providers/save` | `{id?,name,base,apiKey?,models:[模型名]}`。返回更新后的目录和 `savedProviderId` |
| POST `api/providers/discover`、`api/providers/test` | `{id?,base,apiKey?}`，测试另传 `model`。分别返回模型名称列表或连通结果 |
| POST `api/providers/delete`、`api/models/switch` | 删除使用供应商 `id`；选择使用模型记录 `id` 和 `scope: "agent" / "completion"` |
| POST `api/agent` | `{mode:"chat",doc,chatId?,question,modelId?}` 或 `{mode:"complete",doc,before,modelId?}`。聊天可通过 Accept `application/x-ndjson` 接收 progress、result、error |
| POST `api/agent/queue` | 按 `doc`、`chatId` 获取队列（`list`）、追加消息（`add`）或将指定 `requestId` 移至队首（`prioritize`）。队列保存在 Pi Durable 会话文档中，出队与提交用户输入共用一次事务。 |
| POST `api/agent/pause`、GET `api/agent/history` | 以 `doc` 和 `chatId` 定位会话，暂停携带对应 `attemptId`，历史支持通过 `tool` 查询工具明细 |
| GET `api/agent-catalog`、POST `api/skills/import`、POST `api/skills/delete`、GET `api/skills/export` | 工具与技能目录、技能包导入导出 |
| POST `api/attachments?name=…` | 上传附件字节，单文件上限 20 MB |
| POST `api/share`、GET `s/{token}` | 发送 `{doc,lookup:true}` 查询状态，`{doc,enabled:true/false}` 开关链接。可指定 `file` 和 `version`。公开评审数据位于 `api/public/{token}` |

## 版本与许可证

开发使用 `chelen`，确认通过验收后将同一提交合入 `main`，在 `main` 打版本标签。当前版本为 `v1.0.3`。源码按 [Apache License 2.0](LICENSE) 发布，构建的单文件前端附带依赖的许可声明。
