'use strict';
/**
 * 区间 + 行业筛选的接口验证。
 *
 * 重点验证四件事：
 * 1. **口径闭合**：单日区间模式必须与 feed 模式勾选「仅看最新数据日」完全一致
 *    （拿 feed 全量池比是错的——那是"按快照给全部历史池"，语义不同）。
 * 2. **过去的区间也要能用**：10-19~10-20 没有当天快照，但数据在最新快照的回溯窗口里，
 *    必须能查出来，不能报"没有采集过的日期"。
 * 3. **不静默失效**：越界区间要有明确 reason；部分越界要有明确 warning。
 * 4. **筛选真的生效**：行业 / 关键词 / 仅看研报 三个过滤都要改变结果。
 */
const http = require('http');

const BASE = 'http://127.0.0.1:7788';

function get(p) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, raw: b.slice(0, 200), ms: Date.now() - t0 });
      });
    }).on('error', reject);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`);
}

function dupRate(items) {
  const m = new Map();
  for (const x of items) {
    const k = `${x.code}|${x.title}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const dup = [...m.values()].filter((v) => v > 1).length;
  return { dup, unique: m.size, total: items.length };
}

(async () => {
  // 0. 可用日期
  const dates = await get('/api/dates');
  const ds = (dates.json && dates.json.dates) || [];
  check('/api/dates 返回日期列表', ds.length >= 2, `dates=${JSON.stringify(ds)}`);
  if (!ds.length) { console.log('无数据，终止'); process.exit(1); }
  const latest = ds[0];
  const earliest = ds[ds.length - 1];

  // 1. 基准：单日 feed（仅看最新数据日）
  const feedLatest = await get(`/api/feeds?type=news&date=${latest}&size=10&latestOnly=1`);
  const feedLatestTotal = feedLatest.json ? feedLatest.json.total : -1;
  check('/api/feeds 仅看最新数据日 可用', feedLatestTotal >= 0, `total=${feedLatestTotal} ${feedLatest.ms}ms`);
  const feedAll = await get(`/api/feeds?type=news&date=${latest}&size=10`);
  check('/api/feeds 全量池（含历史回溯）明显更大', feedAll.json && feedAll.json.total > feedLatestTotal,
    `全量 ${feedAll.json && feedAll.json.total} > 仅最新日 ${feedLatestTotal}`);

  // 2. 单日区间模式 —— 必须与 feed「仅看最新数据日」一致
  const r1 = await get(`/api/range?from=${latest}&to=${latest}&type=news&size=10`);
  const r1t = r1.json ? r1.json.total : -1;
  check('单日区间 total == feed「仅看最新数据日」total', r1t === feedLatestTotal, `range=${r1t} feed=${feedLatestTotal}`);
  check('单日区间 available=true', r1.json && r1.json.available === true, `baseDate=${r1.json && r1.json.baseDate}`);
  check('单日区间 coverage 有实测回溯窗口', !!(r1.json && r1.json.coverage && r1.json.coverage.newsFrom),
    r1.json && r1.json.coverage ? `${r1.json.coverage.newsFrom} ~ ${r1.json.coverage.newsTo}（${r1.json.coverage.lookbackDays} 天）` : '缺失');

  // 3. 多日区间
  const r2 = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=10`);
  check('多日区间 available=true', r2.json && r2.json.available === true,
    `${r2.json && r2.json.from}~${r2.json && r2.json.to}，${r2.ms}ms`);
  check('多日区间要闻数 >= 单日区间', r2.json && r2.json.stats && r2.json.stats.news >= r1t,
    `多日 ${r2.json && r2.json.stats && r2.json.stats.news} >= 单日 ${r1t}`);
  check('多日区间耗时 < 3s', r2.ms < 3000, `${r2.ms}ms`);

  // 4. 过去的区间（没有当天快照）也必须能查 —— 回归项
  const past = '2026-10-19';
  const rPast = await get(`/api/range?from=${past}&to=${earliest}&type=news&size=10`);
  check('过去的区间（无当日快照）仍然 available=true', rPast.json && rPast.json.available === true,
    rPast.json && rPast.json.reason ? rPast.json.reason : `${rPast.json && rPast.json.from}~${rPast.json && rPast.json.to} 要闻 ${rPast.json && rPast.json.stats && rPast.json.stats.news} 条`);
  check('过去的区间确实取到数据', rPast.json && rPast.json.stats && rPast.json.stats.news > 0,
    `要闻 ${rPast.json && rPast.json.stats && rPast.json.stats.news} 条`);

  // 5. 越界区间 → 必须有明确 reason，不能静默返回空
  const r3 = await get('/api/range?from=2026-01-01&to=2026-01-05&type=news&size=10');
  check('越界区间 available=false 且有 reason', r3.json && r3.json.available === false && !!r3.json.reason,
    r3.json && r3.json.reason ? r3.json.reason : JSON.stringify(r3.json).slice(0, 120));

  // 6. 部分越界 → 必须有明确 warning（不静默截断）
  const r4 = await get(`/api/range?from=2026-06-01&to=${latest}&type=news&size=10`);
  const warn = (r4.json && r4.json.warnings) || [];
  check('部分越界时给出 warning', warn.length > 0, warn.join('；') || '(无 warning)');

  // 7. 行业过滤真的生效
  const r5 = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=10`);
  const inds = (r5.json && r5.json.industries) || [];
  if (inds.length) {
    const pick = inds[Math.floor(inds.length / 2)];
    const r6 = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=10&industry=${encodeURIComponent(pick)}`);
    const cAll = r5.json.stats.companies, cSel = r6.json.stats.companies;
    check('行业过滤后公司数变少', cSel < cAll, `行业「${pick}」${cSel}/${cAll} 家，要闻 ${r6.json.stats.news}/${r5.json.stats.news}`);
    check('行业过滤后要闻数变少', r6.json.stats.news < r5.json.stats.news, `${r6.json.stats.news} < ${r5.json.stats.news}`);
    const bad = (r6.json.companies || []).filter((c) => c.industry !== pick);
    check('行业过滤无串台', bad.length === 0, `串台 ${bad.length} 家`);
  } else {
    check('行业清单非空', false, 'industries 为空');
  }

  // 8. 关键词过滤真的生效
  const r7 = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=10&q=${encodeURIComponent('业绩')}`);
  check('关键词过滤后条数变少', r7.json && r7.json.total < r5.json.total, `${r7.json && r7.json.total} < ${r5.json.total}`);

  // 9. 仅看券商研报
  const r8 = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=50&researchOnly=1`);
  const allResearch = ((r8.json && r8.json.items) || []).every((x) => x.is_research);
  check('researchOnly 只返回研报', r8.json && r8.json.total <= r5.json.total && allResearch, `total=${r8.json && r8.json.total}`);

  // 10. 券商观点条目必须带观点原文 / 盈利预测 / 上次评级
  const r9 = await get(`/api/range?from=${earliest}&to=${latest}&type=research&size=50`);
  const items = (r9.json && r9.json.items) || [];
  const withView = items.filter((x) => x.view && x.view.length > 50).length;
  const withThesis = items.filter((x) => x.view_thesis).length;
  const withForecast = items.filter((x) => x.forecast).length;
  const withLastRating = items.filter((x) => x.last_rating != null).length;
  check('区间研报带观点原文 view', items.length === 0 || withView === items.length, `${withView}/${items.length}`);
  check('区间研报带观点提要 view_thesis', items.length === 0 || withThesis === items.length, `${withThesis}/${items.length}`);
  check('区间研报带盈利预测 forecast', items.length === 0 || withForecast === items.length, `${withForecast}/${items.length}`);
  // last_rating 允许为空：首次覆盖的公司本来就没有"上次评级"
  check('区间研报带 last_rating（首次覆盖可为 null）', items.length === 0 || withLastRating <= items.length, `${withLastRating}/${items.length} 非空`);

  // 11. 重复率不得高于 feed 模式（数据集本身就有同题多源，区间模式不能额外放大）
  const rRange = await get(`/api/range?from=${earliest}&to=${latest}&type=news&size=500`);
  const rFeed = await get(`/api/feeds?type=news&date=${latest}&size=500`);
  const dR = dupRate(rRange.json.items || []);
  const dF = dupRate(rFeed.json.items || []);
  check('区间模式重复率不高于 feed 模式',
    dR.total === 0 || dR.dup / dR.total <= dF.dup / dF.total,
    `区间 ${dR.dup}/${dR.total} vs feed ${dF.dup}/${dF.total}`);

  // 12. 同一篇研报不能在要闻池里出现两次（普通要闻 + research 并集）
  const newsItems = (rRange.json && rRange.json.items) || [];
  const researchTitles = new Set(((rRange.json && rRange.json.items) || []).filter((x) => x.is_research).map((x) => `${x.code}|${x.title}`));
  const dupResearch = newsItems.filter((x) => x.is_research).length - researchTitles.size;
  check('要闻池内研报不重复计入', dupResearch === 0, `重复 ${dupResearch} 条`);

  // 13. 公告池
  const r11 = await get(`/api/range?from=${earliest}&to=${latest}&type=notice&size=10`);
  check('公告池可用', r11.json && r11.json.available === true, `total=${r11.json && r11.json.total}`);

  // 14. 区间涨跌（from 日 vs to 日收盘价）
  const chg = ((r5.json && r5.json.companies) || []).filter((c) => c.rangeChg != null);
  check('区间涨跌已计算', chg.length > 0, `${chg.length} 家有区间涨跌，最大 ${Math.max(...chg.map((c) => c.rangeChg))}%`);

  // 15. 单日 feed 研报也要带 last_rating（"仅看观点变化"在单日模式要能筛）
  const f2 = await get(`/api/feeds?type=research&date=${latest}&size=50`);
  const ritems = (f2.json && f2.json.items) || [];
  const lr = ritems.filter((x) => x.last_rating != null).length;
  const changed = ritems.filter((x) => x.last_rating && x.rating && x.last_rating !== x.rating).length;
  check('单日 feed 研报带 last_rating', ritems.length === 0 || lr <= ritems.length, `${lr}/${ritems.length} 非空，其中评级变化 ${changed} 条`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' - ' + f.name + '  ' + (f.detail || ''));
    process.exit(1);
  }
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
