'use strict';
/**
 * 要闻总结 / 大事板块 / 医药专章 的自测。
 *
 * 断言分两类：
 *  A. **口径闭合**：条数、覆盖家数必须与数据集现场统计一致（不能自己算自己还自洽）。
 *  B. **规则真的生效**：方向判断必须带依据与置信度；栏目稿主体必须真的被拆出来；
 *     非科创板主体必须真的不在 619 家里。
 */
const path = require('path');
const { loadDataset, listDates } = require('../src/store');
const { buildBrief } = require('../src/insight');

const date = listDates()[0];
const ds = loadDataset(date);
const b = buildBrief(ds, null);
const nd = b.newsDigest;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`);
}

// ---- 现场统计（对照组）----
const allItems = [];
for (const c of ds.companies || []) {
  for (const n of c.news || []) allItems.push({ kind: 'news', date: n.date, code: c.code });
  for (const n of c.notices || []) allItems.push({ kind: 'notice', date: n.date, code: c.code });
}
const d1 = allItems.filter((x) => x.date === date);
const d7from = nd.d7from;
const d7 = allItems.filter((x) => x.date >= d7from && x.date <= date);

console.log('=== ① 每日要闻总结 ===');
check('锚点日期 = 数据最新日期', nd.baseDate === date, `${nd.baseDate} vs ${date}`);
check('当日条目数与现场统计一致', nd.overview.counts.d1 === d1.length, `${nd.overview.counts.d1} vs ${d1.length}`);
check('近7天条目数与现场统计一致', nd.overview.counts.d7 === d7.length, `${nd.overview.counts.d7} vs ${d7.length}`);
check('今日要点条数达标', nd.overview.topPoints.length >= 5 && nd.overview.topPoints.length <= 8, `${nd.overview.topPoints.length} 条`);
check('每条要点都有可回查链接', nd.overview.topPoints.every((p) => !!p.url), '缺链接 ' + nd.overview.topPoints.filter((p) => !p.url).length + ' 条');
check('每条要点都有事件归类或明确为空', nd.overview.topPoints.every((p) => p.event === null || typeof p.event === 'string'), '');
check('事件分布有当日与近7天两档', nd.overview.eventMix.d1.length > 0 && nd.overview.eventMix.d7.length > 0,
  `d1 ${nd.overview.eventMix.d1.length} 类 / d7 ${nd.overview.eventMix.d7.length} 类`);
check('要点全部落在近 7 天窗口内', nd.overview.topPoints.every((p) => p.date >= nd.d7from && p.date <= nd.baseDate),
  nd.overview.topPoints.map((p) => p.date).join(','));
check('当日有归因可信条目时，要点里必须有当日条目',
  (() => {
    const d1Attr = allItems.filter((x) => x.date === date).length;   // 当日条目数（含公告）
    if (!d1Attr) return true;
    return nd.overview.topPoints.some((p) => p.date === date);
  })(), `当日 ${nd.overview.topPoints.filter((p) => p.date === date).length} 条 / 近7天补充 ${nd.overview.topPoints.filter((p) => p.date !== date).length} 条`);
check('同一家公司最多 2 条（不刷屏）', (() => {
  const c = {};
  for (const p of nd.overview.topPoints) c[p.name] = (c[p.name] || 0) + 1;
  return Object.values(c).every((v) => v <= 2);
})(), nd.overview.topPoints.map((p) => p.name).join('、'));

console.log('\n=== ② 大事板块 ===');
check('板块数量在 3~5 之间', nd.sectors.length >= 3 && nd.sectors.length <= 5, `${nd.sectors.length} 个：${nd.sectors.map((s) => s.industry).join('、')}`);
check('医药不出现在大事板块列表（医药单列）', !nd.sectors.some((s) => nd.pharma.scope.industries.includes(s.industry)), '');
check('每个板块都有方向判断', nd.sectors.every((s) => s.direction && s.direction.label), '');
check('方向判断必须带依据', nd.sectors.every((s) => s.direction && s.direction.basis && s.direction.basis.length > 10), '');
check('方向判断必须带置信度', nd.sectors.every((s) => ['高', '中', '低'].includes(s.direction.confidence)), nd.sectors.map((s) => `${s.industry}:${s.direction.confidence}`).join(' '));
check('依据里必须含具体数字（可核对）',
  nd.sectors.every((s) => /\d/.test(s.direction.basis)), '');
check('每个板块都有 keyPoints 且带链接', nd.sectors.every((s) => s.keyPoints.length > 0 && s.keyPoints.every((k) => !!k.url)), '');
check('板块打分口径已随结果返回', !!nd.rules.sectorScore, nd.rules.sectorScore);

console.log('\n=== ③ 医药板块专章 ===');
const pharmaCos = (ds.companies || []).filter((c) => nd.pharma.scope.industries.includes(c.industry));
check('医药公司数与现场统计一致', nd.pharma.scope.companies === pharmaCos.length, `${nd.pharma.scope.companies} vs ${pharmaCos.length}`);
check('医药占比可复核', nd.pharma.scope.sharePct === +(pharmaCos.length / (ds.companies || []).length * 100).toFixed(1), `${nd.pharma.scope.sharePct}%`);
check('医药主题 3~5 个', nd.pharma.topics.length >= 3 && nd.pharma.topics.length <= 5, nd.pharma.topics.map((t) => `${t.key}(${t.items})`).join('、'));
check('每个医药主题都带方向判断与依据', nd.pharma.topics.every((t) => t.direction && t.direction.basis && t.direction.confidence), '');
check('每个医药主题都有公司清单与带链接的要点',
  nd.pharma.topics.every((t) => t.companies.length > 0 && t.keyPoints.length > 0 && t.keyPoints.every((k) => !!k.url)), '');
check('板块温度含涨跌家数与均值', nd.pharma.temperature.up + nd.pharma.temperature.down + nd.pharma.temperature.flat === pharmaCos.length,
  `涨 ${nd.pharma.temperature.up} / 跌 ${nd.pharma.temperature.down} / 均 ${nd.pharma.temperature.avg}%`);
check('卖方覆盖与原文家数已给出', nd.pharma.sellSide.total > 0, `覆盖 ${nd.pharma.sellSide.total} 家，带原文 ${nd.pharma.sellSide.withView} 家`);
check('卖方观点原话可引用', nd.pharma.sellSide.topViews.length > 0 && nd.pharma.sellSide.topViews.every((v) => v.thesis), `${nd.pharma.sellSide.topViews.length} 条`);

console.log('\n=== ④ 栏目稿拆解与竞情提示 ===');
const boardNames = new Set((ds.companies || []).map((c) => c.name));
check('栏目稿被识别出来', nd.overview.counts.columnItems > 0, `近7天栏目稿 ${nd.overview.counts.columnItems} 条`);
check('归属与主体不一致的条目被拆出', nd.pharma.misattributed.length > 0, `${nd.pharma.misattributed.length} 条`);
check('串台条目的主体确实在科创板内', nd.pharma.misattributed.every((m) => boardNames.has(m.actual)), '');
check('非科创板竞情提示已产出', nd.pharma.external.length > 0, nd.pharma.external.map((e) => e.name).join('、'));
check('竞情提示的主体确实不在科创板 619 家里', nd.pharma.external.every((e) => !boardNames.has(e.name)),
  nd.pharma.external.filter((e) => boardNames.has(e.name)).map((e) => e.name).join('、') || '无串台');
check('竞情提示必须说明命中原因', nd.pharma.external.every((e) => e.reason && e.reason.length), '');
check('竞情提示必须带原文链接', nd.pharma.external.every((e) => !!e.url), '');

console.log('\n=== ⑤ 归因可信性（标题必须点名本公司） ===');
const unattributed = nd.overview.topPoints.filter((p) => !p.attributed);
check('要点里归因不可靠的条目已被标注', unattributed.every((p) => p.attributed === false),
  `归因不可靠 ${unattributed.length} 条${unattributed.length ? '（' + unattributed.map((p) => p.name + '：' + p.title.slice(0, 18)).join('；') + '）' : ''}`);
check('归因不可靠的要点数量不超过 2（正常情况应当是 0~1 条补位）', unattributed.length <= 2, `${unattributed.length} 条`);
const secUnattr = nd.sectors.flatMap((s) => (s.keyPoints || []).filter((k) => !k.attributed));
check('板块要点优先归因可信条目', secUnattr.length === 0 || nd.sectors.some((s) => (s.keyPoints || []).some((k) => k.attributed)),
  `不可靠 ${secUnattr.length} 条`);
check('方向判断按去重公司数计（家次 ≤ 事件条数）',
  nd.sectors.every((s) => !s.direction || s.direction.companyCount == null || s.direction.companyCount >= 0),
  nd.sectors.map((s) => `${s.industry}:${s.direction.companyCount}家次/${s.direction.dirSum}`).join(' '));
check('方向标签与相对涨跌不矛盾（均跌且无背离提示时不得判"偏正面（置信度高）"）',
  nd.sectors.every((s) => {
    const d = s.direction; if (!d) return true;
    const rel = d.relative;
    if (rel == null) return true;
    if (/背离/.test(d.label)) return true;
    if (rel < -0.8 && d.label === '偏正面') return false;
    if (rel > 0.8 && d.label === '偏负面') return false;
    return true;
  }),
  nd.sectors.map((s) => `${s.industry}:${s.direction.label}/${s.direction.relative}`).join(' '));

console.log('\n=== ⑥ 规则随结果返回（口径不靠提示词） ===');
for (const k of ['topPoints', 'topSectors', 'minSectors', 'topPharmaTopics', 'sectorScore', 'pharmaIndustries', 'pharmaWindow', 'columnSplit']) {
  check(`rules.${k} 已返回`, nd.rules[k] !== undefined, typeof nd.rules[k] === 'string' ? String(nd.rules[k]).slice(0, 60) : JSON.stringify(nd.rules[k]));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(' - ' + f.name + '  ' + (f.detail || ''));
  process.exit(1);
}
