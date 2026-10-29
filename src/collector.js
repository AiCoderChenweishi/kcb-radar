'use strict';
/**
 * 采集编排（双数据源版）。
 *
 * 数据源分工（见 src/em.js 顶部说明）：
 *   东方财富（免费不限量）→ 名单缓存、行情快照、券商研报、公告、要闻、财务兜底
 *   iFinD MCP（额度有限）  → PE 历史分位（不可替代）、财务摘要（可被东财兜底）、热点
 *
 * iFinD 额度耗尽时，相关阶段**明确降级并记录**，绝不让流水线静默产出空数据。
 */
const fs = require('fs');
const path = require('path');
const { callTool, createLimiter, throttleStats, usageStats, quotaBlocked, outageBlocked, outageInfo } = require('./connector');
const cfg = require('./config');
const { refreshUniverse, loadCached } = require('./universe');
const { collectMarket, fillFromEastmoney } = require('./market');
const { fetchStarQuotesWithFallback, mergeQuotes } = require('./quote');
const { fetchProfiles } = require('./profile');
const industry = require('./industry');
const { extractEvents } = require('./events');
const em = require('./em');
const P = require('./parser');

const TOOL = {
  summary: 'connector__thsifind__get_stock_summary',
  news: 'connector__thsifind__search_news',
  notice: 'connector__thsifind__search_notice',
  trending: 'connector__thsifind__search_trending_news',
  // 2026-10-23 移除：indicators（get_security_indicators）
  //   理由：其「PE 分位数」实测三家股票全返 100.0（口径已被证伪），
  //   且 124 次/天不喂任何交付字段。详见 collectFinancials 上方说明。
};

function ymd(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 带修复轮的执行：失败项降并发重跑 */
async function runWithRepair(items, worker, opts = {}) {
  const { concurrency = cfg.CONCURRENCY, label = 'phase', log = () => {}, repairRounds = 2 } = opts;
  let pending = items;
  const collected = [];
  const allFailures = [];

  for (let round = 0; round <= repairRounds; round++) {
    if (!pending.length) break;
    const c = round === 0 ? concurrency : Math.max(1, Math.floor(concurrency / (round * 2)));
    log(`  ${label} 第 ${round + 1} 轮：待处理 ${pending.length}，并发 ${c}`);
    const pool = await runPool(pending, worker, c, label, (d, t) => log(`    ${label} ${d}/${t}`));
    for (const r of pool.results) if (r) collected.push(r);
    pending = pool.failures.map((f) => f.item).filter(Boolean);
    allFailures.push(...pool.failures);
    // 额度耗尽时重试没有意义：立刻放弃本阶段，把额度留给降级路径
    if (pool.failures.some((f) => isQuotaError({ message: f.error }))) {
      log(`  ${label} 命中 iFinD 额度上限，本阶段立即放弃（不再补采）`);
      pending = [];
      break;
    }
    // connector 平台不可达：同样立刻放弃，避免 124 批 × 多轮修复把采集拖成十几分钟
    if (outageBlocked()) {
      log(`  ${label} connector 平台不可达，本阶段立即放弃（不再补采）`);
      pending = [];
      break;
    }
    if (pending.length) {
      log(`  ${label} 本轮失败 ${pending.length}，降并发补采`);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { collected, failures: allFailures, residual: pending };
}

async function runPool(items, worker, concurrency, label, onProgress) {
  const limit = createLimiter(concurrency);
  const failures = [];
  let done = 0;
  const results = await Promise.all(items.map((item, idx) =>
    limit(async () => {
      try {
        const r = await worker(item, idx);
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, items.length);
        return r;
      } catch (e) {
        failures.push({ label, item, error: e.message });
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, items.length);
        return null;
      }
    })
  ));
  return { results, failures };
}

function withPhaseDeadline(promise, deadlineMs, label) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.log(`[watchdog] 阶段 ${label} 超过 ${deadlineMs / 1000}s，主动放弃（已采集部分仍会保留）`);
      resolve(null);
    }, deadlineMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 判断错误是否来自 iFinD 额度耗尽 */
function isQuotaError(e) {
  return !!(e && (e.quotaExhausted || /QUOTA_EXHAUSTED|用量已耗尽/.test(String(e.message || ''))));
}

// ---------------------------------------------------------------- 各阶段

/**
 * 券商研报：两段窗口
 *   - 近期（7 天）→ 每日新增研报，进要闻流
 *   - 存量（90 天）→ 卖方覆盖全景：谁被覆盖、最新评级/目标价/预测
 * 实测：7 天窗口只有 16 篇（覆盖 15 家），90 天窗口翻 33 页有 438 篇（覆盖 234 家），
 * 只用短窗口会严重低估卖方覆盖度。两次调用都是免费的，约 10 秒。
 */
