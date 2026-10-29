'use strict';
/**
 * 把历史数据集里逐公司的 quote.source 修正为**实际取数源**。
 *
 * 为什么需要：旧的 quote.js 把 `source` 写死成 '东方财富'，
 * 而行情走腾讯兜底时（push2 被封）逐公司来源就是假的。
 * 现在代码已改成透传真实来源，历史数据用数据集自己的 sources.quotes 回填。
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, listDates, datasetPath } = require('../src/store');

const ROOT = path.join(__dirname, '..');
const log = [];
for (const d of listDates()) {
  const ds = loadDataset(d);
  if (!ds) continue;
  const real = (ds.sources && ds.sources.quotes) || null;
  if (!real) { log.push(`${d}: 无 sources.quotes，跳过`); continue; }
  let changed = 0;
  const from = new Map();
  for (const c of ds.companies || []) {
    if (!c.quote) continue;
    const old = c.quote.source;
    if (old !== real) { from.set(old, (from.get(old) || 0) + 1); c.quote.source = real; changed++; }
  }
  if (changed) {
    fs.writeFileSync(datasetPath(d), JSON.stringify(ds), 'utf8');
    log.push(`${d}: 修正 ${changed} 家，原值 ${JSON.stringify([...from.entries()])} → ${real}`);
  } else {
    log.push(`${d}: 已是 ${real}，无需修正`);
  }
}
console.log(log.join('\n'));
