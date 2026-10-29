'use strict';
/**
 * 探针 2：c.research 条目的字段构成 + 两日数据集对比。
 *
 * 目的：
 * 1. 确认 research 条目里有没有 view / view_thesis（券商观点原话）——
 *    有的话，区间模式必须带上，否则「券商观点原话」功能在区间筛选下会消失。
 * 2. 对比 10-21 与 10-22 两份数据集的 research / sell_side 规模。
 */
const { loadDataset, listDates } = require('../src/store');

function shapeOf(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    let t = 'null';
    if (v === null || v === undefined) t = 'null';
    else if (Array.isArray(v)) t = `array(${v.length})`;
    else if (typeof v === 'object') t = `object{${Object.keys(v).slice(0, 6).join(',')}}`;
    else if (typeof v === 'string') t = `string(${v.length})${v.length > 40 ? '…' : ''}`;
    else t = `${typeof v}(${String(v).slice(0, 24)})`;
    out[k] = t;
  }
  return out;
}

for (const date of listDates()) {
  const ds = loadDataset(date);
  if (!ds) { console.log(date, 'NO_DATASET'); continue; }
  const companies = ds.companies || [];
  let resTotal = 0, resWithView = 0, resWithThesis = 0, resWithForecast = 0;
  let sellSideCompanies = 0, sellSideTotal = 0, sellSideWithView = 0;
  let newsRes = 0, newsResWithView = 0;
  let researchDates = new Set();
  const sample = [];

  for (const c of companies) {
    for (const r of c.research || []) {
      resTotal++;
      if (r.view) resWithView++;
      if (r.view_thesis) resWithThesis++;
      if (r.forecast) resWithForecast++;
      if (r.date) researchDates.add(r.date);
      if (r.view && sample.length < 2) sample.push({ code: c.code, name: c.name, shape: shapeOf(r), viewHead: String(r.view).slice(0, 60) });
    }
    for (const n of c.news || []) {
      if (n.is_research) { newsRes++; if (n.view) newsResWithView++; }
    }
    const ss = c.sell_side || {};
    const arr = ss.views || ss.reports || null;
    if (arr && arr.length) {
      sellSideCompanies++;
      sellSideTotal += arr.length;
      sellSideWithView += arr.filter((x) => x.view || x.view_thesis).length;
    }
  }
  console.log(JSON.stringify({
    date,
    companies: companies.length,
    research: { total: resTotal, withView: resWithView, withThesis: resWithThesis, withForecast: resWithForecast, dates: [...researchDates].sort().slice(-6) },
    newsResearch: { total: newsRes, withView: newsResWithView },
    sellSide: { companies: sellSideCompanies, total: sellSideTotal, withView: sellSideWithView },
    sample,
  }, null, 2));
}
