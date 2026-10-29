'use strict';
/**
 * 东方财富数据源（免费、不限调用量）。
 *
 * 为什么要引入这层：iFinD MCP 有请求额度，全量 619 家 × (要闻+公告+研报) 每天约 1500 次调用
 * 会直接打爆额度（实测：额度耗尽后接口返回"当前账户MCP请求用量已耗尽"，
 * 而返回值是 HTTP 200 + 正常业务结构，极易被当成"该查无数据"而静默产出空数据）。
 *
 * 分工调整后：
 *   东方财富 → 行情快照(7次) / 券商研报(2~3次) / 公告(~40次) / 要闻(619次) / 财务(619次)
 *   iFinD    → PE 历史分位（唯一不可替代）、必要时的交叉校验
 * iFinD 日调用量从 ~1500 降到 ~124。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://data.eastmoney.com/',
  Accept: '*/*',
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = https.get(url, { headers: HEADERS, timeout: 25000 }, (res) => {
        // **必须按 Buffer 收集再一次性解码**：
        // 早期版本用 `b += c` 逐块拼字符串，UTF-8 的多字节汉字跨 TCP 分块时
        // 会被截断成 U+FFFD（实测抓研报正文出现「出货��位居」）。
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            if (n < tries) return setTimeout(() => attempt(n + 1), 600 * n);
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      req.on('error', (e) => {
        if (n < tries) return setTimeout(() => attempt(n + 1), 600 * n);
        reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
        if (n < tries) return setTimeout(() => attempt(n + 1), 600 * n);
        reject(new Error('timeout'));
      });
    };
    attempt(1);
  });
}

function getJson(url) {
  return get(url).then((b) => JSON.parse(b));
}

const STAR = /^68\d{4}$/;   // 科创板股票代码

// ---------------------------------------------------------------- 券商研报

/**
 * 全市场研报（东财研报中心），翻页取全后筛出科创板。
 *
 * **口径要点（实测得出，踩过坑）**：
 * - `code=*` 返回的是"研报增量流"：全市场每天只有 10~15 篇。
 *   7 天窗口 hits=102、30 天=344、90 天=3213 —— 近期明显稀薄。
 * - 单只查询 `code=688008` 在 30 天窗口返回 0，90 天窗口才返回 4 篇
 *   （澜起最近一篇是 09-02）。只看短窗口会严重低估卖方覆盖。
 * - `pageSize` 上限 100，必须翻页才能拿全。
 *
 * 因此分两次调用：
 *   1) 短窗口（7 天）→ 每日新增研报
 *   2) 长窗口（90 天）→ 存量覆盖全景（谁被覆盖、最新评级/目标价/预测）
 */
async function fetchResearch(beginDate, endDate, log = () => {}, opts = {}) {
  const pageSize = 100;
  const maxPages = opts.maxPages || 40;
  const rows = [];
  let hits = null;
  let page = 1;
  while (page <= maxPages) {
    const url = 'https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&industry=*&rating=*&ratingChange=*'
      + `&pageSize=${pageSize}&beginTime=${beginDate}&endTime=${endDate}`
      + `&pageNo=${page}&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=${page}`;
    let j;
    try { j = await getJson(url); } catch (e) { log(`研报第 ${page} 页失败: ${e.message}`); break; }
    const list = j.data || [];
    if (hits == null) hits = j.hits;
    if (!list.length) break;
    rows.push(...list);
    if (hits && rows.length >= hits) break;
    if (list.length < pageSize) break;
    page++;
    await sleep(120);
  }

  const star = rows.filter((x) => STAR.test(String(x.stockCode || '')));
  log(`研报：全市场 ${rows.length} 篇（hits=${hits}，${page} 页），科创板 ${star.length} 篇`);
  return star.map((x) => ({
    code: String(x.stockCode) + '.SH',
    name: x.stockName,
    title: x.title,
    date: String(x.publishDate || '').slice(0, 10),
    broker: x.orgSName || x.orgName || null,
    rating: x.emRatingName || x.sRatingName || null,
    last_rating: x.lastEmRatingName || null,
    rating_change: x.ratingChange,
    eps: {
      this_year: num(x.predictThisYearEps),
      next_year: num(x.predictNextYearEps),
      next_two_year: num(x.predictNextTwoYearEps),
    },
    pe: {
      this_year: num(x.predictThisYearPe),
      next_year: num(x.predictNextYearPe),
      next_two_year: num(x.predictNextTwoYearPe),
    },
    industry: x.indvInduName || '',
    researcher: x.researcher || '',
    info_code: x.infoCode || '',
    target_price: num(x.indvAimPriceT) || num(x.indvAimPriceL),
  }));
}

