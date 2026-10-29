'use strict';
/**
 * 联网搜索客户端（2026-10-28 新增）。
 *
 * **为什么需要它**：科创板雷达只覆盖 619 家公司。CFO 问"竞对最近有什么动向"时，
 * 竞对往往**不在覆盖范围**（东方略未上市、复星万邦、德展健康、诺思兰德都是），
 * 本地检索再怎么做也答不出来 —— 必须联网。
 *
 * **支持三个供应商**（用户已有哪个 key 就用哪个，不用改代码）：
 *   tavily   POST https://api.tavily.com/search     （为 LLM 设计的搜索，返回干净摘要）
 *   brave    GET  https://api.search.brave.com/res/v1/web/search
 *   serpapi  GET  https://serpapi.com/search
 *
 * **纪律**：
 * 1. key 只在 `data/radar.env`，**绝不写进日志/错误信息/返回值**；
 * 2. 搜索结果会作为 **[W编号]** 证据进提示词，**必须带来源和日期**，
 *    且在提示词里和本地 **[E编号]** 明确区分（网络来源未经本地核验）；
 * 3. 失败要能说清楚（未配置 / 超时 / 4xx / 配额用尽），不吞异常。
 */
const http = require('http');
const https = require('https');
const env = require('./env');

const DEFAULTS = {
  provider: 'RADAR_SEARCH_PROVIDER',
  apiKey: 'RADAR_SEARCH_API_KEY',
  baseUrl: 'RADAR_SEARCH_BASE_URL',
  maxResults: 'RADAR_SEARCH_MAX_RESULTS',
  timeoutMs: 'RADAR_SEARCH_TIMEOUT_MS',
};

/** 免 key 的后端（默认用它，用户不用掏钱也不用注册） */
const NO_KEY_PROVIDERS = new Set(['duckduckgo', 'so360']);

/**
 * **后端清单与降级顺序**。
 *
 * 2026-10-29 实测踩到的坑：**DuckDuckGo 的 html 端点会按频率封 IP** ——
 * 连续跑了几十次之后开始一律 `ECONNRESET`（连试 3 次全断），表现是"联网突然失效"。
 * 所以不能只有一个后端，必须有降级链：
 *   ① 配置了 key 的后端（tavily/brave/serpapi）最稳，优先
 *   ② 免 key 的 duckduckgo
 *   ③ 免 key 的 360 搜索（结构不同但结果可用）
 * 加上**进程内缓存**（同一 query 10 分钟内不重复打后端）和**同后端最小请求间隔**，
 * 大幅降低被封概率。
 */
const BACKENDS = [
  { id: 'tavily', needsKey: true },
  { id: 'brave', needsKey: true },
  { id: 'serpapi', needsKey: true },
  { id: 'duckduckgo', needsKey: false },
  { id: 'so360', needsKey: false },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const MIN_INTERVAL_MS = 900;   // 同一后端两次请求的最小间隔

/** query → {rows, at} */
const searchCache = new Map();
/** 后端 id → 上次请求时间 */
const lastHit = new Map();

function cacheGet(q) {
  const hit = searchCache.get(q);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { searchCache.delete(q); return null; }
  return hit.rows;
}
function cacheSet(q, rows) {
  searchCache.set(q, { rows, at: Date.now() });
  while (searchCache.size > CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}

/** 同后端节流：间隔不够就等 */
async function throttle(id) {
  const last = lastHit.get(id) || 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(id, Date.now());
}

function config() {
  const provider = String(env.get(DEFAULTS.provider, 'auto') || 'auto').trim().toLowerCase();
  return {
    provider,
    apiKey: String(env.get(DEFAULTS.apiKey, '') || '').trim(),
    baseUrl: String(env.get(DEFAULTS.baseUrl, '') || '').trim().replace(/\/+$/, ''),
    maxResults: Math.min(20, Math.max(3, Number(env.get(DEFAULTS.maxResults, 6)) || 6)),
    timeoutMs: Number(env.get(DEFAULTS.timeoutMs, 25000)) || 25000,
  };
}

function status() {
  const c = config();
  return {
    configured: c.provider === 'auto' ? true : !!(c.apiKey || NO_KEY_PROVIDERS.has(c.provider)),
    provider: c.provider || null,
    maxResults: c.maxResults,
    timeoutMs: c.timeoutMs,
    /** 绝不带 apiKey */
  };
}

function isConfigured() {
  return status().configured;
}

/** 底层请求：只返回 {status, text}，不打印任何 key */
function request(urlStr, { method = 'GET', body = null, headers = {} }, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) {
      return reject(Object.assign(new Error('搜索地址不合法'), { code: 'SEARCH_BAD_URL' }));
    }
    const lib = u.protocol === 'http:' ? http : https;
    // body 传字符串就原样发（表单编码），传对象才 JSON 化
    const payload = body == null ? null
      : (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(JSON.stringify(body), 'utf8'));
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error(`搜索超时（${timeoutMs}ms）`), { code: 'SEARCH_TIMEOUT' })); });
    req.on('error', (e) => reject(Object.assign(new Error('搜索接口不可达：' + (e.code || e.message)), { code: 'SEARCH_NETWORK' })));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 统一结果形状 */
