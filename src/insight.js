'use strict';
/**
 * 信号打分与简报组装。
 *
 * 用户明确不设人工关注池（全市场平权），因此"重点"由数据自己说话：
 * 每一家的信号分由可验证的事实自动计算——券商评级/目标价、重大公告、
 * 业绩预告、估值分位极值、当日大幅波动、增速突变。
 * 不引入任何人工偏好，避免对全市场厚此薄彼。
 */
const NOTICE_KEYWORDS = [
  { re: /授权许可|对外授权|License[- ]?out|独家许可/, weight: 5, label: '海外授权/许可' },  { re: /重大合同|中标|订单|框架协议/, weight: 4, label: '重大合同/中标' },
  { re: /收购|兼并|重大资产重组|控制权变更/, weight: 5, label: '并购重组' },
  { re: /定向增发|非公开发行|募集资金|可转债|配股/, weight: 3, label: '再融资' },
  { re: /业绩预告|业绩快报|业绩预增|业绩预亏|业绩预减/, weight: 5, label: '业绩预告' },
  { re: /股权激励|员工持股/, weight: 2, label: '股权激励' },
  { re: /停牌|复牌/, weight: 3, label: '停复牌' },
  { re: /减持|增持股份|回购/, weight: 3, label: '股东增减持/回购' },
  { re: /临床试验|适应症|获批上市|注册证书|NDA|FDA|突破性治疗/, weight: 5, label: '研发/上市里程碑' },
  { re: /诉讼|仲裁|处罚|立案|问询函|风险提示/, weight: 4, label: '诉讼/监管事项' },
];

const { extractSellSideByIndustry } = require('./events');
const { crossDayDiff } = require('./diff');
const { buildNewsDigest } = require('./newsdigest');
const { summarizeView } = require('./summary');

/**
 * 估值分位的**实际历史长度画像**。
 *
 * **口径硬伤（2026-10-21 实测）**：`valuation_window_days` 全样本统一写 750（≈3 年），
 * 但每家公司的 `valuation_history_days`（可用历史长度）实际从 20 到 1757 天不等——
 * 次新股天然更短。实测 PE 分位 394 家里 **38 家（9.6%）**不足 750 天（15 家不足 250 天），
 * PB 分位 609 家里 **54 家**不足 750 天（37 家不足 250 天）。
 *
 * 对这些标的，"近 3 年历史分位"其实是"近 N 月历史分位"，与真 3 年分位**不可直接横比**。
 * 因此必须把这条写进交付物，否则读者会把次新股的短历史分位与老公司的一视同仁。
 */
