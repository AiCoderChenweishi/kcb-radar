'use strict';
/**
 * 跨日变化跟踪（Cross-day delta）。
 *
 * **为什么这是老板真正要的东西**：每日简报现在是"当日截面"——今天有哪些新闻、
 * 今天估值多少。但对决策有用的是**变化**："昨天卖方说贵、今天说便宜"、
 * "昨天没覆盖、今天首次覆盖"、"昨天三季报归零"——这类事才是要动手的信号。
 *
 * 首日没有上一日可比，所以本模块在缺基线时返回 null（而不是编造对比）。
 * 从第二天起（07:30 采集跑完就有两份数据集），差分自动生效。
 *
 * 只报**可核对的突变**，不报噪声：
 * - 财务归零 / PE 变号 / 分位消失 → 数据质量突变，通常是接口侧出问题
 * - 评级升降 / 首次覆盖 / 掉覆盖 / 目标价变动 → 卖方观点变化
 * - 涨跌幅超阈值 → 当日异动
 * - 净利同比大幅变动 → 业绩预期突变
 */

const SEVERITY = { critical: 3, high: 2, medium: 1, low: 0 };

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function pct(v) { return num(v) == null ? null : +v.toFixed(2); }

/**
 * 多路径容错读取。
 *
 * 踩过的坑：同一批指标在数据集里的存放位置并不统一——
 * `revenue`/`net_profit_attr` 在公司顶层，`net_profit_yoy` 在 `growth` 与
 * `financials` 各有一份，`revenue_yoy` 同理。写死 `c.net_profit_yoy` 会静默拿到
 * undefined，差分就永远发现不了"净利同比突变"这类变化。
 * 因此统一用候选路径列表按优先级取第一个非空值。
 */
