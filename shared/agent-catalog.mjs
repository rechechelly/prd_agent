export const toolDescriptions = {
  read: "读取任务文件系统中的附件解析文本、图片、选区或脚本。已激活技能的文件使用 skills/技能名/相对路径。",
  write: "在任务文件系统创建或覆盖文本文件，例如脚本、SKILL.md 或工作草稿。",
  edit: "在任务文件系统按原文修改已有文本文件，例如脚本或技能草稿。",
  install_skill: "用户要求保存可复用技能时，从任务目录安装完整技能包。name 为草稿文件夹名，files 为相对该文件夹的文件清单。",
  list_file: "查看工作区文件树、类型、父子关系和本轮已登记的改动。",
  read_file: "按在线工作区 ID 或目录路径读取文档、HTML、画布及文件夹。省略目标可读取当前工作区文件。",
  write_file: "在工作区创建文件夹、文档、画布或 HTML，并指定父文件或路径。",
  edit_file: "修改在线文件的内容、名称或位置，支持按唯一原文局部替换。",
  draw_canvas:
    "按文件 ID 或路径在目标画布绘制可编辑的图元与连线，供预览和采用。",
  skill_load: "按技能名称加载操作说明和包内资料的基准路径。",
  embed_view_screenshots:
    "为已有 PRD 文档嵌入配套 HTML 的新截图，需同时传入两个文件的 ID。单独编辑 HTML 直接用 edit_file。原型使用 data-prd-view，文档图片使用同名 data-prd-shot，可选 showPrdView(name) 切换状态。",
  bash: "在一次性隔离环境内检索资料、运行技能脚本。",
  compact_context: "请求 Pi 压缩较早的对话，保留当前任务所需信息。",
};

// Keep the settings catalog and the runtime use of names consistent.
export const toolGroups = {
  "在线工作区": ["list_file", "read_file", "write_file", "edit_file", "draw_canvas", "embed_view_screenshots"],
  "任务文件系统": ["read", "write", "edit", "bash"],
  "技能与会话": ["skill_load", "install_skill", "compact_context"],
};