function valuationHistoryProfile(companies, nominalWindowDays = 750) {
  const daysOf = (c) => (c.valuation && c.valuation.valuation_history_days != null
    ? c.valuation.valuation_history_days : null);
  const bucketOf = (d) => (d < 30 ? 'lt30' : d < 90 ? 'd30_90' : d < 250 ? 'd90_250'
    : d < 500 ? 'd250_500' : d < nominalWindowDays ? 'd500_750' : 'full');
  const LABELS = {
    lt30: '不足 30 天', d30_90: '30~90 天', d90_250: '90~250 天',
    d250_500: '250~500 天', d500_750: '500~750 天', full: '满 750 天及以上',
  };
  const buckets = {};
  for (const k of Object.keys(LABELS)) buckets[k] = 0;
  const withDays = companies.filter((c) => daysOf(c) != null);
  for (const c of withDays) buckets[bucketOf(daysOf(c))]++;

  const peSamples = companies.filter((c) => c.valuation && c.valuation.pe_percentile != null);
  const pbSamples = companies.filter((c) => c.valuation && c.valuation.pb_percentile != null);
  const shortPe = peSamples.filter((c) => daysOf(c) != null && daysOf(c) < nominalWindowDays);
  const shortPb = pbSamples.filter((c) => daysOf(c) != null && daysOf(c) < nominalWindowDays);

  // **PE 分位的算术闭合**：619 = 1（无行情无 PE）+ 正 PE 403 + 负 PE 215；
  // 正 PE 403 = 有分位 394 + **正 PE 但无分位 9**（上市太短，算不出分位）。
  // 少写这 9 家，读者会以为 394 + 215 = 618 对不上账。
  const hasPe = companies.filter((c) => c.valuation && c.valuation.pe_ttm != null);
  const pePositive = hasPe.filter((c) => c.valuation.pe_ttm > 0);
  const peNegative = hasPe.filter((c) => c.valuation.pe_ttm < 0);
  const pePositiveNoPct = pePositive.filter((c) => c.valuation.pe_percentile == null);
  // 细分两种成因（**不要一律说成"上市太短"，那是错的**）：
  //  A) 近 3 年窗口内**有效正 PE 观测不足 60 个**（em.js pctOf 的硬门槛；
  //     亏损年份 PE 为负会被过滤掉，所以像恒烁股份历史 1002 天仍可能算不出），
  //     但全历史口径下仍能算出分位（pe_percentile_all 有值）；
  //  B) 连全历史口径都算不出 —— 这才是真正的上市太短。
  const peNoPctButAllHas = pePositiveNoPct.filter((c) => c.valuation.pe_percentile_all != null);
  const peNoPctAny = pePositiveNoPct.filter((c) => c.valuation.pe_percentile_all == null);

  return {
    nominalWindowDays,
    bucketLabels: LABELS,
    companiesWithHistory: withDays.length,
    historyBuckets: buckets,
    peSamples: peSamples.length,
    peShortHistory: shortPe.length,
    peShortHistoryUnder250: shortPe.filter((c) => daysOf(c) < 250).length,
    peShortList: shortPe
      .sort((a, b) => daysOf(a) - daysOf(b))
      .slice(0, 20)
      .map((c) => ({
        code: c.code, name: c.name, days: daysOf(c),
        percentile: c.valuation.pe_percentile, industry: c.industry || '',
      })),
    pbSamples: pbSamples.length,
    pbShortHistory: shortPb.length,
    pbShortHistoryUnder250: shortPb.filter((c) => daysOf(c) < 250).length,
    peClosure: {
      universe: companies.length,
      noPe: companies.length - hasPe.length,
      withPe: hasPe.length,
      pePositive: pePositive.length,
      peNegative: peNegative.length,
      positiveWithPercentile: peSamples.length,
      positiveWithoutPercentile: pePositiveNoPct.length,
      positiveWithoutPercentileButAllHistoryHas: peNoPctButAllHas.length,
      positiveWithoutPercentileAny: peNoPctAny.length,
      positiveWithoutPercentileList: pePositiveNoPct.slice(0, 12).map((c) => ({
        code: c.code, name: c.name, pe: c.valuation.pe_ttm,
        historyDays: daysOf(c),
        pe_percentile_all: c.valuation.pe_percentile_all ?? null,
        reason: c.valuation.pe_percentile_all != null
          ? '近3年窗口内有效正PE观测不足60（全历史口径可算）'
          : '上市太短，全历史口径也观测不足',
      })),
      formula: `${companies.length} 家 = ${companies.length - hasPe.length} 无 PE + ${pePositive.length} 正 PE（其中 ${peSamples.length} 家有分位、${pePositiveNoPct.length} 家近3年分位为空）+ ${peNegative.length} 负 PE（亏损不参与分布）`,
      note: '**正 PE 但近 3 年分位为空**不是数据缺失，而是**窗口内有效正 PE 观测不足 60 个**（em.js pctOf 的硬门槛；亏损年份 PE 为负会被过滤）。其中 ' + peNoPctButAllHas.length + ' 家历史足够长、只是近 3 年窗口内观测不足（全历史口径 pe_percentile_all 有值），' + peNoPctAny.length + ' 家才是真正的上市太短。两者不要混为一谈。',
    },
    note: `名义窗口 ${nominalWindowDays} 交易日（≈3 年）为统一写死值；实际每家的可用历史长度不同，`
      + '历史不足窗口的标的其"分位"实为短窗口分位，不可与真 3 年分位直接横比（多为次新股）。',
  };
}

const POSITIVE_RATINGS = ['买入', '增持', '首次覆盖', '强烈推荐', '推荐'];

