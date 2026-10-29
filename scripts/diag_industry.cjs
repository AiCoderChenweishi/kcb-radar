'use strict';
/**
 * 诊断：行业筛选的"归一化口径"是否与"原始口径"一致。
 *
 * 背景：前端下拉给的是 insight 层归一化后的行业名（46 个），
 * 而 /api/range 用数据集里的原始 company.industry 做等值过滤（76 个原始值）。
 * 若两者不是一一对应，选某个行业会漏掉公司 —— 那是"筛了等于没筛"的静默错误。
 */
const { loadDataset, listDates } = require('../src/store');

const date = listDates()[0];
const ds = loadDataset(date);
const raw = new Map();               // 原始值 -> 公司数
const byCompany = new Map();         // 公司 -> 原始行业
for (const c of ds.companies || []) {
  const i = c.industry || '';
  if (!i) continue;
  raw.set(i, (raw.get(i) || 0) + 1);
  byCompany.set(c.code, i);
}
const rawList = [...raw.keys()].sort();
console.log('数据集日期:', date, '公司', (ds.companies || []).length);
console.log('原始行业值数量:', rawList.length);
console.log('原始行业清单:', JSON.stringify(rawList, null, 0));

// 归一化：去掉 Ⅱ / III 后缀
const norm = (s) => String(s || '').replace(/[ⅠⅡⅢⅣ]+$/u, '').trim();
const normMap = new Map();
for (const [code, i] of byCompany) {
  const n = norm(i);
  if (!normMap.has(n)) normMap.set(n, new Set());
  normMap.get(n).add(code);
}
console.log('\n归一化后行业数:', normMap.size);

const { buildBrief } = require('../src/insight');
const brief = buildBrief(ds);
const briefInds = new Set((brief.companies || []).map((c) => c.industry).filter(Boolean));
console.log('brief 行业数:', briefInds.size);

const briefMap = new Map();
for (const c of brief.companies || []) {
  if (!briefMap.has(c.industry)) briefMap.set(c.industry, []);
  briefMap.get(c.industry).push(c.code);
}

console.log('\n=== 关键比对：每个 brief 行业名，在原始数据里能否用等值过滤命中 ===');
let mismatch = 0;
for (const [name, codes] of briefMap) {
  const rawHit = (raw.get(name) || 0);
  const normHit = (normMap.get(norm(name)) || new Set()).size;
  if (rawHit !== codes.length) {
    mismatch++;
    console.log(`  ⚠ ${name}: brief=${codes.length} 家, 原始等值过滤命中=${rawHit}, 去后缀归一化命中=${normHit}`);
  }
}
console.log(mismatch === 0
  ? '  ✓ 全部一致：brief 行业名可在原始数据里等值命中'
  : `  ✗ ${mismatch} 个行业不一致`);

// 看几个最不一致的
console.log('\n=== 原始行业值里带 Ⅱ 的示例 ===');
console.log(rawList.filter((x) => /[ⅠⅡⅢⅣ]+$/u.test(x)).join(' | ') || '(无)');
