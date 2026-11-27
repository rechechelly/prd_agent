export function completionMessages(title, { before, after, previous, codeLanguage, blockPath, atBlockEnd }) {
  const code = typeof codeLanguage === "string";
  return [
    {
      role: "system",
      content: [
        "你为产品经理续写文档。before 和 after 分别是光标前后的原文。只输出要插在两者之间的新增内容，保留原有后文，避免复述。",
        code
          ? "光标已在代码块中。直接续写该语言的代码，保留缩进，无需再包裹 Markdown 围栏。"
          : "使用 Markdown，根据上下文决定续完一句话，还是另起段落或小节。需要展开步骤时直接写有序列表，需要组织章节时使用相应层级的标题。一次补全可以组合多个段落、标题、列表、表格和代码块。普通文字若应另起一段，以换行开头；段落之间留空行。不要给整段结果套 markdown 围栏。",
        previous ? "用户要求换一版，结合上下文提供与上一版不同的候选。" : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title,
        before: String(before || "").slice(-3500),
        after: String(after || "").slice(0, 1000),
        ...(typeof blockPath === "string" && { blockPath: blockPath.slice(0, 240), atBlockEnd: atBlockEnd === true }),
        ...(code && { codeLanguage: codeLanguage.slice(0, 80) }),
        ...(previous && { previous: String(previous).slice(0, 4000) }),
      }),
    },
  ];
}