async function collectResearchEastmoney(windowStart, windowEnd, log) {
  const recent = await em.fetchResearch(windowStart, windowEnd, (m) => log(`  ${m}`), { maxPages: 6 });
  const coverageEnd = ymd(new Date(new Date(`${windowEnd}T00:00:00Z`).getTime() - 83 * 86400000));
  const all = await em.fetchResearch(coverageEnd, windowEnd, (m) => log(`  ${m}`), { maxPages: 40 });

  const byCode = new Map();
  for (const r of all) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  // 每家取最新一篇作为"卖方观点"代表
  const latest = new Map();
  for (const [code, list] of byCode) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    latest.set(code, list[0]);
  }
  const ratingDist = {};
  for (const r of all) {
    const k = r.rating || '无评级';
    ratingDist[k] = (ratingDist[k] || 0) + 1;
  }
  const brokers = new Set(all.map((r) => r.broker).filter(Boolean));
  const covered = new Set(all.map((r) => r.code));

  log(`  卖方覆盖：科创板 ${all.length} 篇 / ${covered.size} 家公司 / ${brokers.size} 家券商`);
  log(`  评级分布：${Object.entries(ratingDist).map(([k, v]) => k + v).join(' ')}`);

  return { recent, all, byCode, latest, ratingDist, brokers: [...brokers], coveredCompanies: covered.size };
}

/** 公告：东财全市场按日期窗口分页 */
async function collectAnnouncementsEastmoney(windowStart, windowEnd, log) {
  const rows = await em.fetchAnnouncements(windowStart, windowEnd, log);
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  return { rows, byCode };
}

/** 要闻：东财逐家公司搜索（带 12 小时 TTL 缓存，避免同一天反复打接口被限流） */
async function collectNewsEastmoney(universe, log, opts = {}) {
  const size = opts.size || cfg.NEWS_SIZE;
  // **回补时的日期裁剪**：要闻检索是"按公司名搜当前池子"，返回的是此刻可见的条目。
  // 回补某一天时必须把 **晚于该日** 的条目剔掉，
  // 否则「10-24 的数据集」里会装着 10-27 的新闻 —— 简报锚定日会变成 10-27，整份简报就答非所问。
  const cutoff = opts.cutoff || null;
  // **回补用独立的缓存文件**（2026-10-27）：
  // 回补要 30 条、线上要 12 条，共用一个缓存会让明早的实时采集拿到 30 条的池子，
  // 把线上「要闻 N 条」的规模改掉。分开存，互不干扰。
  const cacheFile = opts.cacheFile || null;
  log(`[news-东财] ${universe.length} 家（每家 ${size} 条${cutoff ? `，裁剪到 ≤ ${cutoff}` : ''}）`);
  const cache = em.readNewsCache(cacheFile);
  const save = (c) => em.writeJsonFile(cacheFile || require('path').join(cfg.DATA_DIR, 'news-cache.json'), c);
  let cachedHits = 0;
  const run = await runWithRepair(universe, async (u) => {
    const r = await em.fetchCompanyNewsCached(u, size, cache, save);
    if (r.fromCache) cachedHits++;
    const items = cutoff ? r.items.filter((n) => !n.date || n.date <= cutoff) : r.items;
    return { company: u, items };
  }, { label: 'news-em', log, concurrency: Math.max(4, cfg.CONCURRENCY) });
  if (cachedHits) log(`[news-东财] ${cachedHits} 家命中缓存`);
  save(cache);
  return run;
}

/**
 * 财务摘要：**东方财富 F10 全量为主口径，iFinD 只做补充口径**（2026-10-23 改造）。
 *
 * 改造前的问题（有两条，都不是"浪费"这么轻描淡写）：
 *   1. **额度为 0 时仍然先打满 124 次才发现用不了** —— 旧逻辑是 iFinD 优先、
 *      失败才整批回退东财，而 `runPool` 会把 124 个批次全跑完才检查额度错误。
 *      失败的调用**同样扣账户额度**（iFinD 免费试用版只有 2,000 次永久总量）。
 *   2. **两条口径是"二选一"而不是"合并"** —— iFinD 的摘要里没有
 *      `net_profit_attr`（归属母公司净利润）与 `roe_deducted`，所以当 iFinD 可用时，
 *      这两个字段反而是空的；东财 F10 可用时又拿不到 iFinD 独有的
 *      gross_profit_yoy / eps_yoy / ocf_yoy / roe_ttm / roa / ev_ebitda / peg_lyr /
 *      pcf_ttm / rd_expense。**任一路径单独看，交付字段都少于两者合并。**
 *
 * 改造后：
 *   1. 东财 F10 全量**始终执行**（免费、零额度消耗，实测覆盖 618/619）
 *   2. iFinD **先跑第一批当额度探针**：成功才继续剩余批次；报额度错立刻停（只花 1 次）
 *   3. 两条口径**按字段合并**：东财优先（补 net_profit_attr / roe_deducted / bps），
 *      iFinD 补它独有的字段
 */
