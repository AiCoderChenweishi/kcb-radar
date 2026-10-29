'use strict';
/**
 * Web 服务：静态看板 + 只读 API。
 * 数据全部来自 data/daily/<date>.json，采集由采集脚本写入，服务本身只读。
 */
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cfg = require('./config');
const store = require('./store');
const env = require('./env');
const { buildBrief } = require('./insight');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const briefCache = new Map();

/**
 * 把 console 输出同步落盘（崩溃现场留痕）。
 * 用同步写，保证进程被杀之前写进去的日志不会丢。
 */
function teeConsole(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      stream.write = (chunk, enc, cb) => {
        try { fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch { /* ignore */ }
        return orig(chunk, enc, cb);
      };
    }
  } catch { /* ignore */ }
}

/**
 * **事件循环延迟看门狗**（2026-10-27 新增）。
 *
 * 为什么要专门盯这个：2026-10-27 13:23 和 16:54 两次"静默卡死"，
 * 表象都是**端口还在监听、但请求没人应答**，健康检查探活超时后只能靠杀进程重启。
 * 而"卡死"的本质是**事件循环被长时间占住**（同步的大计算 / 大 JSON 解析），
 * 这在 netstat 和进程存活检查里**完全看不出来** —— 进程活着，端口也在，
 * 只是所有回调都排不上队。
 *
 * 做法：每 1 秒打一个标记，再在下一个 tick 算"实际间隔 - 预期间隔"。
 * 差值就是事件循环被阻塞的时长。超过阈值就落盘报警，
 * 下次排查时直接能看到"哪一刻被堵了、堵了多久"。
 */
const loopLag = { max: 0, last: 0, samples: 0, lastWarnAt: 0 };
function startLoopWatchdog() {
  let expected = Date.now() + 1000;
  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - expected);
    expected = now + 1000;
    loopLag.last = lag;
    loopLag.samples++;
    if (lag > loopLag.max) loopLag.max = lag;
    if (lag >= 2000 && now - loopLag.lastWarnAt > 10000) {
      loopLag.lastWarnAt = now;
      const line = `[${new Date().toISOString()}] [watchdog] 事件循环被阻塞 ${lag}ms（>2s）\n`;
      try { fs.appendFileSync(path.join(cfg.DATA_DIR, 'access.log'), line); } catch { /* ignore */ }
      console.log(line.trim());
    }
  }, 1000).unref();
}

/** 请求是否来自本机回环（回环始终放行写操作） */
function isLoopbackRequest(req) {
  const remote = String(req.socket.remoteAddress || '');
  return /^(::1|::ffff:127\.)/.test(remote) || remote === '127.0.0.1';
}

/**
 * **联网搜索的独立限流**（2026-10-28 新增）。
 *
 * 为什么单独限：问答本身不花搜索额度，但**联网问答要花**（Tavily 按次计费/有月配额）。
 * 所以搜索走自己的闸，避免一个人连续问 8 个问题把当月额度打光。
 */
const askSearchHits = new Map();
function askSearchRateLimit(ip) {
  const max = Number(env.get('RADAR_ASK_SEARCH_RPM', 3)) || 3;
  const now = Date.now();
  const key = ip || 'unknown';
  const h = askSearchHits.get(key);
  if (!h || now - h.t > 60000) { askSearchHits.set(key, { n: 1, t: now }); return { ok: true, n: 1 }; }
  h.n++;
  if (askSearchHits.size > 200) {
    for (const [k, v] of askSearchHits) if (now - v.t > 60000) askSearchHits.delete(k);
  }
  if (h.n > max) return { ok: false, retryAfter: Math.max(1, Math.ceil((60000 - (now - h.t)) / 1000)) };
  return { ok: true, n: h.n };
}

/**
 * **问答全局日限**（2026-10-29 新增）。
 *
 * 为什么需要：看板开放到公网后，问答接口**没有访问控制**（用户明确要求公开），
 * 而每问一次都要消耗模型额度 + 搜索额度。每 IP 限流（8 次/分钟）挡不住
 * 多个 IP 一起刷 —— 所以再加一道**全局每日上限**，把最坏情况钉死。
 *
 * 注意：这是**成本护栏，不是访问控制**（默认 300 次/天，0 表示不限制）。
 * 进程重启会重置计数（可接受：重启本身也是人工动作）。
 */
