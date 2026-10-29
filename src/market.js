'use strict';
/**
 * 科创板市场层面数据。
 *
 * 指数（科创50/科创综指）在 iFinD 的 A 股指标接口里无法稳定取到——
 * "000688" 会被解析成深市国城矿业而不是上证科创50指数；
 * 恒生接口只覆盖沪深个股，不含指数。
 * 因此指数点位从新华财经的收盘播报正文里抽取（东财指数行情兜底），
 * **市场宽度则完全由东方财富行情快照自算**（2026-10-23 改造，理由见 collectMarket 注释）。
 */
const { callTool, quotaBlocked } = require('./connector');
const cfg = require('./config');
const em = require('./em');

const TOOL = 'connector__thsifind__search_securities';

async function countStocks(query) {
  const d = await callTool(TOOL, { market: '股票', query });
  return { count: (d && d.selectedSecuritiesCount) || 0, answer: (d && d.answer) || '' };
}

/** 从收盘播报类资讯里抽取科创板核心指标 */
function parseMarketSummary(text) {
  const out = {};
  const t = String(text || '');

  const idx50 = /科创50指数[^。]{0,40}?报\s*([\d\.]+)\s*点[，,]\s*(涨|跌)\s*([\d\.]+)%/.exec(t);
  if (idx50) {
    out.kc50_point = Number(idx50[1]);
    out.kc50_change_pct = Number(idx50[3]) * (idx50[2] === '跌' ? -1 : 1);
  }
  const idxComp = /科创综指[^。]{0,40}?(?:报\s*([\d\.]+)\s*点[，,]\s*(涨|跌)\s*([\d\.]+)%)?/.exec(t);
  if (idxComp && idxComp[1]) {
    out.kc_comp_point = Number(idxComp[1]);
    out.kc_comp_change_pct = Number(idxComp[3]) * (idxComp[2] === '跌' ? -1 : 1);
  }
  const avg = /平均涨幅\s*([\-\d\.]+)%/.exec(t);
  if (avg) out.avg_change_pct = Number(avg[1]);
  const turn = /平均换手率\s*([\d\.]+)%/.exec(t);
  if (turn) out.avg_turnover_pct = Number(turn[1]);
  const amount = /合计成交额约?\s*([\d\.]+)\s*亿元/.exec(t);
  if (amount) out.total_amount_yi = Number(amount[1]);
  const amp = /平均振幅为?\s*([\d\.]+)%/.exec(t);
  if (amp) out.avg_amplitude_pct = Number(amp[1]);
  const stocks = /科创板其余?\s*(\d+)\s*只个股/.exec(t);
  if (stocks) out.traded_count = Number(stocks[1]);
  const upCount = /今日上涨的有\s*(\d+)\s*只[，,]\s*占\s*([\d\.]+)%/.exec(t);
  if (upCount) { out.rising_count = Number(upCount[1]); out.rising_pct = Number(upCount[2]); }
  const idxAmount = /总成交额约?\s*([\d\.]+)\s*亿元/.exec(t);
  if (idxAmount) out.index_amount_yi = Number(idxAmount[1]);
  return out;
}

/**
 * 采集市场层面数据。
 *
 * **市场宽度（涨跌家数/涨跌幅分档/市值分档）不再走 iFinD 选股接口**（2026-10-23 改造）：
 * `src/quote.js` 的 `mergeQuotes` 已经从**免费的东方财富行情快照**算出全部 8 个口径
 * （rising/falling/up5/down5/up9/down9/mv_over_200yi/mv_over_50yi，还多给 flat 与 mv_over_100yi），
 * 而采集器本来就会用东财结果**覆盖** iFinD 的结果 ——
 * 也就是说那 8 次调用（8 次/天 ≈ 240 次/月）**返回值从来不会被采用**。
 * iFinD 免费试用版只有 2,000 次永久额度，这种纯浪费必须砍掉。
 *
 * @param {Array} trending trending 资讯（用于抽取收盘播报）
 * @param {object} quoteInfo 东财行情合并结果（{breadth, gainers, losers}）
 */
