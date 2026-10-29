'use strict';
/**
 * 生成给 Bot 用的精简摘要。
 *
 * 背景：主编每天要读 web\data\daily\<日期>.json，那个文件 2MB+
 * （619 家公司 × 数千条要闻全文），Bot 读它既慢又容易超上下文。
 * 这里预先算好一份 ~100KB 的摘要，只含"要写晨报真正用得上的东西"，
 * 完整明细仍留在原 JSON 里，需要时按路径查。
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, latestDate, previousDate } = require('../src/store');
const { buildBrief } = require('../src/insight');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');

function trimCompany(c) {
  return {
    code: c.code,
    name: c.name,
    industry: c.industry || '',
    quote: c.quote || null,
    valuation: c.valuation || {},
    growth: c.growth || {},
    profitability: c.profitability || {},
    revenue: c.revenue,
    net_profit_attr: c.net_profit_attr,
    total_assets: c.total_assets,
    eps: c.financials ? c.financials.eps : null,
    bps: c.financials ? c.financials.bps : null,
    score: c.score,
    signals: (c.signals || []).map((s) => s.label),
    viewpoint_change: c.viewpoint_change || [],
    // sell_side 里带着 1200 字的完整正文（applyViews 写入的 view），
    // 与下面的 sell_side_view.excerpt(400 字) 重复 —— 全量带上会让摘要膨胀近 300KB。
    // 这里只保留元数据字段，正文统一走 sell_side_view。
    sell_side: c.sell_side
      ? Object.assign({}, c.sell_side, { view: undefined, view_thesis: undefined })
      : null,
    news_count: (c.news || []).length,
    notice_count: (c.notices || []).length,
    research_count: (c.research || []).length,
    // 每家只留最近 3 条要闻 + 2 条公告，够写判断了
    // **必须带 content**：东财要闻自带约 100 字摘要，没有它主编只能复述标题，
    // 做不出"新闻总结"（2026-10-22 用户直接指出"新闻都没有总结"）。
    news_head: (c.news || []).slice(0, 3).map((n) => ({
      date: n.date, title: n.title, url: n.url,
      content: (n.content || '').slice(0, 300), match: n.match || 'matched',
    })),
    notice_head: (c.notices || []).slice(0, 2).map((n) => ({ date: n.date, title: n.title, type: n.content })),
    research_head: (c.research || []).slice(0, 2).map((r) => ({
      date: r.date, title: r.title, broker: r.broker, rating: r.rating, url: r.url,
      view_thesis: r.view_thesis || null,
    })),
    // 卖方观点原文（**只在真有原文时才输出这个字段**）
    //
    // 之前写成"覆盖了就给一个 {thesis, excerpt} 对象"，结果 178 家里有 148 家带着
    // thesis/excerpt 全为 null 的空壳对象——看结构像是"148 家都有观点原文"，
    // 实际只有 25 家真抓到了。**空壳对象比缺字段更有误导性**，必须省掉。
    sell_side_view: (c.sell_side && c.sell_side.covered && c.sell_side.view_thesis)
      ? { thesis: c.sell_side.view_thesis, excerpt: (c.sell_side.view || '').slice(0, 400), url: c.sell_side.url || null }
      : null,
  };
}

function main() {
  const date = process.argv[2] || latestDate();
  if (!date) { console.error('没有可用数据日期'); process.exit(1); }
  const ds = loadDataset(date);
  if (!ds) { console.error(`未找到 ${date} 的数据`); process.exit(1); }
  // **必须把上一日基线传进去**：跨日差分（crossDay）靠 prev 计算。
  // 原来固定传 null，导致摘要里的 crossDay 永远是 available:false，
  // 明天即使有了第二份数据集，差分也不会生效。
  const prevDate = previousDate(date);
  const prev = prevDate ? loadDataset(prevDate) : null;
  const b = buildBrief(ds, prev);

  // 公司轻量表：只保留"晨报写得到"的公司（按信号分前 150 + 高信号/卖方覆盖涉及的），
  // 其余 619 家的完整明细留在原始 JSON 里，需要时按路径查。
  // **先算出来再引用**，否则"三层卖方观点计数"只能拿到全量 619 家，算出来的分层数是错的。
  const digestCompanies = (() => {
    const keep = new Set();
    for (const c of (b.highlights || []).slice(0, 25)) keep.add(c.code);
    for (const r of (b.sellSide || []).slice(0, 60)) keep.add(r.code);
    for (const c of [...(b.companies || [])].sort((x, y) => (y.score || 0) - (x.score || 0)).slice(0, 150)) keep.add(c.code);
    return (b.companies || []).filter((c) => keep.has(c.code)).map(trimCompany);
  })();

  const digest = {
    date: b.date,
    latestDate: b.latestDate,
    generatedAt: new Date().toISOString(),
    stats: b.stats,
    sources: b.sources,
    degraded: b.degraded,
    coverage: b.coverage,
    market: b.market,
    events: (b.events || []).map((e) => ({
      key: e.key, cat: e.cat, companies: e.companies, mentions: e.mentions,
      window: e.window || null,
      companies_sample: (e.companyList || []).slice(0, 12).map((c) => c.name),
      example: e.samples[0] || null,
    })),
    // 多时间窗事件分布：d1/d7/d30 才是"当期热度"，all 仅作存量背景
    eventsByWindow: b.eventsByWindow
      ? Object.assign(
        {
          // 窗口锚点：数据最新日期（可能早于采集日——07:30 采集时当天新闻未出）
          asOfDate: b.eventsByWindow.asOfDate || null,
          collectionDate: b.eventsByWindow.collectionDate || null,
          anchorNote: b.eventsByWindow.anchorNote || null,
        },
        Object.fromEntries(Object.entries(b.eventsByWindow)
          .filter(([k]) => ['d1', 'd7', 'd30', 'all'].includes(k))
          .map(([k, arr]) => [k, (arr || []).map((e) => ({
            key: e.key, cat: e.cat, companies: e.companies, mentions: e.mentions,
            window: e.window || null,
            companies_sample: (e.companySamples || []).slice(0, 8),
            example: e.samples[0] || null,
          }))])))
      : null,
    newsFreshness: b.newsFreshness || null,
    // 要闻总结 / 大事板块 / 医药专章（简报、看板、Mini App 共用这一份口径）
    newsDigest: b.newsDigest || null,
    // 估值分位历史长度画像：短历史标的必须被披露
    valuationHistory: b.valuationHistory || null,
    // 跨日变化：available=false 表示首日无基线，简报需如实说明
    crossDay: b.crossDay ? {
      available: b.crossDay.available,
      reason: b.crossDay.reason || null,
      from: b.crossDay.from || null,
      to: b.crossDay.to || null,
      counts: b.crossDay.counts || null,
      headline: b.crossDay.headline || [],
      sellSideChanges: (b.crossDay.sellSideChanges || []).slice(0, 20),
      dataQuality: (b.crossDay.financialAnomalies || []).concat(b.crossDay.valuationAnomalies || []).slice(0, 20),
      quoteMoves: (b.crossDay.quoteMoves || []).slice(0, 20),
      growthShifts: (b.crossDay.growthShifts || []).slice(0, 20),
      eventDelta: (b.crossDay.eventDelta || []).slice(0, 12),
      added: (b.crossDay.added || []).slice(0, 10),
      removed: (b.crossDay.removed || []).slice(0, 10),
    } : null,
    sellSideStats: b.sellSideStats,
    sellSideByIndustry: b.sellSideByIndustry,
    sellSideTop: (b.sellSide || []).slice(0, 60),
    researchFeed: (b.researchFeed || []).slice(0, 60).map((x) => ({
      date: x.date, name: x.name, code: x.code, broker: x.broker, rating: x.rating,
      target_price: x.target_price, title: x.title, url: x.url,
      view_thesis: x.view_thesis || null,
      view: x.view ? x.view.slice(0, 400) : null,
    })),
    // 券商观点原文（投资要点）：简报第三节直接引用，不再只写元数据
    // 三层卖方观点的可核对计数（防止把"有元数据"当成"有观点原文"）
    sellSideViewStats: (function(){
      const cs = digestCompanies;
      const covered = cs.filter((c) => c.sell_side && c.sell_side.covered).length;
      const withView = cs.filter((c) => c.sell_side_view && c.sell_side_view.thesis).length;
      return {
        layer1_brokerViews: (b.researchFeed || []).filter((x) => x.view_thesis).length,
        layer1_note: '近 7 天研报的「投资要点」原文，可直接引用',
        layer2_sellSideView: withView,
        layer2_note: '被覆盖公司最新一篇（90 天窗口）的观点原文；未抓到正文的不输出该字段',
        layer3_sellSideMeta: covered,
        layer3_note: '仅评级/EPS预测/标题等元数据，不可当研报原文引用，也不得据标题脑补结论',
        digestCompanies: cs.length,
        universeCompanies: (b.companies || []).length,
        caution: '**"有元数据"不等于"有观点原文"**：第 3 层（评级/EPS/标题）不得当研报原文引用，也不得据标题脑补结论。',
      };
    })(),
    brokerViews: (b.researchFeed || [])
      .filter((x) => x.view_thesis)
      .slice(0, 40)
      .map((x) => ({
        date: x.date, name: x.name, code: x.code, broker: x.broker, rating: x.rating,
        target_price: x.target_price, title: x.title, url: x.url,
        thesis: x.view_thesis,
        excerpt: (x.view || '').slice(0, 700),
      })),
    highlights: (b.highlights || []).slice(0, 25).map((c) => ({
      code: c.code, name: c.name, industry: c.industry, score: c.score,
      signals: (c.signals || []).map((s) => s.label),
      valuation: c.valuation, growth: c.growth, quote: c.quote,
      viewpoint_change: c.viewpoint_change || [],
      sell_side: c.sell_side || null,
      // **必须带 content**：没有正文，主编只能复述标题，做不出"总结"。
      news_head: (c.news || []).slice(0, 3).map((n) => ({
        date: n.date, title: n.title, url: n.url,
        content: (n.content || '').slice(0, 300), match: n.match || 'matched',
      })),
      notice_head: (c.notices || []).slice(0, 2).map((n) => ({ date: n.date, title: n.title })),
    })),
    trending: (b.trending || []).slice(0, 15),
    companies: digestCompanies,
    company_total: (b.companies || []).length,
    paths: {
      full_dataset: path.join('web', 'data', 'daily', `${date}.json`),
      deterministic_brief: path.join('web', 'out', `brief-${date}.md`),
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `digest-${date}.json`);
  fs.writeFileSync(out, JSON.stringify(digest), 'utf8');
  console.log(out);
  console.log(`大小：${(fs.statSync(out).size / 1024).toFixed(0)}KB（原数据集 ${(fs.statSync(path.join(ROOT, 'data', 'daily', `${date}.json`)).size / 1024).toFixed(0)}KB）`);
  console.log(`含：高信号 ${digest.highlights.length} 家 / 卖方覆盖 ${digest.sellSideTop.length} 家 / 事件 ${digest.events.length} 类 / 行业 ${digest.sellSideByIndustry.length} 个 / 公司 ${digest.companies.length} 家`);
}

main();
