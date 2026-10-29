'use strict';
/**
 * 只读预览：按拟定口径生成「医药板块总结」草稿 + 「要闻总览」草稿。
 * 不写任何文件——目的是让确认前就能看到成品长什么样。
 */
const { loadDataset, listDates } = require('../src/store');
const { extractEvents } = require('../src/events');

const PHARMA = ['化学制药', '生物制品', '医疗器械', '医疗服务', '医疗美容', '动物保健Ⅱ'];
const date = listDates()[0];
const ds = loadDataset(date);
const companies = ds.companies || [];
const asOf = date;
const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const d7from = shift(asOf, -6);

// 亚虹六条线的关键词（用于"与本公司管线相关"标注）
const TRACK = {
  'FGFR2/3': /FGFR\s*2|FGFR\s*3|FGFR2\/3|FGFR-2|FGFR-3/i,
  'CLDN6/9 ADC': /CLDN\s*6|CLDN\s*9|CLDN6\/9|Claudin\s*6|Claudin\s*9/i,
  'USP1': /USP1|泛素特异性蛋白酶\s*1/i,
  'UC（溃疡性结肠炎）': /溃疡性结肠炎|ulcerative colitis|\bUC\b/i,
  '宫颈光动力': /光动力|宫颈/i,
  '膀胱（蓝光器械）': /膀胱|blue light/i,
};

// 医药重大事项的事件类型（优先于"投资者调研"这类低信息量的）
const MAJOR = ['研发里程碑', '业绩预增', '业绩预亏', '业绩说明会', '股份回购', '股东减持',
  '股权激励', '对外投资', '诉讼仲裁', '风险警示', '异常波动', '重大合同', '中标', '新股上市',
  '投资者关系', '并购重组', '定增', '再融资', '资产重组'];

const pharma = companies.filter((c) => PHARMA.includes(c.industry));
const codes = new Set(pharma.map((c) => c.code));

// ---------- 窗口内医药要闻（近7天）----------
const inWin = (n) => n.date && n.date >= d7from && n.date <= asOf;
const pNews = [];
for (const c of pharma) {
  for (const n of c.news || []) if (inWin(n)) pNews.push({ ...n, code: c.code, name: c.name, industry: c.industry });
  for (const n of c.notices || []) if (inWin(n)) pNews.push({ ...n, kind: 'notice', code: c.code, name: c.name, industry: c.industry });
}
console.log(`【窗口】${d7from} ~ ${asOf}`);
console.log(`【医药板块】${pharma.length} 家｜窗口内要闻+公告 ${pNews.length} 条\n`);

// ---------- 赛道命中 ----------
console.log('=== 与本公司管线（亚虹六条线）相关的条目 ===');
const trackHits = [];
for (const n of pNews) {
  const text = `${n.title || ''} ${n.content || ''}`;
  for (const [k, re] of Object.entries(TRACK)) {
    if (re.test(text)) {
      trackHits.push({ ...n, track: k });
      console.log(`\n★ ${k}｜${n.name}(${n.code})｜${n.industry}｜${n.date}`);
      console.log(`  标题：${n.title}`);
      if (n.content) console.log(`  摘要：${String(n.content).replace(/\s+/g, ' ').slice(0, 220)}`);
      break;
    }
  }
}
if (!trackHits.length) console.log('（窗口内无命中）');

// ---------- 栏目稿：正文提到但归属公司不是正文主角的 ----------
console.log('\n=== 栏目稿（标题与内容主角不一致，竞情常藏在这里）===');
for (const n of pNews) {
  const t = String(n.title || '');
  if (/早参|晚报|早报|快讯|盘点|汇总|早知道/.test(t)) {
    console.log(`\n▫ ${n.name}(${n.code}) ${n.date}｜${t}`);
    console.log(`  ${String(n.content || '').replace(/\s+/g, ' ').slice(0, 260)}`);
  }
}

// ---------- 重大事项（按事件类型）----------
console.log('\n=== 近7天医药重大事项（按事件类型归并）===');
const ev = extractEvents(companies, { since: d7from, to: asOf, label: `近7天（${d7from} ~ ${asOf}）` });
for (const e of ev.sort((a, b) => MAJOR.indexOf(a.key) - MAJOR.indexOf(b.key))) {
  const hit = (e.companyList || []).filter((x) => codes.has(x.code));
  if (!hit.length) continue;
  console.log(`\n${e.key}（${e.cat}）｜${hit.length} 家 / ${e.mentions} 次`);
  for (const h of hit.slice(0, 12)) {
    const s = (h.samples || [])[0] || {};
    console.log(`   ${h.name}(${h.code}) ${s.date || ''}｜${(s.title || '').slice(0, 60)}${h.count > 1 ? `（共 ${h.count} 次）` : ''}`);
  }
  if (hit.length > 12) console.log(`   …… 其余 ${hit.length - 12} 家从略`);
}

// ---------- 卖方观点（带原文）----------
console.log('\n=== 医药板块卖方观点原文（可引用）===');
let v = 0;
for (const c of pharma) {
  const ss = c.sell_side || {};
  if (!ss.covered || !ss.view_thesis) continue;
  v++;
  if (v > 8) continue;
  console.log(`\n${c.name}(${c.code}) ${c.industry}｜${ss.broker || ''} ${ss.rating || ''}｜${ss.date || ''}`);
  console.log(`  ${String(ss.view_thesis).slice(0, 200)}`);
}
console.log(`\n（医药带原文的卖方观点共 ${v} 家）`);

// ---------- 板块温度 ----------
const up = pharma.filter((c) => c.quote && c.quote.change_pct > 0).length;
const dn = pharma.filter((c) => c.quote && c.quote.change_pct < 0).length;
const ch = pharma.map((c) => c.quote && c.quote.change_pct).filter((x) => x != null);
const avg = ch.reduce((a, b) => a + b, 0) / ch.length;
const mkt = ds.market || {};
console.log(`\n=== 医药板块温度 ===`);
console.log(`涨 ${up} / 跌 ${dn} / 平 ${pharma.length - up - dn}｜板块均涨跌 ${avg.toFixed(2)}%`);
console.log(`科创50 ${mkt.kc50 ? mkt.kc50.changePct ?? mkt.kc50.change_pct ?? '?' : '?'}%`);
const rel = pharma.filter((c) => c.quote && Math.abs(c.quote.change_pct) >= 5)
  .sort((a, b) => Math.abs(b.quote.change_pct) - Math.abs(a.quote.change_pct));
console.log(`当日异动（|涨跌|≥5%）：${rel.length ? rel.map((c) => `${c.name} ${c.quote.change_pct > 0 ? '+' : ''}${c.quote.change_pct}%`).join('、') : '无'}`);