function norm(title, url, snippet, publishedAt, extra) {
  return {
    title: String(title || '').trim(),
    url: String(url || '').trim(),
    snippet: String(snippet || '').trim(),
    publishedAt: publishedAt || null,
    ...(extra || {}),
  };
}

/**
 * **DuckDuckGo html（免 key，默认后端）**。
 *
 * 为什么需要它：DeepSeek 网关只负责"决定搜什么"，**不执行搜索**（实测三轮确认），
 * 所以必须有一个**我们自己能调**的抓取层。DDG 的 html 端点实测可用
 * （HTTP 200、真实中文结果、带标题与摘要），而且**不需要任何 key** ——
 * 用户不用注册、不用掏钱。
 *
 * 有 Tavily/Brave/SerpAPI 的 key 时优先用它们（质量与稳定性更好）。
 */
async function duckduckgo(c, query) {
  const base = c.baseUrl || 'https://html.duckduckgo.com';
  const r = await request(base + '/html/', {
    method: 'POST',
    body: 'q=' + encodeURIComponent(query),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://duckduckgo.com/',
    },
  }, c.timeoutMs);
  if (r.status < 200 || r.status >= 300) {
    throw Object.assign(new Error(`DuckDuckGo 返回 ${r.status}`), { code: 'SEARCH_HTTP_' + r.status, status: r.status });
  }
  const html = r.text;
  const out = [];
  const seen = new Set();

  // 主解析：result__a（标题）+ result__snippet（摘要）
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    const url = realUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title || title.length < 6) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    // 摘要：在标题之后 1500 字符内找 result__snippet
    const after = html.slice(m.index, m.index + 1500);
    const sm = after.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    out.push(norm(title, url, sm ? stripTags(sm[1]).slice(0, 400) : '', null));
  }
  // 兜底：通用 <a> 提取（结构变了也不至于完全瞎）
  if (!out.length) {
    const gre = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
    while ((gre.exec(html)) && out.length < 20) {
      const url = realUrl(gre[1]);
      const title = stripTags(gre[2]);
      if (!url || !title || title.length < 10) continue;
      if (/duckduckgo\.com/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(norm(title, url, '', null));
    }
  }
  return out;
}

/**
 * **360 搜索（免 key，备胎）**。
 *
 * 为什么要备胎：2026-10-29 实测 DuckDuckGo 的 html 端点**会按频率封 IP**
 * （连打几十次后一律 ECONNRESET）。单后端 = 单点故障。
 *
 * 360 的结果结构与 DDG 不同：
 *   <div class="res-list"><h3 class="res-title"><a href="...so.com/link?m=..."
 *      data-mdurl="<真实网址>" >标题</a></h3><p class="res-desc">…<span data-result-summary>摘要</span></p></div>
 * **真实网址在 data-mdurl 属性里**（href 是 360 自己的跳转链）。
 */