async function collectFinancials(universe, log, failures) {
  // ---- (1) 东财 F10 全量：主口径，始终执行 ----
  const emRun = await runWithRepair(universe, async (u) => {
    const f = await em.fetchFinancials(u.code);
    return { code: u.code, f };
  }, { label: 'fin-em', log, concurrency: Math.max(4, cfg.CONCURRENCY), repairRounds: 1 });
  const emMerged = {};
  for (const r of emRun.collected) {
    if (!r || !r.f) continue;
    emMerged[r.code] = {
      code: r.code,
      name: (r.f && r.f.name) || '',
      revenue: r.f.revenue,
      revenue_yoy: r.f.revenue_yoy,
      net_profit_attr: r.f.net_profit,
      net_profit_yoy: r.f.net_profit_yoy,
      gross_margin: r.f.gross_margin,
      net_margin: r.f.net_margin,
      roe_weighted: r.f.roe,
      roe_deducted: r.f.roe_deducted,
      eps: r.f.eps,
      bps: r.f.bps,
      total_assets: r.f.total_assets,
    };
  }
  const emCovered = Object.keys(emMerged).length;
  log(`[summary] 东方财富 F10 口径 ${emCovered}/${universe.length} 家（主口径，零额度消耗）`);

  // ---- (2) iFinD 补充口径：先跑第一批当额度探针 ----
  const ifindMerged = {};
  let quotaBlockedNow = quotaBlocked();
  let quotaReason = quotaBlockedNow ? '额度耗尽' : null;
  let ifindCovered = 0;
  const batches = chunk(universe, cfg.SUMMARY_BATCH);

  if (!quotaBlockedNow && cfg.IFIND_MODE !== 'off') {
    try {
      // 探针：先只打第一批。成功 → 额度可用，继续剩余批次；报额度错 → 立刻停（总消耗 1 次）
      const probe = batches[0];
      const probeMd = await callTool(TOOL.summary, {
        query: `${probe.map((u) => u.name).join('、')} 最新估值水平 市值规模 盈利能力 成长能力 偿债能力 营运能力`,
      }, { timeoutMs: 90000, retries: 0 });
      const probeData = P.parseSummary(probeMd);
      Object.assign(ifindMerged, probeData);
      ifindCovered = Object.keys(probeData).length;
      log(`[summary] iFinD 额度探针通过（首批 ${ifindCovered}/${probe.length} 家），继续剩余 ${batches.length - 1} 批`);

      if (batches.length > 1) {
        const run = await runWithRepair(batches.slice(1), async (batch) => {
          const names = batch.map((u) => u.name).join('、');
          const md = await callTool(TOOL.summary, {
            query: `${names} 最新估值水平 市值规模 盈利能力 成长能力 偿债能力 营运能力`,
          }, { timeoutMs: 90000, retries: 2 });
          return P.parseSummary(md);
        }, { label: 'summary', log, repairRounds: 1 });
        for (const r of run.collected) if (r) Object.assign(ifindMerged, r);
        ifindCovered = Object.keys(ifindMerged).length;
        if (run.failures.some((f) => isQuotaError({ message: f.error }))) {
          quotaBlockedNow = true;
          quotaReason = '额度耗尽';
        }
        failures.push(...run.failures.map((f) => ({ label: 'summary-ifind', item: f.item, error: f.error })));
      }
    } catch (e) {
      if (isQuotaError(e)) {
        quotaBlockedNow = true;
        quotaReason = '额度耗尽';
        log('[summary] iFinD 额度探针报「用量已耗尽」→ 立即停止补充口径（本次只消耗 1 次调用）');
      } else {
        quotaBlockedNow = true;
        quotaReason = `iFinD 不可用（${e.message}）`;
        failures.push({ label: 'summary-ifind', item: '-', error: e.message });
      }
    }
  } else if (quotaBlockedNow) {
    log('[summary] iFinD 额度已知耗尽 → 跳过补充口径（本次 0 次调用）');
  }

  // ---- (3) 按字段合并：东财优先，iFinD 补空 ----
  const merged = {};
  for (const u of universe) {
    const e = emMerged[u.code];
    const f = ifindMerged[u.code];
    if (!e && !f) continue;
    const out = { code: u.code, name: (e && e.name) || (f && f.name) || '' };
    // 先铺 iFinD 的字段
    if (f) for (const [k, v] of Object.entries(f)) if (k !== 'code' && k !== 'name') out[k] = v;
    // 再用东财 F10 的非空值覆盖（东财多出 net_profit_attr / roe_deducted / bps）
    if (e) for (const [k, v] of Object.entries(e)) {
      if (k === 'code' || k === 'name') continue;
      if (v === null || v === undefined) continue;
      out[k] = v;
    }
    merged[u.code] = out;
  }

  if (quotaBlockedNow) {
    failures.push({
      label: 'summary', item: '-',
      error: `iFinD 补充口径不可用（${quotaReason}），财务摘要主口径为东方财富 F10（${emCovered}/${universe.length} 家）`,
    });
  }

  return {
    merged,
    quotaBlocked: quotaBlockedNow,
    quotaReason,
    emCovered,
    ifindCovered,
    ifindMode: cfg.IFIND_MODE,
  };
}

/**
 * 估值分位：主口径用东财历史估值序列自算（免费、稳定、可离线复算）；
 * iFinD 的指标接口降级为可选交叉校验，其「PE分位数」字段实测不可信（见 em.js 注释）。
 */
