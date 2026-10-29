'use strict';
/**
 * 区间聚合：**行业 + 日期范围**的整体筛选。
 *
 * 之前只有"单日期切换"，没法回答"这半个月半导体行业发生了什么"这类问题。
 * 这里把多天的日数据集聚合成一个可筛选的视图。
 *
 * ── 口径（每个数字都可复核）────────────────────────────────
 * **日期的两种含义，必须分清**：
 * - 「数据日期」下拉框 = 选**哪一天的快照**（该快照含近 85 天回溯的要闻，共 5600+ 条）。
 * - 「区间筛选」= 按条目的**发布日期**落在 [from, to] 内来筛。
 *   两者数字天然不同，这不是 bug：区间筛选回答的是"这几天发生了什么"。
 *   单日区间（from=to=最新日）= 17 条，与 feed 模式勾选「仅看最新数据日」的 17 条完全一致。
 *
 * **要闻**：取最新一份快照（baseDate）的 c.news，过滤 `date ∈ [from, to]`。
 *   理由：日采集本身就带回溯窗口（10-22 实测覆盖 2026-06-09 ~ 10-22，136 天），
 *   所以"过去某几天"的数据也在最新快照里——不必回溯旧快照，也不会漏。
 *   取**一份**而不是并集，避免同一篇在不同快照里重复出现。
 *   **回溯窗口是数据实测出来的，不是写死的常数**——所以这里输出 coverage 起点，
 *   越界时显式给 warning，绝不静默截断。
 *
 * **研报**：日采集的 research 是"最近 7 天新增"，单份快照盖不住一个长区间，
 *   所以取 **D ∈ [from-7, to+7] 的快照并集**，按 (代码|日期|标题|券商) 去重后按发布日期过滤。
 *
 * **要闻池 = 普通要闻 + 区间研报**：单日模式下 researchFeed 是 newsFeed 的子集
 *   （研报也挂在 c.news 里），区间模式必须保持同一关系，否则两个标签页数字对不上。
 *
 * **区间涨跌**：用 from 日与 to 日两份数据集的收盘价算，不用单日涨跌幅。
 * **行业过滤**：按公司所属行业（company.industry）过滤，可多选（逗号分隔）。
 */
const { loadDataset, listDates } = require('./store');

const MAX_LOAD_DAYS = 16;        // 研报并集最多加载 16 份数据集（控制解析开销）
const RESEARCH_WINDOW_DAYS = 7;  // 每份快照的 research 只含"最近 7 天新增"

