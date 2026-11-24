// 题目内容块：文字、表格、代码、公式（v2 2.9：新题型只能用这几种块，鸿蒙 ArkWeb 里同样复用）
import { html, sheet } from '../ui.js';
import { api } from '../api.js';

export function blocks(list = []) {
  return list.map((b) => {
    switch (b.kind) {
      case 'table': return html`<div class="tbl-wrap"><table class="tbl">
        ${b.header?.length ? html`<thead><tr>${b.header.map((h) => html`<th>${h}</th>`)}</tr></thead>` : ''}
        <tbody>${b.rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
      case 'code': return html`<pre class="blk-code">${b.text}</pre>`;
      case 'formula': return html`<pre class="blk-formula">${b.text}</pre>`;
      default: return html`<p>${b.text}</p>`;
    }
  });
}

export const refTag = (r) => html`<button class="tag" data-act="ref" data-mid="${r.material_id}" data-page="${r.page}" title="查看原页">${shortTitle(r.material_title)} 第 ${r.page} 页</button>`;
const shortTitle = (t) => (t || '').replace(/\.(pdf|pptx?|docx?|txt|md)$/i, '');

/** 打开原页：有截图显示截图，没有就显示文字层 */
export async function openPage(mid, page, label) {
  const p = await api.page(mid, page);
  sheet({
    title: label,
    wide: true,
    body: p.image_url ? html`<img class="page-img" src="${p.image_url}" alt="${label}原页">` : html`<div class="page-text">${p.text}</div>`,
  });
}