function pickField(c, paths) {
  for (const p of paths) {
    let v = c;
    for (const k of p.split('.')) {
      if (v == null) { v = undefined; break; }
      v = v[k];
    }
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

const F_REVENUE = ['revenue', 'financials.revenue'];
const F_NETPROFIT = ['net_profit_attr', 'financials.net_profit_attr'];
const F_NP_YOY = ['growth.net_profit_yoy', 'financials.net_profit_yoy'];
const F_REV_YOY = ['growth.revenue_yoy', 'financials.revenue_yoy'];
const F_PE = ['valuation.pe_ttm'];
const F_PE_PCT = ['valuation.pe_percentile'];
const F_PB_PCT = ['valuation.pb_percentile'];
const F_CHG = ['quote.change_pct'];

/**
 * @param {object} prev 上一日数据集
 * @param {object} cur  当日数据集
 * @returns {object} 差分结果
 */
function diffDatasets(prev, cur) {
  const prevMap = new Map((prev.companies || []).map((c) => [c.code, c]));
  const curMap = new Map((cur.companies || []).map((c) => [c.code, c]));

  const added = [];
  for (const [code, c] of curMap) {
    if (!prevMap.has(code)) added.push({ code, name: c.name, industry: c.industry || '' });
  }
  const removed = [];
  for (const [code, c] of prevMap) {
    if (!curMap.has(code)) removed.push({ code, name: c.name, industry: c.industry || '' });
  }

  const financialAnomalies = [];
  const valuationAnomalies = [];
  const sellSideChanges = [];
  const quoteMoves = [];
  const growthShifts = [];

  for (const [code, c] of curMap) {
    const p = prevMap.get(code);
    if (!p) continue;
    const name = c.name;

    // ---- 财务突变 ----
    const rev = pickField(c, F_REVENUE), revP = pickField(p, F_REVENUE);
    // **双向检测**：昨天归零今天恢复，和昨天正常今天归零，同样是数据源异常信号。
    // 只做单向的话，"接口昨天挂了今天修好"这种变化会被漏掉。
    if (revP != null && rev == null) {
      financialAnomalies.push({ code, name, type: '营收缺失', detail: `营收 ${fmtYi(revP)} → 未获取`, severity: 'critical' });
    } else if (revP != null && rev === 0) {
      financialAnomalies.push({ code, name, type: '营收归零', detail: `营收 ${fmtYi(revP)} → 0`, severity: 'critical' });
    } else if (revP === 0 && rev != null && rev !== 0) {
      financialAnomalies.push({ code, name, type: '营收从 0 恢复', detail: `营收 0 → ${fmtYi(rev)}`, severity: 'critical' });
    } else if (revP != null && rev != null && revP > 0 && Math.abs(rev - revP) / revP > 0.5) {
      financialAnomalies.push({ code, name, name2: undefined, type: '营收大幅变动', detail: `营收 ${fmtYi(revP)} → ${fmtYi(rev)}`, severity: 'high' });
    }
    const np = pickField(c, F_NETPROFIT), npP = pickField(p, F_NETPROFIT);
    if (npP != null && np === 0) {
      financialAnomalies.push({ code, name, type: '归母净利归零', detail: `归母净利 ${fmtYi(npP)} → 0`, severity: 'critical' });
    } else if (npP != null && np != null && npP !== 0 && Math.sign(np) !== Math.sign(npP)) {
      financialAnomalies.push({ code, name, type: '净利盈亏反转', detail: `归母净利 ${fmtYi(npP)} → ${fmtYi(np)}`, severity: 'critical' });
    }

    // 净利同比突变
    const ny = pickField(c, F_NP_YOY), nyP = pickField(p, F_NP_YOY);
    if (ny != null && nyP != null && Math.abs(ny - nyP) >= 50) {
      growthShifts.push({ code, name, type: '净利同比变动', detail: `同比 ${pct(nyP)}% → ${pct(ny)}%`, severity: 'high' });
    }

    // ---- 估值突变 ----
    const pe = pickField(c, F_PE), peP = pickField(p, F_PE);
    if (peP != null && pe != null && Math.sign(pe) !== Math.sign(peP)) {
      valuationAnomalies.push({ code, name, type: 'PE 变号', detail: `PE ${pct(peP)} → ${pct(pe)}`, severity: 'critical' });
    }
    const pq = pickField(c, F_PE_PCT), pqP = pickField(p, F_PE_PCT);
    if (pqP != null && pq == null) {
      valuationAnomalies.push({ code, name, type: 'PE 分位消失', detail: `PE 分位 ${pct(pqP)}% → 未获取`, severity: 'high' });
    } else if (pqP == null && pq != null) {
      valuationAnomalies.push({ code, name, type: 'PE 分位新增', detail: `PE 分位 未获取 → ${pct(pq)}%`, severity: 'medium' });
    }
    const pbq = pickField(c, F_PB_PCT), pbqP = pickField(p, F_PB_PCT);
    if (pbqP != null && pbq == null) {
      valuationAnomalies.push({ code, name, type: 'PB 分位消失', detail: `PB 分位 ${pct(pbqP)}% → 未获取`, severity: 'high' });
    }

    // ---- 卖方观点变化 ----
    const cs = c.sell_side || {}, ps = p.sell_side || {};
    if (cs.covered && !ps.covered) {
      sellSideChanges.push({ code, name, type: '首次覆盖', detail: `${cs.broker || '—'}｜${cs.rating || '无评级'}｜${cs.date || ''}`, severity: 'high' });
    } else if (!cs.covered && ps.covered) {
      sellSideChanges.push({ code, name, type: '覆盖消失', detail: `上一日 ${ps.broker || '—'} 覆盖，本日无`, severity: 'medium' });
    } else if (cs.covered && ps.covered) {
      if (cs.rating && ps.rating && cs.rating !== ps.rating) {
        const dir = isBullish(cs.rating) && !isBullish(ps.rating) ? '评级上调'
          : (!isBullish(cs.rating) && isBullish(ps.rating) ? '评级下调' : '评级变动');
        sellSideChanges.push({ code, name, type: dir, detail: `${ps.rating}（${ps.broker || '—'}）→ ${cs.rating}（${cs.broker || '—'}）`, severity: 'high' });
      }
      const tp = num(cs.target_price), tpP = num(ps.target_price);
      if (tp != null && tpP != null && Math.abs(tp - tpP) > 0.01) {
        const pctMove = tpP > 0 ? ((tp - tpP) / tpP) * 100 : null;
        const r2 = (x) => Math.round(x * 100) / 100;
        sellSideChanges.push({
          code, name, type: '目标价调整',
          detail: `${r2(tpP)} 元 → ${r2(tp)} 元${pctMove != null ? `（${pctMove > 0 ? '+' : ''}${pctMove.toFixed(1)}%）` : ''}`,
          severity: 'high',
        });
      } else if (tp != null && tpP == null) {
        sellSideChanges.push({ code, name, type: '新增目标价', detail: `${Math.round(tp * 100) / 100} 元`, severity: 'high' });
      }
    }

    // ---- 当日异动 ----
    const chg = pickField(c, F_CHG);
    if (chg != null && Math.abs(chg) >= 9) {
      quoteMoves.push({ code, name, type: chg > 0 ? '大涨' : '大跌', detail: `${pct(chg)}%`, severity: Math.abs(chg) >= 15 ? 'high' : 'medium' });
    }
  }

  // ---- 事件类型分布变化（数据集级） ----
  const eventDelta = diffEventCounts(prev, cur);

  const items = [
    ...financialAnomalies.map((x) => ({ ...x, group: '数据质量' })),
    ...valuationAnomalies.map((x) => ({ ...x, group: '数据质量' })),
    ...sellSideChanges.map((x) => ({ ...x, group: '卖方观点' })),
    ...growthShifts.map((x) => ({ ...x, group: '业绩预期' })),
    ...quoteMoves.map((x) => ({ ...x, group: '市场异动' })),
  ].sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));

  return {
    from: prev.date,
    to: cur.date,
    universe: { prev: (prev.companies || []).length, cur: (cur.companies || []).length },
    added,
    removed,
    counts: {
      dataQuality: financialAnomalies.length + valuationAnomalies.length,
      sellSide: sellSideChanges.length,
      growth: growthShifts.length,
      quoteMoves: quoteMoves.length,
    },
    financialAnomalies,
    valuationAnomalies,
    sellSideChanges,
    growthShifts,
    quoteMoves,
    eventDelta,
    items,
    headline: items.slice(0, 12).map((x) => `${x.name}(${x.code})｜${x.type}｜${x.detail}`),
  };
}

