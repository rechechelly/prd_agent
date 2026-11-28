export const toolDescriptions = {
  list_online_files: "列出指定节点的后代，含 id、parent_id、名称、类型、层级和 display_path（仅供展示）。必传 parent_id，根节点传 null，其他节点传其 ID。用 offset 和 limit 分页。",
  read_online_file: "按 id 读取在线文件，用 offset、limit 按字符分页，按 next_offset 续读。多个文件或区段用 list，每项必传 id，总计最多 40000 字符。文档及 HTML 每页均返回完整正文的 content_version，供整篇替换使用。历史交付引用按其 id、version、file 读取。",
  write_online_file: "新建独立文件。必传 parent_id（根节点传 null）、title（单个文件名）和 type，正文可传 content。任何在线文件都可作为父级。多个文件可传 list，每项提供独立创建参数，整批成功后按顺序返回 ID。需要新建父级时，先创建父级取得 ID。",
  edit_online_file: "按 id 修改在线文件。支持重命名、移动、用 old_text 和 content 精确替换唯一原文，以及用 append:true 和 content 追加。多处局部修改传 {id,list:[{old_text,new_text},…]}，每项在同一份原文中唯一匹配、互不重叠，整批一次提交。整篇替换先按 id 读取，以 content_version 作为 base_version，连同 id、replace_all:true 和完整 content 提交。图元用 draw_online_canvas 编辑。",
  draw_online_canvas: "按画布 id 绘制可编辑图元，新画布使用创建工具返回的 ID。用 elements 和 remove 一次提交节点、from/to 绑定箭头及删除。同一图元 ID 表示更新，仅显式 remove 才删除。多个画布可传 list，每项含画布 id 和图元变更。",
  skill_load: "按 available_skills 中的名称加载匹配任务的技能。返回 SKILL.md 正文和包内资料的基准路径。",
  embed_view_screenshots:
    "为已有 PRD 文档嵌入配套 HTML 的新截图，用 document_id 和 html_id 指定文件对，一次处理所有标记的视图。多组文件可传含各文件对的 list。单独编辑 HTML 直接用 edit_online_file。原型使用 data-prd-view，文档图片使用同名 data-prd-shot，可选 showPrdView(name) 切换状态。",
  compact_context: "长对话切换阶段时请求 Pi 原生上下文压缩。可在 focus 指出需保留的目标、文件 ID、决策和待办。自动阈值和溢出压缩独立运行。",
};

// Keep the settings catalog and the runtime use of names consistent.
export const toolGroups = {
  "在线工作区": ["list_online_files", "read_online_file", "write_online_file", "edit_online_file", "draw_online_canvas", "embed_view_screenshots"],
  "任务文件系统": ["read", "write", "edit", "bash"],
  "技能与会话": ["skill_load", "compact_context"],
};
