'use strict';
/**
 * 行情层：东方财富 push2 板块接口。
 *
 * 用途：一次性拿到科创板全量（~622 只）的当日涨跌幅、PE、PB、市值、
 * 流通市值、最新价和行业分类。7 次分页 HTTP 调用即可，
 * 比走 iFinD 指标接口（5 只/次 → 124 次）快一个数量级。
 *
 * 与 iFinD 的分工：
 *   东方财富 → 行情/估值快照/行业分类（广度）
 *   iFinD    → 财务摘要、PE 历史分位、要闻、研报、公告、热点（深度与权威）
 * 两套来源交叉互补，UI 上分别标注来源，不混为一谈。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const EM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: '*/*',
};

/**
 * 行情快照缓存。
 *
 * 东方财富的 push2 报价接口有 IP 级防滥用：请求量过大时会直接断连
 * （socket hang up），push2his / datacenter 等同源主机也会被连带影响。
 * 一旦碰上，行情层会整个失败——如果不做缓存，采集就会写出"覆盖 0/619"的空数据，
 * 把前一天的好数据覆盖掉。
 *
 * 所以：成功就落盘缓存，失败就读缓存顶上，并在数据里标记 stale。
 */
const QUOTE_CACHE = path.join(DATA_DIR, 'quotes.json');

function readCache() {
  try {
    if (!fs.existsSync(QUOTE_CACHE)) return null;
    const c = JSON.parse(fs.readFileSync(QUOTE_CACHE, 'utf8'));
    if (!c || !Array.isArray(c.rows) || !c.rows.length) return null;
    return c;
  } catch { return null; }
}

function writeCache(payload) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUOTE_CACHE, JSON.stringify(payload), 'utf8');
  } catch { /* ignore */ }
}

// 科创板全量板块口径: m:1 + t:23
const STAR_BOARD_FS = 'm%3A1%2Bt%3A23';
const FIELDS = 'f12,f14,f2,f3,f9,f20,f21,f23,f26,f100';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 取纯文本响应（腾讯行情不是 JSON） */
async function emGetText(url, headers) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: headers || EM_HEADERS, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(800 * (i + 1));
    }
  }
  throw lastErr || new Error('emGetText failed');
}

async function emGet(url, headers) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: headers || EM_HEADERS, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j && j.data) return j.data;
      throw new Error(`empty data: ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(800 * (i + 1));
    }
  }
  throw lastErr || new Error('emGet failed');
}

function num(v) {
  if (v === undefined || v === null || v === '-' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 东方财富用裸 6 位代码，iFinD 用 688xxx.SH，统一到后者 */
function toIfindCode(code) {
  const c = String(code || '').trim();
  if (/^\d{6}$/.test(c)) return c + '.SH';   // 科创板全部上交所
  return c;
}

async function fetchStarQuotes(pageSize = 100, options = {}) {
  const rows = [];
  const seen = new Set();
  let total = 0;
  let page = 1;
  let guard = 0;
  const industryMap = new Map((options && options.industryMap) || []);

  while (guard++ < 20) {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}` +
      `&po=1&np=1&fltt=2&invt=2&fid=f20&fs=${STAR_BOARD_FS}&fields=${FIELDS}`;
    const data = await emGet(url);
    total = data.total || total;
    const diff = data.diff || [];
    if (!diff.length) break;

    let added = 0;
    for (const r of diff) {
      const code = String(r.f12 || '');
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push({
        code: toIfindCode(code),
        bareCode: code,
        name: r.f14 || '',
        price: num(r.f2),
        change_pct: num(r.f3),
        pe: num(r.f9),
        pb: num(r.f23),
        total_mv: num(r.f20),
        float_mv: num(r.f21),
        listDate: r.f26 ? String(r.f26) : '',
        industry: r.f100 || (industryMap.get(toIfindCode(code)) || ''),
      });
      added++;
    }
    if (rows.length >= total || added === 0) break;
    page++;
    await sleep(200);
  }

  rows.sort((a, b) => (b.total_mv || 0) - (a.total_mv || 0));
  const payload = {
    rows,
    reportedTotal: total,
    source: '东方财富 push2 clist fs=m:1+t:23（科创板板块口径）',
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
  if (!rows.length) throw new Error('东方财富行情接口返回空数据');
  writeCache(payload);
  return payload;
}