function num(v) {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- 公告

/**
 * 全市场公告（按日期窗口分页），筛出科创板。
 * 东方财富的日期过滤是服务端过滤，窗口越长页数越多。
 */
async function fetchAnnouncements(beginDate, endDate, log = () => {}) {
  const out = [];
  const seen = new Set();
  const pageSize = 100;
  let page = 1;
  let guard = 0;
  let total = null;

  while (guard++ < 60) {
    const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
      + `?page_size=${pageSize}&page_index=${page}&ann_type=A&client_source=web&stock_list=`
      + `&begin_time=${beginDate}&end_time=${endDate}&f_node=0&s_node=0`;
    let j;
    try { j = await getJson(url); } catch (e) { log(`公告第 ${page} 页失败: ${e.message}`); break; }
    const list = (j.data && j.data.list) || [];
    if (total == null) total = j.data && j.data.total_hits;
    if (!list.length) break;

    for (const it of list) {
      const codes = it.codes || [];
      for (const c of codes) {
        if (!STAR.test(String(c.stock_code || ''))) continue;
        const key = `${c.stock_code}|${it.title}|${it.notice_date || it.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          code: c.stock_code + '.SH',
          name: c.short_name || '',
          title: it.title,
          date: String(it.notice_date || it.date || '').slice(0, 10),
          type: (it.columns || []).map((x) => x.column_name).filter(Boolean).join('/'),
          url: `https://data.eastmoney.com/notices/detail/${c.stock_code}/${encodeURIComponent(it.title)}.html`,
        });
      }
    }
    if (list.length < pageSize) break;
    page++;
    await sleep(120);
  }
  log(`公告：科创板 ${out.length} 条（翻 ${page - 1} 页）`);
  return out;
}

// ---------------------------------------------------------------- 个股要闻

/**
 * 个股新闻。东方财富搜索接口按关键词返回资讯，含日期、标题、摘要、链接。
 * 每家公司 1 次调用，619 次 —— 免费来源，量能承受。
 *
 * 带 TTL 缓存：东财搜索接口也有频次限制，短时间反复跑会拿到残缺结果
 * （实测同样 619 家，重复跑会从 3610 条掉到 1156 条）。
 * 新闻在小时级别变化不大，所以同一天内重复跑直接复用缓存，
 * 既省请求也避免把残缺结果当正常结果。
 */
const NEWS_CACHE = path.join(DATA_DIR, 'news-cache.json');
const NEWS_TTL_MS = 12 * 3600 * 1000;

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJsonFile(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  } catch { /* ignore */ }
}

function readNewsCache(file) {
  return readJsonFile(file || NEWS_CACHE, { savedAt: 0, items: {} });
}

async function fetchCompanyNews(company, limit = 8) {
  const kw = encodeURIComponent(company.name);
  const param = encodeURIComponent(JSON.stringify({
    uid: '',
    keyword: company.name,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: limit } },
  }));
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${param}`;
  const body = await get(url);
  const m = /cb\(([\s\S]*)\)\s*$/.exec(body);
  if (!m) return [];
  let j;
  try { j = JSON.parse(m[1]); } catch { return []; }
  const list = (j.result && j.result.cmsArticleWebOld) || [];
  return list.map((x) => ({
    title: String(x.title || '').replace(/<[^>]+>/g, ''),
    content: String(x.content || '').replace(/<[^>]+>/g, '').slice(0, 800),
    date: String(x.date || '').slice(0, 10),
    url: x.url || `https://so.eastmoney.com/news/s?keyword=${kw}`,
    source: x.mediaName || x.source || '',
  }));
}