function fmtChg(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function scoreCompany(company, ctx = {}) {
  const signals = [];
  let score = 0;

  // --- 券商观点（用 90 天存量覆盖画像，不只看近期新增）
  const research = company.research || [];
  const ss = company.sell_side || {};
  if (ss.covered) {
    score += 2;
    signals.push({ type: 'research', label: `卖方覆盖 ${ss.report_count_90d || 1} 篇`, weight: 2 });
    if (ss.rating) {
      const pos = POSITIVE_RATINGS.includes(ss.rating);
      score += pos ? 2 : 0;
      signals.push({
        type: 'rating',
        label: `${ss.broker || '券商'} ${ss.rating}${ss.last_rating && ss.last_rating !== ss.rating ? `（上次 ${ss.last_rating}）` : ''}`,
        weight: pos ? 2 : 1,
      });
    }
    if (ss.target_price != null) {
      score += 2;
      signals.push({ type: 'target_price', label: `目标价 ${ss.target_price} 元`, weight: 2 });
    }
    const eps = ss.eps || {};
    if (eps.this_year != null || eps.next_year != null) {
      score += 1;
      signals.push({
        type: 'forecast',
        label: `EPS预测 ${eps.this_year ?? '—'}/${eps.next_year ?? '—'}/${eps.next_two_year ?? '—'}`,
        weight: 1,
      });
    }
  }
  if (research.length) {
    score += Math.min(2, research.length);
    signals.push({ type: 'research_new', label: `近期研报 ${research.length} 篇`, weight: Math.min(2, research.length) });
  }

  // --- 公告信号（同一条公告只记一次，类型去重）
  const seenNoticeLabels = new Set();
  for (const n of company.notices || []) {
    for (const k of NOTICE_KEYWORDS) {
      if (!k.re.test(n.title)) continue;
      const key = `${k.label}::${n.title}`;
      if (seenNoticeLabels.has(key)) break;
      seenNoticeLabels.add(key);
      score += k.weight;
      signals.push({ type: 'notice', label: k.label, detail: n.title.slice(0, 60), weight: k.weight, date: n.date });
      break;
    }
  }

  // --- 估值极值（近 3 年口径，自算）
  const pct = company.valuation.pe_percentile;
  if (pct != null && pct >= 95) {
    score += 3;
    signals.push({ type: 'valuation', label: `PE 分位 ${pct}%（近3年高位）`, weight: 3 });
  } else if (pct != null && pct <= 10) {
    score += 3;
    signals.push({ type: 'valuation', label: `PE 分位 ${pct}%（近3年低位）`, weight: 3 });
  }
  const pbPct = company.valuation.pb_percentile;
  if (pbPct != null && pbPct >= 95) {
    score += 2;
    signals.push({ type: 'valuation', label: `PB 分位 ${pbPct}%（近3年高位）`, weight: 2 });
  } else if (pbPct != null && pbPct <= 10) {
    score += 2;
    signals.push({ type: 'valuation', label: `PB 分位 ${pbPct}%（近3年低位）`, weight: 2 });
  }

  // --- 当日大幅波动（行情源全量涨跌幅，比涨跌榜更精确）
  const chg = company.quote && company.quote.change_pct;
  if (chg != null && chg >= 9.5) {
    score += 4;
    signals.push({ type: 'move', label: `当日涨停 ${fmtChg(chg)}`, weight: 4 });
  } else if (chg != null && chg <= -9.5) {
    score += 4;
    signals.push({ type: 'move', label: `当日跌停 ${fmtChg(chg)}`, weight: 4 });
  } else if (chg != null && chg >= 5) {
    score += 3;
    signals.push({ type: 'move', label: `当日大涨 ${fmtChg(chg)}`, weight: 3 });
  } else if (chg != null && chg <= -5) {
    score += 3;
    signals.push({ type: 'move', label: `当日大跌 ${fmtChg(chg)}`, weight: 3 });
  }
  // 兜底：没有行情源时用涨跌榜名单
  const upList = ctx.gainers || [];
  const downList = ctx.losers || [];
  if (chg == null && upList.includes(company.code)) {
    score += 3;
    signals.push({ type: 'move', label: '当日涨幅居前', weight: 3 });
  }
  if (chg == null && downList.includes(company.code)) {
    score += 3;
    signals.push({ type: 'move', label: '当日跌幅居前', weight: 3 });
  }

  // --- 增速突变
  const revYoy = company.growth.revenue_yoy;
  if (revYoy != null && revYoy > 30) {
    score += 2;
    signals.push({ type: 'growth', label: `营收同比 +${revYoy.toFixed(1)}%`, weight: 2 });
  } else if (revYoy != null && revYoy < -30) {
    score += 3;
    signals.push({ type: 'growth', label: `营收同比 ${revYoy.toFixed(1)}%（大幅下滑）`, weight: 3 });
  }
  const npYoy = company.growth.net_profit_yoy;
  if (npYoy != null && npYoy < -40) {
    score += 3;
    signals.push({ type: 'growth', label: `净利润同比 ${npYoy.toFixed(1)}%`, weight: 3 });
  }

  // --- 重大市值公司（流动性/影响力）
  const mv = company.valuation.total_mv;
  if (mv != null && mv >= 5e10) {
    score += 1;
    signals.push({ type: 'size', label: `总市值 ${(mv / 1e8).toFixed(0)} 亿`, weight: 1 });
  }

  // 同一标签只保留权重最高的一条，避免首页出现三条一样的"业绩预告"
  const byLabel = new Map();
  for (const s of signals) {
    const prev = byLabel.get(s.label);
    if (!prev || s.weight > prev.weight) byLabel.set(s.label, s);
  }
  const finalSignals = [...byLabel.values()].sort((a, b) => b.weight - a.weight);
  return { score, signals: finalSignals };
}

/** 提取涨跌幅榜的代码列表 */
function extractCodeList(answer) {
  const codes = [];
  const re = /\b(\d{6}\.(?:SH|SZ))\b/g;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) codes.push(m[1]);
  return [...new Set(codes)];
}

