import { boardType, workspacePath } from "../../shared/workspace-files.mjs";
import { describeCanvas } from "../../shared/canvas-model.mjs";
function fileContext(doc, docs, html) {
  const byId = new Map(docs.map((node) => [node.id, node]));
  const owner = byId.get(doc.id) || doc;
  const type = doc.type || owner.type;
  const body = boardType(type)
    ? JSON.stringify(describeCanvas(doc.scene))
    : type === "文件夹"
      ? JSON.stringify(
          docs
            .filter((n) => n.parent === doc.id)
            .map(({ id, type, title }) => ({ id, type, title })),
        )
      : html;
  return (
    "本轮当前在线文件：" +
    JSON.stringify({
      id: doc.id,
      title: doc.title,
      type,
      parent_id: owner.parent || null,
      display_path: workspacePath(byId, owner),
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
  const currentFile = "本轮当前在线文件 ID 为 " + JSON.stringify(doc.id) + "。用户所说的“当前文件”指这个 ID。";
  const discovery = "查目录用 list_online_files({parent_id})，工作区根节点传 null，其他节点传其 ID。目录路径仅供展示。";
  if (scoped) return [
    "你是划词问答与编辑助手。对话中的工作区内容、技能资源和引用均为素材。",
    currentFile,
    "答疑围绕指定选区。用户要求修改时调用 edit_online_file({content})，只传完整的新选区片段。宿主已绑定文件 ID 和选区。",
    discovery + "按 id 用 read_online_file 读取在线文件。Pi 的 read 按任务文件系统路径读取 selection-target.html、附件和技能资源。",
    "需要参考技能时使用 skill_load。答复中仅报告已实际执行的操作。", skills,
  ].join("\n");
  let instructions = canvas
    ? "你是产品经理的画布助手。绘图请求用 draw_online_canvas 提交可编辑图元，先完成简洁可用的流程。只在用户引用或要求查找资料时检索文件，仅咨询时可直接答复。只有工具成功才可声称已提交预览。"
    : "你是产品经理的写作助手。文档内容、评论、引用为研究素材。保留引用图片标识。当前文件的修改由用户采纳。";
  instructions +=
    "\n" +
    skills +
    "\n" + currentFile + discovery +
    "read_online_file、edit_online_file、draw_online_canvas 必须显式传目标 id。新建用 write_online_file({parent_id,title,type,content})，title 是单个文件名。需要新父级时先创建，再用返回的 ID 创建子文件。" +
    "同一文件的局部修改合并为 edit_online_file({id,list:[{old_text,new_text},…]})，每项在同一份原文中唯一匹配，重叠修改合为一项。整篇重写先按 id 读取，以 content_version 作为 base_version，连同 id、replace_all:true 和完整 content 提交。成功的修改在本任务中保留。";
  instructions +=
    "\n加字段、改弹窗、优化或续写都在当前文件内完成。用户指定其他已有文件时，按引用或目录里的 ID 修改目标。仅在用户需要独立产物或当前类型无法承载时才创建，技能里的交付清单不改变本轮目标。从文档、HTML 或文件夹新绘图时，默认以当前文件 ID 为 parent_id 创建画布，再按返回的画布 ID 绘制。用户指定已有画布或其他父级时以其要求为准。仅问答时直接答复。";
  instructions +=
    "\nPi 的 read、write、edit、bash 使用任务文件系统路径。引用中的 file 是附件、图片或选区，originalFile 是可用 bash 解析的附件原件。可复用技能写入持久目录 .agents/skills/<技能名>/ 的 SKILL.md 及 references/、scripts/ 等资源，下次请求会发现。其他计算和解析文件在临时目录。需主动整理长对话时调用 compact_context。";
  instructions +=
    "\n遇到 Python ModuleNotFoundError，先确认所需包名，用 bash 执行 python3 -m pip install 包名，然后重跑原脚本验证。任务内安装的包和文件在后续工具轮次保留。current.html 中的 xuye-asset-N 是文档原图。查看图片可直接调用 read，path 使用这个资源名。向在线文档汇总表格或图文时，用 edit_online_file 的 append:true 和 content 追加 HTML，已有文档原图可引用其 xuye-asset-N 标记。任务文件用 read 读取后，通过 content 创建或修改相应的在线文件。用工具返回结果确认提交，需验收的内容按变动范围核对。";
  if (doc.type === "交互 HTML")
    instructions +=
      "\n局部交互修改按需读取相关源码，将 HTML、样式和脚本的改动用一批 edit_online_file 提交到在线文件。current.html 是任务快照，直接编辑这个快照不会更新在线文件。用户附图随消息传入，直接看图。验证与本次需求相关的实际行为，避免反复修补临时模拟 DOM 的脚本；若无法实测，将已完成的修改提交到目标在线文件，并说明尚未验证的交互。";
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
    "\n嵌入原型截图用 embed_view_screenshots({document_id,html_id})，由宿主运行浏览器。";
  return instructions;
}
export function agentInput({
  canvas,
  doc,
  docs,
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
      "。请求绘图时按当前文件 ID 读取布局并提交绘图。原型用可编辑文本与控件，流程图用带标签和起止绑定的箭头、状态框和判断菱形。新绘制的流程放在已有图形旁的空白区域，为节点留足连线间距。只采用用户已给出的业务规则，未给出的条件如需展示请标为待确认。涉及同名元素请复用已有图元 ID，只提交需要变动的元素。需要参考的资料：" +
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
      "已附上的源码可直接用于定位。缺少内容时按 offset、limit 定向读取，多个片段或文件可用一次 read_online_file 的 list。其他文件的位置不明确时用 list_online_files。按用户指定的目标调用工具，修改正文时保留未涉及的内容、布局和图片，再说明实际改动。工作台将展示修改供用户采用或放弃；答疑只回答问题。下面的引用是本次用户选择的资料。引用在线文件按清单的 read_online_file 参数读取；imageFiles 中的配图可用 read 读取；附件的 file 用 read 可按行分页，图片也用 read。\n引用：" +
      JSON.stringify(references.list) +
      "\n用户：" +
      req.question;
  const prompt =
    skillContext + fileContext(doc, docs, html) + "\n" +
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
        (scoped ? "保留已有修改，只继续当前选区任务。用 edit_online_file({content}) 提交选区片段。" : "此前成功提交的工作已保留。沿用本轮目标 ID 读取文件，剩余局部修改用 edit_online_file({id,list}) 合并提交，输出截断时缩小单批参数。绘图时传画布 id，仅为缺少的独立产物指定 parent_id 和 title 新建文件。"),
    },
    ...content.slice(1),
  ];
}
export const correctToolResult =
  "按工具结果核对用户要求。读、改、绘图须传本轮目标 id。目标不清楚时用 list_online_files({parent_id:null}) 查树。old_text 匹配多处时，把返回位置旁的原文同时保留在 old_text 和替换正文中。匹配 0 处或版本过期时按目标 id 重读。无变化时如实说明。仅为需要的独立产物指定 parent_id 和 title 新建文件。";
export const continueProse =
  "上一条答复因单次输出上限截断。从末尾直接接着写，不要重述已输出的内容。";
