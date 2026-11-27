import { demoScene, sceneImage } from "./board";

export async function exampleWorkspace() {
  const folders = [
    { id: "product", type: "文件夹", title: "产品设计", parent: "" },
    { id: "research", type: "文件夹", title: "用户研究", parent: "product" },
    { id: "personal", type: "文件夹", title: "日常备忘", parent: "" },
  ];
  const docs = [
    {
      id: "feedback",
      title: "客户反馈池",
      type: "文档",
      parent: "product",
      html: "",
    },
    {
      id: "interview",
      title: "客户访谈摘录",
      type: "文档",
      parent: "research",
      html: "<h2>反馈处理</h2><p>访谈示例：希望产品经理能按状态查看客户反馈，并快速找到反馈来源。</p>",
    },
    {
      id: "review",
      title: "需求评审备忘",
      type: "文档",
      parent: "personal",
      html: "<p>评审前核对交互原型、字段口径和待确认事项。</p>",
    },
    {
      id: "week",
      title: "本周灵感",
      type: "文档",
      parent: "personal",
      html: "<p>记录值得再次讨论的产品想法。</p>",
    },
  ];
  const scene = demoScene();
  const img = await sceneImage(scene, {}, "#f0eef8");
  docs[0].html =
    '<h2>需求背景</h2><p>客户反馈分散在访谈记录和评审备忘中。产品经理需要一个统一的反馈池，按标题检索、按处理状态筛选，在评审时快速定位原始问题。</p><h2>页面草图</h2><img src="' +
    img +
    '" alt="反馈池列表与交互备注"><h2>交互与字段</h2><p>标题支持关键词匹配；状态为单选，默认全部。状态枚举：待评估、已采纳、暂缓。点击行展开该条反馈的详情。</p><p>反馈标题（文本）：该条反馈的简短描述。状态（枚举）：产品经理对反馈的处理结论。来源（文本）：记录该反馈的渠道。</p><table><tr><th>反馈标题</th><th>状态</th><th>来源</th></tr><tr><td>希望支持批量归档</td><td>待评估</td><td>客户访谈</td></tr><tr><td>补充快捷键说明</td><td>已采纳</td><td>评审备忘</td></tr><tr><td>列表支持自定义列</td><td>暂缓</td><td>客户访谈</td></tr><tr><td>搜索保留最近条件</td><td>待评估</td><td>产品体验</td></tr></table>';
  docs.push({
    id: crypto.randomUUID(), type: "画布", parent: "feedback",
    title: "客户反馈池 · 草图", html: "", scene,
  });
  return { docs, folders };
}
