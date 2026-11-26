# 叙页 · PRD Agent

叙页是给产品经理使用的单人在线工作台。把需求文档、交互 HTML、原型画布放在同一棵文件树里，在任一文件中打开 Agent 对话，就可以围绕当前内容提问、跨文件修改，或创建一组新的交付物。Agent 基于 Pi Durable，文档使用 Tiptap，画布使用 Excalidraw。

## 本地启动

使用 Node.js 24 和 npm。在仓库根目录执行：

```sh
npm ci
npm ci --prefix server
npm run build
npm test
npm start
```

浏览器打开 [本地工作台](http://127.0.0.1:4317/)。首次启动账号为 `admin`，随机密码在 `.private/首次登录密码.txt`。首次启动前可设置 `XUYE_USERNAME` 和 `XUYE_PASSWORD`。已有账号继续使用数据库中的凭据。

前端构建产物为根目录的 `叙页产品需求工作台.html`。每次修改前端后重新运行 `npm run build`，修改服务端后重启 Node。完整的模型、存储与分享能力通过登录版使用。Linux 的 Bash 和原型截图分别需要 bubblewrap 和 Chromium，安装与托管方式见[部署说明](部署说明.md)。

## 连接模型

1. 打开**工作区设置 → 供应商管理**，选「新增供应商」，填写名称、Base URL 和 API Key。Base URL 应包含供应商要求的版本前缀，例如 `https://api.example.com/v1`。远程地址使用 HTTPS，本机兼容服务也支持 loopback HTTP。
2. 点击「获取模型列表」从该地址的 `GET /models` 发现模型，或每行手动填写一个模型 ID。可测试首个模型后保存。
3. 在 Agent 输入框下方选择对话模型，在文档的 AI 补全开关旁选择补全模型。列表按 Base URL 分组，可按名称、模型 ID 或地址搜索。同名模型通过供应商区分。两处选择独立保存，下一次请求使用新选择。
4. 修改供应商时，密钥留空可沿用同一地址的凭据。更换地址时需要重新输入密钥。删除模型后，默认选择会移到仍可用的模型。

新工作区的供应商列表为空。供应商密钥用 AES-256-GCM 加密后写入工作区数据库，解密密钥在数据目录的 `master.key`。浏览器获取的是配置元数据与模型 ID。升级旧工作区时，服务按接口地址和原有凭据合并旧配置，并迁移原有模型选择。

兼容接口使用 `POST /chat/completions`。Agent 需要流式响应及工具调用能力，图片问答还需要模型支持图像输入。测试首个模型检查普通文本调用。自行设置模型输出上限时，请与实际供应商的窗口和输出限制匹配。

## 在工作台中工作

- **文档**支持图文、表格、标题目录、行级工具栏、划词与框选格式化。打开 AI 补全后，在文档中输入可得到续写建议。
- **HTML** 是单文件原型。Raw Text 编辑源码并展示 Agent 提议的差异，渲染模式预览修改效果。可以逐处保留或放弃修改。
- **原型画布**支持编辑图形和连线。Agent 可以用文件路径或 ID 定位画布，修改内容可在工作台预览。
- **Agent 对话**默认携带当前文件上下文，可以引用图片，上传 PDF、Word、Excel 等附件。工具执行详情可展开查看。处理过程中可以暂停，在同一会话中继续。
- **技能**在「工作区设置 → Agent 工具与技能」管理。仓库附带可替换的 `prd-writing` 技能，指导 Agent 交付可交互 HTML 和图文 PRD。用户可导入其他技能包。

## 代码结构和二次开发

| 需要修改的行为 | 入口 |
| --- | --- |
| Agent 系统指令、文件上下文、用户消息、错误纠正和截断续写提示 | [server/agent/prompts.mjs](server/agent/prompts.mjs) 中的 `agentInstructions`、`agentInput`、`continuationInput` |
| 文档行内补全提示 | 同一模块的 `completionMessages`，调用端在 [src/main.js](src/main.js) |
| 工具循环及重试、压缩策略 | [server/agent/policy.mjs](server/agent/policy.mjs) 的 `loopPolicy`，以及 [server/agent.mjs](server/agent.mjs) 的 `runAgent` |
| 模型协议、上下文窗口、输出 token 和供应商适配 | [server/agent/model.mjs](server/agent/model.mjs)；普通补全和模型发现在 [server/models/client.mjs](server/models/client.mjs) |
| 工具清单、参数与执行 | [src/agent-catalog.mjs](src/agent-catalog.mjs) 的描述和 [server/agent/tools.mjs](server/agent/tools.mjs) 的注册。文件与画布操作分别见 `server/create-file.mjs`、`server/canvas-tools.mjs` |
| 技能发现、导入、按需加载 | [server/skills.mjs](server/skills.mjs)、[skills/prd-writing/SKILL.md](skills/prd-writing/SKILL.md) |
| 图片、附件和临时任务目录 | `server/agent/context.mjs`、`server/attachment-parser.mjs`、`server/task-environment.mjs` |
| 会话续接、持久化记录和流式展示 | `server/agent/conversation.mjs`、`server/agent-history.mjs`、`server/agent-stream.mjs`、`src/chat-trace.js` |
| 供应商存储、选择与管理界面 | `server/models/providers.mjs`、`server/models/routes.mjs`、`src/providers.js` |
| HTTP 入口、登录和工作区版本 | `server/index.mjs`、`server/storage.mjs`、`src/service.js` |
| 编辑器、HTML、画布和工作区布局 | `src/main.js`、`src/html-source.js`、`src/board.js`、`src/shell.html`、`src/style.css` |

**修改循环。** Pi 的 `maxTurns` 默认为 `null`，工具串行执行，启用原生重试与上下文压缩。应用另有针对错误工具结果、纯文本截断和无进展续写的限制。需要改变这些行为时，先调整 `loopPolicy`，再用 `server/tests/agent-continuation.test.mjs` 中的模拟流验证中断、恢复与重复写入。一次输出被截断与上下文总窗口溢出走不同的处理路径。

**增加工具。** 将模型可读的用途加入 `toolDescriptions`，在 `createAgentTools` 中声明 schema 并实现执行结果。文件修改通过现有工作区文件接口登记，确保预览、审阅和目标路径一致。工具错误通过 Pi 的工具结果反馈给模型。当前工具包括 `list_file`、`read_file`、`write_file`、`edit_file`、`draw_canvas`、`bash`、`skill_load`、`read_resource`、`embed_view_screenshots` 和 `compact_context`。最后一项由应用封装，调用 Pi 原生压缩机制。Bash 工具在任务专属目录内执行。

**增加技能。** 每个技能一个目录，入口为 `SKILL.md`，YAML frontmatter 至少包含 `name` 和 `description`，参考资料可放入同包的 `references/`。发现阶段向模型提供元数据，匹配后由 `skill_load` 加载正文，`read_resource` 读取包内资源，也可在对话中显式指定 `/skill:名称`。额外文件系统搜索路径可通过 `XUYE_SKILL_DIRS` 配置。

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
| POST `api/agent/pause`、GET `api/agent/history` | 以 `doc` 和 `chatId` 定位会话，暂停携带对应 `attemptId`，历史支持通过 `tool` 查询工具明细 |
| GET `api/agent-catalog`、POST `api/skills/import`、POST `api/skills/delete`、GET `api/skills/export` | 工具与技能目录、技能包导入导出 |
| POST `api/attachments?name=…` | 上传附件字节，单文件上限 20 MB |
| POST `api/share`、GET `s/{token}` | 创建分享及打开公开评审，相关公开接口位于 `api/public/{token}` |

## 版本与许可证

开发使用 `chelen`，确认通过验收后将同一提交合入 `main`，在 `main` 打版本标签。首个发行版本为 `v1.0.0`。源码按 [Apache License 2.0](LICENSE) 发布，构建的单文件前端附带依赖的许可声明。