const askDaily = { date: null, n: 0 };
function askDailyCap() {
  const cap = Number(env.get('RADAR_ASK_DAILY_CAP', 300)) || 0;
  const today = new Date().toISOString().slice(0, 10);
  if (askDaily.date !== today) { askDaily.date = today; askDaily.n = 0; }
  if (cap <= 0) return { ok: true, n: askDaily.n, cap: 0 };
  if (askDaily.n >= cap) return { ok: false, n: askDaily.n, cap };
  askDaily.n++;
  return { ok: true, n: askDaily.n, cap };
}

/**
 * 问答接口限流（每 IP 每分钟 N 次，默认 8）。
 * 问答会消耗模型额度，不能无限刷；但它不碰外部采集接口，阈值比采集宽松。
 */
const askHits = new Map();
function askRateLimit(ip) {
  const max = Number(env.get('RADAR_ASK_RPM', 8)) || 8;
  const now = Date.now();
  const key = ip || 'unknown';
  const h = askHits.get(key);
  if (!h || now - h.t > 60000) { askHits.set(key, { n: 1, t: now }); return { ok: true, n: 1 }; }
  h.n++;
  if (askHits.size > 200) {                       // 防止 map 无限增长
    for (const [k, v] of askHits) if (now - v.t > 60000) askHits.delete(k);
  }
  if (h.n > max) return { ok: false, retryAfter: Math.max(1, Math.ceil((60000 - (now - h.t)) / 1000)) };
  return { ok: true, n: h.n };
}

