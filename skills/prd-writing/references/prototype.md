# 原型实现规则

以下设备重制代码仅说明交互模式；不得据此新增解绑、代金券或其他业务动作。实际状态变更必须以当前需求为准，并更新所有受影响字段。

## 3. 可交互原型规则
## 3.1 硬性要求
* 单文件，样式写在 <style>，脚本写在 <script>，不引用外部 CSS、字体、框架、图片。
* 不联网、不构建、不依赖本地服务；双击 HTML 就能用。
* 核心操作必须真的可用：输入、点击、弹窗打开与关闭（取消 / Esc / 点遮罩）、提交后行内数据变化、成功提示。
* 刷新后回到初始示例数据。原型的改动不持久化。
* 示例数据 4 到 6 行，覆盖已确认且适用的状态，例如正常、缺字段、未启用、不同枚举值；不为凑状态新增业务。
* 示例数据要互相自洽：绑定时间晚于激活时间，激活时间晚于录入时间；ID、指纹、IP、版本号看起来像真实系统产出。
* 宽表横向滚动，首列 position: sticky; left: 0，滚动时不丢身份信息。
* 窄屏不塌：表格在容器内横向滚动，不换行、不压缩列。
* 没有后端。凡是仅作展示的部分（分页、下拉、复杂筛选），集中在一处，并在文档红色标注里说明「原型中只展示，不生效」。
## 3.2 存在确认操作时的交互模式
以「列表 + 行内操作 + 确认弹窗」为例，这是最常见的后台形态：
```html
<div class="table-wrap"><table>…</table></div>

<div class="mask" id="mask" hidden>
  <form class="dialog" id="form" role="dialog" aria-modal="true">
    <h2 id="title">设备重制</h2>
    <p id="lead"></p>
    <div class="actions">
      <button class="btn-cancel" type="button" id="cancel">取消</button>
      <button class="btn-ok" type="submit" id="ok">确认重制</button>
    </div>
  </form>
</div>
<div class="toast" id="toast" hidden role="status"></div>
```

```javascript
let rows = INITIAL.map(row => ({ ...row }));
let currentId = "";

function render() {
  document.getElementById("rows").innerHTML = rows.map(row => `
    <tr data-id="${esc(row.id)}">
      <td class="sticky">${esc(row.id)}</td>
      <td>${esc(row.model)}</td>
      …
      <td>${row.user ? `<button class="void-btn" data-void="${esc(row.id)}">设备重制</button>` : ""}</td>
    </tr>`).join("");
}

function openVoid(id) {
  const row = rows.find(r => r.id === id);
  if (!row || !row.user) return;
  currentId = id;
  document.getElementById("lead").textContent =
    `确认后将解除设备「${row.id}」与用户「${row.user}」的绑定，废除该用户已兑换的代金券，并把设备恢复为未激活、未绑定。`;
  document.getElementById("mask").hidden = false;
}

function closeVoid() {
  document.getElementById("mask").hidden = true;
  currentId = "";
}

document.getElementById("cancel").addEventListener("click", closeVoid);
document.getElementById("mask").addEventListener("click", e => {
  if (e.target.id === "mask") closeVoid();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !document.getElementById("mask").hidden) closeVoid();
});
document.getElementById("form").addEventListener("submit", e => {
  e.preventDefault();
  const row = rows.find(r => r.id === currentId);
  if (!row) return;
  row.user = ""; row.region = ""; row.phone = ""; row.email = ""; row.bindAt = ""; row.activated = "";
  closeVoid();
  render();
  showToast("已重置该设备");
});
```

要点：
* 弹窗优先用原生 <dialog> 或 hidden 属性控制，不要用 display:none 内联样式当开关，状态难查。
* 文案里的变量用模板字符串填，不要留 {占位符} 在原型里。
* 提交后必须重新渲染整行，而不是只改一个单元格，避免状态不一致。
* 提示条 2 秒左右自动消失，同一时间只留一条。
* 禁止 alert() / confirm()：交互形态由文档定义，不用浏览器默认弹窗糊过去。
## 3.3 可复制字段
表格里的长文本（ID、哈希、密钥）按这个写法，默认截断，悬停出现复制按钮：
```html
<td><div class="clip" title="完整值">
  <span>完整值</span>
  <button class="copy" data-copy="完整值" aria-label="复制设备 ID">⧉</button>
</div></td>
```

```css
.clip { display: flex; align-items: center; gap: 2px; white-space: nowrap; }
.clip span { display: inline-block; overflow: hidden; text-overflow: ellipsis; }
.clip:hover .copy { visibility: visible; }
.copy { border: 0; background: transparent; padding: 0 0 0 4px; color: #94a3b8; visibility: hidden; cursor: pointer; }
```

复制用 navigator.clipboard?.writeText(...)，捕获异步拒绝，失败静默，不报错打断演示；失败时不要显示复制成功。
## 3.4 多行单元格
一格里放多行「标签 + 值」，用于把同类字段合并成一列，减少列数：
```css
.specs { margin: 0; padding: 0; list-style: none; font-size: 13px; }
.specs li { margin: 1px 0; white-space: nowrap; }
.specs em { font-style: normal; color: #64748b; font-size: 12px; }
```

```html
<ul class="specs">
  <li><em>录入：</em>2026-04-21 15:50</li>
  <li><em>激活：</em>2026-04-23 23:15</li>
  <li><em>绑定：</em>2026-04-23 23:18</li>
  <li><em>最近活跃：</em>2026-11-06 14:18</li>
</ul>
```

同一列内的行数固定。缺值显示「—」，不隐藏整行，否则行数变化会让表格跳动。
## 3.5 原型的「假」要收口
* 分页、下拉、日期区间这类控件，可以只做样式。但要在文档红色标注里一次说清哪几处不生效。
* 不要为了好看塞入文档里没有的控件；也不要因为不好实现就删掉文档要求的列。
* 原型里出现的数据，就是文档示例里引用的数据。两边必须能对上。
