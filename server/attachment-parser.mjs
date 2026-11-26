// Runs in a short-lived process so a slow parser cannot block the workspace.
const limit = 2_000_000;
async function parse(ext, bytes) {
  const chunks = [];
  let size = 0;
  const append = (text) => {
    size += text.length + 1;
    if (size > limit) throw Error("解析后的文字超过 200 万字符，请拆分文件。");
    chunks.push(text);
  };
  const signature = bytes.subarray(0, 8).toString("hex");
  if (ext === "pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: Uint8Array.from(bytes),
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    const pdf = await task.promise;
    let readable = false;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i),
        content = await page.getTextContent();
      const text = content.items
        .map((item) => (item.str || "") + (item.hasEOL ? "\n" : " "))
        .join("")
        .trim();
      if (text) readable = true;
      append("第 " + i + " 页\n" + (text || "（本页无可提取文字）"));
      page.cleanup();
    }
    if (!readable) throw Error("PDF 没有可提取的文字，请先进行 OCR 后再上传。");
  } else {
    const legacy = ["doc", "xls"].includes(ext);
    if (
      legacy
        ? signature !== "d0cf11e0a1b11ae1"
        : !signature.startsWith("504b0304")
    )
      throw Error("文件内容与扩展名不符，或文件已加密。");
    if (ext === "doc" || ext === "docx") {
      const { default: WordExtractor } = await import("word-extractor");
      const doc = await new WordExtractor().extract(bytes);
      for (const section of [
        doc.getHeaders(),
        doc.getBody(),
        doc.getTextboxes(),
        doc.getFootnotes(),
        doc.getEndnotes(),
      ]) {
        if (section?.trim()) append(section.trim());
      }
    } else {
      const { default: XLSX } = await import("xlsx");
      const book = XLSX.read(bytes, { type: "buffer", cellFormula: true });
      let populated = false;
      for (const name of book.SheetNames) {
        append("工作表：" + name);
        const sheet = book.Sheets[name];
        const cells = Object.keys(sheet).filter((k) =>
          /^[A-Z]+[1-9]\d*$/.test(k),
        );
        cells.sort((a, b) => {
          const x = XLSX.utils.decode_cell(a),
            y = XLSX.utils.decode_cell(b);
          return x.r - y.r || x.c - y.c;
        });
        let row,
          values = [];
        for (const addr of cells) {
          const cell = sheet[addr],
            next = XLSX.utils.decode_cell(addr).r;
          if (cell.v == null && !cell.f) continue;
          if (row !== next && values.length) {
            append(values.join("\t"));
            values = [];
          }
          row = next;
          populated = true;
          values.push(
            addr +
              "=" +
              (cell.w ?? cell.v ?? "") +
              (cell.f ? " [公式 =" + cell.f + "]" : ""),
          );
        }
        if (values.length) append(values.join("\t"));
      }
      if (!populated) throw Error("工作簿中没有可读取的单元格。");
    }
  }
  if (!chunks.length) throw Error("文件没有可提取的文字。");
  return chunks.join("\n");
}
process.once("message", async ({ ext, bytes }) => {
  try {
    process.send({ text: await parse(ext, bytes) });
  } catch (e) {
    process.send({
      error:
        e.name === "PasswordException"
          ? "PDF 已加密，请先解锁。"
          : /^(解析后|文件内容|文件没有|PDF 没有|工作簿中)/.test(e.message)
            ? e.message
            : "无法解析文件，请检查格式、密码或文件完整性。",
    });
  } finally {
    process.disconnect();
  }
});
