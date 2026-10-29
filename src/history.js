'use strict';
/**
 * **历史行情回补**（2026-10-27 新增）。
 *
 * 为什么需要它：2026-10-24/25/26 三天机器不可用，采集任务一次都没触发，
 * 数据集缺失（其中 10-26 是周一交易日）。事后补采时，**行情不能直接用实时快照** ——
 * 东方财富 push2 的 clist 只给"此刻"的行情，拿到的会是 10-27 的价格却标成 10-26，
 * 那是编造，不是回补。
 *
 * 回补用的两个权威源（都是**按日**的真实数据）：
 *   1) `push2his` 日 K 线 → 指定日期的开/收/高/低/成交量/成交额/振幅/涨跌幅/换手率
 *      字段序：f51 日期, f52 开盘, f53 收盘, f54 最高, f55 最低, f56 成交量(手),
 *              f57 成交额(元), f58 振幅%, f59 涨跌幅%, f60 涨跌额, f61 换手率%
 *   2) `RPT_VALUEANALYSIS_DET`（东财 datacenter）→ 该日期的 PE/PB/PS/PCF/PEG、
 *      **总市值、流通市值、总股本、流通股本**、收盘价、涨跌幅
 *      （`em.fetchValuationHistory(code, {asOf, full:true})` 统一取）
 *
 * **非交易日（周末/节假日）怎么办**：
 *   - K 线里没有该日 → 收盘价沿用**最近交易日**，并标注 `as_of`；
 *   - **涨跌幅记 0**（当日无交易，日涨跌按定义为 0，不是编造）；
 *   - 换手率/成交量/成交额/振幅留空（当日确实没有成交）。
 *   这样「休市日」在看板里表现为"涨 0 / 跌 0 / 平 N"，语义正确。
 */
const em = require('./em');

const KLINE_HOST = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

/** 科创板 688 开头属沪市 → secid 前缀 1；其余按 6 位代码首位判断 */
function secidOf(code) {
  const bare = String(code || '').split('.')[0];
  return (bare.startsWith('6') ? '1.' : '0.') + bare;
}