// ---------------------------------------------------------------- 腾讯行情（第二兜底）

/**
 * 腾讯行情 qt.gtimg.cn —— 东方财富 push2 被封时的备用行情源。
 * 一次可批量查 60 只，619 家只需 11 次请求。
 * 字段位置（以 ~ 分隔后的 0 基下标）：
 *   3 现价 / 4 昨收 / 5 今开 / 30 时间 / 31 涨跌 / 32 涨跌幅 / 33 最高 / 34 最低
 *   38 换手率 / 39 市盈率TTM / 44 流通市值(亿) / 45 总市值(亿) / 46 市净率
 * 行业分类腾讯不提供，保留东财缓存里的值。
 */
const TX_HEADERS = { Referer: 'https://gu.qq.com/' };

async function fetchQuotesTencent(universe, batchSize = 60) {
  const rows = [];
  const codes = universe.map((u) => `sh${String(u.code).split('.')[0]}`);
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const url = 'https://qt.gtimg.cn/q=' + batch.join(',');
    let body = '';
    try {
      body = await emGetText(url, TX_HEADERS);
    } catch (e) {
      continue;
    }
    for (const line of body.split('\n')) {
      const m = /v_sh(\d{6})="([^"]*)"/.exec(line);
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 50) continue;
      const bare = m[1];
      const mv = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n !== 0 ? n : null;
      };
      rows.push({
        code: bare + '.SH',
        bareCode: bare,
        price: mv(f[3]),
        change_pct: mv(f[32]),
        pe: mv(f[39]),
        pb: mv(f[46]),
        total_mv: mv(f[45]) != null ? mv(f[45]) * 1e8 : null,
        float_mv: mv(f[44]) != null ? mv(f[44]) * 1e8 : null,
        turnover: mv(f[38]),
        industry: '',
      });
    }
    await sleep(120);
  }
  return rows;
}

/**
 * 行情获取三级兜底：
 *   1. 东方财富 push2（首选，带行业分类）
 *   2. 腾讯 qt.gtimg.cn（push2 被封时用，缺行业分类，用缓存补）
 *   3. 本地缓存快照（两个源都挂时用，标记 stale）
 */
async function fetchQuotesRobust(universe, industryMap) {
  const cached = readCache();
  const im = industryMap || new Map();

  let primaryError = null;
  try {
    const q = await fetchStarQuotes(100, { industryMap: im });
    if (q.rows.length) return { ...q, fallback: null };
  } catch (e) {
    primaryError = e;
  }

  // 第二级：腾讯
  try {
    const txRows = await fetchQuotesTencent(universe);
    if (txRows.length) {
      for (const r of txRows) if (!r.industry && im.has(r.code)) r.industry = im.get(r.code);
      return {
        rows: txRows,
        reportedTotal: txRows.length,
        source: '腾讯行情 qt.gtimg.cn（东方财富 push2 暂不可用时的备用源）',
        fetchedAt: new Date().toISOString(),
        stale: false,
        fallback: `东方财富 push2 不可用：${primaryError ? primaryError.message : '未知原因'}`,
      };
    }
  } catch (e) { /* 落到第三级 */ }

  // 第三级：缓存
  if (cached) {
    return { ...cached, stale: true, staleReason: primaryError ? primaryError.message : '行情源不可用' };
  }
  throw primaryError || new Error('所有行情源均不可用');
}

/**
 * 带缓存兜底的行情获取：接口被封/失败时用上次成功的快照顶上，
 * 宁可标记"缓存"也不能让整轮采集变成空数据。
 */
async function fetchStarQuotesWithFallback(universe, industryMap) {
  try {
    return await fetchQuotesRobust(universe, industryMap);
  } catch (e) {
    const cached = readCache();
    if (cached) {
      return { ...cached, stale: true, staleReason: e.message };
    }
    throw e;
  }
}