function normalizeIndustry(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function inRange(date, from, to) {
  if (!date) return false;
  return date >= from && date <= to;
}

function shiftDate(date, days) {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** 研报条目 → 统一结构（字段与 insight.js 的 researchFeed 对齐，缺一个字段界面上就少一列） */
function researchItem(c, r) {
  return {
    date: r.date, code: c.code, name: c.name, industry: c.industry || '',
    title: r.title, url: r.url, content: r.content || '',
    broker: r.broker || '', rating: r.rating || '', last_rating: r.last_rating || null,
    target_price: r.target_price ?? null,
    forecast: r.forecast || null,
    kind: r.kind || '', match: r.match || 'matched',
    institution_count: r.institution_count ?? null,
    rating_distribution: r.rating_distribution || null,
    view: r.view || null, view_thesis: r.view_thesis || null,
    is_research: true, source: r.source || '', is_latest: false,
  };
}

/** 普通要闻条目 → 统一结构（与 insight.js 的 newsFeed 对齐） */
function newsItem(c, n) {
  return {
    date: n.date, code: c.code, name: c.name, industry: c.industry || '',
    title: n.title, url: n.url, content: n.content || '',
    broker: n.broker || null, rating: n.rating || null, last_rating: n.last_rating || null,
    target_price: n.target_price ?? null,
    forecast: n.forecast || null,
    kind: n.kind || 'mention', match: n.match || 'matched',
    institution_count: n.institution_count ?? null,
    rating_distribution: n.rating_distribution || null,
    is_research: !!n.is_research, source: n.source || '', is_latest: false,
  };
}

/**
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {string[]} industries 行业过滤（空 = 全部）
 */
/**
 * **区间聚合的进程级记忆化**（2026-10-27 新增）。
 *
 * 为什么必须做：看板首屏会同时打出几十个区间请求（不同日期组合 × 不同行业），
 * 每一个都要把窗口内每一天的全量数据集读盘 + 解析 + 遍历全部要闻。
 * 2026-10-27 实测：30 个并发请求耗时 8.8 秒，其中 20 个超过 3 秒，
 * 期间探活一度超时 8 秒 —— 服务虽然没死，但已经不可用。
 *
 * 现在：同一 (from, to, 行业集合) 组合在 TTL 内直接复用上一次的结果；
 * 叠加 store.js 的数据集缓存后，重复请求几乎零成本。
 *
 * **TTL 不能太长**：采集任务会写入新数据集，缓存里的旧结果会与新数据不一致。
 * 默认 60 秒，配合 store.js 按 mtime 失效的数据集缓存，窗口很短。
 */
const RANGE_CACHE_TTL_MS = Number(process.env.RANGE_CACHE_TTL_MS || 60 * 1000);
const RANGE_MEMO_MAX = Number(process.env.RANGE_MEMO_MAX || 160);
const rangeMemo = new Map(); // key -> { at, value }

function aggregateRange(from, to, industries = []) {
  const key = `${from || ''}|${to || ''}|${(industries || []).slice().sort().join(',')}`;
  const hit = rangeMemo.get(key);
  if (hit && Date.now() - hit.at < RANGE_CACHE_TTL_MS) {
    rangeMemo.delete(key);
    rangeMemo.set(key, hit); // 刷新 LRU 位置
    return hit.value;
  }
  const value = aggregateRangeCore(from, to, industries);
  rangeMemo.set(key, { at: Date.now(), value });
  while (rangeMemo.size > RANGE_MEMO_MAX) {
    rangeMemo.delete(rangeMemo.keys().next().value);
  }
  return value;
}

/** 采集写完新数据后调用，强制下一次请求重新聚合 */
function clearRangeCache() {
  rangeMemo.clear();
}

function aggregateRangeCore(from, to, industries = []) {
  const all = listDates();                 // 降序，最新在前
  if (!all.length) {
    return { available: false, reason: '没有可用数据日期', from, to, dates: [], industries: [], items: { news: [], research: [], notice: [] }, companies: [], stats: null };
  }
  const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : all[all.length - 1];
  const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : all[0];
  const lo = f <= t ? f : t;
  const hi = f <= t ? t : f;

  // 基准快照 = 最新一份（它的要闻回溯窗口最长，过去某几天的数据也在里面）
  const baseDate = all[0];
  const base = loadDataset(baseDate);
  if (!base) {
    return { available: false, reason: `无法读取 ${baseDate} 的数据集`, from: lo, to: hi, dates: [], industries: [], items: { news: [], research: [], notice: [] }, companies: [], stats: null };
  }

  // ---- 数据覆盖窗口（实测，不写死）----
  let covFrom = null, covTo = null;
  for (const c of base.companies || []) {
    for (const n of c.news || []) {
      if (!n.date) continue;
      if (covFrom === null || n.date < covFrom) covFrom = n.date;
      if (covTo === null || n.date > covTo) covTo = n.date;
    }
  }
  const coverage = {
    newsFrom: covFrom, newsTo: covTo,
    lookbackDays: covFrom && covTo ? Math.round((Date.parse(covTo) - Date.parse(covFrom)) / 86400000) + 1 : 0,
    source: `${baseDate} 数据集实测`,
  };

  // 区间与覆盖窗口没有交集 → 直接不可用（而不是给一张空表让人猜）
  if (covFrom && covTo && (hi < covFrom || lo > covTo)) {
    return {
      available: false,
      reason: `所选区间（${lo} ~ ${hi}）完全落在要闻覆盖窗口（${covFrom} ~ ${covTo}）之外`,
      from: lo, to: hi, dates: [], industries: [], items: { news: [], research: [], notice: [] }, companies: [], stats: null,
      coverage, baseDate,
    };
  }
  const warnings = [];
  if (covFrom && lo < covFrom) warnings.push(`区间起点早于要闻回溯起点 ${covFrom}（${baseDate} 实测覆盖 ${covFrom} ~ ${covTo}），该段无数据`);
  if (covTo && hi > covTo) warnings.push(`区间终点晚于要闻数据末日 ${covTo}，该段无数据`);

  const indFilter = new Set(industries);
  const keepInd = (c) => !indFilter.size || indFilter.has(c.industry || '');
  const baseCompanies = (base.companies || []).filter(keepInd);

  // ---- 普通要闻 / 公告：基准快照 + 按发布日期过滤 ----
  const news = [];
  const notice = [];
  for (const c of baseCompanies) {
    for (const n of c.news || []) {
      if (n.is_research) continue;                 // 研报统一从 research 并集进池，避免重复
      if (!inRange(n.date, lo, hi)) continue;
      news.push(newsItem(c, n));
    }
    for (const n of c.notices || []) {
      if (!inRange(n.date, lo, hi)) continue;
      notice.push({
        date: n.date, code: c.code, name: c.name, industry: c.industry || '',
        title: n.title, url: n.url, content: n.content || '', match: n.match || 'matched',
        is_latest: false,
      });
    }
  }

  // ---- 研报：窗口 [from-7, to+7] 内的快照并集去重 ----
  const rLo = shiftDate(lo, -RESEARCH_WINDOW_DAYS);
  const rHi = shiftDate(hi, RESEARCH_WINDOW_DAYS);
  const researchSources = all
    .filter((d) => d >= rLo && d <= rHi)
    .sort()
    .slice(-MAX_LOAD_DAYS);
  const research = [];
  const seenR = new Set();
  for (const d of researchSources) {
    const ds = d === baseDate ? base : loadDataset(d);
    if (!ds) continue;
    for (const c of ds.companies || []) {
      if (!keepInd(c)) continue;
      for (const r of c.research || []) {
        if (!inRange(r.date, lo, hi)) continue;
        const key = `${c.code}|${r.date || ''}|${r.title || ''}|${r.broker || ''}`;
        if (seenR.has(key)) continue;
        seenR.add(key);
        research.push(researchItem(c, r));
      }
    }
  }
  research.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 研报并进要闻池，保证「要闻」与「券商观点」两个标签页口径一致
  for (const r of research) {
    r.is_latest = r.date === coverage.newsTo;
    news.push(r);
  }
  news.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  notice.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ---- 区间涨跌：from 日 vs to 日收盘价 ----
  const dates = all.filter((d) => d >= lo && d <= hi).sort();
  const fromDs = dates.length ? loadDataset(dates[0]) : null;
  const toDs = dates.length ? loadDataset(dates[dates.length - 1]) : null;
  const priceOf = (ds, code) => {
    if (!ds) return null;
    const c = (ds.companies || []).find((x) => x.code === code);
    return c && c.quote && c.quote.price != null ? c.quote.price : null;
  };
  const newsCountOf = new Map();
  const researchCountOf = new Map();
  const noticeCountOf = new Map();
  for (const n of news) newsCountOf.set(n.code, (newsCountOf.get(n.code) || 0) + 1);
  for (const r of research) researchCountOf.set(r.code, (researchCountOf.get(r.code) || 0) + 1);
  for (const n of notice) noticeCountOf.set(n.code, (noticeCountOf.get(n.code) || 0) + 1);
  const companies = baseCompanies.map((c) => {
    const pf = priceOf(fromDs, c.code);
    const pt = priceOf(toDs, c.code);
    const rangeChg = (pf != null && pt != null && pf > 0) ? +(((pt - pf) / pf) * 100).toFixed(2) : null;
    return {
      code: c.code, name: c.name, industry: c.industry || '',
      priceFrom: pf, priceTo: pt, rangeChg,
      newsCount: newsCountOf.get(c.code) || 0,
      researchCount: researchCountOf.get(c.code) || 0,
      noticeCount: noticeCountOf.get(c.code) || 0,
    };
  });

  // ---- 每日统计 ----
  const perDay = [];
  for (const d of [...new Set(news.map((n) => n.date))].sort()) {
    const dn = news.filter((n) => n.date === d);
    perDay.push({
      date: d, news: dn.length,
      research: research.filter((n) => n.date === d).length,
      notice: notice.filter((n) => n.date === d).length,
      companies: new Set(dn.map((n) => n.code)).size,
    });
  }

  const industryList = [...new Set((base.companies || []).map((c) => c.industry).filter(Boolean))].sort();

  return {
    available: true,
    from: lo, to: hi,
    baseDate,
    dates,
    coverage,
    warnings,
    truncated: researchSources.length
      ? null
      : `区间内没有能覆盖研报窗口（${rLo} ~ ${rHi}）的采集日`,
    industries: industryList,
    items: { news, research, notice },
    companies,
    stats: {
      days: perDay.length,          // 窗口内**有要闻的天数**
      rangeDays: Math.round((Date.parse(hi) - Date.parse(lo)) / 86400000) + 1,   // 区间自然天数
      news: news.length,
      research: research.length,
      notice: notice.length,
      companiesWithNews: new Set(news.map((n) => n.code)).size,
      companies: companies.length,
      universe: (base.companies || []).length,
      perDay,
    },
  };
}

module.exports = { aggregateRange, clearRangeCache, normalizeIndustry, MAX_LOAD_DAYS, RESEARCH_WINDOW_DAYS };