/** 问答台账：谁在什么时候问了什么（额度消耗要可追溯） */
function appendAskLog(entry) {
  try {
    const f = path.join(cfg.DATA_DIR, 'ask-log.jsonl');
    fs.appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * 瘦载荷：首屏只给汇总与表格。
 * 全量 brief 有 2MB，浏览器读完响应体这一步会卡住（1MB 的响应能读、2MB 读不完），
 * 所以把三条信息流拆到 /api/feeds，按 tab 分页按需拉取。
 */
function trimBrief(brief) {
  const light = (n) => {
    if (!n) return n;
    return {
      date: n.date, code: n.code, name: n.name, title: n.title, url: n.url,
      is_research: n.is_research, broker: n.broker, rating: n.rating,
      target_price: n.target_price, kind: n.kind, is_latest: n.is_latest,
      institution_count: n.institution_count,
      // 内容总结：券商观点的"这篇研报到底说了什么"（2026-10-23 用户要求）
      summary: n.summary || '',
      content: n.content || '',
      view: n.view || null,
      view_thesis: n.view_thesis || null,
    };
  };
  return {
    date: brief.date,
    window: brief.window,
    generatedAt: brief.generatedAt,
    elapsedMs: brief.elapsedMs,
    latestDate: brief.latestDate,
    // 行业清单：全局筛选（行业 + 日期范围）要用它来填下拉
    industryStats: brief.industryStats || [],
    // 要闻总结 / 大事板块 / 医药专章（与简报、Mini App 同源）
    newsDigest: brief.newsDigest || null,
    stats: brief.stats,
    sources: brief.sources,
    // iFinD 额度台账（2026-10-23 改造）：看板顶部要显示当日实际请求数
    ifind: brief.ifind || null,
    degraded: brief.degraded,
    market: brief.market,
    coverage: brief.coverage,
    events: brief.events || [],
    sellSideByIndustry: brief.sellSideByIndustry || [],
    highlights: (brief.highlights || []).map((c) => ({
      code: c.code, name: c.name, score: c.score, signals: c.signals,
      industry: c.industry, quote: c.quote, valuation: c.valuation, growth: c.growth,
      news_count: (c.news || []).length,
      notice_count: (c.notices || []).length,
      research_count: (c.research || []).length,
      viewpoint_change: c.viewpoint_change,
    })),
    trending: brief.trending,
    sellSide: brief.sellSide,
    sellSideStats: brief.sellSideStats,
    valuationTable: brief.valuationTable,
    financialTable: brief.financialTable,
    companies: (brief.companies || []).map((c) => ({
      code: c.code, name: c.name, board: c.board, industry: c.industry,
      quote: c.quote, valuation: c.valuation, growth: c.growth, profitability: c.profitability,
      revenue: c.revenue, net_profit_attr: c.net_profit_attr, total_assets: c.total_assets,
      score: c.score, signals: c.signals,
      news_count: (c.news || []).length,
      notice_count: (c.notices || []).length,
      research_count: (c.research || []).length,
    })),
    feedCounts: {
      news: (brief.newsFeed || []).length,
      research: (brief.researchFeed || []).length,
      notice: (brief.noticeFeed || []).length,
    },
  };
}

/** 信息流分页接口 */
function buildFeed(brief, type, page, size, keyword, researchOnly, latestOnly) {
  let list = type === 'news' ? brief.newsFeed
    : type === 'research' ? brief.researchFeed
      : brief.noticeFeed;
  if (type === 'news') {
    if (researchOnly) list = list.filter((x) => x.is_research);
    if (latestOnly) list = list.filter((x) => x.is_latest);
  }
  if (keyword) {
    const lq = String(keyword).toLowerCase();
    // 搜索范围包含摘要正文：只搜标题的话，用户搜"业绩预增"搜不到摘要里提到这事的新闻
    list = list.filter((x) => `${x.name || ''}${x.code || ''}${x.title || ''}${x.broker || ''}${x.content || ''}`.toLowerCase().includes(lq));
  }
  const total = list.length;
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(500, Math.max(10, Number(size) || 100));
  const start = (p - 1) * s;
  return {
    type, page: p, size: s, total,
    pages: Math.max(1, Math.ceil(total / s)),
    items: list.slice(start, start + s),
  };
}

function getBrief(date) {
  const d = date || store.latestDate();
  if (!d) return null;
  const ds = store.loadDataset(d);
  if (!ds) return null;

  // 缓存必须跟数据文件的修改时间绑定：
  // 同一天重采（补跑/复采）后日期不变，只按日期做 key 会一直返回旧数据。
  const file = store.datasetPath(d);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  // **还要跟"上一日"绑定**：跨日差分是拿上一日数据集做基准算的，
  // 而上一日会因历史回补而改变（2026-10-27 补进 10-24/25/26 后，
  // 10-27 的基准就从 10-23 变成了 10-26）。
  // 只按 mtime 判定 → 数据集没动，缓存却留着按旧基准算出来的跨日差分。
  const prevDate = store.previousDate(d);
  const hit = briefCache.get(d);
  if (hit && hit.mtime === mtime && hit.prevDate === prevDate) return hit.brief;

  const prev = prevDate ? store.loadDataset(prevDate) : null;
  const brief = buildBrief(ds, prev);
  briefCache.set(d, { mtime, prevDate, brief });
  if (briefCache.size > 8) briefCache.delete(briefCache.keys().next().value);
  // 数据集变了 → 区间聚合的记忆化缓存也要作废（否则看板会拿到按旧数据算的区间结果）
  try { require('./range').clearRangeCache(); } catch { /* ignore */ }
  return brief;
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  // 暂不启用 gzip：实测在客户端侧 2MB 响应会卡在读 body 阶段，
  // 且 16:21（未压缩、833KB）能正常渲染，启用压缩后反而读不完。
  // 保持不压缩，待确认压缩是否兼容后再开。
  const payload = Buffer.from(body, 'utf8');
  res._outLen = payload.length;      // 供访问日志统计（响应结束后头会被清掉）
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    // 明确关闭连接：客户端在 keep-alive 下可能一直等不到 fetch 结算
    Connection: 'close',
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\./g, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 看板是日更的，前端资源随时会改；不显式禁用缓存会让浏览器拿旧版 app.js，
    // 表现为"改了代码但界面没变"（2026-10-22 实测踩到）。
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q = parsed.query || {};

  // 请求日志写文件（后台任务的 stdout 拿不到，排查时需要落盘）
  if (pathname.startsWith('/api/')) {
    const t0 = Date.now();
    // **响应结束时 Content-Length 头已经被 Node 清掉了**，
    // 所以必须在 writeHead 之前就把长度抓下来，否则日志里永远是 "?B"。
    let outLen = '?';
    res.on('finish', () => {
      const line = `[${new Date().toISOString().slice(11, 19)}] ${req.method} ${pathname}`
        + ` -> ${res.statusCode} ${res._outLen != null ? res._outLen : outLen}B ${Date.now() - t0}ms\n`;
      try { fs.appendFileSync(path.join(cfg.DATA_DIR, 'access.log'), line); } catch { /* ignore */ }
      console.log(line.trim());
    });
  }

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/ping') {
        const size = Math.min(5 * 1024 * 1024, Number(q.bytes) || 1024);
        const buf = Buffer.alloc(size, 'x');
        res._outLen = size;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': size,
        });
        res.end(buf);
        return;
      }
      if (pathname === '/api/dates') {
        return sendJson(res, { dates: store.listDates() });
      }
      if (pathname === '/api/status') {
        const st = store.loadStatus() || { ok: null, message: '尚未执行过采集' };
        // 告诉前端"当前这台机器能不能触发写操作"——
        // 监听 0.0.0.0 后，从别的 PC 点「刷新」会拿到 403，
        // 与其给一个看不懂的报错，不如让前端直接禁用按钮并说明原因。
        st.writeAllowed = isLoopbackRequest(req);
        st.lanExposed = cfg.HOST !== '127.0.0.1' && cfg.HOST !== 'localhost';
        st.host = cfg.HOST;
        st.port = cfg.PORT;
        // **局域网访问地址**：页面直接显示，团队里其他人照着就能打开。
        // 为什么必须实时取：内网 IP 是 DHCP 分配的，**会变** ——
        // 写死在文档里的地址过几天就失效了。
        try {
          const os = require('os');
          const ips = [];
          for (const list of Object.values(os.networkInterfaces() || {})) {
            for (const n of (list || [])) {
              if (n && n.family === 'IPv4' && !n.internal) ips.push(n.address);
            }
          }
          st.lan = {
            host: os.hostname(),
            port: cfg.PORT,
            ips,
            /** 优先给私有网段的那个（192.168 / 10 / 172.16-31） */
            primary: ips.find((x) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x)) || ips[0] || null,
            exposed: st.lanExposed,
          };
        } catch { st.lan = null; }
        // 预热状态：冷缓存时首屏会慢，前端/巡检据此判断"该等还是该用"
        st.warm = { ...warmState };
        // 事件循环延迟：>2000ms 说明服务曾经被同步计算堵死过
        st.loopLag = { ...loopLag };
        // 问答配额（公网开放时靠它兜底）
        st.askQuota = {
          today: askDaily.date,
          used: askDaily.n,
          cap: Number(env.get('RADAR_ASK_DAILY_CAP', 300)) || 0,
        };
        // 模型是否已配置（前端据此决定"直接问"还是"只给提示词"）
        try { st.llm = require('./llm').status(); } catch { st.llm = { configured: false }; }
        return sendJson(res, st);
      }
      if (pathname === '/api/brief') {
        const brief = getBrief(q.date);
        if (!brief) return sendJson(res, { error: '暂无数据，请先运行采集' }, 404);
        const out = trimBrief(brief);
        // 调试用：限制返回的公司数，用于定位客户端读取大响应的阈值
        if (q.n) {
          const n = Math.max(1, Math.min(2000, Number(q.n) || 0));
          out.companies = out.companies.slice(0, n);
          out.valuationTable = out.valuationTable.slice(0, n);
          out.financialTable = out.financialTable.slice(0, n);
        }
        return sendJson(res, out);
      }
      if (pathname === '/api/range') {
        // **区间 + 行业整体筛选**：一次给全，前端不再自己拼。
        const { aggregateRange, normalizeIndustry } = require('./range');
        const type = q.type || 'news';
        const r = aggregateRange(q.from, q.to, normalizeIndustry(q.industry));
        if (!r.available) {
          return sendJson(res, { available: false, reason: r.reason, from: r.from, to: r.to, dates: [] }, 200);
        }
        const pool = (r.items[type] || []);
        const kw = (q.q || '').trim().toLowerCase();
        let list = kw
          ? pool.filter((x) => `${x.name || ''}${x.code || ''}${x.title || ''}${x.content || ''}${x.broker || ''}${x.view_thesis || ''}`.toLowerCase().includes(kw))
          : pool.slice();
        // 「仅看券商研报」：区间模式下要闻池同样混着研报，口径与单日模式一致
        if (type === 'news' && (q.researchOnly === '1' || q.researchOnly === 'true')) {
          list = list.filter((x) => x.is_research);
        }
        const size = Math.min(500, Math.max(10, Number(q.size) || 50));
        const page = Math.max(1, Number(q.page) || 1);
        return sendJson(res, {
          available: true,
          from: r.from, to: r.to, baseDate: r.baseDate, dates: r.dates,
          truncated: r.truncated,
          coverage: r.coverage,
          warnings: r.warnings || [],
          industries: r.industries,
          stats: r.stats,
          type,
          total: list.length,
          pages: Math.max(1, Math.ceil(list.length / size)),
          page, size,
          items: list.slice((page - 1) * size, page * size),
          // 区间涨跌：from 日 vs to 日收盘价（给"全量"面板排序用）
          companies: r.companies,
        });
      }
      if (pathname === '/api/feeds') {
        const brief = getBrief(q.date);
        if (!brief) return sendJson(res, { error: '暂无数据' }, 404);
        const feed = buildFeed(
          brief,
          q.type || 'news',
          q.page, q.size,
          q.q || q.keyword,
          q.researchOnly === '1' || q.researchOnly === 'true',
          q.latestOnly === '1' || q.latestOnly === 'true'
        );
        return sendJson(res, feed);
      }
      if (pathname === '/api/company') {
        const code = q.code;
        const brief = getBrief(q.date);
        if (!brief) return sendJson(res, { error: '暂无数据' }, 404);
        const c = brief.companies.find((x) => x.code === code);
        if (!c) return sendJson(res, { error: '未找到该公司' }, 404);
        return sendJson(res, c);
      }
      if (pathname === '/api/collect' && req.method === 'POST') {
        // **写接口的暴露面**：一旦服务监听在局域网（RADAR_HOST=0.0.0.0），
        // 同网段任何人都能 POST 触发一次全量采集（会打满外部接口、抢配额）。
        // 因此：非回环来源必须带对 RADAR_WRITE_TOKEN；本机始终放行。
        const remote = String(req.socket.remoteAddress || '');
        const isLoopback = /^(::1|::ffff:127\.)/.test(remote) || remote === '127.0.0.1';
        if (!isLoopback) {
          const token = process.env.RADAR_WRITE_TOKEN || '';
          const given = String(req.headers['x-radar-token'] || '');
          if (!token || given !== token) {
            return sendJson(res, { error: '写接口需要有效的 X-Radar-Token' }, 403);
          }
        }
        // 并发保护：锁里是 JSON（pid + startedAt），与 run_collect.cjs 保持一致
        const marker = path.join(cfg.DATA_DIR, 'collecting.lock');
        if (fs.existsSync(marker)) {
          let info = null;
          try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { info = null; }
          const age = info && info.startedAt ? Date.now() - info.startedAt : 0;
          let alive = false;
          if (info && info.pid) { try { process.kill(info.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
          if (age < 20 * 60 * 1000 && alive) {
            return sendJson(res, { started: false, reason: '已有采集任务在运行' });
          }
        }
        const { spawn } = require('child_process');
        const script = path.join(__dirname, '..', 'scripts', 'run_collect.cjs');
        try { fs.writeFileSync(marker, String(Date.now()), 'utf8'); } catch { /* ignore */ }
        const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
        child.unref();
        return sendJson(res, { started: true, pid: child.pid });
      }
      if (pathname === '/api/ask' && req.method === 'POST') {
        // **CFO 问答**：组装「项目背景 + 当日上下文 + 检索材料」→ 调模型 → 回答案与证据
        //
        // 鉴权取舍：问答会消耗**模型额度**，所以做限流；
        // 但它不像 /api/collect 那样会打满外部采集接口，也不改任何数据，
        // 所以**内网可直接用**（CFO 在 PC 或手机上都能问），不给它上写接口那套 token 门。
        // 限流阈值走 env（RADAR_ASK_RPM，默认 8 次/分钟/IP）。
        const body = await readBody(req);
        const question = String(body.question || '').trim();
        const ip = String(req.socket.remoteAddress || '');
        if (!question) return sendJson(res, { error: '问题不能为空' }, 400);
        if (question.length > 500) return sendJson(res, { error: '问题过长（限 500 字）' }, 400);
        const rl = askRateLimit(ip);
        if (!rl.ok) {
          return sendJson(res, { error: `请求太频繁，请 ${rl.retryAfter} 秒后再试` }, 429);
        }
        // 全局日限（成本护栏，见函数注释）
        const dc = askDailyCap();
        if (!dc.ok) {
          return sendJson(res, {
            error: `今日问答次数已达上限（${dc.cap} 次/天），明天再来`,
            degraded: 'DAILY_CAP_REACHED',
          }, 429);
        }
        const askMod = require('./ask');
        const llmMod = require('./llm');
        // **分阶段计时**：问答是唯一会跑很久的接口（要调模型），
        // 一旦出现"请求发出去没回来"，必须能一眼看出卡在哪一段。
        let tp = Date.now();
        const phases = [];
        const mark = (name) => { const n = Date.now(); phases.push(`${name}=${n - tp}ms`); tp = n; };
        const date = body.date || store.latestDate();
        const ds = store.loadDataset(date);
        mark('loadDataset');
        if (!ds) return sendJson(res, { error: '没有可用数据' }, 404);
        const brief = getBrief(date);
        mark('getBrief');
        if (!brief) return sendJson(res, { error: '简报数据未就绪' }, 404);

        const retrieval = askMod.retrieve(question, ds);
        mark('retrieve');

        // ---- 联网检索（2026-10-28 新增）----
        // 竞对/最新动向这类问题，本地 619 家根本覆盖不到 → 必须联网。
        //
        // **两段式**（因为 DeepSeek 网关只"决定搜什么"、不"执行搜索"——实测三轮确认）：
        //   ① 让模型用 web_search 工具提出检索式（它会自动把复杂问题拆成多个查询）
        //   ② 我们去搜（默认 DuckDuckGo 免 key；配了 key 就用 Tavily/Brave/SerpAPI）
        //   ③ 把结果编成 [W编号] 证据，连同原提示词一起让模型写最终答案
        const webMod = require('./websearch');
        const need = askMod.detectWebNeed(question, { mode: env.get('RADAR_SEARCH_MODE', 'auto') });
        let webResults = [];
        let webError = null;
        let webNote = '';
        let searchQueries = [];
        if (need.needed && webMod.isConfigured()) {
          const srl = askSearchRateLimit(ip);
          if (!srl.ok) {
            webError = `SEARCH_RATE_LIMITED（${srl.retryAfter}s 后可再试）`;
          } else {
            try {
              // ① 检索规划
              const plan = askMod.buildSearchPlan(question, brief);
              let queries = [];
              try {
                const pr = await llmMod.chat(
                  [{ role: 'system', content: plan.system }, { role: 'user', content: plan.user }],
                  { webSearch: true, maxTokens: 600, noRetry: true }
                );
                queries = (pr.toolCalls || []).map((t) => t.query).filter(Boolean);
              } catch (pe) {
                // 规划失败不致命：退回用原问题搜
                queries = [];
              }
              if (!queries.length) queries = [question];
              searchQueries = queries.slice(0, 3);
              mark('searchPlan');
              // ② 抓取
              const maxW = Number(env.get('RADAR_SEARCH_MAX_RESULTS', 6)) || 6;
              const perQuery = Math.max(1, Math.ceil(maxW / Math.max(1, searchQueries.length)));
              const buckets = [];
              for (const q of searchQueries) {
                let rows = [];
                try { rows = await webMod.search(q); } catch (se) { webError = String(se.code || se.message); }
                buckets.push(rows.map((r) => ({ ...r, viaQuery: q })));
              }
              // **多查询轮询**：不能按查询顺序一路吃满 ——
              // 第一个查询通常结果最多，会把配额吃光，后面的查询（往往才是竞对角度）一个都进不来。
              const seen = new Set();
              const take = (x) => {
                const k = String(x.url || x.title).replace(/[#?].*$/, '');
                if (seen.has(k)) return false;
                seen.add(k);
                webResults.push(x);
                return true;
              };
              for (let round = 0; round < perQuery; round++) {
                for (const b of buckets) { if (round < b.length) take(b[round]); }
              }
              for (const b of buckets) { for (const x of b) { if (webResults.length >= maxW) break; take(x); } }
              webResults = webResults.slice(0, maxW);
              mark('websearch');
            } catch (e) {
              webError = String(e.code || e.message);
              mark('webError');
            }
          }
        } else if (need.needed) {
          webError = 'SEARCH_NOT_CONFIGURED';
        }
        // 竞争类问题：把雷达覆盖内的同赛道公司一起拉进来（康希诺、百利天恒这类）
        let peers = [];
        if (need.competitive) {
          const exp = askMod.expandCompetitive(ds, retrieval.named, retrieval.evidence);
          peers = exp.peers;
          webNote = exp.note;
        }
        const prompt = askMod.buildPrompt({ question, brief, dataset: ds, retrieval, webResults, peers, webNote });
        mark('buildPrompt');
        const evidence = askMod.slimEvidence(retrieval.evidence);
        const webEvidence = askMod.slimWeb(webResults);
        mark('slim');
        const base = {
          question, date, prompt: prompt.user, system: prompt.system,
          evidence, webEvidence, namedCompanies: retrieval.namedCompanies,
          llm: llmMod.status(),
          search: { ...webMod.status(), used: webResults.length > 0, error: webError, reason: need.reason, results: webResults.length, queries: searchQueries },
          peers: peers.map((p) => ({
            code: p.c.code, name: p.c.name, industry: p.c.industry,
            reasons: p.reasons, topNews: p.topNews || [], mentionedTitles: p.mentionedTitles || [],
          })),
        };

        // **模型不可用时降级成"只出提示词"**，而不是报错让页面白屏
        if (!llmMod.isConfigured()) {
          return sendJson(res, {
            ...base,
            degraded: 'MODEL_NOT_CONFIGURED',
            message: '未配置模型（请在 data/radar.env 填 RADAR_LLM_BASE_URL / RADAR_LLM_API_KEY / RADAR_LLM_MODEL）。已改为只返回提示词，可复制到别处使用。',
          });
        }
        try {
          const r = await llmMod.chat([
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ]);
          mark('llm');
          console.log(`[ask] ${phases.join(' ')} | ${question.slice(0, 40)}`);
          appendAskLog({ at: new Date().toISOString(), ip, date, question, model: r.model, usage: r.usage || null, evidenceCount: evidence.length, ms: Date.now() - tp, phases: phases.join(' ') });
          return sendJson(res, { ...base, answer: r.text, model: r.model, usage: r.usage || null, degraded: null });
        } catch (e) {
          mark('llmError');
          console.log(`[ask] ${phases.join(' ')} | ${question.slice(0, 40)}`);
          appendAskLog({ at: new Date().toISOString(), ip, date, question, error: String(e.code || e.message), evidenceCount: evidence.length, ms: Date.now() - tp, phases: phases.join(' ') });
          return sendJson(res, {
            ...base,
            degraded: 'MODEL_ERROR',
            error: String(e.message || e),
            message: '模型调用失败，已改为只返回提示词，可复制到别处使用。',
          });
        }
      }
      return sendJson(res, { error: '未知接口' }, 404);
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  return serveStatic(req, res, pathname);
}

/** 内置定时器：每天 07:30 触发采集 */
function startScheduler() {
  const tick = () => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(cfg.SCHEDULE.hour, cfg.SCHEDULE.minute, 0, 0);
    let delay = target - now;
    if (delay < 0) delay += 86400000;
    setTimeout(() => {
      const { spawn } = require('child_process');
      const script = path.join(__dirname, '..', 'scripts', 'run_collect.cjs');
      const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`[scheduler] ${new Date().toISOString()} 已触发每日采集`);
      tick();
    }, delay);
    console.log(`[scheduler] 下次采集：${target.toLocaleString('zh-CN')}`);
  };
  tick();
}

/**
 * **启动预热**（2026-10-27 新增）。
 *
 * 为什么必须做：数据集缓存是**进程级**的，服务一重启就是冷的。
 * 而看板首屏会同时打几十个区间请求，每个都要把窗口内的日期重新读盘 + 重新解析
 * （实测冷启动时 30 个并发请求 9 秒、20 个超过 3 秒；缓存热了以后是 74 毫秒）。
 * 也就是说**用户重启后第一次打开看板要等 9 秒** —— 这不是"内部问题"，是直接的用户体验。
 *
 * 做法：服务一监听就在后台把可用日期的数据集全部灌进缓存，
 * 用户真正打开看板时缓存已经是热的。预热是**后台**的，不阻塞启动。
 */
const warmState = { done: false, startedAt: null, finishedAt: null, datasets: 0, ms: 0, error: null };

async function warmUp() {
  const t0 = Date.now();
  warmState.startedAt = new Date().toISOString();
  try {
    const dates = store.listDates();
    for (const d of dates) {
      store.loadDataset(d);
      warmState.datasets++;
      // **必须让出事件循环**：JSON.parse 一份 8MB 数据集是同步操作，
      // 一口气预热 7 份会把事件循环堵住好几秒 —— 期间所有请求（含健康探活）
      // 都排在队列里没人应答，表现出来就是"服务静默卡死"。
      // 2026-10-27 实测：冷启动预热把探活顶到超时，看门狗只能靠杀进程自愈。
      await new Promise((r) => setImmediate(r));
    }
    // 区间聚合也会命中记忆化缓存（最近一天的默认区间）
    try {
      const { aggregateRange } = require('./range');
      if (dates.length) aggregateRange(dates[dates.length - 1], dates[0], []);
    } catch { /* ignore */ }
    warmState.done = true;
    warmState.ms = Date.now() - t0;
    console.log(`[warm] 预热完成：${warmState.datasets} 份数据集，${warmState.ms}ms`);
  } catch (e) {
    warmState.error = String(e.message || e);
    warmState.done = true;
    console.log(`[warm] 预热失败（不影响服务）：${warmState.error}`);
  }
  warmState.finishedAt = new Date().toISOString();
}

function start() {
  // **stdout/stderr 自己落盘**（2026-10-27 补）。
  //
  // 为什么不靠启动脚本重定向：`start "" /min node ... >> file` 里，
  // 重定向句柄属于 `start` 自己，**子进程并不继承** —— 实测日志文件是 0 字节。
  // 服务又经常由计划任务/看门狗拉起（没有可见控制台），一旦崩溃就什么线索都没有。
  // 所以落盘这件事由进程自己做，不依赖"谁拉起的我"。
  teeConsole(path.join(cfg.DATA_DIR, 'server.log'));

  // **崩溃要留痕**：未捕获异常如果被吞掉，服务会变成"进程还在、端口还在、
  // 但什么都不干"的僵尸 —— 这正是 2026-10-27 两次静默卡死的形态。
  // 这里落盘 + 退出，让健康检查任务把它拉起来；退出码非 0，巡检能看见。
  const fatal = (kind) => (err) => {
    const line = `[${new Date().toISOString()}] [fatal] ${kind}: ${(err && (err.stack || err.message)) || err}\n`;
    try { fs.appendFileSync(path.join(cfg.DATA_DIR, 'server.log'), line); } catch { /* ignore */ }
    console.error(line.trim());
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      try { sendJson(res, { error: e.message }, 500); } catch { /* ignore */ }
    });
  });
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.log(`端口 ${cfg.PORT} 已被占用（服务可能已在运行），本次退出。`);
      process.exit(0);
    }
    console.error('服务启动失败：', e && e.message);
    process.exit(1);
  });
  server.listen(cfg.PORT, cfg.HOST, () => {
    const lan = cfg.HOST !== '127.0.0.1' && cfg.HOST !== 'localhost';
    console.log(`科创板雷达看板已启动 → http://${cfg.HOST}:${cfg.PORT}`);
    if (lan) {
      const nets = require('os').networkInterfaces();
      const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
      console.log(`⚠ 已监听 ${cfg.HOST}（局域网可访问，无鉴权）｜本机内网地址：${ips.join(', ') || '未获取到'}`);
    }
    console.log(`数据目录：${cfg.DAILY_DIR}`);
    // 事件循环延迟看门狗：卡死时能留下证据，而不是只剩"端口还在听"的假象
    startLoopWatchdog();
    // 后台预热（不阻塞监听）
    setImmediate(() => { warmUp(); });
  });
  if (process.argv.includes('--schedule')) startScheduler();
  return server;
}

module.exports = { start, getBrief };

if (require.main === module) start();
