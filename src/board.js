'use strict';
/**
 * 把雷达数据集适配成 Mini App（kcb-intel）需要的 latest.json 形态。
 *
 * 两套界面共用同一份数据：Web 看板（web/）和 Mini App（miniapps/kcb-intel/）。
 * 这里做的是字段映射，Mini App 侧的渲染逻辑不动。
 */
const fs = require('fs');
const path = require('path');
const { buildNewsDigest } = require('./newsdigest');
const { summarizeView } = require('./summary');

/** 数据里最新的要闻/公告日期（事件与总结的窗口锚点，不能用采集日） */
function latestNewsDate(dataset) {
  let d = '';
  for (const c of dataset.companies || []) {
    for (const n of c.news || []) if (n.date > d) d = n.date;
    for (const n of c.notices || []) if (n.date > d) d = n.date;
  }
  return d || dataset.date || '';
}

function bare(code) { return String(code || '').split('.')[0]; }

function num(v) {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  const xs = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 评级分布 → Mini App 期望的 {买入,增持,中性,减持,卖出} */
function toRatingDist(dist) {
  if (!dist || !dist.length) return null;
  const out = { 买入: 0, 增持: 0, 中性: 0, 减持: 0, 卖出: 0 };
  let known = false;
  for (const d of dist) {
    if (out[d.rating] !== undefined) { out[d.rating] += d.count; known = true; }
  }
  return known ? out : null;
}

function mapCompany(c) {
  const q = c.quote || {};
  const v = c.valuation || {};
  const g = c.growth || {};
  const p = c.profitability || {};
  const research = (c.research || []).map((r) => ({
    date: r.date,
    title: r.title,
    url: r.url,
    content: r.content,
    parsed: {
      brokers: r.broker ? [r.broker] : [],
      ratingDist: toRatingDist(r.rating_distribution),
      epsForecast: null,
      epsGrowth: null,
      revenueForecast: r.forecast ? r.forecast.revenue_forecast : null,
      profitForecast: r.forecast ? r.forecast.profit_forecast : null,
      targetPrice: r.target_price ?? null,
      rating: r.rating || null,
      kind: r.kind || null,
    },
  }));

  // 卖方覆盖画像（90 天窗口）—— Mini App 的「观点分歧」矩阵靠它，
  // 不能用"近期研报"那一份，否则只有 7 天内发研报的公司才显示，矩阵几乎全空。
  const ss = c.sell_side || {};
  const ssEps = ss.eps || {};
  const sellRating = ss.rating || null;
  const sellTarget = ss.target_price ?? null;
  const sellUpside = (sellTarget != null && q.price != null && q.price > 0)
    ? ((sellTarget - q.price) / q.price) * 100
    : null;

  const firstResearch = (c.research || [])[0] || {};
  const ratingDist = toRatingDist(firstResearch.rating_distribution);
  const rating = sellRating || firstResearch.rating || null;
  const targetPrice = sellTarget ?? firstResearch.target_price ?? null;
  const upside = sellUpside != null
    ? sellUpside
    : ((targetPrice != null && q.price != null && q.price > 0)
      ? ((targetPrice - q.price) / q.price) * 100
      : null);

  return {
    code: bare(c.code),
    name: c.name,
    industry: c.industry || '',
    listDate: q.list_date || '',
    price: q.price ?? null,
    chg: q.change_pct ?? null,
    pe: q.pe ?? null,
    pb: q.pb ?? null,
    mktcap: q.total_mv ?? v.total_mv ?? null,
    floatcap: q.float_mv ?? v.float_mv ?? null,
    peTTM: v.pe_ttm ?? null,
    pbIf: v.pb ?? null,
    capIfind: v.total_mv ?? null,
    roe: p.roe_weighted ?? null,
    revYoY: g.revenue_yoy ?? null,
    profitYoY: g.net_profit_yoy ?? null,
    rating,
    ratingCount: ss.report_count_90d ?? firstResearch.institution_count ?? null,
    targetPrice,
    targetUpside: upside,
    consensusProfit: ssEps.next_two_year != null ? ssEps.next_two_year : null,
    epsForecast: ssEps.next_year ?? ssEps.this_year ?? null,
    inFocus: (c.score || 0) > 0,
    sellSideCovered: !!ss.covered,
    sellSideDate: ss.date || '',
    sellSideBroker: ss.broker || '',
    sellSideTitle: ss.title || '',
    sellSideUrl: ss.url || '',
    // 券商观点原文（第 2 层：被覆盖公司最新一篇研报的「投资要点」）
    // 全量抓取后 229 家里有 228 家能拿到，界面此前完全没用上——数据在库里但看不见。
    sellSideView: ss.view_thesis || null,
    // 内容总结：正文抽取式摘要（数字不被切断），Mini App 详情面板优先显示它
    sellSideSummary: summarizeView(ss.view || ss.view_thesis || '', { maxLen: 180 }),
    sellSideViewExcerpt: ss.view ? String(ss.view).slice(0, 600) : null,
    sellSideViewHas: !!ss.view_thesis,
    // 估值分位的实际历史长度（名义窗口 750 是写死的，次新股不成立）
    peHistoryDays: v.valuation_history_days ?? null,
    peWindowDays: v.valuation_window_days ?? null,
    focusReasons: (c.signals || []).map((s) => s.label).slice(0, 4),
    newsCount: (c.news || []).length,
    noticeCount: (c.notices || []).length,
    researchCount: research.length,
    research,
    latestNews: (c.news || []).slice(0, 3).map((n) => ({ date: n.date, title: n.title, url: n.url, content: n.content })),
    latestNotice: (c.notices || []).slice(0, 3).map((n) => ({ date: n.date, title: n.title, content: n.content })),
    pePct: v.pe_percentile ?? null,
    pbPct: v.pb_percentile ?? null,
    score: c.score || 0,
  };
}

function buildIndustryStats(companies) {
  const map = new Map();
  for (const c of companies) {
    const ind = c.industry || '未分类';
    if (!map.has(ind)) map.set(ind, []);
    map.get(ind).push(c);
  }
  const out = [];
  for (const [industry, list] of map) {
    const chgs = list.map((c) => (c.quote || {}).change_pct).filter((x) => x != null);
    out.push({
      industry,
      count: list.length,
      up: chgs.filter((x) => x > 0).length,
      down: chgs.filter((x) => x < 0).length,
      avgChg: chgs.length ? +(chgs.reduce((a, b) => a + b, 0) / chgs.length).toFixed(2) : null,
      totalMktcap: list.reduce((a, c) => a + ((c.quote || {}).total_mv || (c.valuation || {}).total_mv || 0), 0),
      medianPE: median(list.map((c) => (c.valuation || {}).pe_ttm)),
      lossCount: list.filter((c) => (c.growth || {}).net_profit_yoy != null && c.growth.net_profit_yoy < 0).length,
    });
  }
  out.sort((a, b) => b.totalMktcap - a.totalMktcap);
  return out;
}

function build(dataset) {
  const companies = dataset.companies.map(mapCompany);
  const chgs = companies.map((c) => c.chg).filter((x) => x != null);
  const focus = companies.filter((c) => c.sellSideCovered);

  const byChg = (a, b) => (b.chg ?? -999) - (a.chg ?? -999);
  const byMv = (a, b) => (b.mktcap ?? 0) - (a.mktcap ?? 0);

  const overview = {
    up: chgs.filter((x) => x > 0).length,
    down: chgs.filter((x) => x < 0).length,
    flat: chgs.filter((x) => x === 0).length,
    limitUp: companies.filter((c) => c.chg != null && c.chg >= 9.5).length,
    limitDown: companies.filter((c) => c.chg != null && c.chg <= -9.5).length,
    total: companies.length,
    lossyCount: companies.filter((c) => c.profitYoY != null && c.profitYoY < 0).length,
    peMedian: median(companies.map((c) => c.peTTM)),
    pbMedian: median(companies.map((c) => c.pb)),
    totalMktcap: companies.reduce((a, c) => a + (c.mktcap || 0), 0),
    avgChg: chgs.length ? +(chgs.reduce((a, b) => a + b, 0) / chgs.length).toFixed(2) : null,
  };

  // 「观点分歧」矩阵 = 近 90 天被卖方覆盖的公司（229 家），
  // 旧版用"重点池"，而新架构没有人工重点池，所以改用卖方覆盖集。
  const focusMatrix = companies.filter((c) => c.sellSideCovered).map((c) => {
    const bull = c.rating ? (/买入|增持|推荐/.test(c.rating) ? 1 : 0) : 0;
    const bear = c.rating ? (/减持|卖出/.test(c.rating) ? 1 : 0) : 0;
    return {
      ...c,
      divergence: c.pePct != null ? +(100 - c.pePct).toFixed(1) : undefined,
      bullRatio: bull ? 100 : (c.ratingCount ? 0 : undefined),
      bearRatio: bear ? 100 : undefined,
      targetUpside: c.targetUpside,
      ratingDist: c.ratingDist || null,
      brokers: c.sellSideBroker ? [c.sellSideBroker] : [],
      reasons: [c.sellSideDate ? `卖方覆盖 ${c.ratingCount} 篇（近90天）` : '卖方覆盖'].concat(
        c.focusReasons || []).slice(0, 4),
      research: c.sellSideTitle ? [{
        date: c.sellSideDate,
        title: c.sellSideTitle,
        url: c.sellSideUrl,
        parsed: { brokers: c.sellSideBroker ? [c.sellSideBroker] : [], ratingDist: null, epsForecast: c.epsForecast, epsGrowth: null },
      }] : c.research,
    };
  });

  // 热点：市场快讯 + 科创板事件类型分布（把"热点"做成两层：大盘快讯 + 本板事件）
  const hot = (dataset.trending || []).map((t) => ({
    scope: t.scope || '全市场',
    title: t.title,
    content: t.content,
    url: t.url,
    source: t.source,
    heat: t.heat,
  }));
  for (const e of (dataset.events || []).slice(0, 12)) {
    hot.push({
      scope: `科创板事件｜${e.cat}`,
      title: `${e.key}：涉及 ${e.companies} 家公司（${e.mentions} 次提及）`,
      content: `${e.companyList.slice(0, 12).map((c) => c.name).join('、')}`
        + (e.samples && e.samples[0] ? `　示例：${e.samples[0].title}` : ''),
      url: e.samples && e.samples[0] ? e.samples[0].url : '',
      source: '科创板雷达事件分布',
      heat: e.companies,
    });
  }

  // 风险：从公告标题里识别风险类事项
  const RISK_RE = /诉讼|仲裁|处罚|立案|问询|退市|风险警示|ST|冻结|质押|减持|终止|撤回|失败|事故/;
  const risk = [];
  for (const c of dataset.companies) {
    for (const n of c.notices || []) {
      if (RISK_RE.test(n.title)) {
        risk.push({ code: c.code, name: c.name, title: n.title, content: n.content, date: n.date });
      }
    }
  }

  return {
    date: dataset.date,
    generatedAt: new Date().toISOString(),
    meta: {
      universe: companies.length,
      // **来源必须透传实际取数源，不能写死**（2026-10-22 已因写死"东方财富"被纠正过一次：
      // 当期实际走的是腾讯兜底，署名却是东方财富，等于骗人）
      marketSource: (dataset.sources && dataset.sources.quotes) || '未知来源',
      ifindSource: (dataset.sources && dataset.sources.consensus) || '未获取',
      // ifindCovered 保持原语义（**有估值口径的家数**，Mini App 用它显示"覆盖 N 家财务/评级"）。
      // 2026-10-23 曾经误把它改成「iFinD 补充口径覆盖家数」，
      // 结果额度耗尽时 Mini App 会显示"覆盖 0 家财务"并报"未覆盖部分无财务与券商数据"——
      // 与事实相反（财务实际覆盖 618/619）。**同一个字段名换语义 = 骗人。**
      ifindCovered: companies.filter((c) => c.peTTM != null).length,
      // iFinD 补充口径与额度台账另起字段，不复用旧名
      ifindSupplement: (dataset.ifind && dataset.ifind.ifindCovered) || 0,
      ifindAttempts: (dataset.ifind && dataset.ifind.attempts) || 0,
      ifindMode: (dataset.ifind && dataset.ifind.mode) || 'off',
      ifindQuotaExhausted: !!(dataset.ifind && dataset.ifind.quotaExhausted),
      // 财务与估值分两个口径统计（2026-10-23 起财务主口径是东财 F10，不是 iFinD）
      // **必须从 dataset.companies 取**：`companies` 是 mapCompany 后的看板视图对象，
      // 里面没有 `revenue` 字段（在 `revYoY`），直接统计会恒为 0。
      financialCovered: (dataset.companies || []).filter((c) => c.revenue != null).length,
      financialSource: (dataset.sources && dataset.sources.financials) || '东方财富 F10（全量主口径）',
      focusCount: focus.length,
      sellSideCompanies: focus.length,
      sellSideBrokers: (dataset.stats && dataset.stats.sellSideBrokers) || 0,
      newsItems: companies.reduce((a, c) => a + c.newsCount, 0),
      hotItems: hot.length,
      riskItems: risk.length,
      rotation: {},
      buildMs: 0,
    },
    overview,
    index: (dataset.market && dataset.market.index_broadcast) ? {
      code: '000688', name: '科创50',
      price: (dataset.market.index || {}).kc50_point ?? null,
      chgPct: (dataset.market.index || {}).kc50_change_pct ?? null,
    } : { code: '000688', name: '科创50', price: null, chgPct: null },
    industryStats: buildIndustryStats(dataset.companies),
    // 要闻总结 / 大事板块 / 医药专章（与简报、看板同一套口径与同一份算法）
    newsDigest: buildNewsDigest(dataset.companies, { market: dataset.market, baseDate: latestNewsDate(dataset) }),
    topMovers: companies.slice().sort(byChg).slice(0, 20),
    topGainers: companies.slice().sort(byChg).slice(0, 20),
    topLosers: companies.slice().sort((a, b) => (a.chg ?? 999) - (b.chg ?? 999)).slice(0, 20),
    focusMatrix,
    diverged: focusMatrix.filter((m) => m.divergence != null && m.divergence >= 20),
    hot,
    risk: risk.slice(0, 100),
    companies: companies.sort(byMv),
  };
}

module.exports = { build, mapCompany };