/**
 * 把行情层合并进公司档案。
 * @param {Array} companies 采集结果里的公司档案
 * @param {Array} quoteRows  行情行
 * @param {string} quoteSource 实际取数源（push2 / 腾讯 / 缓存快照）——
 *   **必须透传**，不能硬编码：行情走备用源时，逐公司来源标错，下游署名会骗人
 *   （2026-10-22 实测踩到：quote.source 写死"东方财富"，而当期实际是腾讯兜底）。
 * @returns {{matched:number, industries:string[], breadth:object}}
 */
function mergeQuotes(companies, quoteRows, quoteSource) {
  const byCode = new Map(quoteRows.map((r) => [r.code, r]));
  const industries = new Set();
  let matched = 0;
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
  const gainers = [], losers = [];

  for (const c of companies) {
    const q = byCode.get(c.code);
    if (!q) continue;
    matched++;
    // 行业口径已由 src/industry.js 钉死（申万二级），**行情源不得改写口径**：
    // push2 的 f100 会被 IP 级封禁，一封标签就从申万二级漂成东财 EM2016 末级
    // （实测 2026-10-21 = 76 个行业、2026-10-22 = 46 个，同一批公司标签不同）。
    // 行情源的行业只在公司本来没有行业时兜底。
    if (!c.industry && q.industry) c.industry = q.industry;
    if (c.industry) industries.add(c.industry);
    c.quote = {
      price: q.price,
      change_pct: q.change_pct,
      pe: q.pe,
      pb: q.pb,
      total_mv: q.total_mv,
      float_mv: q.float_mv,
      list_date: q.listDate,
      source: quoteSource || '未知来源',
    };
    // 历史回补口径才会有的字段（实时快照里没有 → 不写，保持线上数据结构不变）
    if (q.change_amount != null) c.quote.change_amount = q.change_amount;
    if (q.turnover != null) c.quote.turnover = q.turnover;
    if (q.amount != null) c.quote.amount = q.amount;
    if (q.volume != null) c.quote.volume = q.volume;
    if (q.amplitude != null) c.quote.amplitude = q.amplitude;
    if (q.total_shares != null) c.quote.total_shares = q.total_shares;
    if (q.free_shares != null) c.quote.free_shares = q.free_shares;
    if (q.__quote_date) c.quote.trade_date = q.__quote_date;
    // 行情源的估值与市值优先（当日快照，比财报口径新）
    if (q.pe != null) c.valuation.pe_ttm = q.pe;
    if (q.pb != null) c.valuation.pb = q.pb;
    if (q.total_mv != null) c.valuation.total_mv = q.total_mv;
    if (q.float_mv != null) c.valuation.float_mv = q.float_mv;

    const ch = q.change_pct;
    if (ch != null) {
      if (ch > 0) up++; else if (ch < 0) down++; else flat++;
      if (ch >= 9.5) { limitUp++; gainers.push(c.code); }
      else if (ch <= -9.5) { limitDown++; losers.push(c.code); }
      if (ch >= 5) gainers.push(c.code);
      if (ch <= -5) losers.push(c.code);
    }
  }

  return {
    matched,
    industries: [...industries].sort(),
    breadth: {
      rising: up, falling: down, flat,
      up5: quoteRows.filter((r) => r.change_pct != null && r.change_pct >= 5).length,
      down5: quoteRows.filter((r) => r.change_pct != null && r.change_pct <= -5).length,
      up9: limitUp, down9: limitDown,
      limit_ups: quoteRows.filter((r) => r.change_pct != null && r.change_pct >= 9.5).map((r) => r.code),
      limit_downs: quoteRows.filter((r) => r.change_pct != null && r.change_pct <= -9.5).map((r) => r.code),
      // 市值分布直接从行情快照本地算，不必再调 iFinD 选股接口
      mv_over_200yi: quoteRows.filter((r) => r.total_mv != null && r.total_mv >= 2e10).length,
      mv_over_50yi: quoteRows.filter((r) => r.total_mv != null && r.total_mv >= 5e9).length,
      mv_over_100yi: quoteRows.filter((r) => r.total_mv != null && r.total_mv >= 1e10).length,
    },
    gainers: [...new Set(gainers)],
    losers: [...new Set(losers)],
  };
}

module.exports = { fetchStarQuotes, fetchStarQuotesWithFallback, mergeQuotes, toIfindCode, readCache };