async function so360(c, query) {
  const base = c.baseUrl || 'https://www.so.com';
  const r = await request(base + '/s?q=' + encodeURIComponent(query), {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://www.so.com/' },
  }, c.timeoutMs);
  if (r.status < 200 || r.status >= 300) {
    throw Object.assign(new Error(`360 搜索返回 ${r.status}`), { code: 'SEARCH_HTTP_' + r.status, status: r.status });
  }
  const html = r.text;
  const out = [];
  const seen = new Set();
  // 每个结果块：<div class="res-list" …> … </div>（用 res-title 定位更稳）
  const re = /<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>\s*<a([^>]*)>([\s\S]*?)<\/a>([\s\S]{0,1200}?)<\/h3>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 30) {
    const attrs = m[1] || '';
    const title = stripTags(m[2]);
    const after = m[3] || '';
    const urlMatch = attrs.match(/data-mdurl="([^"]+)"/);
    let url = urlMatch ? urlMatch[1] : '';
    if (!url) {
      const hm = attrs.match(/href="(https?:\/\/[^"]+)"/);
      url = hm ? hm[1] : '';
    }
    if (!/^https?:\/\//i.test(url) || !title || title.length < 6) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const sm = after.match(/data-result-summary[^>]*>([\s\S]*?)<\/span>/i)
      || after.match(/class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sm ? stripTags(sm[1]).slice(0, 400) : '';
    out.push(norm(title, url, snippet, null));
  }
  if (!out.length) {
    // 兜底：通用 <a> 提取
    const gre = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*data-mdurl="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
    while ((gre.exec(html)) && out.length < 20) {
      const title = stripTags(gre[3]);
      if (title.length < 10) continue;
      if (seen.has(gre[2])) continue;
      seen.add(gre[2]);
      out.push(norm(title, gre[2], '', null));
    }
  }
  return out;
}