/**
 * 组装简报数据。
 * @param {object} dataset 采集结果
 * @param {object} prev     上一日数据集（用于观点变化对比，可为 null）
 */
function buildBrief(dataset, prev = null) {
  const companies = dataset.companies || [];
  const market = dataset.market || {};

  const ctx = {
    gainers: market.gainers || [],
    losers: market.losers || [],
  };

  // 上日目标价/评级映射，用于观点变化对比
  const prevMap = new Map();
  if (prev) {
    for (const c of prev.companies || []) {
      const r = (c.research || [])[0];
      if (r) prevMap.set(c.code, { rating: r.rating, target_price: r.target_price, broker: r.broker });
    }
  }

  const scored = companies.map((c) => {
    const s = scoreCompany(c, ctx);
    const change = [];
    const p = prevMap.get(c.code);
    if (p) {
      const cur = (c.research || [])[0];
      if (cur) {
        if (p.target_price != null && cur.target_price != null && Math.abs(p.target_price - cur.target_price) > 1e-9) {
          const dir = cur.target_price > p.target_price ? '上调' : '下调';
          change.push(`目标价 ${p.target_price} → ${cur.target_price}（${dir}）`);
          s.score += 2;
          s.signals.unshift({ type: 'change', label: `目标价${dir} ${p.target_price}→${cur.target_price}`, weight: 2 });
        }
        if (p.rating && cur.rating && p.rating !== cur.rating) {
          change.push(`评级 ${p.rating} → ${cur.rating}`);
          s.score += 2;
          s.signals.unshift({ type: 'change', label: `评级 ${p.rating}→${cur.rating}`, weight: 2 });
        }
      }
    }
    return { ...c, score: s.score, signals: s.signals, viewpoint_change: change };
  });

  const highlights = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  // 最新数据日
  let latestDate = '';
  for (const c of companies) {
    for (const n of c.news || []) if (n.date > latestDate) latestDate = n.date;
    for (const n of c.notices || []) if (n.date > latestDate) latestDate = n.date;
  }

  const newsFeed = [];
  const researchFeed = [];
  const noticeFeed = [];
  for (const c of companies) {
    for (const n of c.news || []) {
      const item = {
        date: n.date, code: c.code, name: c.name, title: n.title, url: n.url,
        // **摘要必须透出**：东财要闻自带约 100 字摘要，此前没往接口里带，
        // 结果看板与简报里只剩光秃秃的标题（2026-10-22 用户直接指出"新闻都没有总结"）。
        content: n.content || '',
        // 匹配质量：'matched'=正文直接提及该公司；'weak'=仅行业/概念关联
        match: n.match || 'matched',
        is_research: !!n.is_research, broker: n.broker || null, rating: n.rating || null,
        // 上次评级：没有它，「仅看观点变化」勾选框在单日模式下筛不出任何东西
        last_rating: n.last_rating || null,
        target_price: n.target_price ?? null, forecast: n.forecast || null,
        kind: n.kind || 'mention',
        institution_count: n.institution_count ?? null,
        rating_distribution: n.rating_distribution || null,
        is_latest: n.date === latestDate,
      };
      newsFeed.push(item);
      if (n.is_research) {
        researchFeed.push({
          ...item,
          content: n.content,
          view: n.view || null,
          view_thesis: n.view_thesis || null,
          // **内容总结**（2026-10-23 用户要求：券商观点不能只有标题）。
          // 从研报正文（投资要点）里抽一段可读的摘要，数字不会被切断。
          summary: summarizeView(n.view || n.view_thesis || '', { maxLen: 180 }),
        });
      }
    }
    for (const n of c.notices || []) {
      noticeFeed.push({ date: n.date, code: c.code, name: c.name, title: n.title, content: n.content, is_latest: n.date === latestDate });
    }
  }
  newsFeed.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  researchFeed.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  noticeFeed.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const valuationTable = companies
    .filter((c) => c.valuation.pe_ttm != null || c.valuation.total_mv != null)
    .map((c) => ({
      code: c.code, name: c.name,
      industry: c.industry || '',
      change_pct: c.quote ? c.quote.change_pct : null,
      price: c.quote ? c.quote.price : null,
      pe_ttm: c.valuation.pe_ttm, pb: c.valuation.pb, ps_ttm: c.valuation.ps_ttm,
      pe_percentile: c.valuation.pe_percentile,
      pe_percentile_all: c.valuation.pe_percentile_all,
      pb_percentile: c.valuation.pb_percentile,
      total_mv: c.valuation.total_mv, float_mv: c.valuation.float_mv,
      revenue_yoy: c.growth.revenue_yoy, net_profit_yoy: c.growth.net_profit_yoy,
      roe: c.profitability.roe_weighted,
      score: scored.find((s) => s.code === c.code)?.score || 0,
    }));

  const financialTable = companies
    .filter((c) => c.revenue != null || c.growth.revenue_yoy != null)
    .map((c) => ({
      code: c.code, name: c.name,
      industry: c.industry || '',
      change_pct: c.quote ? c.quote.change_pct : null,
      revenue: c.revenue, revenue_yoy: c.growth.revenue_yoy,
      net_profit_attr: c.net_profit_attr, net_profit_yoy: c.growth.net_profit_yoy,
      gross_profit_yoy: c.growth.gross_profit_yoy,
      roe: c.profitability.roe_weighted, gross_margin: c.profitability.gross_margin,
      net_margin: c.profitability.net_margin,
      total_assets: c.total_assets, total_mv: c.valuation.total_mv,
      score: scored.find((s) => s.code === c.code)?.score || 0,
    }));

  const trending = (dataset.trending || []).slice().sort((a, b) => (b.heat || 0) - (a.heat || 0));

  // 卖方覆盖全景：90 天窗口内有研报覆盖的科创板公司
  const sellSide = companies
    .filter((c) => c.sell_side && c.sell_side.covered)
    .map((c) => ({
      code: c.code, name: c.name, industry: c.industry || '',
      broker: c.sell_side.broker,
      rating: c.sell_side.rating,
      last_rating: c.sell_side.last_rating,
      target_price: c.sell_side.target_price,
      date: c.sell_side.date,
      title: c.sell_side.title,
      eps: c.sell_side.eps,
      report_count: c.sell_side.report_count_90d,
      // 券商观点原文（第 2 层）——全量抓取后 229 家里有 228 家能拿到
      view_thesis: c.sell_side.view_thesis || null,
      view_excerpt: c.sell_side.view ? String(c.sell_side.view).slice(0, 400) : null,
      // 内容总结：正文抽取式摘要（数字不被切断），界面优先显示它
      summary: summarizeView(c.sell_side.view || c.sell_side.view_thesis || '', { maxLen: 180 }),
      price: c.quote ? c.quote.price : null,
      change_pct: c.quote ? c.quote.change_pct : null,
      pe_ttm: c.valuation.pe_ttm,
      pe_percentile: c.valuation.pe_percentile,
      total_mv: c.valuation.total_mv,
      upside: (c.sell_side.target_price != null && c.quote && c.quote.price)
        ? +(((c.sell_side.target_price - c.quote.price) / c.quote.price) * 100).toFixed(1) : null,
    }))
    .sort((a, b) => (b.report_count || 0) - (a.report_count || 0) || (b.date || '').localeCompare(a.date || ''));

  const sellSideStats = {
    covered_companies: sellSide.length,
    total_companies: companies.length,
    coverage_rate: companies.length ? +((sellSide.length / companies.length) * 100).toFixed(1) : 0,
    brokers: (dataset.stats && dataset.stats.sellSideBrokers) || 0,
    rating_dist: (dataset.stats && dataset.stats.sellSideRatingDist) || {},
    with_target_price: sellSide.filter((x) => x.target_price != null).length,
    avg_upside: (() => {
      const xs = sellSide.map((x) => x.upside).filter((x) => x != null);
      if (!xs.length) return null;
      return +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
    })(),
  };

  return {
    date: dataset.date,
    window: dataset.window,
    generatedAt: dataset.generatedAt,
    elapsedMs: dataset.elapsedMs,
    latestDate,
    stats: dataset.stats,
    sources: dataset.sources || {},
    // 历史回补标记（2026-10-27）：回补数据集的口径与实时采集不同，必须透出
    backfill: dataset.backfill || null,
    // iFinD 额度台账（2026-10-23 改造）：当日实际请求数 / 模式 / 覆盖家数 / 分工具明细
    ifind: dataset.ifind || null,
    degraded: dataset.degraded || [],
    market,
    events: dataset.events || [],
    eventsAll: dataset.eventsAll || [],
    // 跨日变化跟踪：没有上一日就返回 available:false（不编造对比）
    crossDay: crossDayDiff(prev, dataset),
    // 估值分位的实际历史长度画像（名义"近 3 年"对部分标的名不副实）
    valuationHistory: valuationHistoryProfile(companies),
    eventsByWindow: dataset.eventsByWindow || null,
    newsFreshness: dataset.newsFreshness || null,
    sellSideByIndustry: extractSellSideByIndustry(companies, sellSide),
    // 要闻总结 / 大事板块 / 医药专章（三端同源：简报、看板、Mini App 都读这一份）
    newsDigest: buildNewsDigest(scored, { market, baseDate: latestDate }),
    highlights,
    newsFeed,
    researchFeed,
    noticeFeed,
    trending,
    sellSide,
    sellSideStats,
    valuationTable,
    financialTable,
    companies: scored,
    coverage: {
      total: companies.length,
      withNews: companies.filter((c) => c.news.length).length,
      withResearch: companies.filter((c) => c.research.length).length,
      withNotice: companies.filter((c) => c.notices.length).length,
      withFinancials: companies.filter((c) => c.revenue != null).length,
      withValuation: companies.filter((c) => c.valuation.pe_ttm != null).length,
      withPercentile: companies.filter((c) => c.valuation.pe_percentile != null).length,
      newsItems: newsFeed.length,
      researchItems: researchFeed.length,
      noticeItems: noticeFeed.length,
    },
  };
}

module.exports = { scoreCompany, buildBrief, extractCodeList, NOTICE_KEYWORDS };
