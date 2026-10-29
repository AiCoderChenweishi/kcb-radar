'use strict';
/**
 * 探针：确认「要闻池」与「研报池」在真实数据集里的关系。
 *
 * 要回答三个问题：
 * 1. c.news 里是否已经包含研报（is_research=true）？
 * 2. 若包含，c.news 与 c.research 是否指向同一批研报（会重复计数）？
 * 3. 要闻日期回溯窗口实际有多长（决定区间筛选能不能超过 30 天）？
 */
const path = require('path');
const { loadDataset, listDates } = require('../src/store');

const date = process.argv[2] || listDates()[0];
const ds = loadDataset(date);
if (!ds) { console.error('NO_DATASET', date); process.exit(1); }

const companies = ds.companies || [];
let newsTotal = 0, newsResearch = 0, researchTotal = 0;
let overlapByTitle = 0;
const dates = new Set();
const sample = [];

for (const c of companies) {
  for (const n of c.news || []) {
    newsTotal++;
    if (n.is_research) newsResearch++;
    if (n.date) dates.add(n.date);
  }
  const res = c.research || [];
  researchTotal += res.length;
  const newsTitles = new Set((c.news || []).map((n) => n.title));
  for (const r of res) {
    if (newsTitles.has(r.title)) overlapByTitle++;
  }
  if (res.length && sample.length < 3) {
    sample.push({
      code: c.code, name: c.name,
      newsTitles: (c.news || []).map((n) => `${n.date}|${n.is_research ? 'R' : 'N'}|${(n.title || '').slice(0, 28)}`),
      researchTitles: res.map((r) => `${r.date}|${(r.title || '').slice(0, 28)}`),
    });
  }
}

const sorted = [...dates].sort();
console.log(JSON.stringify({
  date,
  companies: companies.length,
  newsTotal, newsResearch, researchTotal,
  overlapByTitle,
  newsDistinctDates: sorted.length,
  newsMinDate: sorted[0], newsMaxDate: sorted[sorted.length - 1],
  distinctDateList: sorted,
  industries: new Set(companies.map((c) => c.industry).filter(Boolean)).size,
  sample,
}, null, 2));