/** 带 TTL 缓存的个股要闻 */
async function fetchCompanyNewsCached(company, limit = 8, cache = null, save = null) {
  const c = cache || readNewsCache();
  const hit = c.items && c.items[company.code];
  const fresh = hit && (Date.now() - (hit.at || 0)) < NEWS_TTL_MS;
  // **缓存必须同时满足「条数够」**：
  // 缓存里存的是上一次请求的条数（线上 12 条），历史回补要 30 条才能覆盖到目标日期。
  // 只看 TTL 不看条数 → 回补会拿到 12 条的旧缓存，按目标日期裁剪后几乎什么都不剩。
  const enough = hit && (hit.items || []).length >= limit;
  if (fresh && enough) return { items: hit.items || [], fromCache: true };

  const items = await fetchCompanyNews(company, limit);
  if (items.length && c.items) {
    c.items[company.code] = { at: Date.now(), items };
    if (save) save(c);
  }
  return { items, fromCache: false };
}

// ---------------------------------------------------------------- 财务

/**
 * F10 财务：两张报表各取一次，按报告期倒序取最新一期。
 *
 *   RPT_LICO_FN_CPD              → 营收、归母净利、营收同比、净利同比、EPS、行业(BOARD_NAME)
 *   RPT_F10_FINANCE_MAINFINADATA → 加权ROE、销售毛利率、总资产、每股净资产
 *
 * 注意：两张表默认排序不同，必须显式 sortColumns=REPORT_DATE & sortTypes=-1，
 * 否则会拿到一年前的旧数据（踩过：澜起科技返回的是 2025-06-30 而不是 2026-06-30）。
 */
async function fetchFinancials(code) {
  const bare = String(code || '').split('.')[0];
  const base = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
  const url = (report) => base + '?reportName=' + report + '&columns=ALL'
    + '&filter=(SECUCODE%3D%22' + bare + '.SH%22)&pageNumber=1&pageSize=2'
    + '&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC';

  const [cpdRes, mainRes] = await Promise.allSettled([
    getJson(url('RPT_LICO_FN_CPD')),
    getJson(url('RPT_F10_FINANCE_MAINFINADATA')),
  ]);

  const cpd = cpdRes.status === 'fulfilled'
    ? (((cpdRes.value || {}).result || {}).data || [])[0] : null;
  const main = mainRes.status === 'fulfilled'
    ? (((mainRes.value || {}).result || {}).data || [])[0] : null;
  if (!cpd && !main) return null;

  const revenue = num(cpd && cpd.TOTAL_OPERATE_INCOME) ?? num(main && main.OPERATE_INCOME_PK);
  const netProfit = num(cpd && cpd.PARENT_NETPROFIT) ?? num(main && main.PARENTNETPROFIT);

  return {
    report_date: String((main && main.REPORT_DATE) || (cpd && cpd.REPORTDATE) || '').slice(0, 10),
    revenue,
    revenue_yoy: num(cpd && cpd.YSTZ) ?? num(main && main.OI_YOYRATIO_PK),
    net_profit: netProfit,
    net_profit_yoy: num(cpd && cpd.SJLTZ) ?? num(main && main.PARENTNETPROFITTZ),
    gross_profit: num(main && main.OPERATE_PROFIT_PK),
    gross_margin: num(main && main.XSMLL) ?? num(cpd && cpd.XSMLL),
    net_margin: revenue && netProfit != null ? +(netProfit / revenue * 100).toFixed(2) : null,
    roe: num(main && main.ROEJQ) ?? num(cpd && cpd.WEIGHTAVG_ROE),
    roe_deducted: num(main && main.ROEKCJQ),
    eps: num(cpd && cpd.BASIC_EPS) ?? num(main && main.EPSJB),
    bps: num(main && main.BPS) ?? num(cpd && cpd.BPS),
    total_assets: num(main && main.TOTAL_ASSETS_PK),
    industry: (cpd && cpd.BOARD_NAME) || null,
  };
}

// ---------------------------------------------------------------- 指数

/**
 * 科创板主要指数行情（东方财富）。
 * 科创50 = 沪市 1.000688，科创综指 = 沪市 1.000680，科创100 = 沪市 1.000698。
 * iFinD 的指标接口查「科创50指数」会把 000688 解析成深市国城矿业，这条路走不通。
 */
