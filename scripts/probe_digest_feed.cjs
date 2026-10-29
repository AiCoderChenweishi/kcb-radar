'use strict';
/**
 * 侦察：做"每日要闻总结 + 大事板块总结 + 医药板块专章"的原料盘点。
 *
 * 只读，不写任何文件。目的是在动手前确认：
 * 1. 科创板医药板块有多少家、当日有多少条要闻/公告、够不够撑起一节专章
 * 2. 哪些板块当日称得上"有事"（候选的大事板块）
 * 3. 医药板块当日的具体条目（总结的原料）
 */
const { loadDataset, listDates } = require('../src/store');
const { extractEvents } = require('../src/events');

const PHARMA = ['化学制药', '生物制品', '医疗器械', '医疗服务', '医疗美容', '动物保健Ⅱ'];
const date = listDates()[0];
const ds = loadDataset(date);
const companies = ds.companies || [];

// 事件识别（当日窗口）
const ev = extractEvents(companies, { since: date, to: date, label: `当日（${date}）` });
const evByType = new Map(ev.map((e) => [e.key, e]));

// 行业聚合
const byInd = new Map();
for (const c of companies) {
  const ind = c.industry || '未分类';
  if (!byInd.has(ind)) byInd.set(ind, []);
  byInd.get(ind).push(c);
}

function dayCount(c, key) {
  if (key === 'news') return (c.news || []).filter((n) => n.date === date).length;
  if (key === 'notice') return (c.notices || []).filter((n) => n.date === date).length;
  return 0;
}

console.log(`数据日期：${date}｜公司 ${companies.length} 家｜行业 ${byInd.size} 个\n`);

// ---------- 1. 医药板块盘点 ----------
const pharmaCos = companies.filter((c) => PHARMA.includes(c.industry));
console.log(`=== 医药板块（申万二级：${PHARMA.join('、')}）===\n`);
console.log(`公司数：${pharmaCos.length} / ${companies.length}（${(pharmaCos.length / companies.length * 100).toFixed(1)}%）`);
const sub = new Map();
for (const c of pharmaCos) sub.set(c.industry, (sub.get(c.industry) || 0) + 1);
for (const [k, v] of [...sub].sort((a, b) => b[1] - a[1])) console.log(`  ${k}：${v} 家`);
const pNews = pharmaCos.reduce((s, c) => s + dayCount(c, 'news'), 0);
const pNotice = pharmaCos.reduce((s, c) => s + dayCount(c, 'notice'), 0);
const pResearch = pharmaCos.filter((c) => (c.research || []).length).length;
const pSell = pharmaCos.filter((c) => c.sell_side && c.sell_side.covered).length;
const pSellView = pharmaCos.filter((c) => c.sell_side && c.sell_side.view_thesis).length;
console.log(`\n当日要闻 ${pNews} 条｜当日公告 ${pNotice} 条｜近期研报 ${pResearch} 家｜卖方覆盖 ${pSell} 家（带原文 ${pSellView} 家）`);
const up = pharmaCos.filter((c) => c.quote && c.quote.change_pct > 0).length;
const down = pharmaCos.filter((c) => c.quote && c.quote.change_pct < 0).length;
const chgs = pharmaCos.map((c) => c.quote && c.quote.change_pct).filter((x) => x != null);
console.log(`涨跌：涨 ${up} / 跌 ${down}｜板块均值 ${(chgs.reduce((a, b) => a + b, 0) / chgs.length).toFixed(2)}%`);

// 医药公司名单（含代码、涨跌幅、卖方评级）
console.log('\n--- 医药板块公司一览（按当日涨跌幅排序）---');
for (const c of [...pharmaCos].sort((a, b) => ((b.quote?.change_pct ?? 0) - (a.quote?.change_pct ?? 0)))) {
  const ch = c.quote && c.quote.change_pct != null ? `${c.quote.change_pct > 0 ? '+' : ''}${c.quote.change_pct}%` : '—';
  const r = c.sell_side && c.sell_side.covered ? `${c.sell_side.broker || ''} ${c.sell_side.rating || ''}` : '';
  console.log(`  ${c.code} ${c.name.padEnd(6, '　')} ${String(c.industry).padEnd(5, '　')} ${ch.padStart(7)}  ${r}`);
}

// ---------- 2. 医药板块当日要闻明细（总结原料）----------
console.log('\n=== 医药板块当日要闻明细（总结原料）===');
const pharmaNews = [];
for (const c of pharmaCos) {
  for (const n of c.news || []) {
    if (n.date !== date) continue;
    pharmaNews.push({ ...n, code: c.code, name: c.name, industry: c.industry });
  }
}
console.log(`条数：${pharmaNews.length}`);
for (const n of pharmaNews) {
  console.log(`\n[${n.industry}] ${n.name}(${n.code}) ${n.date}`);
  console.log(`  标题：${n.title}`);
  if (n.content) console.log(`  摘要：${String(n.content).slice(0, 140)}`);
  console.log(`  标记：is_research=${!!n.is_research} match=${n.match} kind=${n.kind || ''} broker=${n.broker || ''}`);
}

// 医药当日事件类型
const pharmaCodes = new Set(pharmaCos.map((c) => c.code));
console.log('\n--- 医药板块当日涉及的事件类型 ---');
for (const e of ev) {
  const hit = (e.companyList || []).filter((x) => pharmaCodes.has(x.code));
  if (hit.length) console.log(`  ${e.key}（${e.cat}）：${hit.length} 家 → ${hit.map((x) => x.name).join('、')}`);
}

// ---------- 3. 大事板块候选 ----------
console.log('\n=== 当日"有事"的板块候选（按要闻+公告+重大事件排序）===');
const rows = [];
for (const [ind, cs] of byInd) {
  const news = cs.reduce((s, c) => s + dayCount(c, 'news'), 0);
  const notice = cs.reduce((s, c) => s + dayCount(c, 'notice'), 0);
  const research = cs.filter((c) => (c.research || []).length).length;
  const evHits = ev.map((e) => {
    const hit = (e.companyList || []).filter((x) => cs.some((cc) => cc.code === x.code));
    return hit.length ? `${e.key}:${hit.length}` : null;
  }).filter(Boolean);
  const ch = cs.map((c) => c.quote && c.quote.change_pct).filter((x) => x != null);
  const avg = ch.length ? ch.reduce((a, b) => a + b, 0) / ch.length : 0;
  rows.push({ ind, n: cs.length, news, notice, research, ev: evHits.join(' '), avg });
}
rows.sort((a, b) => (b.news + b.notice) - (a.news + a.notice));
for (const r of rows.slice(0, 20)) {
  console.log(`  ${r.ind.padEnd(6, '　')} 公司${String(r.n).padStart(3)}｜当日要闻 ${String(r.news).padStart(3)}｜公告 ${String(r.notice).padStart(3)}｜研报 ${String(r.research).padStart(2)}｜均涨跌 ${r.avg.toFixed(2)}%｜事件 ${r.ev || '—'}`);
}