async function collectValuationHistory(universe, log, failures, opts = {}) {
  const asOf = opts.asOf || null;
  log(asOf
    ? `[估值分位] 自算历史分位（东财估值序列，锚定 ${asOf}，只用到该日及之前的数据）`
    : '[估值分位] 自算历史分位（东财 7 年估值序列）');
  const run = await runWithRepair(universe, async (u) => {
    const v = await em.fetchValuationHistory(u.code, { asOf, full: !!opts.full });
    return { code: u.code, v };
  }, { label: 'valpct', log, concurrency: Math.max(4, cfg.CONCURRENCY) });

  const out = {};
  let ok = 0;
  for (const r of run.collected) {
    if (!r || !r.v) continue;
    out[r.code] = r.v;
    ok++;
  }
  failures.push(...run.failures);
  log(`[估值分位] 成功 ${ok}/${universe.length} 家`);
  return out;
}

/**
 * iFinD 指标接口（get_security_indicators）—— **已于 2026-10-23 整段移除**。
 *
 * 移除理由（两条，都不是"省额度"这么轻描淡写）：
 *   1. **口径已被证伪**：该接口的「市盈率(PE,TTM)分位数」实测对澜起/华兴源创/中微
 *      三家股票全部返回整齐的 100.0，而自算结果分别是 37.5 / 93.2 / 18.4
 *      （见 src/em.js 的说明）。它早已被降级为"可选交叉校验"，不作为分位主口径。
 *   2. **它不喂任何交付字段**：124 次/天（≈3,700 次/月）的调用，换来一个用不上的数字。
 *
 * 保留位：估值分位主口径是东财历史估值序列自算（免费、可离线复算），
 * 被删掉的 `pe_percentile_ifind` 字段在全链路无消费方，一并移除。
 */

// ---------------------------------------------------------------- 主流程

