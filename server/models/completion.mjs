export function completionMessages(title, { before, after, previous, codeLanguage }) {
  const code = typeof codeLanguage === "string";
  return [
    {
      role: "system",
      content: [
        "你为产品经理补全文档。仅输出适合插入光标位置的简短片段，衔接前后文，不重复原文，不加前言。",
        code
          ? "光标已在代码块中。直接续写该语言的代码，保留缩进，无需再包裹 Markdown 围栏。"
          : "使用 Markdown。行内续写自然衔接原句，按内容选用标题、列表、表格、行内代码或带语言的围栏代码块。不要给整段结果套 markdown 围栏。",
        previous ? "用户要求换一版，结合上下文提供与上一版不同的候选。" : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        title,
        before: String(before || "").slice(-3500),
        after: String(after || "").slice(0, 1000),
        ...(code && { codeLanguage: codeLanguage.slice(0, 80) }),
        ...(previous && { previous: String(previous).slice(0, 4000) }),
      }),
    },
  ];
}
