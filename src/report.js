'use strict';
/**
 * 券商研报正文抓取（东方财富研报中心详情页）。
 *
 * **为什么必须做这一步**：研报列表接口只给元数据（标题/机构/评级/EPS预测/链接），
 * 也就是"观点的索引"，不是观点本身。用户要的是"各大券商出具的报告与观点"，
 * 详情页里有 **投资要点** 全文——那才是券商真正的论据（数字+逻辑）。
 * 实测 https://data.eastmoney.com/report/info/<infoCode>.html 首屏 HTML 里
 * 就带完整投资要点，不需要执行 JS。
 *
 * 取正文的好处：简报第三节能引用券商原话，而不是复述元数据。
 *
 * 口径控制：
 * - 只抓**有限集合**（近期新增 + 高信号/高覆盖公司的最新一篇），不逐篇全抓，
 *   既控制耗时，也避免对同域大量请求触发风控（push2 就是这么被封的）。
 * - 抓不到就留空，不编造；抓到的内容标注来源机构与日期。
 */

const { get } = require('./em');

const REPORT_URL = (infoCode) => `https://data.eastmoney.com/report/info/${infoCode}.html`;

// 研报正文的起始标记。**不同券商的研报页用的标题不一样**：
// 实测 55 篇里有 28 篇用「投资要点」，另外 27 篇用「盈利预测及投资建议」——
// 只认前者会把那 27 篇全部误判成"无正文"，抓取成功率因此只有 51%。
// 按优先级逐个尝试，命中即用（保持已成功的 28 篇行为不变）。
const VIEW_MARKERS = ['投资要点', '盈利预测及投资建议'];

/**
 * **公司行**（形如「萤石网络(688475)」）是研报正文的**最稳锚点**：
 * 它总是出现在「查看PDF原文」之后、正文之前。
 * 用它做主锚点，可以避开页脚里那些同名噪声——
 * 实测「投资建议」在页脚免责声明之后（@2271），
 * 只按字符串找会把「据此操作，风险自担。东方财富 扫一扫下载APP…」当成券商观点。
 */
// 注意：研报页里的公司行是「萤石网络(688475)」，**没有 .SH/.SZ 后缀**。
// （东财 F10 那边才是 688475.SH —— 两者格式不同，正则要允许后缀可选。）
const COMPANY_LINE_RE = /[\u4e00-\u9fa5A-Za-z*]{2,12}\(\d{6}(?:\.(?:SH|SZ))?\)/;

/** 页脚/导航噪声：正文里出现这些就说明切错位置了，宁可判为"没抓到"也不能污染观点 */
const NOISE_RE = /扫一扫下载APP|东方财富|Choice金融终端|金融界|数据来源|更多点击查看|东方财富发布|郑重声明/;

// 正文块结束标志（取到即停）。「风险提示」是正文真正的边界，
// 后面几个是页面尾部导航/免责声明噪声。
const END_MARKERS = ['风险提示', '免责声明', '郑重声明', '分析师声明', '重要声明',
  '今日最新研究报告', '查看PDF原文', '数据来源', '东方财富发布', '更多点击查看'];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从页面纯文本里切出"投资要点"正文。
 * @returns {{thesis:string, excerpt:string}|null}
 */
function extractView(text) {
  // 候选锚点：公司行（最稳）与明确小节标题，取**最早**的那个作为正文起点
  const cands = [];
  const cm = COMPANY_LINE_RE.exec(text);
  if (cm) cands.push({ start: cm.index + cm[0].length, marker: '公司行之后', skip: 0 });
  for (const m of VIEW_MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0) cands.push({ start: i, marker: m, skip: m.length });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.start - b.start);
  const pick = cands[0];

  let body = text.slice(pick.start + pick.skip);
  body = body.replace(/^[\s:：、,，。]+/, '');
  // 正文紧跟一个已知小节标题时，去掉标题本身
  for (const m of VIEW_MARKERS) {
    if (body.startsWith(m)) { body = body.slice(m.length).replace(/^[\s:：、,，。]+/, ''); pick.marker = m; break; }
  }

  // 截到下一个板块标志
  let end = body.length;
  for (const m of END_MARKERS) {
    const i = body.indexOf(m);
    if (i > 30 && i < end) end = i;
  }
  body = body.slice(0, end).trim();

  if (body.length < 40) return null;
  // 命中页脚噪声 → 判定为没抓到（**绝不能把页脚当券商观点写进简报**）
  if (NOISE_RE.test(body)) return null;

  // 核心观点 = 前 1~2 句（券商的判断句，后面是论据）
  const sentences = body.split(/(?<=[。！？])/).filter((s) => s.trim().length > 0);
  let thesis = sentences.length ? sentences[0].trim() : body.slice(0, 200);
  if (thesis.length < 60 && sentences.length > 1) thesis += sentences[1].trim();

  return {
    thesis: thesis.slice(0, 220),
    excerpt: body.slice(0, 1200),
    sentences: sentences.length,
    marker: pick.marker,
  };
}

/**
 * 抓取单篇研报的投资要点。
 */
async function fetchReportView(infoCode) {
  if (!infoCode) return null;
  try {
    const html = await get(REPORT_URL(infoCode), 2);
    const text = stripHtml(html);
    const view = extractView(text);
    if (!view) return { infoCode, ok: false, reason: 'no_投资要点' };
    // 机构名：详情页里紧跟标题的位置，形如「东吴证券 陈海进」
    const m = text.match(/(买入|增持|持有|中性|卖出|推荐|强烈推荐|首次覆盖)[^。]{0,20}/);
    return { infoCode, ok: true, ...view, ratingHint: m ? m[0].slice(0, 12) : '' };
  } catch (e) {
    return { infoCode, ok: false, reason: e.message.slice(0, 80) };
  }
}