function ymd(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

function compact(dateStr) {
  return String(dateStr).replace(/-/g, '');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 取指定区间的日 K 线。
 *
 * **这是"增强"而不是"依赖"**（2026-10-27 实测踩出来的）：
 * push2his 在高频请求下会整片 ECONNRESET（实测回补跑 15 分钟、约 3700 次请求后，
 * 连打 12 只全部被拒；同一时段 datacenter 的估值序列 618/619 家全部正常）。
 * 而估值序列（`RPT_VALUEANALYSIS_DET`）本身就有该日期的 **CLOSE_PRICE 与 CHANGE_RATE**，
 * 实测与 K 线逐字一致（亚虹医药 10-26：K 线 -1.50 / 估值序列 -1.496259…）。
 * 所以：价格与涨跌幅以估值序列为主口径，K 线只补它独有的换手率/成交量/成交额/振幅，
 * **拿不到就留空，不影响主口径**。
 *
 * @returns {Array<{date,open,close,high,low,volume,amount,amplitude,change_pct,change_amount,turnover}>}
 */
async function fetchDailyKline(code, fromDate, toDate) {
  const url = KLINE_HOST
    + `?secid=${secidOf(code)}&klt=101&fqt=0`
    + `&beg=${compact(fromDate)}&end=${compact(toDate)}`
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  for (let attempt = 0; attempt < 2; attempt++) {
    let j;
    try {
      j = await em.getJson(url);
    } catch (e) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const lines = (j && j.data && j.data.klines) || [];
    if (!lines.length) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const out = [];
    for (const line of lines) {
      const p = String(line).split(',');
      if (p.length < 11) continue;
      out.push({
        date: p[0],
        open: num(p[1]), close: num(p[2]), high: num(p[3]), low: num(p[4]),
        volume: num(p[5]), amount: num(p[6]), amplitude: num(p[7]),
        change_pct: num(p[8]), change_amount: num(p[9]), turnover: num(p[10]),
      });
    }
    return out;
  }
  return [];
}

/**
 * 为全量科创板公司构建「指定日期」的行情快照。
 *
 * @returns {{rows:Array, source:string, quoteDate:string, tradingDay:boolean, covered:number, exact:number}}
 */
async function buildHistoryQuotes(universe, dateStr, log = () => {}, opts = {}) {
  const concurrency = opts.concurrency || 5;
  const from = opts.from || ymd(new Date(new Date(dateStr + 'T00:00:00Z').getTime() - 20 * 86400000));
  const rows = [];
  let covered = 0;
  let exact = 0;
  let quoteDate = dateStr;
  let tradingDay = true;
  // **K 线熔断**：被限流时（ECONNRESET）继续打只是浪费时间和加重封禁，
  // 而主口径靠估值序列并不依赖它。连续失败达阈值就整轮不再请求日 K。
  let klineFailStreak = 0;
  let klineDisabled = false;
  const KLINE_FAIL_THRESHOLD = opts.klineFailThreshold || 20;

  let idx = 0;
  const workers = [];
  const runOne = async (u) => {
    const code = u.code;
    const val = await em.fetchValuationHistory(code, { asOf: dateStr, full: true });
    let klines = [];
    if (!klineDisabled) {
      klines = await fetchDailyKline(code, from, dateStr);
      if (klines.length) {
        klineFailStreak = 0;
      } else {
        klineFailStreak++;
        if (klineFailStreak >= KLINE_FAIL_THRESHOLD && !opts.klineDisabled) {
          klineDisabled = true;
          log(`[history] push2his 日K 连续 ${klineFailStreak} 次失败（疑似限流），本轮停止请求日K；收盘价与涨跌幅由东财逐日估值口径提供，不受影响`);
        }
      }
    }
    // K 线里取「当天或之前最近的一根」
    // **klines 是按日期升序**，所以要一路往后覆盖，取最后一个 ≤ date 的；
    // 写成"遇到第一个就 break"会取到最早的那根（实测把 10-26 错取成 10-08）。
    let bar = null;
    for (const k of klines) {
      if (k.date <= dateStr) bar = k;
      else break;
    }
    // **估值序列是主口径**（datacenter 比 push2his 稳得多）：
    // 它给出该日期的 CLOSE_PRICE 与 CHANGE_RATE，实测与 K 线逐字一致。
    const valDate = val ? val.as_of : null;
    const valExact = valDate === dateStr;
    // 当日是否真的成交：估值行的日期 == 目标日（K 线拿不到时用它判断）
    const tradedOn = valExact || !!(bar && bar.date === dateStr && bar.date === dateStr);
    if (bar && bar.date > quoteDate) quoteDate = bar.date;

    const price = (bar && bar.close != null) ? bar.close
      : (val && val.close_price != null ? val.close_price : null);
    // 涨跌幅：**当日成交**才取真实值；休市/停牌一律记 0（当日无交易，按定义为 0）
    const changePct = tradedOn
      ? ((bar && bar.date === dateStr && bar.change_pct != null) ? bar.change_pct
        : (val && val.change_rate != null ? val.change_rate : null))
      : 0;
    // **统一保留两位小数**：线上口径的涨跌幅来自 push2 的 f3（两位），
    // 估值序列的 CHANGE_RATE 是全精度，直接用会让看板/简报的数字形态与实时采集日不一致。
    const round2 = (v) => (v == null ? null : +Number(v).toFixed(2));
    const row = {
      code,
      bareCode: String(code).split('.')[0],
      name: u.name || '',
      price: round2(price),
      change_pct: round2(changePct),
      change_amount: tradedOn && bar && bar.date === dateStr ? round2(bar.change_amount) : 0,
      pe: val ? val.pe_ttm : null,
      pb: val ? val.pb_mrq : null,
      total_mv: val ? val.total_mv : null,
      float_mv: val ? val.float_mv : null,
      total_shares: val ? val.total_shares : null,
      free_shares: val ? val.free_shares : null,
      // 下面四个只有 K 线有，拿不到就留空（不影响主口径）
      turnover: tradedOn && bar && bar.date === dateStr ? bar.turnover : null,
      amount: tradedOn && bar && bar.date === dateStr ? bar.amount : null,
      volume: tradedOn && bar && bar.date === dateStr ? bar.volume : null,
      amplitude: tradedOn && bar && bar.date === dateStr ? bar.amplitude : null,
      listDate: '',
      industry: '',
      // 溯源：这一行的行情与估值分别来自哪一天
      __quote_date: valDate || (bar ? bar.date : null),
      __valuation_date: valDate,
      __kline_date: bar ? bar.date : null,
      __kline_ok: !!bar,
      __exact: tradedOn,
    };
    if (price != null || (val && val.total_mv != null)) covered++;
    if (tradedOn) exact++;
    rows.push(row);
  };

  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (idx < universe.length) {
        const u = universe[idx++];
        try { await runOne(u); } catch (e) { /* 单家失败不阻断 */ }
      }
    })());
  }
  await Promise.all(workers);

  // 实际生效的行情日（休市时是最近交易日）
  const dates = rows.map((r) => r.__quote_date).filter(Boolean).sort();
  const actualQuoteDate = dates.length ? dates[dates.length - 1] : dateStr;
  const anyExact = rows.some((r) => r.__exact);
  const klineOk = rows.filter((r) => r.__kline_ok).length;

  return {
    rows,
    source: `东方财富逐日口径（RPT_VALUEANALYSIS_DET 为主 + push2his 日K 补充成交明细，锚定 ${actualQuoteDate}）`,
    quoteDate: actualQuoteDate,
    tradingDay: anyExact,
    covered,
    exact,
    klineOk,
    asOf: dateStr,
  };
}

module.exports = { fetchDailyKline, buildHistoryQuotes, secidOf };