async function collectAll(options = {}) {
  const startedAt = Date.now();
  const log = options.log || (() => {});
  const runDate = options.runDate || new Date();
  const dateStr = ymd(runDate);
  const windowEnd = dateStr;
  const windowStart = ymd(new Date(runDate.getTime() - cfg.NEWS_LOOKBACK_DAYS * 86400000));

  log(`=== 科创板雷达采集 ${dateStr} (回溯 ${cfg.NEWS_LOOKBACK_DAYS} 天) ===`);

  const failures = [];
  const degraded = [];

  // 0. 名单（iFinD 优先，额度不足时用本地缓存）
  let universe = [];
  let universeSource = 'cache';
  try {
    const uni = await refreshUniverse();
    universe = uni.list;
    universeSource = uni.source;
  } catch (e) {
    universe = loadCached();
    degraded.push(`名单接口不可用（${e.message}），使用本地缓存`);
    log(`[universe] 接口不可用，使用缓存 ${universe.length} 家`);
  }
  if (options.limit) universe = universe.slice(0, options.limit);
  log(`[universe] ${universe.length} 家 (来源 ${universeSource})`);

  // 0.6 公司档案（行业/省份/主营，慢变属性带缓存）
  let profiles = {};
  try {
    const pr = await fetchProfiles(universe, log, 8);
    profiles = pr.profiles;
  } catch (e) {
    failures.push({ label: 'profiles', item: '-', error: e.message });
  }

  // 0.7 行业分类（申万二级，唯一权威源，带永久缓存）
  // 为什么不能挂在行情/财务源上：push2 的 f100 会被封，一封标签就从申万二级
  // 漂成东财 EM2016 末级（2026-10-21 = 76 类 vs 2026-10-22 = 46 类），
  // 行业筛选跨天会漏公司、跨日差分会把分类变化误读成"公司换行业"。
  let industries = {};
  try {
    const ir = await industry.fetchIndustries(universe, log, { concurrency: 8 });
    industries = ir.map;
  } catch (e) {
    failures.push({ label: 'industry', item: '-', error: e.message });
  }

  // 0.5 行情快照（东方财富，腾讯兜底，再兜底缓存）
  // **回补模式**（2026-10-27）：改用历史日行情（push2his 日K + 逐日估值口径），
  // 绝不能用实时快照 —— 那会把"此刻"的价格标成历史日期，是编造。
  const backfill = !!options.backfill;
  let quoteRows = [];
  let quoteSource = null;
  let quoteStale = false;
  let backfillInfo = null;
  const industryMap = new Map(Object.entries(profiles)
    .map(([code, p]) => [code, p.industry]).filter(([, v]) => !!v));
  try {
    if (backfill) {
      const history = require('./history');
      const hq = await history.buildHistoryQuotes(universe, dateStr, log, { concurrency: cfg.BACKFILL_CONCURRENCY });
      quoteRows = hq.rows;
      quoteSource = hq.source;
      backfillInfo = {
        mode: 'history',
        asOf: dateStr,
        quoteDate: hq.quoteDate,
        tradingDay: hq.tradingDay,
        covered: hq.covered,
        exact: hq.exact,
        klineOk: hq.klineOk,
      };
      log(`[quotes] 历史行情 ${quoteRows.length} 家（锚定 ${hq.quoteDate}，${hq.tradingDay ? '当日为交易日' : '当日休市，涨跌幅按 0 计'}）｜日K成交明细可用 ${hq.klineOk} 家`);
      if (!hq.tradingDay) {
        degraded.push(`${dateStr} 为非交易日（休市）：收盘价沿用 ${hq.quoteDate}，当日涨跌幅按 0 计，换手率/成交额无数据`);
      }
      if (hq.klineOk < quoteRows.length * 0.5) {
        degraded.push(`push2his 日K 接口仅 ${hq.klineOk}/${quoteRows.length} 家可用（高频请求会被限流），换手率/成交额/振幅按缺失处理；收盘价与涨跌幅由东财逐日估值口径提供，不受影响`);
      }
    } else {
      const q = await fetchStarQuotesWithFallback(universe, industryMap);
      quoteRows = q.rows;
      quoteSource = q.source;
      quoteStale = !!q.stale;
      if (q.fallback) degraded.push(`行情主源不可用（${q.fallback}），已切换备用源`);
      if (quoteStale) {
        degraded.push(`东方财富行情接口暂不可用（${q.staleReason}），本期使用缓存快照（${q.fetchedAt}）`);
        log(`[quotes] 接口不可用，使用缓存快照（${q.fetchedAt}）`);
      } else {
        log(`[quotes] ${quoteRows.length} 家行情 (${quoteSource})`);
      }
    }
  } catch (e) {
    failures.push({ label: 'quotes', item: '-', error: e.message });
    degraded.push(`行情快照本期缺失：${e.message}`);
  }

  // 1. 券商研报（东方财富：近期新增 + 90 天存量覆盖）
  let researchRows = [];
  let researchByCode = new Map();
  let researchLatest = new Map();
  let researchMeta = { ratingDist: {}, brokers: [], coveredCompanies: 0 };
  try {
    const r = await collectResearchEastmoney(windowStart, windowEnd, log);
    researchRows = r.recent;
    researchByCode = r.byCode;
    researchLatest = r.latest;
    researchMeta = { ratingDist: r.ratingDist, brokers: r.brokers, coveredCompanies: r.coveredCompanies };
  } catch (e) {
    failures.push({ label: 'research-em', item: '-', error: e.message });
    log(`[research] 失败: ${e.message}`);
  }

  // 2. 公告（东方财富，全市场分页）
  let noticeRows = [];
  let noticeByCode = new Map();
  try {
    const r = await collectAnnouncementsEastmoney(windowStart, windowEnd, log);
    noticeRows = r.rows;
    noticeByCode = r.byCode;
  } catch (e) {
    failures.push({ label: 'announcements-em', item: '-', error: e.message });
    log(`[announcements] 失败: ${e.message}`);
  }

  // 3. 要闻（东方财富逐家）
  let newsRun = { collected: [], failures: [], residual: [] };
  try {
    newsRun = await collectNewsEastmoney(universe, log, {
      // 回补时要闻池要更大（才能覆盖到目标日期），并把晚于目标日的条目剔掉
      size: backfill ? cfg.NEWS_SIZE_BACKFILL : cfg.NEWS_SIZE,
      cutoff: backfill ? dateStr : null,
      cacheFile: backfill ? require('path').join(cfg.DATA_DIR, 'news-cache-backfill.json') : null,
    });
    Object.assign(failures, newsRun.failures);
  } catch (e) {
    failures.push({ label: 'news-em', item: '-', error: e.message });
  }

  // 4. 财务摘要
  //    口径（2026-10-23 改造后）：**主源恒为东方财富 F10 全量**；
  //    iFinD get_stock_summary 只作为"额度允许时的补充口径"，
  //    两者逐字段合并（iFinD 只补它独有的字段，见 docs/PROJECT.md 4.28）。
  const fin = await collectFinancials(universe, log, failures);
  if (fin.quotaBlocked) {
    degraded.push(`iFinD 不可用（${fin.quotaReason || '额度耗尽'}）：财务摘要全量走东方财富 F10 口径`);
  }

  // 5. 估值分位（东财历史序列自算，主口径）
  //    iFinD 的 get_security_indicators 交叉校验已整段移除（口径已被证伪，且不喂任何交付字段）
  const valHist = await collectValuationHistory(universe, log, failures, {
    asOf: backfill ? dateStr : null,
    full: backfill,
  });

  // 6. 热点（iFinD；行业数受 cfg.IFIND_TRENDING_LIMIT 控制，1 = 只查「科创板整体」）
  let trending = [];
  if (quotaBlocked()) {
    degraded.push('iFinD 额度耗尽：分行业热点改为东方财富 7×24 快讯 + 科创板事件分布自算');
    log('[trending] iFinD 额度已耗尽 → 改用东方财富 7×24 快讯 + 事件分布自算');
  } else {
    try {
    const trendingIndustries = cfg.TRENDING_INDUSTRIES.slice(0, Math.max(0, cfg.IFIND_TRENDING_LIMIT - 1));
    const calls = [{ kw: '科创板', label: '科创板整体' },
      ...trendingIndustries.map((x) => ({ kw: x, label: x }))];
    log(`[trending] 查询 ${calls.length} 个板块（上限 ${cfg.IFIND_TRENDING_LIMIT}）`);
    const pool = await runPool(calls, async (c) => {
      const args = { time_scope: cfg.TRENDING_TIME_SCOPE, sensitive: '全部', keyword: c.kw, size: 10 };
      if (c.label !== '科创板整体') args.industry_name = c.label;
      const data = await callTool(TOOL.trending, args, { timeoutMs: 60000, retries: 1 });
      const list = Array.isArray(data && data.result) ? data.result : [];
      return list.map((x) => ({
        ...x, scope: c.label,
        heat: Number(x['资讯热度']) || null,
        title: x['资讯标题'], content: x['资讯内容'],
        url: x['URL'], source: x['信息来源'],
      }));
    }, cfg.CONCURRENCY, 'trending');
    Object.assign(failures, pool.failures);
    trending = pool.results.filter(Boolean).flat();
  } catch (e) {
    failures.push({ label: 'trending', item: '-', error: e.message });
    if (isQuotaError(e)) degraded.push('iFinD 额度耗尽：热点事件流本期缺失');
  }
  if (!trending.length) {
    degraded.push('行业热点流本期缺失：iFinD 热点接口不可用（额度耗尽或 connector 平台不可达），行业热点改由 7×24 快讯 + 事件分布自算替代');
  }
  }

  // 7. 组装
  const newsByCode = new Map();
  let crossTalkDropped = 0;
  let weakCount = 0;
  let noiseDropped = 0;
  let marketNoiseDropped = 0;
  const crossTalk = P.buildCrossTalkDetector(universe);

  for (const r of newsRun.collected) {
    if (!r) continue;
    const kept = [];
    for (const item of r.items) {
      if (P.isNoiseTitle(item.title)) { noiseDropped++; continue; }
      // 板块/ETF/资金流快讯讲的不是公司，剔除
      if (P.isMarketLevelNoise(item.title)) { marketNoiseDropped++; continue; }
      const text = `${item.title} ${item.content}`;
      const verdict = crossTalk(r.company, text);
      if (verdict.status === 'crosstalk') { crossTalkDropped++; continue; }
      if (verdict.status === 'weak') weakCount++;
      kept.push({ ...item, match: verdict.status, is_research: false });
    }
    newsByCode.set(r.company.code, kept);
  }

  // 研报条目并入各公司（近期 7 天的进要闻流；90 天存量用于卖方覆盖画像）
  // 注意去重：同一家公司同一天可能有多篇研报，
  // 若按 (公司, 日期) 展开会让同一篇在列表里出现两次（实测 22 条里 4 条是重复）。
  const researchByCompany = new Map();
  const seenResearch = new Set();
  for (const r of researchRows) {
    const cands = (researchByCode.get(r.code) || []).filter((x) => x.date === r.date);
    const mapped = [];
    for (const x of cands) {
      const key = `${x.code}|${x.date}|${x.title}|${x.broker || ''}`;
      if (seenResearch.has(key)) continue;
      seenResearch.add(key);
      mapped.push({
        title: x.title,
        content: `研报机构：${x.broker || '—'}｜评级：${x.rating || '—'}`
          + (x.last_rating && x.last_rating !== x.rating ? `（上次：${x.last_rating}）` : '')
          + `｜EPS预测：本年 ${x.eps.this_year ?? '—'} / 次年 ${x.eps.next_year ?? '—'} / 第三年 ${x.eps.next_two_year ?? '—'}`
          + (x.target_price != null ? `｜目标价 ${x.target_price} 元` : ''),
        date: x.date,
        url: x.info_code ? `https://data.eastmoney.com/report/info/${x.info_code}.html` : '',
        broker: x.broker,
        rating: x.rating,
        last_rating: x.last_rating,
        target_price: x.target_price,
        forecast: (x.eps.this_year != null || x.eps.next_year != null)
          ? { eps: x.eps, pe: x.pe } : null,
        is_research: true,
        kind: 'broker_report',
        match: 'matched',
      });
    }
    if (!mapped.length) continue;
    const prev = researchByCompany.get(r.code) || [];
    researchByCompany.set(r.code, prev.concat(mapped));
    const news = newsByCode.get(r.code) || [];
    newsByCode.set(r.code, news.concat(mapped));
  }

  const companies = universe.map((u) => {
    const s = fin.merged[u.code] || {};
    const vh = valHist[u.code] || {};
    const news = newsByCode.get(u.code) || [];
    const pf = profiles[u.code] || {};
    const notices = (noticeByCode.get(u.code) || []).map((n) => ({
      title: n.title, content: n.type ? `公告类型：${n.type}` : '', date: n.date, url: n.url, match: 'matched',
    }));
    const research = researchByCompany.get(u.code) || [];
    // 卖方覆盖画像：90 天窗口内该公司最新一篇研报
    const sl = researchLatest.get(u.code) || null;
    const sellSide = sl ? {
      covered: true,
      broker: sl.broker,
      rating: sl.rating,
      last_rating: sl.last_rating,
      target_price: sl.target_price,
      date: sl.date,
      title: sl.title,
      eps: sl.eps,
      pe: sl.pe,
      researcher: sl.researcher,
      report_count_90d: (researchByCode.get(u.code) || []).length,
      url: sl.info_code ? `https://data.eastmoney.com/report/info/${sl.info_code}.html` : '',
    } : { covered: false };
    return {
      code: u.code,
      name: u.name,
      board: u.board || '科创板',
      // 行业口径唯一来源：钉死的申万二级分类；缺失才退回 F10 概况的 EM2016 末级
      industry: (industries[u.code] || pf.industry || ''),
      profile: {
        province: pf.province || null,
        industry_chain: pf.industry_chain || null,
        industry_csrc: pf.industry_csrc || null,
        employees: pf.employees || null,
        main_business: pf.main_business ? String(pf.main_business).slice(0, 300) : null,
        org_name: pf.org_name || null,
      },
      financials: s,
      valuation: {
        pe_ttm: vh.pe_ttm ?? s.pe_ttm ?? null,
        pb: vh.pb_mrq ?? s.pb ?? null,
        ps_ttm: vh.ps_ttm ?? s.ps_ttm ?? null,
        // 回补模式下 vh 带逐日口径（总市值/流通市值/PCF/PEG/股本），
        // 线上模式 vh 没有这些字段 → 自动回落到财报口径，行为不变。
        pcf_ttm: vh.pcf_ocf_ttm ?? s.pcf_ttm ?? null,
        peg_lyr: vh.peg_car ?? s.peg_lyr ?? null,
        ev_ebitda: s.ev_ebitda ?? null,
        total_mv: vh.total_mv ?? s.total_mv ?? null,
        float_mv: vh.float_mv ?? s.float_mv ?? null,
        total_shares: vh.total_shares ?? null,
        free_shares: vh.free_shares ?? null,
        pe_percentile: vh.pe_percentile ?? null,
        pe_percentile_all: vh.pe_percentile_all ?? null,
        pb_percentile: vh.pb_percentile ?? null,
        valuation_history_days: vh.history_days ?? null,
        valuation_window_days: vh.window_days ?? null,
        valuation_date: vh.date ?? null,
      },
      growth: {
        revenue_yoy: s.revenue_yoy ?? null,
        net_profit_yoy: s.net_profit_yoy ?? null,
        gross_profit_yoy: s.gross_profit_yoy ?? null,
        eps_yoy: s.eps_yoy ?? null,
        ocf_yoy: s.ocf_yoy ?? null,
      },
      profitability: {
        roe_weighted: s.roe_weighted ?? null,
        roe_ttm: s.roe_ttm ?? null,
        gross_margin: s.gross_margin ?? null,
        net_margin: s.net_margin ?? null,
      },
      revenue: s.revenue ?? null,
      net_profit_attr: s.net_profit_attr ?? null,
      total_assets: s.total_assets ?? null,
      eps: s.eps ?? null,
      bps: s.bps ?? null,
      news,
      notices,
      research,
      sell_side: sellSide,
    };
  });

  // 8. 行情合并 + 市场层面
  let quoteInfo = { matched: 0, industries: [], breadth: {}, gainers: [], losers: [] };
  if (quoteRows.length) {
    quoteInfo = mergeQuotes(companies, quoteRows, quoteSource);
    log(`[quotes] 合并 ${quoteInfo.matched}/${companies.length} 家，覆盖 ${quoteInfo.industries.length} 个行业`);
  }

  let market = {};
  try {
    // 市场宽度直接用东财行情自算口径（2026-10-23 改造：不再花 8 次 iFinD 调用，
    // 因为那 8 次的返回值本来就会被下面的东财结果覆盖）
    market = await collectMarket(trending, quoteInfo);
    Object.assign(failures, market.failures || []);
    // 东财兜底：指数点位与快讯（iFinD 额度耗尽时缺失）
    const filled = await fillFromEastmoney(market, trending);
    market = filled.market;
    trending = filled.trending;
    // 回补日的市场宽度是**用回补行情自算**的，不能写成"实时快照"（2026-10-27 补）
    if (backfill && market.source && market.source.breadth) {
      market.source.breadth = `回补日行情自算（全量精确统计，锚定 ${backfillInfo.quoteDate}）`;
    }
  } catch (e) {
    failures.push({ label: 'market', item: '-', error: e.message });
  }

  // connector 平台级不可达：本轮 iFinD 侧能力整体缺失，必须如实披露
  if (outageBlocked()) {
    const oi = outageInfo();
    degraded.push(`connector 平台不可达（连续 ${oi.consecutive} 次网络失败，${oi.detectedAt}）：iFinD 侧口径本期整体缺失，已全部由东方财富替代口径承接`);
    log(`[connector] 平台不可达已熔断：${String(oi.message || '').slice(0, 120)}`);
  }

  const elapsedMs = Date.now() - startedAt;
  const ts = throttleStats();
  const usage = usageStats();

  // 事件类型分布（科创板 619 家的可核对事实）
  // **必须带时间窗口**：要闻池是按公司名检索的结果，天然横跨数月
  // （实测 5,607 条里 33% 超 90 天）。dataset.events 取近7天作"热点"口径，
  // eventsAll 为全量存量（仅作背景），eventsByWindow 供简报按需引用。
  let events = [];
  let eventsAll = [];
  let eventsByWindow = null;
  let freshness = null;
  try {
    const { extractEventsByWindow, newsFreshness } = require('./events');
    eventsByWindow = extractEventsByWindow(companies, dateStr);
    events = eventsByWindow.d7;
    eventsAll = eventsByWindow.all;
    freshness = newsFreshness(companies, dateStr);
    log(`[事件] 近7天 ${events.length} 类（最多：${events.slice(0, 3).map((e) => `${e.key}(${e.companies}家)`).join(' ')}）｜全量存量 ${eventsAll.length} 类`);
    log(`[时效] 要闻 ${freshness.total} 条：当日 ${freshness.d1}（${freshness.d1Ratio}%）／近7天 ${freshness.d7}（${freshness.d7Ratio}%）／超30天 ${freshness.olderThan30}`);
  } catch (e) {
    failures.push({ label: 'events', item: '-', error: e.message });
  }

  log(`=== 完成，用时 ${(elapsedMs / 1000).toFixed(1)}s，失败 ${failures.length} 条，串台丢弃 ${crossTalkDropped} 条，导航噪声丢弃 ${noiseDropped} 条，板块快讯丢弃 ${marketNoiseDropped} 条 ===`);
  log(`=== iFinD 额度消耗：实际请求 ${usage.attempts} 次（成功 ${usage.calls} / 失败 ${usage.errors}），模式 ${cfg.IFIND_MODE} ===`);
  log(`=== 降级项：${degraded.length ? degraded.join(' / ') : '无'} ===`);

  return {
    date: dateStr,
    window: { start: windowStart, end: windowEnd },
    generatedAt: new Date().toISOString(),
    elapsedMs,
    universeSource,
    degraded,
    /**
     * **历史回补标记**（2026-10-27）。
     * 非空 = 这份数据集是事后回补的，行情/估值锚定的是历史某一天而不是"此刻"。
     * 必须写清楚，否则看板/简报会把回补数据当实时数据读。
     */
    backfill: backfillInfo ? {
      ...backfillInfo,
      newsCutoff: dateStr,
      newsPoolSize: cfg.NEWS_SIZE_BACKFILL,
      note: backfillInfo.tradingDay
        ? `历史回补：行情与估值取自 ${backfillInfo.quoteDate} 的真实收盘口径`
        : `历史回补：${dateStr} 为休市日，行情沿用 ${backfillInfo.quoteDate} 收盘，当日涨跌幅按 0 计`,
    } : null,
    sources: {
      quotes: quoteSource + (quoteStale ? '（缓存快照）' : ''),
      research: '东方财富研报中心（全市场）',
      announcements: '东方财富公告（全市场分页）',
      news: '东方财富个股资讯检索',
      percentile: '东方财富历史估值序列自算（近3年 750 交易日）',
      // 财务口径：2026-10-23 起**主口径恒为东方财富 F10**，
      // iFinD 只作补充（额度允许时），不再因为额度耗尽而"降级"——F10 本来就是主口径。
      financials: '东方财富 F10（全量主口径）'
        + (fin.ifindCovered ? ` + 同花顺 iFinD 补充（${fin.ifindCovered} 家）` : ''),
      consensus: fin.ifindCovered
        ? `同花顺 iFinD（${fin.ifindCovered}/${universe.length} 家，补充口径）`
        : '未获取（iFinD 补充口径本期不可用）',
      breadth: (market.source && market.source.breadth) || '未获取',
    },
    /**
     * **iFinD 额度消耗台账**（2026-10-23 改造新增）。
     *
     * 为什么要把它写进数据集：试用额度是 2,000 次**永久总量**，
     * 烧完就没有了，而"额度被谁吃掉了"如果没有台账就永远说不清。
     * 判据：额度型外部依赖必须自带可观测的消耗计数。
     */
    ifind: {
      mode: cfg.IFIND_MODE,
      calls: usage.calls,
      attempts: usage.attempts,
      errors: usage.errors,
      byTool: usage.byTool,
      quotaExhausted: usage.quotaExhausted,
      quotaDetectedAt: usage.quotaDetectedAt,
      budget: cfg.IFIND_DAILY_CALL_BUDGET,
      budgetEnabled: cfg.IFIND_DAILY_CALL_BUDGET > 0,
      trendingLimit: cfg.IFIND_TRENDING_LIMIT,
      emCovered: fin.emCovered,
      ifindCovered: fin.ifindCovered,
      note: '免费试用版为 2,000 次永久总量、不按月刷新；attempts 才是真正消耗账户额度的请求数',
    },
    companies,
    trending,
    market,
    events,
    eventsAll,
    eventsByWindow,
    newsFreshness: freshness,
    stats: {
      companyCount: companies.length,
      withFinancials: companies.filter((c) => c.revenue != null).length,
      withValuation: companies.filter((c) => c.valuation.pe_ttm != null || c.valuation.total_mv != null).length,
      withPercentile: companies.filter((c) => c.valuation.pe_percentile != null).length,
      newsCount: companies.reduce((a, c) => a + c.news.length, 0),
      noticeCount: companies.reduce((a, c) => a + c.notices.length, 0),
      researchCount: companies.reduce((a, c) => a + c.research.length, 0),
      sellSideCompanies: researchMeta.coveredCompanies,
      sellSideBrokers: (researchMeta.brokers || []).length,
      sellSideRatingDist: researchMeta.ratingDist || {},
      trendingCount: trending.length,
      crossTalkDropped,
      weakMatchCount: weakCount,
      noiseDropped,
      marketNoiseDropped,
      failureCount: failures.length,
      degraded,
      ifindAttempts: usage.attempts,
      ifindCalls: usage.calls,
      failures: failures.slice(0, 50),
    },
  };
}

module.exports = { collectAll, ymd, chunk, runPool, runWithRepair };
