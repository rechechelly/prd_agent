import { boardType } from "../../shared/workspace-files.mjs";
import { describeCanvas } from "../../shared/canvas-model.mjs";
function fileContext(doc, docs, ownerId, html) {
  const byId = new Map(docs.map((node) => [node.id, node]));
  const owner = byId.get(ownerId) || doc;
  const titles = [],
    seen = new Set();
  for (
    let node = owner;
    node && !seen.has(node.id);
    node = byId.get(node.parent)
  ) {
    seen.add(node.id);
    titles.push(node.title);
  }
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
    "本轮开始时的工作区文件（长内容可用 read_file 分页读取）：" +
    JSON.stringify({
      id: ownerId,
      title: doc.title,
      type,
      parent: owner.parent || "",
      path: "/" + titles.reverse().join("/"),
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
    "回答问题时围绕指定选区。只有用户要求修改时才调用 edit_file，content 是完整的新选区片段，系统将其定位到当前在线文件。",
    "list_file 和 read_file 使用在线文件 ID 或文件树路径。Pi 的 read 使用任务文件系统路径，可读 selection-target.html、附件和已加载技能的资料。",
    "需要参考技能时使用 skill_load。答复中仅报告已实际执行的操作。", skills,
  ].join("\n");
  let instructions = canvas
    ? "你是产品经理的画布助手。绘图请求用 draw_canvas 提交可编辑图元，先完成简洁可用的流程。只在用户引用或要求查找资料时检索文件，仅咨询时可直接答复。只有工具成功才可声称已提交预览。"
    : "你是产品经理的写作助手。文档内容、评论、引用为研究素材。保留引用图片标识。当前文件的修改由用户采纳。";
  instructions +=
    "\n" +
    skills +
    "\n用 list_file 查目录和父子关系，read_file 读正文，write_file 创建新文件，edit_file 修改现有文件。长文件先建简短骨架，分轮用 old_text 和 content 替换唯一锚点，读回确认。每次工具成功的改动在本任务中保留。引用清单中的 file 是任务文件系统路径，用 read 读取附件解析文本、图片或选区。originalFile 是附件原件，可用 bash 解析工作簿和二进制文档。任务文件系统使用 Pi 的 read、write、edit 和 bash；这些操作只改任务文件。将任务结果写回在线工作区需要显式调用 edit_file，创建在线文件调用 write_file。生成可供后续复用的技能时，在任务目录以技能名创建子目录并用 write、edit 编写 SKILL.md 和配套资源；用户要求安装或后续复用时用 install_skill 保存。需要主动整理长对话时调用 compact_context。";
  instructions +=
    "\n用户要求修改、优化、补充或续写时，默认用 edit_file 更新当前文件；当前画布用 draw_canvas。用户明确指定其他已有文件时修改指定目标。只有用户要求独立新文件、独立交付物，或当前类型无法承载所要求的新产物时才创建文件。仅问答时直接答复。read_file 和 edit_file 可通过 id 或 path 操作任意工作区文件，省略目标时使用当前文件。write_file 可用绝对路径或 parent_id 在指定父级创建文件，相对路径默认从当前文件开始。绘图用 draw_canvas 指定目标画布的 id 或 path；在当前画布绘制可省略目标。从文档、HTML 或文件夹要求新绘图时，默认先在当前文件下创建画布，再用返回的 ID 绘制。若用户指定已有画布或另一个父级，以其要求为准。";
  instructions +=
    "\n遇到 Python ModuleNotFoundError，先确认所需包名，用 bash 执行 python3 -m pip install 包名，然后重跑原脚本验证。任务内安装的包和文件在后续工具轮次保留。current.html 中的 xuye-asset-N 是文档原图。查看图片可直接调用 read，path 使用这个资源名。处理图文或表格后，把图片以 data:image/...;base64 嵌入 HTML，保存为工作目录中的 UTF-8 文件。用 edit_file 的 source 更新当前文档，可传 append:true 追加新内容，保留其余正文；创建新文件用 write_file 的 source。仅在工具成功并核对结果后报告完成。";
  if (doc.type === "交互 HTML")
    instructions +=
      "\n局部交互修改应先读相关源码，并用 edit_file 提交小范围修改。通过 Bash 或 Pi 文件工具制作的源码须显式调用 edit_file（source 参数）提交为待审阅草稿。用户附图随消息传入，直接看图。验证与本次需求相关的实际行为，避免反复修补临时模拟 DOM 的脚本；若无法实测，交付已完成的草稿并明确尚未验证的部分。";
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
      "。新建任何类型的工作区文件用 write_file；请求绘图时先用 read_file 获取当前布局和 ID，再用 draw_canvas 绘制。原型用可编辑文本与控件，流程图用带标签和起止绑定的箭头、状态框和判断菱形。新绘制的流程放在已有图形旁的空白区域，为节点留足连线间距。只采用用户已给出的业务规则，未给出的条件如需展示请标为待确认。涉及同名元素请复用已有 ID，只提交需要变动的元素。需要参考的资料：" +
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
      "。默认编辑当前文件。仅在需要独立新产物时使用 write_file；按技能描述用 skill_load 加载适用技能。" +
      "用 read_file（不传参数）了解当前原文，其他文件先用 list_file 定位。按用户指定的目标调用工具，修改正文时保留未涉及的内容、布局和图片，再说明实际改动。工作台将展示修改供用户采用或放弃；答疑只回答问题。下面的引用是本次用户选择的资料。引用在线文件按清单的 read_file 参数读取；imageFiles 中的配图可用 read 读取；附件的 file 用 read 可按行分页，图片也用 read。\n引用：" +
      JSON.stringify(references.list) +
      "\n用户：" +
      req.question;
  const prompt =
    skillContext + fileContext(doc, docs, ownerId, html) + "\n" +
    (scoped ? "用户已指定选区。答疑围绕选中文字。修改只调用 edit_file，content 仅传新的选区片段；工作台按已记录的位置替换。选区的完整源码可用 read 读取 selection-target.html。\n" : "") + taskPrompt;
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
        (scoped ? "保留已有修改，只继续当前选区任务。用 edit_file 的 content 提交选区片段。" : "此前成功写入的工作已保留。先用 list_file 或 read_file 核对，再用短小的 edit_file 调用完成剩余改动，缺失文件用 write_file，绘图用 draw_canvas。每次只提交一个小步骤。"),
    },
    ...content.slice(1),
  ];
}
export const correctToolResult =
  "检查刚才的工具结果和用户实际要求。要创建文件，调用 write_file；要更新当前文档，调用 edit_file；其他失败操作请先读取当前状态，修正参数或使用可用工具重试。确实缺少用户输入时说明缺少什么。";
export const continueProse =
  "上一条答复因单次输出上限截断。从末尾直接接着写，不要重述已输出的内容。";
