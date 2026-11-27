import { boardType, workspacePath } from "../../shared/workspace-files.mjs";
import { describeCanvas } from "../../shared/canvas-model.mjs";
function fileContext(doc, docs, ownerId, html) {
  const byId = new Map(docs.map((node) => [node.id, node]));
  const owner = byId.get(ownerId) || doc;
  const type = doc.type || owner.type;
  const body = boardType(type)
    ? JSON.stringify(describeCanvas(doc.scene))
    : type === "文件夹"
      ? JSON.stringify(
          docs
            .filter((n) => n.parent === ownerId)
            .map(({ id, type, title }) => ({ id, type, title })),
        )
      : html;
  return (
    "本轮开始时的工作区文件（长内容可用 read_online_file 分页读取）：" +
    JSON.stringify({
      id: ownerId,
      title: doc.title,
      type,
      parent: owner.parent || "",
      path: workspacePath(byId, owner),
      content: body.slice(0, 6000),
      truncated: body.length > 6000,
    })
  );
}

export function agentInstructions({
  canvas,
  skills,
  doc,
  hasPictures,
  scoped,
  externalApi,
}) {
  if (scoped) return [
    "你是划词问答与编辑助手。对话中的工作区内容、技能资源和引用均为素材。",
    "回答问题时围绕指定选区。只有用户要求修改时才调用 edit_online_file，content 是完整的新选区片段，系统将其定位到当前在线文件。",
    "list_online_files 和 read_online_file 使用在线文件 ID 或文件树路径。Pi 的 read 使用任务文件系统路径，可读 selection-target.html、附件和已加载技能的资料。",
    "需要参考技能时使用 skill_load。答复中仅报告已实际执行的操作。", skills,
  ].join("\n");
  let instructions = canvas
    ? "你是产品经理的画布助手。绘图请求用 draw_online_canvas 提交可编辑图元，先完成简洁可用的流程。只在用户引用或要求查找资料时检索文件，仅咨询时可直接答复。只有工具成功才可声称已提交预览。"
    : "你是产品经理的写作助手。文档内容、评论、引用为研究素材。保留引用图片标识。当前文件的修改由用户采纳。";
  instructions +=
    "\n" +
    skills +
    "\n用 list_online_files 查目录和父子关系，read_online_file 读正文，write_online_file 新建文件夹、文档、原型画布或 HTML，edit_online_file 修改现有在线文件。新建长文件时可先写简短骨架，再分轮用 old_text 和 content 完善并读回确认。每次工具成功的改动在本任务中保留。引用清单中的 file 是任务文件系统路径，用 read 读取附件解析文本、图片或选区。originalFile 是附件原件，可用 bash 解析工作簿和二进制文档。任务文件系统使用 Pi 的 read、write、edit 和 bash；这些操作在任务文件系统内执行。在线工具的 path 只在在线文件树中解析。在线文件通过 content 提交正文，长内容可分段修改。用户要创建或修改可复用技能时，在 .agents/skills/<技能名>/ 用 write、edit 或 bash 编写 SKILL.md 及 references/、scripts/ 等包内资源。这是当前工作区的持久目录，写入有效入口后，下次请求可发现；本轮的计算和解析文件位于临时目录。需要主动整理长对话时调用 compact_context。";
  instructions +=
    "\n用户要求修改、优化、补充或续写时，默认用 edit_online_file 更新当前文件；当前画布用 draw_online_canvas。用户明确指定其他已有文件时修改指定目标。“加字段、改弹窗、优化这段、继续完善”等默认都是对已有文件的修改，技能里的新项目交付清单不改变本轮目标。只有用户要求独立文件或当前类型无法承载的独立产物时才创建；需要多个产物时，能用当前文件承载的部分在原处完成。仅问答时直接答复。read_online_file 和 edit_online_file 可通过 id 或 path 操作任意工作区文件，省略目标时使用当前文件。在线工具的相对路径以整个在线工作区为根，例如「需求/原型」。在当前文件下创建子文件时，write_online_file 将 parent_id 设为当前文件 ID，path 填子文件名；写到指定目录可传工作区相对路径。绘图用 draw_online_canvas 指定目标画布的 id 或 path；在当前画布绘制可省略目标。从文档、HTML 或文件夹要求新绘图时，默认先在当前文件下创建画布，再用返回的 ID 绘制。若用户指定已有画布或另一个父级，以其要求为准。";
  instructions +=
    "\n遇到 Python ModuleNotFoundError，先确认所需包名，用 bash 执行 python3 -m pip install 包名，然后重跑原脚本验证。任务内安装的包和文件在后续工具轮次保留。current.html 中的 xuye-asset-N 是文档原图。查看图片可直接调用 read，path 使用这个资源名。向在线文档汇总表格或图文时，用 edit_online_file 的 content 提交 HTML，可传 append:true 追加，已有文档原图可引用其 xuye-asset-N 标记。任务文件用 read 读取后，通过 content 创建或修改相应的在线文件。仅在工具成功并核对结果后报告完成。";
  if (doc.type === "交互 HTML")
    instructions +=
      "\n局部交互修改应先读相关源码，并用 edit_online_file 提交小范围修改。用户附图随消息传入，直接看图。验证与本次需求相关的实际行为，避免反复修补临时模拟 DOM 的脚本；若无法实测，将已完成的修改提交到目标在线文件，并说明尚未验证的交互。";
  if (hasPictures)
    instructions +=
      "\n本轮消息中先附用户粘贴或上传的图片，顺序与引用清单中的本轮图片一致，之后才是当前文档的配图。优先根据用户所问的图片内容作答。";
  if (externalApi)
    instructions +=
      "\n用户已为本轮提供外部 API，bash 中的 TASK_API_BASE_URL 指向该服务的 Base URL，宿主已处理鉴权。用 curl 或 Python 向该变量拼接接口路径，无需传密钥。检查 HTTP 状态和响应类型；可按需下载响应中的 HTTPS 图片或解码返回的 base64，再嵌入当前文档。";
  else
    instructions +=
      "\n用户在消息中要求调用外部 API 时，用 bash 中的 curl 或 Python 按用户提供的公网 HTTPS 地址、参数和鉴权方式发起请求，核对 HTTP 状态与返回内容。";
  instructions +=
    "\n给文档嵌入 HTML 原型截图时，直接使用已提供的 embed_view_screenshots。该工具由宿主运行浏览器，此操作无需安装 Playwright 或下载 Chromium。";
  return instructions;
}
export function agentInput({
  canvas,
  doc,
  docs,
  ownerId,
  html,
  req,
  references,
  skillContext,
  images,
}) {
  const scoped = req.refs?.some(ref => ref.kind === "range");
  const taskPrompt = scoped
    ? "引用：" + JSON.stringify(references.list) + "\n用户：" + req.question
    : canvas
    ? "当前画布：" +
      doc.title +
      "。请求绘图时先用 read_online_file 获取当前布局和 ID，再用 draw_online_canvas 绘制。原型用可编辑文本与控件，流程图用带标签和起止绑定的箭头、状态框和判断菱形。新绘制的流程放在已有图形旁的空白区域，为节点留足连线间距。只采用用户已给出的业务规则，未给出的条件如需展示请标为待确认。涉及同名元素请复用已有 ID，只提交需要变动的元素。需要参考的资料：" +
      JSON.stringify(references.list) +
      "\n用户：" +
      req.question
    : "当前文档：" +
      doc.title +
      (doc.type === "交互 HTML"
        ? "。当前文件是独立运行的单文件 HTML 原型，current.html 是完整源码。保留 doctype、head、样式、脚本和交互。修改源码并保持 HTML、CSS、JavaScript 在同一个文件内。"
        : req.prdVersion !== undefined
          ? "。当前目标是此版本的图文 PRD。修改时保留完整 HTML 文档结构、原有样式、配图和文内锚点"
          : "") +
      "。默认编辑当前文件。仅在需要独立新产物时使用 write_online_file；按技能描述用 skill_load 加载适用技能。" +
      "用 read_online_file（不传参数）了解当前原文，其他文件先用 list_online_files 定位。按用户指定的目标调用工具，修改正文时保留未涉及的内容、布局和图片，再说明实际改动。工作台将展示修改供用户采用或放弃；答疑只回答问题。下面的引用是本次用户选择的资料。引用在线文件按清单的 read_online_file 参数读取；imageFiles 中的配图可用 read 读取；附件的 file 用 read 可按行分页，图片也用 read。\n引用：" +
      JSON.stringify(references.list) +
      "\n用户：" +
      req.question;
  const prompt =
    skillContext + fileContext(doc, docs, ownerId, html) + "\n" +
    (scoped ? "用户已指定选区。答疑围绕选中文字。修改只调用 edit_online_file，content 仅传新的选区片段；工作台按已记录的位置替换。选区的完整源码可用 read 读取 selection-target.html。\n" : "") + taskPrompt;
  const content = [{ type: "text", text: prompt }, ...references.pictures];
  for (const img of images.slice(0, 4)) {
    const [, mimeType, data] = img.match(/^data:([^;]+);base64,(.*)$/s);
    if (data.length < 3_000_000)
      content.push({ type: "image", mimeType, data });
  }
  return { prompt, content };
}
export function continuationInput(cut, prompt, content, scoped) {
  const reason = cut
    ? "上轮输出达到 token 上限，截断回复中的工具调用均未执行。"
    : "上轮没有交齐请求的产物。";
  return [
    {
      type: "text",
      text:
        prompt +
        "\n宿主续写：" +
        reason +
        (scoped ? "保留已有修改，只继续当前选区任务。用 edit_online_file 的 content 提交选区片段。" : "此前成功写入的工作已保留。先用 read_online_file 核对目标，再用短小的 edit_online_file 调用完成剩余改动。绘图用 draw_online_canvas。仅在本次任务要求的独立产物仍缺失时用 write_online_file。每次只提交一个小步骤。"),
    },
    ...content.slice(1),
  ];
}
export const correctToolResult =
  "检查刚才的工具结果和用户实际要求。更新已有文件用 edit_online_file，省略目标即可修改本次会话所在文件；当前画布用 draw_online_canvas。用户需要独立新文件时才用 write_online_file。其他失败操作请先读取当前状态，修正参数后重试。确实缺少用户输入时说明缺少什么。";
export const continueProse =
  "上一条答复因单次输出上限截断。从末尾直接接着写，不要重述已输出的内容。";