/**
 * 批量抓取（限并发 + 限总量 + 失败重试）。
 *
 * **为什么要失败重试**：实测同一批 231 篇抓取，成功数会在 **119 ↔ 230** 之间跳变，
 * 失败的那批是**同一批 infoCode** —— 说明是东方财富的**瞬时限流**（并发一高就返回残页），
 * 不是那些页面没有正文。隔几秒用更慢的节奏单独重抓就能拿到。
 * 所以：第一轮跑完后，把失败的用「串行 + 更长间隔」再兜两轮。
 *
 * @param {string[]} infoCodes
 * @returns {Promise<Map<string,object>>} infoCode → 抓取结果
 */
async function fetchReportViews(infoCodes, opts = {}) {
  const {
    concurrency = 3, max = 260, gapMs = 250, log = () => {},
    retryRounds = 2, retryConcurrency = 1, retryGapMs = 600,
  } = opts;
  const uniq = [...new Set(infoCodes.filter(Boolean))].slice(0, max);
  const out = new Map();
  let idx = 0, done = 0, okCount = 0;

  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= uniq.length) return;
      const code = uniq[i];
      const r = await fetchReportView(code);
      out.set(code, r);
      done++;
      if (r && r.ok) okCount++;
      if (done % 25 === 0) log(`[研报正文] ${done}/${uniq.length}，成功 ${okCount}`);
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, worker));

  // 失败重试：串行 + 更长间隔，绕过瞬时限流
  for (let round = 1; round <= retryRounds; round++) {
    const failed = uniq.filter((c) => out.get(c) && !out.get(c).ok);
    if (!failed.length) break;
    log(`[研报正文] 第 ${round} 轮慢速重试 ${failed.length} 篇`);
    for (const code of failed) {
      const r = await fetchReportView(code);
      if (r && r.ok) { out.set(code, r); okCount++; }
      if (retryGapMs) await new Promise((r) => setTimeout(r, retryGapMs));
    }
  }

  return out;
}

/**
 * 从研报 URL 里抠出 infoCode。
 */
function infoCodeFromUrl(url) {
  const m = /\/report\/info\/([A-Za-z0-9]+)\.html/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * 挑要抓正文的研报集合（可解释、可控）：
 *   1) 近 7 天新增研报（全部）——每日新增，最该有观点
 *   2) 高信号公司的最新一篇（若已覆盖）
 *   3) **全部被覆盖公司的最新一篇**（`allCovered`，默认开）
 *      —— 这一层决定"券商观点原文"能覆盖多少家：只抓前 30 家时第 2 层只有 53/229，
 *      全量抓则是 229/229（每家最新一篇的观点原话）。
 *
 * 请求量：229 + 18 ≈ 250 页/日，并发 5、带间隔，约 30~50 秒。
 * 远小于导致 push2 被封的量级（那是每天上万次），但仍保留 gapMs 与并发上限。
 */
function pickReportTargets(dataset, brief, opts = {}) {
  const { recent = 30, topCovered = 30, topSignal = 25, allCovered = true } = opts;
  const codes = new Set();
  const recentList = [];
  const covered = [];

  for (const c of dataset.companies || []) {
    for (const r of c.research || []) {
      const code = infoCodeFromUrl(r.url);
      if (code) recentList.push({ code, date: r.date || '' });
    }
    const sl = c.sell_side;
    if (sl && sl.covered) {
      const code = infoCodeFromUrl(sl.url);
      if (code) covered.push({ code, name: c.name, n: sl.report_count_90d || 0, score: 0 });
    }
  }

  // 1) 近 7 天新增
  recentList.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  for (const r of recentList.slice(0, recent)) codes.add(r.code);

  // 2) 高信号公司
  const hl = (brief && brief.highlights) || [];
  for (const h of hl.slice(0, topSignal)) {
    const c = (dataset.companies || []).find((x) => x.code === h.code);
    const code = c && c.sell_side && infoCodeFromUrl(c.sell_side.url);
    if (code) codes.add(code);
  }

  // 3) 研报最密集的公司
  covered.sort((a, b) => b.n - a.n);
  for (const c of covered.slice(0, topCovered)) codes.add(c.code);

  // 4) 全部被覆盖公司的最新一篇（让第 2 层观点原文覆盖 229/229）
  if (allCovered) for (const c of covered) codes.add(c.code);

  return {
    codes: [...codes],
    recentTotal: recentList.length,
    coveredTotal: covered.length,
    allCovered,
  };
}

/**
 * 把抓到的正文贴回数据集（research 条目 + sell_side 画像）。
 */
function applyViews(dataset, views) {
  let hit = 0;
  for (const c of dataset.companies || []) {
    for (const r of c.research || []) {
      const code = infoCodeFromUrl(r.url);
      const v = code && views.get(code);
      if (v && v.ok) { r.view = v.excerpt; r.view_thesis = v.thesis; hit++; }
    }
    const sl = c.sell_side;
    if (sl && sl.covered) {
      const code = infoCodeFromUrl(sl.url);
      const v = code && views.get(code);
      if (v && v.ok) { sl.view = v.excerpt; sl.view_thesis = v.thesis; }
    }
  }
  return hit;
}

module.exports = { fetchReportView, fetchReportViews, pickReportTargets, applyViews, infoCodeFromUrl, extractView, stripHtml };