async function fetchIndices() {
  const targets = [
    { key: 'kc50', name: '科创50', secid: '1.000688' },
    { key: 'kc_comp', name: '科创综指', secid: '1.000680' },
    { key: 'kc100', name: '科创100', secid: '1.000698' },
  ];
  const out = {};
  await Promise.all(targets.map(async (t) => {
    try {
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${t.secid}`
        + '&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170';
      const j = await getJson(url);
      const d = j && j.data;
      if (!d) return;
      out[t.key] = {
        name: d.f58 || t.name,
        point: d.f43 != null ? d.f43 / 100 : null,
        change_pct: d.f170 != null ? d.f170 / 100 : null,
        prev_close: d.f60 != null ? d.f60 / 100 : null,
        amount_yi: d.f48 != null ? d.f48 / 1e8 : null,
      };
    } catch { /* ignore */ }
  }));
  return out;
}

// ---------------------------------------------------------------- 快讯

/**
 * 7×24 全球财经快讯（东方财富），column=345 为 A 股快讯。
 * 覆盖了 iFinD trending 的角色：市场级热点事件流。
 */
async function fetchHotNews(limit = 20) {
  const out = [];
  for (const column of [345, 350]) {
    try {
      const url = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns'
        + `?client=web&biz=web_news_col&column=${column}&order=1&needInteractData=0`
        + `&page_index=1&page_size=${Math.ceil(limit / 2)}&req_trace=1`
        + '&fields=code,showTime,title,mediaName,summary,url,uniqueUrl&types=1,20';
      const j = await getJson(url);
      const list = (j.data && j.data.list) || [];
      for (const x of list) {
        out.push({
          title: String(x.title || '').replace(/<[^>]+>/g, ''),
          content: String(x.summary || '').replace(/<[^>]+>/g, ''),
          date: String(x.showTime || '').slice(0, 10),
          time: String(x.showTime || ''),
          url: x.uniqueUrl || x.url || '',
          source: x.mediaName || '东方财富',
          scope: '全市场',
        });
      }
    } catch { /* ignore */ }
  }
  const seen = new Set();
  return out.filter((x) => {
    if (!x.title || seen.has(x.title)) return false;
    seen.add(x.title);
    return true;
  }).slice(0, limit);
}

/**
 * 指数行情的腾讯兜底（东方财富 push2 被封时用）。
 * 指数代码：科创50=sh000688，科创综指=sh000680，科创100=sh000698。
 * 腾讯的指数行情字段布局与个股一致。
 */
async function fetchIndicesTencent() {
  const targets = [
    { key: 'kc50', name: '科创50', code: 'sh000688' },
    { key: 'kc_comp', name: '科创综指', code: 'sh000680' },
    { key: 'kc100', name: '科创100', code: 'sh000698' },
  ];
  const out = {};
  const url = 'https://qt.gtimg.cn/q=' + targets.map((t) => t.code).join(',');
  let body = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'], Referer: 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(25000),
    });
    body = await res.text();
  } catch { return out; }
  for (const t of targets) {
    const m = new RegExp(`v_${t.code}="([^"]*)"`).exec(body);
    if (!m) continue;
    const f = m[1].split('~');
    if (f.length < 50) continue;
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) && x !== 0 ? x : null;
    };
    out[t.key] = {
      name: t.name,
      point: n(f[3]),
      change_pct: n(f[32]),
      prev_close: n(f[4]),
      amount_yi: n(f[37]) != null ? n(f[37]) / 1e4 : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------- 历史估值分位

/**
 * 历史估值序列 → 自算 PE / PB 历史分位。
 *
 * 数据源：东财 RPT_VALUEANALYSIS_DET，每股约 1757 个交易日（7年）的
 * PE_TTM / PB_MRQ / 收盘价 / 涨跌幅 / 总市值。
 *
 * **为什么不直接用 iFinD 的「市盈率(PE,TTM)分位数」**：
 * 实测三家不同股票（澜起/华兴源创/中微）都返回**整整齐齐的 100.0**，
 * 而自算结果分别是 37.5 / 93.2 / 18.4 —— 例如澜起当前 PE 70.81，
 * 其 7 年 PE_TTM 中位数是 80.4、最大 151.0，不可能处在历史最高位。
 * 该指标至少在本次取数环境下不可信，而它还被用作高信号公司的加分项，
 * 会把大量公司误标成"估值极高"。故改为自算口径。
 *
 * 口径：默认近 3 年（约 750 个交易日）为主口径，同时给出全历史分位作参考；
 * 负 PE（亏损）不参与分布计算，与主流口径一致。
 */
async function fetchValuationHistory(code, opts = {}) {
  const bare = String(code || '').split('.')[0];
  const windowRows = opts.windowRows || 750;
  // **历史回补**（2026-10-27 新增）：asOf 指定"这一天的口径"，
  // full=true 时多要总市值/股本/PCF/PEG 等字段。
  // asOf=null 时行为与原来完全一致（取最新一行），线上采集路径不受影响。
  const asOf = opts.asOf || null;
  const full = !!opts.full;
  const columns = full
    ? 'ALL'
    : 'SECURITY_CODE%2CTRADE_DATE%2CPE_TTM%2CPB_MRQ%2CPS_TTM%2CCHANGE_RATE%2CCLOSE_PRICE';
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_VALUEANALYSIS_DET'
    + `&columns=${columns}`
    + `&filter=(SECUCODE%3D%22${bare}.SH%22)&pageNumber=1&pageSize=2000`
    + '&sortColumns=TRADE_DATE&sortTypes=-1&source=HSF10&client=PC';

  const j = await getJson(url);
  const rows = (j.result && j.result.data) || [];
  if (!rows.length) return null;

  // rows 已按 TRADE_DATE 倒序。asOf 模式：定位"当天或之前最近的一行"，
  // 并且**分位只能用该日及之前的历史**算（不能用未来的数据）。
  let idx = 0;
  if (asOf) {
    idx = rows.findIndex((r) => String(r.TRADE_DATE || '').slice(0, 10) <= asOf);
    if (idx === -1) idx = rows.length - 1;   // asOf 早于全部历史 → 取最早一行
  }
  const cur = rows[idx];
  // **upto 必须是「asOf 当天及更早」的那一段**：
  // rows 是按日期倒序的，所以 asOf 及更早的行是 rows[idx..末尾] → rows.slice(idx)。
  // （写成 slice(0, idx+1) 会把 asOf **之后**的行也算进来，分位窗口直接取错。）
  const upto = rows.slice(idx);
  const curPE = Number(cur.PE_TTM);
  const curPB = Number(cur.PB_MRQ);
  const curPS = Number(cur.PS_TTM);

  const pctOf = (field, curV, useWindow) => {
    if (!Number.isFinite(curV) || curV <= 0) return null;
    const src = useWindow ? upto.slice(0, windowRows) : upto;
    const hist = src.map((r) => Number(r[field])).filter((v) => Number.isFinite(v) && v > 0);
    if (hist.length < 60) return null;
    const below = hist.filter((v) => v < curV).length;
    return +((below / hist.length) * 100).toFixed(1);
  };

  return {
    date: String(cur.TRADE_DATE || '').slice(0, 10),
    // 回补口径下，"历史长度"应该只算到 asOf 当天（含），否则会把未来的交易日也数进去
    history_days: asOf ? upto.length : rows.length,
    window_days: windowRows,
    pe_ttm: Number.isFinite(curPE) ? +curPE.toFixed(2) : null,
    pb_mrq: Number.isFinite(curPB) ? +curPB.toFixed(2) : null,
    ps_ttm: Number.isFinite(curPS) ? +curPS.toFixed(2) : null,
    pe_percentile: pctOf('PE_TTM', curPE, true),
    pe_percentile_all: pctOf('PE_TTM', curPE, false),
    pb_percentile: pctOf('PB_MRQ', curPB, true),
    pb_percentile_all: pctOf('PB_MRQ', curPB, false),
    // ---- 回补口径（asOf + full）----
    ...(asOf ? { as_of: String(cur.TRADE_DATE || '').slice(0, 10), as_of_exact: String(cur.TRADE_DATE || '').slice(0, 10) === asOf } : {}),
    ...(full ? {
      total_mv: numOrNull(cur.TOTAL_MARKET_CAP),
      float_mv: numOrNull(cur.NOTLIMITED_MARKETCAP_A),
      total_shares: numOrNull(cur.TOTAL_SHARES),
      free_shares: numOrNull(cur.FREE_SHARES_A),
      close_price: numOrNull(cur.CLOSE_PRICE),
      change_rate: numOrNull(cur.CHANGE_RATE),
      pcf_ocf_ttm: numOrNull(cur.PCF_OCF_TTM),
      pcf_ocf_lar: numOrNull(cur.PCF_OCF_LAR),
      peg_car: numOrNull(cur.PEG_CAR),
    } : {}),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  fetchResearch, fetchAnnouncements, fetchCompanyNews, fetchCompanyNewsCached,
  fetchFinancials, fetchIndices, fetchIndicesTencent, fetchHotNews, fetchValuationHistory,
  readNewsCache, writeJsonFile, STAR, get, getJson,
};
