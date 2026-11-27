export const toolDescriptions = {
  list_online_files: "列出工作区文件树，含名称、类型、ID、父 ID 和层级。默认从根目录开始；传 id 或 path 可只列该节点的后代。offset 和 limit 用于分页。",
  read_online_file: "只读在线工作区。按 ID 或文件树路径读取，默认当前文件。用 offset、limit 按字符分页，按 next_offset 续读。多个文件或区段可传 list，每项含自己的定位和分页参数，单批共最多 40000 字符。读取历史交付引用时按其提供的 id、version 和 file 读取。",
  write_online_file: "需要独立新文件时，在工作区创建文件夹、文档、原型画布或 HTML。给现有文件加字段、修改交互或续写内容时使用 edit_online_file。path 是含文件名的工作区路径，默认相对于在线工作区根目录；指定 parent_id 时相对于该在线父文件。中间缺失目录自动创建；任何文件都能作为父级。同名路径不会覆盖已有文件。多个新文件可传 list，每项指定 path、type 和可选正文，整批成功后按顺序返回文件 ID。",
  edit_online_file: "修改现有在线文件。默认更新本次会话所在的文件，可按 ID 或工作区相对路径指定其他已有文件。支持重命名、移动、用 content 更新正文或配合 old_text 精确替换唯一原文。同一文件的多处修改优先传 list:[{old_text,new_text},…]，每项在同一份原文上唯一匹配、互不重叠，全部成功后一次提交。编辑画布图元使用 draw_online_canvas。",
  draw_online_canvas: "按工作区画布 id 或 path 绘制可编辑图元。省略目标表示当前画布。可操作刚由 write_online_file 创建的画布。同一画布用一次 elements 和 remove 提交节点、from/to 绑定箭头及删除。多个画布可传 list，每项指定目标和图元变更。同 id 更新，仅显式 remove 才删除。",
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