function diffEventCounts(prev, cur) {
  const p = new Map((prev.events || []).map((e) => [e.key, e.companies]));
  const c = new Map((cur.events || []).map((e) => [e.key, e.companies]));
  const out = [];
  for (const [k, v] of c) {
    const pv = p.get(k);
    if (pv == null) out.push({ key: k, from: null, to: v, delta: null, note: '新增事件类型' });
    else if (Math.abs(v - pv) >= 5) out.push({ key: k, from: pv, to: v, delta: v - pv });
  }
  for (const [k, v] of p) {
    if (!c.has(k)) out.push({ key: k, from: v, to: null, delta: null, note: '事件类型消失' });
  }
  return out.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0)).slice(0, 15);
}

function isBullish(rating) {
  return /买入|增持|推荐|强烈/.test(String(rating || ''));
}

function fmtYi(v) {
  if (v == null) return '未获取';
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(0)} 万`;
  return String(v);
}

/**
 * 取上一日与当日做差；没有上一日就返回 null（不编造）。
 */
function crossDayDiff(prev, cur) {
  if (!prev || !cur) {
    return {
      available: false,
      reason: prev ? '上一日数据集缺失' : '没有上一日基线（首日采集）',
      from: null, to: cur ? cur.date : null,
    };
  }
  const d = diffDatasets(prev, cur);
  return { available: true, ...d };
}

module.exports = { diffDatasets, crossDayDiff, isBullish };