/** DDG 的链接是跳转链接（//duckduckgo.com/l/?uddg=...），要还原成真实网址 */
function realUrl(href) {
  let h = String(href || '').trim();
  if (!h) return '';
  if (h.startsWith('//')) h = 'https:' + h;
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* ignore */ }
  }
  if (!/^https?:\/\//i.test(h)) return '';
  return h;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function tavily(c, query) {
  const base = c.baseUrl || 'https://api.tavily.com';
  const body = {
    query,
    max_results: c.maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
  };
  let r;
  // 官方现行文档用 Authorization 头；老版本用 body 里的 api_key。
  // 先用头，401/403 再回退 body —— 这样两种 key 形态都能用。
  try {
    r = await request(base + '/search', { method: 'POST', body, headers: { Authorization: `Bearer ${c.apiKey}` } }, c.timeoutMs);
  } catch (e) { throw e; }
  if (r.status === 401 || r.status === 403) {
    r = await request(base + '/search', { method: 'POST', body: { ...body, api_key: c.apiKey }, headers: {} }, c.timeoutMs);
  }
  if (r.status < 200 || r.status >= 300) {
    const msg = /quota|limit|credit|plan/i.test(r.text) ? '（配额或额度用尽）' : '';
    throw Object.assign(new Error(`Tavily 返回 ${r.status}${msg}`), { code: 'SEARCH_HTTP_' + r.status, status: r.status });
  }
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
  const rows = (j && j.results) || [];
  return rows.map((x) => norm(x.title, x.url, x.content || x.snippet, x.published_date, { score: x.score }));
}

async function brave(c, query) {
  const base = c.baseUrl || 'https://api.search.brave.com';
  const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${c.maxResults}&textDecorations=false`;
  const r = await request(url, { method: 'GET', headers: { 'X-Subscription-Token': c.apiKey, Accept: 'application/json' } }, c.timeoutMs);
  if (r.status < 200 || r.status >= 300) {
    const msg = /quota|limit|credit|plan/i.test(r.text) ? '（配额或额度用尽）' : '';
    throw Object.assign(new Error(`Brave 返回 ${r.status}${msg}`), { code: 'SEARCH_HTTP_' + r.status, status: r.status });
  }
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
  const rows = (j && j.web && j.web.results) || [];
  return rows.map((x) => norm(x.title, x.url, x.description, x.age || x.page_age, { profile: x.profile }));
}

async function serpapi(c, query) {
  const base = c.baseUrl || 'https://serpapi.com';
  const url = `${base}/search?q=${encodeURIComponent(query)}&num=${c.maxResults}&hl=zh-cn&api_key=${encodeURIComponent(c.apiKey)}`;
  const r = await request(url, { method: 'GET', headers: { Accept: 'application/json' } }, c.timeoutMs);
  if (r.status < 200 || r.status >= 300) {
    const msg = /quota|limit|credit|plan/i.test(r.text) ? '（配额或额度用尽）' : '';
    throw Object.assign(new Error(`SerpAPI 返回 ${r.status}${msg}`), { code: 'SEARCH_HTTP_' + r.status, status: r.status });
  }
  let j = null;
  try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
  const rows = (j && j.organic_results) || [];
  return rows.map((x) => norm(x.title, x.link, x.snippet, x.date, { position: x.position }));
}

/**
 * 联网搜索。
 * @param {string} query
 * @param {{maxResults?:number}} opts
 * @returns {Promise<Array<{title,url,snippet,publishedAt}>>}
 */
/**
 * 联网搜索。
 *
 * **降级链**（2026-10-29 实测 DDG 会被封之后加的）：
 *   配置了 key 的后端优先 → duckduckgo → so360
 *   同一个 query 10 分钟内走缓存，不重复打后端。
 *
 * @param {string} query
 * @param {{maxResults?:number}} opts
 * @returns {Promise<Array<{title,url,snippet,publishedAt,viaQuery?}>>}
 */
async function search(query, opts = {}) {
  const c = config();
  const q = String(query || '').trim();
  if (!q) return [];

  // 缓存命中直接返回（省一次外部请求，也降低被封概率）
  const cached = cacheGet(q);
  if (cached) return cached.slice(0, opts.maxResults || c.maxResults);

  const max = Math.min(20, Math.max(3, Number(opts.maxResults) || c.maxResults));

  // 要试的后端：指定了就只试它；auto 则按清单顺序（key 后端优先）
  let list;
  if (c.provider !== 'auto') {
    list = BACKENDS.filter((b) => b.id === c.provider);
    if (!list.length) throw Object.assign(new Error(`未知的搜索后端：${c.provider}`), { code: 'SEARCH_BAD_PROVIDER' });
  } else {
    list = BACKENDS.filter((b) => (b.needsKey ? !!c.apiKey : true));
  }
  // 指定后端但缺 key
  for (const b of list) {
    if (b.needsKey && !c.apiKey) {
      throw Object.assign(new Error(`搜索后端 ${b.id} 需要 API key（可改用 provider=auto 或 duckduckgo/so360）`), { code: 'SEARCH_NOT_CONFIGURED' });
    }
  }

  let lastErr = null;
  for (const b of list) {
    try {
      await throttle(b.id);
      let rows = [];
      if (b.id === 'duckduckgo') rows = await duckduckgo({ ...c, maxResults: max }, q);
      else if (b.id === 'so360') rows = await so360({ ...c, maxResults: max }, q);
      else if (b.id === 'brave') rows = await brave({ ...c, maxResults: max }, q);
      else if (b.id === 'serpapi') rows = await serpapi({ ...c, maxResults: max }, q);
      else rows = await tavily({ ...c, maxResults: max }, q);

      // 去重 + 截断
      const seen = new Set();
      const out = [];
      for (const x of rows) {
        const k = String(x.url || x.title).replace(/[#?].*$/, '');
        if (!x.title || seen.has(k)) continue;
        seen.add(k);
        out.push(x);
        if (out.length >= max) break;
      }
      if (out.length) {
        cacheSet(q, out);
        return out;
      }
      lastErr = Object.assign(new Error(`${b.id} 没返回结果`), { code: 'SEARCH_EMPTY' });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || Object.assign(new Error('所有搜索后端都没成功'), { code: 'SEARCH_FAILED' });
}

module.exports = { search, status, isConfigured, config, NO_KEY_PROVIDERS, BACKENDS };
