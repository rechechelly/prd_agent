export const toolDescriptions = {
  list_file: "查看工作区文件树、类型、父子关系和本轮已登记的改动。",
  read_file: "读取工作区文件或交付草稿。省略目标可读取当前工作区文件。",
  write_file: "创建文件夹、文档、画布或 HTML，并指定父文件或路径。",
  edit_file: "修改已有文件的内容、名称或位置，支持按唯一原文局部替换。",
  draw_canvas:
    "按文件 ID 或路径在目标画布绘制可编辑的图元与连线，供预览和采用。",
  skill_load: "按技能名称加载操作说明和包内资料的基准路径。",
  read_resource: "读取选区、附件、引用图片和已加载技能的参考资料。",
  embed_view_screenshots:
    "为已有 PRD 文档嵌入配套 HTML 的新截图，需同时传入两个文件的 ID。单独编辑 HTML 直接用 edit_file。原型使用 data-prd-view，文档图片使用同名 data-prd-shot，可选 showPrdView(name) 切换状态。",
  bash: "在一次性隔离环境内检索资料、运行技能脚本。",
  compact_context: "请求 Pi 压缩较早的对话，保留当前任务所需信息。",
};