async function collectMarket(trending = [], quoteInfo = null) {
  const out = { breadth: {}, index: {}, source: {}, failures: [] };
  const emBreadth = (quoteInfo && quoteInfo.breadth) || null;

  // 优先用东财自算口径（免费、精确、全量）。只有 full 模式且东财口径缺失时才回退 iFinD。
  if (emBreadth && emBreadth.rising != null) {
    out.breadth = { ...emBreadth };
    out.source.breadth = '东方财富行情快照（全量精确统计）';
    out.gainers = (quoteInfo && quoteInfo.gainers) || [];
    out.losers = (quoteInfo && quoteInfo.losers) || [];
    out.limit_ups = emBreadth.limit_ups || [];
    out.limit_downs = emBreadth.limit_downs || [];
  } else if (cfg.IFIND_MODE === 'full' && !quotaBlocked()) {
    const breadthQueries = [
      ['rising', '科创板今日上涨的股票'],
      ['falling', '科创板今日下跌的股票'],
      ['up5', '科创板今日涨幅大于5%的股票'],
      ['down5', '科创板今日跌幅大于5%的股票'],
      ['up9', '科创板今日涨幅大于9.5%的股票'],
      ['down9', '科创板今日跌幅大于9.5%的股票'],
      ['mv_over_200yi', '科创板总市值大于200亿元的股票'],
      ['mv_over_50yi', '科创板总市值大于50亿元的股票'],
    ];

    const results = await Promise.all(breadthQueries.map(async ([key, q]) => {
      try {
        const r = await countStocks(q);
        return [key, r.count, r.answer];
      } catch (e) {
        out.failures.push({ scope: 'breadth', key, error: e.message });
        return [key, null, ''];
      }
    }));
    const answers = {};
    for (const [key, val, ans] of results) {
      out.breadth[key] = val;
      if (ans) answers[key] = ans;
    }
    out.source.breadth = 'iFinD 智能选股（full 模式回退）';

    // 涨跌幅榜的个股清单（answer 里含表格，代码可直接抽取）
    const codeRe = /\b(\d{6}\.(?:SH|SZ))\b/g;
    const grab = (key) => {
      const ans = answers[key] || '';
      const set = new Set();
      let m;
      while ((m = codeRe.exec(ans)) !== null) set.add(m[1]);
      return [...set];
    };
    out.gainers = [...new Set([...grab('up5'), ...grab('up9')])];
    out.losers = [...new Set([...grab('down5'), ...grab('down9')])];
    out.limit_ups = grab('up9');
    out.limit_downs = grab('down9');
  } else {
    // 东财行情口径缺失且不允许回退 iFinD → 如实留空，由采集器写进降级项
    out.breadth = {};
    out.source.breadth = '未获取（东方财富行情快照缺失，且精简口径不回退 iFinD）';
  }

  // 收盘播报 → 指数与总量
  const summaryItem = trending.find((x) => /收盘播报|科创综指|科创50指数/.test(x.title || ''));
  if (summaryItem) {
    Object.assign(out.index, parseMarketSummary(`${summaryItem.title} ${summaryItem.content}`));
    out.source.index = `新华财经收盘播报（${summaryItem.source || '财经媒体'}）`;
    out.index_broadcast = {
      title: summaryItem.title,
      url: summaryItem.url,
      content: String(summaryItem.content || '').slice(0, 1400),
    };
  }

  out.total_count = (out.breadth.rising || 0) + (out.breadth.falling || 0) || null;
  out.capturedAt = new Date().toISOString();
  return out;
}

/**
 * 指数与快讯的东方财富兜底。
 * iFinD 额度耗尽时 trending / 指数点位都拿不到，
 * 东方财富的指数行情与 7×24 快讯可以完整补上这两块。
 */
async function fillFromEastmoney(market, trending) {
  // 指数
  try {
    let idx = await em.fetchIndices();
    let src = '东方财富指数行情（1.000688 科创50 / 1.000680 科创综指）';
    if (!idx || !idx.kc50) {
      // 东财 push2 被封时的腾讯兜底
      const tx = await em.fetchIndicesTencent();
      if (tx && tx.kc50) { idx = { ...(idx || {}), ...tx }; src = '腾讯指数行情（东方财富暂不可用）'; }
    }
    if (idx && idx.kc50) {
      market.index.kc50_point = idx.kc50.point;
      market.index.kc50_change_pct = idx.kc50.change_pct;
      market.index.kc50_amount_yi = idx.kc50.amount_yi;
    }
    if (idx && idx.kc_comp) {
      market.index.kc_comp_point = idx.kc_comp.point;
      market.index.kc_comp_change_pct = idx.kc_comp.change_pct;
      market.index.kc_comp_amount_yi = idx.kc_comp.amount_yi;
    }
    if (idx && idx.kc100) {
      market.index.kc100_point = idx.kc100.point;
      market.index.kc100_change_pct = idx.kc100.change_pct;
    }
    if (idx && idx.kc_comp && idx.kc_comp.amount_yi) {
      market.index.total_amount_yi = idx.kc_comp.amount_yi;
    }
    if (idx && idx.kc50 && !market.source.index) {
      market.source.index = src;
    }
  } catch { /* ignore */ }

  // 快讯（仅在 iFinD trending 无数据时补）
  if (!trending || !trending.length) {
    try {
      const hot = await em.fetchHotNews(20);
      if (hot.length) {
        trending.push(...hot);
        market.source.hot = '东方财富 7×24 快讯（iFinD 额度耗尽降级）';
      }
    } catch { /* ignore */ }
  }

  return { market, trending };
}

module.exports = { collectMarket, parseMarketSummary, countStocks, fillFromEastmoney };
