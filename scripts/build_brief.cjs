'use strict';
/**
 * 从采集结果生成一份可直接汇报的 Markdown 简报（确定性基线）。
 *
 * 定位：这是"没有 LLM 参与时也必须存在"的基线版本——
 * 所有数字都来自采集数据，不含模型推断，因此不会出错。
 * Bot 生成的"判断层"简报应在此基础上补充观点，两者可并存。
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, listDates, latestDate } = require('../src/store');
const { buildBrief } = require('../src/insight');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');

function fmtMv(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' 万亿';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return n.toFixed(0);
}
function fmtPct(v, d = 2) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
}
function num(v, d = 2) {
  if (v == null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function build(date) {
  const ds = loadDataset(date);
  if (!ds) return null;
  const b = buildBrief(ds, null);
  const m = b.market || {};
  const br = m.breadth || {};
  const ix = m.index || {};
  const L = [];

  L.push(`# 科创板每日简报 · ${b.date}`);
  L.push('');
  L.push(`> 数据日期 ${b.date} ｜ 最新消息日 ${b.latestDate || '—'} ｜ 覆盖 ${b.coverage.total} 家`);
  L.push(`> 生成于 ${new Date(b.generatedAt).toLocaleString('zh-CN')} ｜ 采集耗时 ${((b.elapsedMs || 0) / 1000).toFixed(0)}s`);
  L.push('');

  L.push('## 一、今日要闻总结');
  L.push('');
  const nd = b.newsDigest || {};
  const ov = nd.overview || {};
  if (!ov.counts) {
    L.push('_本期未生成要闻总结_');
  } else {
    L.push(`> 窗口：当日 ${nd.baseDate}｜近 7 天 ${nd.d7from} ~ ${nd.baseDate}（锚点=数据最新日期，不是采集日）。`);
    L.push(`> 规模：要闻 ${ov.counts.newsTotal} 条 + 公告 ${ov.counts.noticeTotal} 条；`
      + `当日 ${ov.counts.d1} 条（${ov.counts.d1Companies} 家），近 7 天 ${ov.counts.d7} 条（${ov.counts.d7Companies} 家）；`
      + `其中栏目稿 ${ov.counts.columnItems} 条。`);
    L.push('');
    L.push('**今日要点**');
    L.push('');
    L.push('| # | 日期 | 公司 | 行业 | 事件 | 要点 |');
    L.push('|---|---|---|---|---|---|');
    for (const [i, p] of (ov.topPoints || []).entries()) {
      const t = `[${p.title}](${p.url})`;
      const flags = [p.event, p.isColumn ? '栏目稿' : null, p.attributed === false ? '综合稿（标题未点名公司）' : null]
        .filter(Boolean).join(' / ') || '—';
      L.push(`| ${i + 1} | ${p.date} | ${p.name} | ${p.industry || '—'} | ${flags} | ${t}`
        + `${p.summary ? '<br>' + p.summary.replace(/\|/g, '／') : ''} |`);
    }
    L.push('');
    const mix = (ov.eventMix && ov.eventMix.d7) || [];
    if (mix.length) {
      L.push('**事件类型分布（近 7 天）**');
      L.push('');
      L.push('| 事件类型 | 类别 | 覆盖公司 | 提及次数 |');
      L.push('|---|---|---|---|');
      for (const e of mix.slice(0, 10)) L.push(`| ${e.key} | ${e.cat} | ${e.companies} | ${e.mentions} |`);
      L.push('');
    }
  }

  L.push('## 二、大事板块');
  L.push('');
  const secs = nd.sectors || [];
  if (!secs.length) {
    L.push('_窗口内没有板块达到入选门槛_');
  } else {
    L.push(`> 入选口径：${nd.rules && nd.rules.sectorScore ? nd.rules.sectorScore : '—'}。${nd.sectorNote || ''}`);
    L.push('> 事实与判断分列：**事实**来自公告/要闻正文与行情字段；**方向**是按事件方向合计与相对涨跌的规则判断，依据写在同一行，可逐条回查。');
    L.push('');
    for (const s of secs) {
      L.push(`### ${s.industry}（${s.companies} 家｜重要度 ${s.score}）`);
      L.push('');
      L.push(`> **事实**：窗口内要闻 ${s.basis.news} 条、公告 ${s.basis.notices} 条、研报覆盖 ${s.basis.research} 家；`
        + `事件 ${(s.basis.events || []).map((e) => `${e.key} ${e.companies} 家`).join('、') || '无'}；`
        + `板块均涨跌 ${fmtPct(s.basis.avgChg)}${s.basis.benchmark != null ? `（大盘 ${fmtPct(s.basis.benchmark)}）` : ''}。`);
      if (s.direction) {
        L.push(`> **方向**：${s.direction.label}（置信度 ${s.direction.confidence}）——依据：${s.direction.basis}。`);
      }
      L.push('');
      if ((s.keyPoints || []).length) {
        L.push('| 日期 | 公司 | 事件 | 标题 |');
        L.push('|---|---|---|---|');
        for (const k of s.keyPoints) {
          L.push(`| ${k.date} | ${k.name} | ${k.event || '—'}${k.attributed === false ? '（综合稿）' : ''} | [${k.title}](${k.url}) |`);
        }
        L.push('');
      }
    }
  }

  L.push('## 三、医药板块专章');
  L.push('');
  const ph = nd.pharma || {};
  if (!ph.scope) {
    L.push('_本期未生成医药板块专章_');
  } else {
    L.push(`> 口径：申万二级 ${(ph.scope.industries || []).join('、')}，共 **${ph.scope.companies} 家**（占科创板 ${ph.scope.sharePct}%）；`
      + `窗口 ${ph.scope.window}，窗口内要闻+公告 ${ph.scope.items} 条。`);
    const br = (ph.scope.breakdown || []).map((x) => `${x.industry} ${x.companies}`).join('、');
    L.push(`> 细分：${br}`);
    L.push('');
    L.push('| 指标 | 数值 |');
    L.push('|---|---|');
    L.push(`| 涨 / 跌 / 平 | ${ph.temperature.up} / ${ph.temperature.down} / ${ph.temperature.flat} |`);
    L.push(`| 板块均涨跌 | ${fmtPct(ph.temperature.avg)}${ph.temperature.benchmark != null ? `（大盘 ${fmtPct(ph.temperature.benchmark)}，相对 ${fmtPct(ph.temperature.relative)}）` : ''} |`);
    L.push(`| 卖方覆盖 | ${ph.sellSide.total} 家（带观点原文 ${ph.sellSide.withView} 家）｜看多 ${ph.sellSide.bull} / 中性 ${ph.sellSide.neutral} / 看空 ${ph.sellSide.bear} |`);
    if (ph.direction) L.push(`| 板块方向 | ${ph.direction.label}（置信度 ${ph.direction.confidence}）——${ph.direction.basis} |`);
    L.push('');
    L.push('**重点主题（按重要性排序）**');
    L.push('');
    for (const t of (ph.topics || [])) {
      L.push(`#### ${t.key}｜${t.items} 条、涉及 ${t.companies.length} 家公司`);
      L.push('');
      L.push(`> 方向：${t.direction.label}（置信度 ${t.direction.confidence}）——${t.direction.basis}`);
      L.push('');
      L.push('| 日期 | 公司 | 事件 | 标题 |');
      L.push('|---|---|---|---|');
      for (const k of (t.keyPoints || [])) {
        L.push(`| ${k.date} | ${k.name} | ${k.event || '—'}${k.attributed === false ? '（综合稿）' : ''} | [${k.title}](${k.url}) |`);
      }
      L.push('');
    }
    if ((ph.misattributed || []).length) {
      L.push('**归属修正（栏目稿里挂着别家公司）**');
      L.push('');
      L.push('| 稿件归属 | 实际主体 | 行业 | 日期 | 原文 |');
      L.push('|---|---|---|---|---|');
      for (const m of ph.misattributed) {
        L.push(`| ${m.attributed} | **${m.actual}** | ${m.actualIndustry} | ${m.date} | [${m.title}](${m.url}) |`);
      }
      L.push('');
    }
    if ((ph.external || []).length) {
      L.push('**竞情提示（非科创板主体，仅作提示，不进建档体系）**');
      L.push('');
      L.push('| 主体 | 日期 | 命中方向 | 事件 | 稿件来源 |');
      L.push('|---|---|---|---|---|');
      for (const e of ph.external) {
        L.push(`| **${e.name}** | ${e.date} | ${(e.reason || []).join('、')} | ${String(e.what).replace(/\|/g, '／').slice(0, 90)} | [${e.sourceTitle}](${e.url})（经 ${e.via} 命中） |`);
      }
      L.push('');
    }
    if ((ph.sellSide && ph.sellSide.topViews || []).length) {
      L.push('**卖方观点原话（可引用）**');
      L.push('');
      for (const v of ph.sellSide.topViews) {
        L.push(`- **${v.name}**（${v.code}｜${v.industry}）｜${v.broker || '—'} ${v.rating || '—'}｜${v.date || '—'}：${v.thesis}`);
      }
      L.push('');
    }
  }

  L.push('## 四、今日全景');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('|---|---|');
  if (ix.kc50_point != null) L.push(`| 科创50 收盘 | ${num(ix.kc50_point)}（${fmtPct(ix.kc50_change_pct)}） |`);
  if (ix.kc_comp_point != null) L.push(`| 科创综指 收盘 | ${num(ix.kc_comp_point)}（${fmtPct(ix.kc_comp_change_pct)}） |`);
  L.push(`| 上涨 / 下跌 | ${br.rising ?? '—'} / ${br.falling ?? '—'} |`);
  L.push(`| 涨幅>5% / 跌幅>5% | ${br.up5 ?? '—'} / ${br.down5 ?? '—'} |`);
  L.push(`| 涨停 / 跌停 | ${br.up9 ?? '—'} / ${br.down9 ?? '—'} |`);
  if (ix.total_amount_yi != null) L.push(`| 科创板成交额 | ${num(ix.total_amount_yi, 0)} 亿 |`);
  if (ix.avg_turnover_pct != null) L.push(`| 平均换手率 | ${num(ix.avg_turnover_pct)}% |`);
  L.push(`| 数据来源 | ${m.source && m.source.breadth ? m.source.breadth : '—'} |`);
  L.push('');

  L.push('## 五、高信号公司 Top 15');
  L.push('');
  L.push('> 排名由可验证事实自动计算（券商评级/目标价、重大公告、业绩预告、PE 历史分位极值、当日大幅波动、增速突变），无人工名单。');
  L.push('');
  L.push('| # | 公司 | 代码 | 信号分 | 涨跌幅 | PE(TTM) | 总市值 | 关键信号 |');
  L.push('|---|---|---|---|---|---|---|---|');
  b.highlights.slice(0, 15).forEach((c, i) => {
    const chg = c.quote ? c.quote.change_pct : null;
    L.push(`| ${i + 1} | ${c.name} | ${c.code} | ${c.score} | ${fmtPct(chg)} | ${num(c.valuation.pe_ttm, 1)} | ${fmtMv(c.valuation.total_mv)} | ${(c.signals || []).slice(0, 3).map((s) => s.label).join('；')} |`);
  });
  L.push('');

  L.push('## 六、券商观点（最新 20 条）');
  L.push('');
  const rr = b.researchFeed.slice(0, 20);
  if (!rr.length) L.push('_窗口期内无券商观点命中_');
  else {
    L.push('| 日期 | 公司 | 类型 | 券商 | 评级 | 目标价 | 盈利预测 | 内容总结 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const x of rr) {
      const f = x.forecast || {};
      // 东财研报给的是 EPS 预测（今年/次年/第三年），iFinD 一致预期给的是营收/净利预测
      const ft = [
        f.revenue_forecast ? `营收 ${f.revenue_forecast.join('/')}亿` : '',
        f.profit_forecast ? `归母净利 ${f.profit_forecast.join('/')}亿` : '',
        (f.eps && (f.eps.this_year != null || f.eps.next_year != null))
          ? `EPS ${f.eps.this_year ?? '—'}/${f.eps.next_year ?? '—'}/${f.eps.next_two_year ?? '—'}` : '',
      ].filter(Boolean).join('，');
      const kind = x.kind === 'broker_report' ? '券商报告' : x.kind === 'consensus' ? '一致预期' : '提及';
      const chg = x.last_rating && x.last_rating !== x.rating ? `（上次 ${x.last_rating}）` : '';
      const sum = String(x.summary || x.view_thesis || x.content || '').replace(/\|/g, '／').replace(/\n/g, ' ');
      L.push(`| ${x.date || ''} | ${x.name} | ${kind} | ${x.broker || '—'} | ${x.rating || '—'}${chg} | ${x.target_price != null ? num(x.target_price) : '—'} | ${ft || '—'} | ${sum || '—'} |`);
    }
  }
  L.push('');

  L.push('## 七、卖方覆盖全景');
  L.push('');
  const ss = b.sellSideStats || {};
  if (!ss.covered_companies) {
    L.push('_本期未取到卖方研报覆盖数据_');
  } else {
    L.push(`> 近 90 天窗口：科创板 **${ss.covered_companies}** 家公司被卖方覆盖（覆盖率 ${ss.coverage_rate}%），`
      + `共 ${ss.brokers} 家券商，${ss.with_target_price} 篇给出目标价。`);
    const dist = ss.rating_dist || {};
    if (Object.keys(dist).length) {
      L.push(`> 评级分布：${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join('｜')}`);
    }
    L.push('');
    L.push('| 公司 | 代码 | 最新评级 | 券商 | 目标价 | 空间 | 研报数 | 最新研报日期 | PE分位 | 涨跌幅 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of (b.sellSide || []).slice(0, 20)) {
      const chg = r.last_rating && r.last_rating !== r.rating ? `（${r.last_rating}→${r.rating}）` : '';
      L.push(`| ${r.name} | ${r.code} | ${r.rating || '—'}${chg} | ${r.broker || '—'} | ${r.target_price != null ? num(r.target_price) : '—'} | `
        + `${r.upside != null ? fmtPct(r.upside, 1) : '—'} | ${r.report_count} | ${r.date} | `
        + `${r.pe_percentile != null ? num(r.pe_percentile, 0) + '%' : '—'} | ${fmtPct(r.change_pct)} |`);
    }
    L.push('');
  }

  L.push('## 八、估值极端');
  L.push('');
  L.push('> 分位口径：基于东方财富近 3 年（750 个交易日）PE_TTM 序列自算，负 PE（亏损）不参与分布。');
  L.push('');
  const vRows = b.valuationTable.filter((r) => r.pe_percentile != null);
  const high = vRows.filter((r) => r.pe_percentile >= 95).sort((a, b2) => b2.pe_percentile - a.pe_percentile).slice(0, 12);
  const low = vRows.filter((r) => r.pe_percentile <= 10).sort((a, b2) => a.pe_percentile - b2.pe_percentile).slice(0, 12);
  if (!high.length && !low.length) {
    L.push('_本期无 PE 历史分位极值样本_');
  } else {
    if (high.length) {
      L.push('**PE 分位 ≥95%（近 3 年高位）**');
      L.push('');
      L.push('| 公司 | PE(TTM) | PE分位 | PB分位 | 总市值 | 涨跌幅 |');
      L.push('|---|---|---|---|---|---|');
      for (const r of high) L.push(`| ${r.name} | ${num(r.pe_ttm, 1)} | ${num(r.pe_percentile, 0)}% | ${r.pb_percentile != null ? num(r.pb_percentile, 0) + '%' : '—'} | ${fmtMv(r.total_mv)} | ${fmtPct(r.change_pct)} |`);
      L.push('');
    }
    if (low.length) {
      L.push('**PE 分位 ≤10%（近 3 年低位）**');
      L.push('');
      L.push('| 公司 | PE(TTM) | PE分位 | PB分位 | 总市值 | 涨跌幅 |');
      L.push('|---|---|---|---|---|---|');
      for (const r of low) L.push(`| ${r.name} | ${num(r.pe_ttm, 1)} | ${num(r.pe_percentile, 0)}% | ${r.pb_percentile != null ? num(r.pb_percentile, 0) + '%' : '—'} | ${fmtMv(r.total_mv)} | ${fmtPct(r.change_pct)} |`);
      L.push('');
    }
  }

  L.push('## 九、热点事件');
  L.push('');
  const evs = b.events || [];
  if (!evs.length) {
    L.push('_本期未识别到事件分布_');
  } else {
    L.push('> 按科创板 619 家的公告/要闻正文识别，"覆盖公司数"= 有多少家不同公司涉及该事件。');
    L.push('');
    L.push('| 事件类型 | 类别 | 覆盖公司 | 提及次数 | 涉及公司（前 8） | 示例 |');
    L.push('|---|---|---|---|---|---|');
    for (const e of evs.slice(0, 14)) {
      L.push(`| ${e.key} | ${e.cat} | ${e.companies} | ${e.mentions} | ${e.companyList.slice(0, 8).map((c) => c.name).join('、')} | ${String(e.samples[0] ? e.samples[0].title : '').slice(0, 40)} |`);
    }
    L.push('');
  }
  const inds = b.sellSideByIndustry || [];
  if (inds.length) {
    L.push('### 卖方关注行业（近 90 天研报聚合）');
    L.push('');
    L.push('| 行业 | 覆盖公司 | 研报篇数 | 看多占比 | 目标空间均值 | 代表公司 |');
    L.push('|---|---|---|---|---|---|');
    for (const x of inds.slice(0, 12)) {
      L.push(`| ${x.industry} | ${x.companies} | ${x.reports} | ${x.bull_ratio != null ? x.bull_ratio + '%' : '—'} | ${x.avg_upside != null ? fmtPct(x.avg_upside, 1) : '—'} | ${x.names.slice(0, 6).join('、')} |`);
    }
    L.push('');
  }
  if (b.trending.length) {
    L.push('### 市场快讯');
    L.push('');
    for (const t of b.trending.slice(0, 8)) {
      L.push(`- **[${t.scope || '全市场'}]** ${t.title}${t.heat != null ? `（热度 ${t.heat}）` : ''}${t.source ? ` — ${t.source}` : ''}`);
      if (t.content) L.push(`  > ${String(t.content).replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    L.push('');
  }

  L.push('## 十、数据覆盖与质量');
  L.push('');
  L.push('| 项 | 数量 |');
  L.push('|---|---|');
  L.push(`| 科创板公司总数 | ${b.coverage.total} |`);
  L.push(`| 有财务摘要 | ${b.coverage.withFinancials} |`);
  L.push(`| 有估值数据 | ${b.coverage.withValuation} |`);
  L.push(`| 有 PE 历史分位 | ${b.coverage.withPercentile} |`);
  L.push(`| 有要闻 | ${b.coverage.withNews} |`);
  L.push(`| 有券商观点 | ${b.coverage.withResearch} |`);
  L.push(`| 有公告 | ${b.coverage.withNotice} |`);
  L.push(`| 要闻条目 | ${b.coverage.newsItems} |`);
  L.push(`| 研报条目 | ${b.coverage.researchItems} |`);
  L.push(`| 公告条目 | ${b.coverage.noticeItems} |`);
  L.push(`| 串台丢弃 | ${(b.stats && b.stats.crossTalkDropped) || 0} |`);
  L.push(`| 采集失败 | ${(b.stats && b.stats.failureCount) || 0} |`);
  L.push('');
  L.push('### 数据源');
  const src = b.sources || {};
  const ifd = b.ifind || null;
  L.push('| 环节 | 来源 |');
  L.push('|---|---|');
  L.push(`| 行情快照 / 估值 / 行业 | ${src.quotes || '东方财富 push2'} |`);
  L.push(`| 券商研报 | ${src.research || '—'} |`);
  L.push(`| 公告 | ${src.announcements || '—'} |`);
  L.push(`| 要闻 | ${src.news || '—'} |`);
  L.push(`| 财务摘要 | ${src.financials || '—'} |`);
  L.push(`| 一致预期 / 补充口径 | ${src.consensus || '—'} |`);
  L.push(`| PE 历史分位 | ${src.percentile || '—'} |`);
  L.push(`| 市场宽度 | ${src.breadth || '—'} |`);
  if (ifd) {
    L.push(`| iFinD 额度用量 | 本期实际请求 ${ifd.attempts} 次（成功 ${ifd.calls} / 失败 ${ifd.errors}）｜模式 ${ifd.mode}｜补充口径覆盖 ${ifd.ifindCovered || 0} 家 |`);
  }
  L.push('');
  const deg = (b.degraded && b.degraded.length) ? b.degraded : (b.stats && b.stats.degraded) || [];
  if (deg.length) {
    L.push('### 本期降级说明（如实披露）');
    L.push('');
    for (const d of deg) L.push(`- ${d}`);
    L.push('');
  }
  // **历史回补的口径差异必须写在正文里**（2026-10-27）：
  // 回补的行情锚定在历史某一天，要闻池按 30 条/家取（实时采集是 12 条/家），
  // 所以「要闻总数」与实时采集日**不可直接比较** —— 不写清楚会被误读成"那天新闻特别多"。
  if (b.backfill) {
    const bf = b.backfill;
    L.push('### 本期为历史回补（口径差异须知）');
    L.push('');
    L.push(`- 行情/估值锚定：**${bf.quoteDate}**${bf.tradingDay ? '（当日为交易日）' : '（当日休市，收盘价沿用最近交易日、涨跌幅按 0 计）'}`);
    L.push(`- 要闻池：每家取 ${bf.newsPoolSize} 条（实时采集为 12 条/家），因此**要闻总数与实时采集日不可直接比较**`);
    L.push(`- 要闻已裁剪到 ≤ ${bf.newsCutoff}，避免把之后的新闻装进本期`);
    L.push(`- 覆盖：${bf.covered} 家（精确命中当日 ${bf.exact} 家）`);
    L.push('');
  }
  L.push('---');
  L.push('');
  // 数据源署名必须与实际取数一致，不能沿用模板里的旧源名
  const srcLines = [
    `行情快照 / 估值 / 行业分类：${src.quotes || '—'}`,
    `财务摘要：${src.financials || '—'}`,
    `一致预期 / 补充口径：${src.consensus || '—'}`,
    `PE / PB 历史分位：${src.percentile || '—'}`,
    `市场宽度：${src.breadth || '—'}`,
    `券商研报：${src.research || '—'}`,
    `法定公告：${src.announcements || '—'}`,
    `个股要闻：${src.news || '—'}`,
  ];
  L.push(`*本简报由科创板每日情报雷达自动生成。数据来源：*`);
  for (const s of srcLines) L.push(`*· ${s}*`);
  L.push('');
  // **说明必须动态生成**（2026-10-23 修正）：原来这里写死"iFinD 当前处于额度耗尽状态"，
  // 而额度恢复后这句话会变成假陈述。改为按当期的实际台账生成。
  if (ifd && ifd.quotaExhausted) {
    L.push('*说明：同花顺 iFinD 本期额度不可用（免费试用版为 2,000 次永久总量、不按月刷新），'
      + `本期 iFinD 补充口径未取到数据（实际请求 ${ifd.attempts} 次）；上述各项均已切换为可用来源。*`);
  } else if (ifd) {
    L.push('*说明：同花顺 iFinD 本期实际请求 '
      + `${ifd.attempts} 次（成功 ${ifd.calls} / 失败 ${ifd.errors}），补充口径覆盖 ${ifd.ifindCovered || 0} 家，`
      + '已按字段合并进主口径；免费试用版为 2,000 次永久总量、不按月刷新，用量需持续盯。*');
  } else {
    L.push('*说明：本期无 iFinD 调用记录，全部指标由东方财富等可用来源承接。*');
  }
  return L.join('\n');
}

function main() {
  const arg = process.argv[2];
  const date = arg || latestDate() || listDates()[0];
  if (!date) { console.error('没有可用数据日期，请先执行采集'); process.exit(1); }
  const md = build(date);
  if (!md) { console.error(`未找到 ${date} 的数据`); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 写独立文件名：基线版不能覆盖 Bot 写的判断版（out/brief-<日期>.md）
  const out = path.join(OUT_DIR, `brief-baseline-${date}.md`);
  fs.writeFileSync(out, md, 'utf8');
  console.log(out);
  console.log(`字符数：${md.length}`);
  console.log('（这是无模型参与的基线版；判断层简报由 Bot 写在 brief-<日期>.md，两者不互相覆盖）');
}

if (require.main === module) main();
module.exports = { build };
