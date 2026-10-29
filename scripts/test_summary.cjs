'use strict';
/**
 * 检验「内容总结」的产出质量（用真实数据）：
 *  1. 覆盖率：多少条目能生成总结
 *  2. 长度分布
 *  3. **数字是否被切断**（核心质量指标）
 *     判定：摘要结尾的数字 token，如果在原文里紧跟着另一个数字，说明这个数字被切了。
 *  4. 抽样人工看
 */
const { loadDataset, listDates } = require('../src/store');
const { summarizeView } = require('../src/summary');

const ds = loadDataset(listDates()[0]);
const all = [];
for (const c of ds.companies || []) {
  for (const r of c.research || []) {
    all.push({ kind: 'research', code: c.code, name: c.name, title: r.title, view: r.view, old: r.view_thesis });
  }
  const ss = c.sell_side || {};
  if (ss.covered && ss.view) {
    all.push({ kind: 'sellSide', code: c.code, name: c.name, title: ss.title, view: ss.view, old: ss.view_thesis });
  }
}

/** 摘要结尾的数字是否在原文里被切断了 */
function brokenTail(summary, source) {
  const s = String(summary || '').replace(/[…\s]+$/, '');
  const m = s.match(/([+\-−]?\d[\d,.]*)$/);
  if (!m) return false;
  const tok = m[1];
  const src = String(source || '');
  let from = 0;
  for (;;) {
    const i = src.indexOf(tok, from);
    if (i < 0) return false;          // 原文里找不到这个 token（可能跨句拼接），不判定
    const after = src.slice(i + tok.length);
    if (/^\d/.test(after) || /^\.\d/.test(after)) return true;  // 后面还跟数字 → 被切了
    from = i + 1;
    if (from > src.length) break;
  }
  return false;
}

let noSummary = 0, cutNew = 0, cutOld = 0;
const lens = [];
const bad = [];
const samples = [];
for (const it of all) {
  const s = summarizeView(it.view, { maxLen: 180 });
  if (!s) { noSummary++; continue; }
  lens.push(s.length);
  if (brokenTail(s, it.view)) {
    cutNew++;
    if (bad.length < 5) bad.push(`【新截断】${it.name} → …${s.slice(-34)}`);
  }
  if (brokenTail(it.old || '', it.view)) cutOld++;
  if (samples.length < 5 && it.kind === 'research') {
    samples.push(`${it.name}｜${it.title.slice(0, 28)}\n   标题→ ${it.title.slice(0, 40)}\n   总结→ ${s}`);
  }
}
lens.sort((a, b) => a - b);
console.log(`总条目：${all.length}（近期研报 + 卖方覆盖）`);
console.log(`生成总结：${all.length - noSummary}｜无正文：${noSummary}`);
console.log(`长度：最短 ${lens[0]}｜中位 ${lens[Math.floor(lens.length / 2)]}｜最长 ${lens[lens.length - 1]}｜平均 ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)}`);
console.log(`\n**新总结切坏数字：${cutNew} 条**（旧 view_thesis 同样问题：${cutOld} 条）`);
if (bad.length) { console.log('\n仍有问题：'); for (const b of bad) console.log('  ' + b); }
console.log('\n---- 抽样 ----');
for (const s of samples) console.log(s);
