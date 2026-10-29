'use strict';
/**
 * CFO 问答：把「项目背景 + 当日上下文 + 检索到的相关材料」组装成提示词。
 *
 * **三个设计原则（都是从踩过的坑来的）**
 *
 * ① **不要把 5MB 数据集塞进上下文**
 *    档案里自己的结论：「人写的 Bot 提示词要带文件大小意识。给模型 5MB 的输入不是"给上下文"，
 *    是给它埋雷」。所以这里只给**结构化切片**：当日概览 + 检索命中的条目 + 相关公司的财务估值。
 *
 * ② **可信度边界必须写进提示词**
 *    模型不知道"iFinD 额度耗尽所以一致预期取不到"、"卖方观点分三层、第三层只有元数据"。
 *    不写清楚，模型就会把"没有"当成"没有这回事"，或者拿元数据当研报原文引用。
 *
 * ③ **证据要编号**
 *    每条材料给 [E1]…[En]，要求模型引用编号 → 回答可回查，不会变成"听起来很像"的编造。
 */

/** 静态项目背景（口径不随日期变，但下面的「本期可信度边界」是动态的） */
const PROJECT_BACKGROUND = `【项目背景】
本系统是"科创板每日情报雷达"，每日自动采集并整理**科创板 619 家公司**（688 段，含未盈利上市 -U/-W）的公开信息，输出每日简报与看板。

覆盖范围（**对象是整个科创板，不是某一家公司**）：
- 619 家分布在 **46 个行业**：半导体 119、软件开发 38、医疗器械 52、通用设备 32、化学制药 30、自动化设备 29、专用设备 24、生物制品 23、电池 23……**医药相关合计约 108 家**。
- 仅覆盖科创板，不含主板、创业板、港股、美股；个股基本面数据截止到最近披露的财报期。
- **问哪家公司就答哪家公司**。科创板上有半导体公司、锂电公司、高端装备公司、软件公司、军工公司等等，
  不要把答案往某一个方向上靠。

【医药方向的关注口径 —— **只在问题涉及医药/生物医药/竞情时才用**】
科创板医药相关约 108 家。CFO 常用的赛道口径是这六条：
  ① FGFR2/FGFR3 靶点 ② CLDN6/CLDN9 ADC ③ USP1 靶点 ④ 溃疡性结肠炎 UC ⑤ 宫颈光动力治疗 ⑥ 膀胱蓝光医疗器械。
  （这六条是**赛道口径，不是本系统的覆盖范围**；其中 APL-2401/2501/2302/1401 等代号是
  亚虹医药(688176.SH) 自身的产品代号，涉及具体公司时以该公司的实际披露为准。）

数据来源与口径（引用数字时必须带上）：
- 行情 / 估值：东方财富逐日口径（含 PE/PB/PS/PCF/PEG、总市值、流通市值、总股本）
- 财务：东方财富 F10 为主口径（营收、归母净利、同比、毛利率、净利率、ROE、扣非 ROE、EPS、BPS、总资产）
- 估值分位：由历史估值序列自算（名义近 3 年窗口；部分标的实际历史不足 3 年，另有标注）
- 券商研报：东方财富研报中心（全市场，90 天窗口）
- 公告：东方财富公告（全市场分页）
- 要闻：东方财富个股资讯检索（按公司名检索的条目池，含摘要非全文）

系统不提供、模型也不应编造的内容：
- 非科创板标的的数据、实时盘中数据、境外市场数据
- 未公开的经营信息、订单、产能、渠道等
- 任何投资建议、目标价预测、买卖判断`;

/** 从问题里切候选词（中文不做分词，用片段匹配 + 公司名/代码强命中） */
const STOP_WORDS = ['请问', '我们', '公司', '他们', '这个', '那个', '一下', '怎么样', '如何', '什么',
  '哪些', '哪个', '为什么', '是否', '可以', '需要', '现在', '最近', '目前', '今天', '昨天', '有没有',
  '多少', '情况', '问题', '分析', '帮我', '说说', '介绍', '以及', '还有', '和', '与', '的', '了', '吗', '呢', '啊'];

/**
 * 噪声字：含这些字的片段基本没有检索价值。
 *
 * **为什么必须过滤**（2026-10-27 实测踩到）：
 * 问「睿创微纳最近的业绩和研报怎么看？」，按标点切出来是一整段，
 * 再切 2 字子串会得到「的业」「和研」「么看」这种碎片 ——
 * 它们在大量研报正文里都能命中，把**不相关**的条目抬到了前面，
 * 结果点名要问的公司自己的研报反而被挤掉。
 */
const NOISE_CHARS = '的了和与及吗呢啊呀是在有个我你他她它们这那什怎样如何否可要看问说给对从到把被让并且但而因所以如果虽只都还也很更最又再才将已经正非常挺';

function isNoiseTerm(term) {
  for (const ch of term) if (NOISE_CHARS.includes(ch)) return true;
  return false;
}

function extractTerms(question) {
  const q = String(question || '');
  const parts = q.split(/[，。！？、；：\s,.!?;:()（）【】\[\]"“”'’\-—_/]+/).filter(Boolean);
  const primary = [];   // 完整片段，权重高
  const sub = [];       // 2 字子串，权重低且要过噪声字
  const seen = new Set();
  for (const p of parts) {
    if (p.length < 2) continue;
    if (STOP_WORDS.includes(p)) continue;
    if (!seen.has(p)) { seen.add(p); primary.push(p); }
    if (p.length > 4) {
      for (let i = 0; i + 2 <= p.length; i++) {
        const s = p.slice(i, i + 2);
        if (isNoiseTerm(s) || seen.has(s)) continue;
        seen.add(s); sub.push(s);
      }
    }
  }
  return { primary, sub };
}

/** 在文本里数命中次数（长片段权重更高） */
function hitCount(text, terms) {
  const t = String(text || '').toLowerCase();
  let n = 0;
  const matched = [];
  for (const term of terms.primary) {
    const k = term.toLowerCase();
    if (t.indexOf(k) < 0) continue;
    n += 3;
    matched.push(term);
  }
  for (const term of terms.sub) {
    const k = term.toLowerCase();
    if (t.indexOf(k) < 0) continue;
    n += 1;
    matched.push(term);
  }
  return { n, matched };
}

/** 找出问题里点名的公司（名称或代码） */
function matchCompanies(question, companies) {
  const q = String(question || '');
  const hits = [];
  for (const c of companies) {
    const name = c.name || '';
    if (name.length >= 2 && q.includes(name)) { hits.push({ c, why: '名称' }); continue; }
    const bare = String(c.code || '').split('.')[0];
    if (bare && q.includes(bare)) hits.push({ c, why: '代码' });
  }
  return hits;
}

/**
 * 检索相关材料。
 * @returns {{evidence:Array, companies:Array, terms:Array, namedCompanies:Array}}
 */
function retrieve(question, dataset, opts = {}) {
  const maxNews = opts.maxNews || 6;
  const maxResearch = opts.maxResearch || 5;
  const maxNotice = opts.maxNotice || 4;
  const companies = dataset.companies || [];
  const terms = extractTerms(question);
  const named = matchCompanies(question, companies);
  const namedCodes = new Set(named.map((h) => h.c.code));
  const anchorDate = dataset.date || '';

  const scored = { news: [], research: [], notice: [] };
  for (const c of companies) {
    const isNamed = namedCodes.has(c.code);
    for (const n of c.news || []) {
      if (n.is_research) continue;               // 研报单列，避免重复
      const hay = `${n.title || ''} ${n.content || ''}`;
      const { n: hits, matched } = hitCount(hay, terms);
      const score = hits + (isNamed ? 20 : 0) + (n.date && n.date >= anchorDate ? 2 : 0);
      if (score > 0) scored.news.push({ score, matched, isNamed, kind: 'news', date: n.date, code: c.code, name: c.name, industry: c.industry, title: n.title, content: n.content, url: n.url, match: n.match });
    }
    for (const r of c.research || []) {
      const hay = `${r.title || ''} ${r.view_thesis || ''} ${r.broker || ''} ${(r.eps && r.eps.this_year) || ''}`;
      const { n: hits, matched } = hitCount(hay, terms);
      const score = hits + (isNamed ? 20 : 0) + (r.date && r.date >= anchorDate ? 2 : 0);
      if (score > 0) scored.research.push({ score, matched, isNamed, kind: 'research', date: r.date, code: c.code, name: c.name, industry: c.industry, title: r.title, broker: r.broker, rating: r.rating, target_price: r.target_price, view_thesis: r.view_thesis, url: r.url, hasView: !!(r.view || r.view_thesis) });
    }
    for (const nt of c.notices || []) {
      const hay = `${nt.title || ''} ${nt.content || ''}`;
      const { n: hits, matched } = hitCount(hay, terms);
      const score = hits + (isNamed ? 20 : 0) + (nt.date && nt.date >= anchorDate ? 2 : 0);
      if (score > 0) scored.notice.push({ score, matched, isNamed, kind: 'notice', date: nt.date, code: c.code, name: c.name, industry: c.industry, title: nt.title, content: nt.content, url: nt.url });
    }
  }
  for (const k of Object.keys(scored)) {
    // **点名公司的条目排最前**（isNamed 优先，其次分数、再次日期）——
    // 不这么做的话，通用词命中的无关条目会把点名公司的材料挤掉。
    scored[k].sort((a, b) => (Number(b.isNamed) - Number(a.isNamed)) || (b.score - a.score) || String(b.date || '').localeCompare(String(a.date || '')));
  }

  // **三类合并后统一按相关度排序**（不是"研报→要闻→公告"分段堆）。
  // 分段堆的问题：问"睿创微纳最近的业绩"时，如果它家没有研报，
  // 前 5 条证据会全是别家的研报，而它自己的要闻/公告被压到第 6 条以后 ——
  // 模型看到的第一屏全是无关内容。
  const all = [...scored.research, ...scored.news, ...scored.notice];
  all.sort((a, b) => (Number(b.isNamed) - Number(a.isNamed)) || (b.score - a.score) || String(b.date || '').localeCompare(String(a.date || '')));
  const evidence = all.slice(0, (opts.maxEvidence || 12));
  const kinds = { research: 0, news: 0, notice: 0 };
  for (const e of evidence) kinds[e.kind] = (kinds[e.kind] || 0) + 1;

  const sliceCodes = new Set([
    ...named.map((h) => h.c.code),
    ...evidence.map((e) => e.code),
  ]);
  const companySlices = companies.filter((c) => sliceCodes.has(c.code)).slice(0, 8);

  return {
    evidence, companies: companySlices, terms, kinds,
    namedCompanies: named.map((h) => h.c.name),
    named,   // 点名公司的完整对象（竞争类扩展要用 industry / news）
  };
}

/** 数字格式化（避免 undefined / NaN） */
function fmt(v, digits = 2, suffix = '') {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(digits) + suffix;
}
function yi(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return (Number(v) / 1e8).toFixed(2) + ' 亿元';
}

/** 单个公司的财务/估值切片 */
function companySlice(c) {
  const f = c.financials || {};
  const v = c.valuation || {};
  const g = c.growth || {};
  const p = c.profitability || {};
  const lines = [];
  lines.push(`- ${c.name}（${c.code}）｜${c.industry || '未分类'}`);
  const fin = [];
  if (f.revenue != null) fin.push(`营收 ${yi(f.revenue)}（同比 ${fmt(g.revenue_yoy != null ? g.revenue_yoy : f.revenue_yoy, 1, '%')}）`);
  if (f.net_profit_attr != null) fin.push(`归母净利 ${yi(f.net_profit_attr)}（同比 ${fmt(g.net_profit_yoy != null ? g.net_profit_yoy : f.net_profit_yoy, 1, '%')}）`);
  if (p.gross_margin != null) fin.push(`毛利率 ${fmt(p.gross_margin, 1, '%')}`);
  if (p.roe_weighted != null) fin.push(`ROE ${fmt(p.roe_weighted, 1, '%')}`);
  if (p.roe_deducted != null) fin.push(`扣非ROE ${fmt(p.roe_deducted, 1, '%')}`);
  if (f.eps != null) fin.push(`EPS ${fmt(f.eps, 3)}`);
  if (f.bps != null) fin.push(`BPS ${fmt(f.bps, 2)}`);
  if (fin.length) lines.push(`  基本面：${fin.join('｜')}`);
  const val = [];
  if (v.pe_ttm != null) val.push(`PE(TTM) ${fmt(v.pe_ttm, 2)}`);
  if (v.pb != null) val.push(`PB ${fmt(v.pb, 2)}`);
  if (v.pe_percentile != null) val.push(`PE 近3年分位 ${fmt(v.pe_percentile, 1, '%')}`);
  if (v.pb_percentile != null) val.push(`PB 近3年分位 ${fmt(v.pb_percentile, 1, '%')}`);
  if (v.total_mv != null) val.push(`总市值 ${yi(v.total_mv)}`);
  if (val.length) lines.push(`  估值：${val.join('｜')}`);
  const sl = c.sell_side || {};
  if (sl.covered) {
    const s = [];
    if (sl.broker) s.push(`券商 ${sl.broker}`);
    if (sl.rating) s.push(`评级 ${sl.rating}`);
    if (sl.target_price != null) s.push(`目标价 ${fmt(sl.target_price, 2)} 元`);
    if (sl.date) s.push(`研报日 ${sl.date}`);
    if (s.length) lines.push(`  卖方：${s.join('｜')}${sl.view || sl.view_thesis ? '' : '（⚠ 只有元数据、无研报原文，不得当原文引用）'}`);
  }
  return lines.join('\n');
}

/** 当日上下文（结构化、可直接读） */
function buildContext(brief, dataset) {
  const L = [];
  const date = brief.date || (dataset && dataset.date) || '未知';
  const cov = brief.coverage || {};
  const src = brief.sources || {};
  L.push(`数据日：${date}｜最新消息日：${brief.latestDate || date}｜覆盖 ${cov.total || 0} 家公司`);
  L.push(`条目：要闻 ${cov.newsItems || 0} 条（${cov.withNews || 0} 家有）／研报 ${cov.researchItems || 0} 条（${cov.withResearch || 0} 家）／公告 ${cov.noticeItems || 0} 条（${cov.withNotice || 0} 家）`);
  L.push(`覆盖度：财务 ${cov.withFinancials || 0} 家｜估值 ${cov.withValuation || 0} 家｜PE 历史分位 ${cov.withPercentile || 0} 家`
    + `｜卖方覆盖 ${(brief.sellSideStats && brief.sellSideStats.covered_companies) || 0} 家`);

  const m = brief.market || {};
  const br = m.breadth || {};
  const idx = m.index || {};
  L.push(`市场：涨 ${br.rising ?? '—'}／跌 ${br.falling ?? '—'}／平 ${br.flat ?? '—'}`
    + (idx.kc50_change_pct != null ? `｜科创50 ${fmt(idx.kc50_change_pct, 2, '%')}` : '')
    + (br.up5 != null ? `｜涨超5% ${br.up5} 家｜跌超5% ${br.down5} 家` : ''));

  const dg = brief.newsDigest || {};
  const ov = dg.overview || {};
  const points = (ov.topPoints || []).slice(0, 8);
  if (points.length) {
    L.push('今日要点（当日发生、标题点名了公司的事件）：');
    for (const p of points) {
      const t = p.summary || p.title || '';
      L.push(`  - ${p.date || date}｜${p.name || ''}${p.industry ? '（' + p.industry + '）' : ''}${p.event ? '｜' + p.event : ''}：${String(t).slice(0, 180)}`);
    }
  }
  const secs = (dg.sectors || []).slice(0, 5);
  if (secs.length) {
    L.push('大事板块（按事件强度排序）：');
    for (const s of secs) {
      const b = s.basis || {};
      const evs = (b.events || []).slice(0, 3).map((e) => `${e.key}(${e.companies}家)`).join('、');
      L.push(`  - ${s.industry || ''}：${s.companies || 0} 家｜要闻 ${b.news || 0}｜公告 ${b.notices || 0}｜研报 ${b.research || 0}`
        + `${evs ? '｜主要事件 ' + evs : ''}${b.avgChg != null ? '｜平均涨跌 ' + fmt(b.avgChg, 2, '%') : ''}`);
    }
  }
  const hi = (brief.highlights || []).slice(0, 10);
  if (hi.length) {
    L.push('高信号公司（按信号强度排序）：');
    for (const h of hi) {
      const sig = (h.signals || []).map((s) => (s && (s.label || s.text || s)) || '').filter(Boolean).slice(0, 3).join('、');
      L.push(`  - ${h.name}（${h.code}）${h.industry ? '｜' + h.industry : ''}${sig ? '｜' + sig : ''}`);
    }
  }
  const cd = brief.crossDay || {};
  if (cd.available && (cd.headline || []).length) {
    L.push(`跨日变化（基准 ${cd.from} → ${cd.to}）：`);
    for (const h of (cd.headline || []).slice(0, 8)) L.push(`  - ${h.name}（${h.code}）｜${h.type}：${h.detail || ''}`);
  }

  // **排序类上下文**：CFO 常问"涨得最多/估值最低/市值最大"，
  // 这类问题关键词检索答不了（检索只能匹配文本，排序要全量算）→ 直接把榜单给模型。
  if (dataset && (dataset.companies || []).length) {
    const cs = dataset.companies;
    const byChg = cs.map((c) => ({ c, chg: c.quote && c.quote.change_pct })).filter((x) => x.chg != null)
      .sort((a, b) => b.chg - a.chg);
    if (byChg.length) {
      L.push('涨跌幅榜（当日）：');
      for (const x of byChg.slice(0, 8)) L.push(`  - ${x.c.name}（${x.c.code}）${fmt(x.chg, 2, '%')}${x.c.industry ? '｜' + x.c.industry : ''}`);
      L.push('跌幅榜（当日）：');
      for (const x of byChg.slice(-8).reverse()) L.push(`  - ${x.c.name}（${x.c.code}）${fmt(x.chg, 2, '%')}${x.c.industry ? '｜' + x.c.industry : ''}`);
    }
    const byMv = cs.filter((c) => c.valuation && c.valuation.total_mv != null)
      .sort((a, b) => b.valuation.total_mv - a.valuation.total_mv);
    if (byMv.length) {
      L.push('总市值前 8：' + byMv.slice(0, 8).map((c) => `${c.name} ${yi(c.valuation.total_mv)}`).join('｜'));
    }
    const byPct = cs.filter((c) => c.valuation && c.valuation.pe_percentile != null)
      .sort((a, b) => a.valuation.pe_percentile - b.valuation.pe_percentile);
    if (byPct.length) {
      L.push('PE 近3年分位最低 8 家（估值低位，注意部分标的实际历史不足 3 年）：'
        + byPct.slice(0, 8).map((c) => `${c.name} ${fmt(c.valuation.pe_percentile, 1, '%')}`).join('｜'));
    }
  }

  L.push(`数据来源：行情 ${src.quotes || '—'}｜财务 ${src.financials || '—'}｜估值分位 ${src.percentile || '—'}｜研报 ${src.research || '—'}`);
  return L.join('\n');
}

/** 本期可信度边界（动态 —— 这段是整个提示词里最要紧的部分） */
function buildTrustBoundary(brief, dataset, opts = {}) {
  const L = [];
  const src = brief.sources || {};
  L.push('【本期可信度边界（必须遵守，材料里没有的不要编）】');
  L.push(`- 财务主口径：${src.financials || '—'}；估值分位：${src.percentile || '—'}；一致预期/研报评级：${src.consensus || '—'}`);
  if (src.consensus && /未获取|不可用/.test(src.consensus)) {
    L.push('  ⚠ 一致预期与研报评级本期**取不到**，不得凭印象给出盈利预测或评级。');
  }
  if (dataset && dataset.backfill) {
    const b = dataset.backfill;
    L.push(`- ⚠ 本期为**历史回补**（锚定 ${b.quoteDate}）：行情/估值是 ${b.quoteDate} 的口径，不是最新交易日；` +
      (b.tradingDay ? '' : '且该日为休市日，当日涨跌幅按 0 计、成交数据缺失。'));
  }
  L.push('- ⚠ 卖方观点分三层：① 研报正文原文 ② 从原文抽出的摘要 ③ **只有元数据（券商/评级/目标价/日期）**。');
  L.push('  引用时必须注明层级；第 ③ 层**不得当作研报原文引用**，也不得据此复述"研报认为…"这类说法。');
  const vh = brief.valuationHistory || {};
  if (vh && vh.peShort > 0) {
    L.push(`- ⚠ 估值分位是"名义近 3 年"窗口，但有 ${vh.peShort} 只标的实际历史不足 3 年（最短 ${vh.peShortUnder250 || '—'} 只不足 250 天），` +
      '其分位不可与真 3 年横比，回答时要说明。');
  }
  const deg = brief.degraded || [];
  if (deg.length) {
    L.push('- 本期降级项（如实披露）：');
    for (const d of deg.slice(0, 5)) L.push(`  · ${d}`);
  }
  // **网络来源的边界**（2026-10-28 新增）
  if (opts.webResults && opts.webResults.length) {
    L.push('- ⚠ 下面【网络检索结果】是**外部网页，未经本地数据核验**，每条都必须带来源站点和日期。');
    L.push('  它们与本地 [E编号] 是**两套证据**，不能混用编号；W 编号只能引 W 编号。');
    L.push('  若网络信息与本地数据冲突，以**本地数据为准**并把冲突点讲出来。');
    L.push('  网络检索有**召回限制**（没搜到的 ≠ 不存在），不得说"没有"、只能说"本次检索未覆盖"。');
  }
  if (opts.competitiveNote) {
    L.push(`- ⚠ 本题涉及**竞争对手**：${opts.competitiveNote}`);
  }
  return L.join('\n');
}

/** 竞争类问题：竞对往往不在 619 家覆盖范围内，必须联网 */
const COMPETITIVE_WORDS = ['竞对', '竞争对手', '竞品', '对手', '竞争格局', '同业', '对标', '可比公司', '同行'];

/** 强烈的"外部性/时效性"信号 —— 命中就必联网 */
const WEB_MUST_WORDS = [
  ...COMPETITIVE_WORDS,
  '海外', '出海', '全球', '国外', '政策', '监管', '行业动态', '产业趋势',
  '最新进展', '有什么动向', '什么动向', '最新消息', '最近有什么',
];

/** 较弱的时效信号 —— 本地覆盖不足时也联网 */
const WEB_HINT_WORDS = ['最近', '最新', '近期', '这周', '本周', '本月', '新动向', '进展'];

/**
 * 判断是否需要联网检索，并构造检索式。
 * @returns {{needed:boolean, reason:string, query:string, competitive:boolean}}
 */
function detectWebNeed(question, opts = {}) {
  const q = String(question || '');
  const mode = String(opts.mode || 'auto').toLowerCase();
  const competitive = COMPETITIVE_WORDS.some((w) => q.includes(w));
  if (mode === 'off') return { needed: false, reason: '关闭了联网', query: '', competitive };
  if (mode === 'always') return { needed: true, reason: '强制联网', query: q, competitive };

  const must = WEB_MUST_WORDS.find((w) => q.includes(w));
  if (must) return { needed: true, reason: `命中「${must}」`, query: q, competitive };
  const hint = WEB_HINT_WORDS.find((w) => q.includes(w));
  if (hint) return { needed: true, reason: `命中时效词「${hint}」`, query: q, competitive };
  return { needed: false, reason: '无外部性信号', query: '', competitive };
}

/**
 * 竞争类问题的本地扩展：把**同题材 / 同篇提及 / 同行业**的科创板公司一起拉进来。
 *
 * 为什么需要：原来检索只匹配"问题里出现的公司名"，问"亚虹的竞对"只会拿到亚虹自己的材料。
 *
 * **三个信号，强度递减**：
 * 1. **同篇提及（最强）**：东财的「医药早参 / 早参 / 盘点」是**一天一篇的汇总稿**，
 *    同一篇里会点名十几家公司（例："艾力斯伏美替尼Ⅲ期未达标；亚虹医药与Theramex签订授权协议丨医药早参"）。
 *    这类稿子天然是**竞情素材** —— 把稿子里出现的其它科创板公司一起带出来，
 *    就等于"一篇早参看全行业"。这是**雷达本地数据里竞对动向最集中的地方**。
 * 2. **同题材匹配**：疫苗/HPV/宫颈/光动力/ADC/基因治疗 等领域词 + 动作词
 *    （授权/出海/获批/NDA/III期/临床/BD/收购/中标）。
 * 3. **同行业（最弱，只作兜底）**：同属一个申万行业就算沾边，但往往毫无关系，
 *    所以**最多给 3 家**，并明确标注"仅同行业，非同题材"。
 */
const TOPIC_NOUNS = ['疫苗', 'HPV', '宫颈', '光动力', 'ADC', '基因治疗', '细胞治疗', 'CAR-T', '肿瘤',
  '免疫治疗', '双抗', 'PROTAC', '小分子', '创新药', '泌尿', '肾病', '抗病毒', '减重', '糖尿病'];
const TOPIC_ACTIONS = ['授权', '出海', '许可', '获批', 'NDA', 'IND', 'III期', 'II期', '临床', 'BD',
  '收购', '中标', 'IPO', '专利', '上市申请', '突破性', '首发'];

/** 医药专属题材词 —— 只有医药赛道的匹配才算强信号 */
const MED_TOPICS = new Set(['疫苗', 'HPV', '宫颈', '光动力', 'ADC', '基因治疗', '细胞治疗', 'CAR-T',
  '肿瘤', '免疫治疗', '双抗', 'PROTAC', '创新药', '泌尿', '肾病', '抗病毒', '减重', '糖尿病',
  'NDA', 'IND', 'III期', 'II期', '临床', '适应症']);

/** 医药相关行业（用于判断焦点公司是不是医药公司） */
const MED_INDUSTRIES = ['化学制药', '生物制品', '医疗器械', '医药商业', '中药', '动物保健Ⅱ', '医疗研发外包与诊断', '生物科技'];

/** 判定一个行业是否与焦点行业"沾边"（同行业或相邻的医药行业） */
function industryRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const am = MED_INDUSTRIES.includes(a), bm = MED_INDUSTRIES.includes(b);
  return am && bm;
}

function expandCompetitive(dataset, namedCompanies, evidence) {
  const companies = (dataset && dataset.companies) || [];
  if (!companies.length) return { peers: [], note: '' };
  const focus = (namedCompanies || []).map((h) => h.c).filter(Boolean);
  if (!focus.length) return { peers: [], note: '' };

  const focusCodes = new Set(focus.map((c) => c.code));
  const industries = new Set(focus.map((c) => c.industry).filter(Boolean));

  // 名称 → 公司（用于"同篇提及"识别）
  const nameIndex = new Map();
  for (const c of companies) {
    if (!c.name || c.name.length < 2) continue;
    nameIndex.set(c.name.replace(/[-－]?(U|W)$/i, ''), c);
  }

  // ---- 信号 1：同篇提及 ----
  const mentioned = new Map(); // code -> {c, titles:[]}
  for (const c of focus) {
    for (const n of (c.news || [])) {
      const t = String(n.title || '');
      // 早参/盘点类稿件才做同篇识别，普通公司公告标题不会提别的公司
      if (!/早参|盘点|日报|周报|简报|要闻|资讯|动态|一览/.test(t)) continue;
      for (const [nm, other] of nameIndex) {
        if (other.code === c.code || focusCodes.has(other.code)) continue;
        if (!t.includes(nm)) continue;
        const key = other.code;
        if (!mentioned.has(key)) mentioned.set(key, { c: other, titles: [] });
        mentioned.get(key).titles.push(`${n.date || ''}｜${t}`);
      }
    }
  }

  // ---- 信号 2：题材词 ----
  const topicWords = new Set();
  for (const c of focus) {
    for (const n of (c.news || []).slice(0, 8)) {
      const t = String(n.title || '');
      for (const w of TOPIC_NOUNS) if (t.includes(w)) topicWords.add(w);
      for (const w of TOPIC_ACTIONS) if (t.includes(w)) topicWords.add(w);
    }
  }
  for (const w of TOPIC_ACTIONS) if (c_containsAny(focus, w)) topicWords.add(w);
  function c_containsAny(list, w) {
    for (const c of list) for (const n of (c.news || []).slice(0, 8)) if (String(n.title || '').includes(w)) return true;
    return false;
  }

  const scored = [];
  for (const c of companies) {
    if (focusCodes.has(c.code)) continue;
    let score = 0;
    const reasons = [];
    const sameIndustry = industries.has(c.industry);
    const relatedIndustry = focus.some((f) => industryRelated(f.industry, c.industry));
    // 1) 同篇提及（最强，且不受题材词泛化影响）
    if (mentioned.has(c.code)) {
      score += 6;
      reasons.push('与焦点公司出现在同一篇早参/盘点稿');
    }
    // 2) 同题材：医药专属词才算强信号；通用动作词（授权/许可…）在**跨行业**时只算弱信号
    const hits = new Set();
    for (const n of (c.news || [])) {
      const t = String(n.title || '');
      for (const w of topicWords) if (t.includes(w)) hits.add(w);
    }
    if (hits.size) {
      const medHits = Array.from(hits).filter((w) => MED_TOPICS.has(w));
      const genHits = Array.from(hits).filter((w) => !MED_TOPICS.has(w));
      if (medHits.length) {
        score += 1.5 * Math.min(3, medHits.length);
        reasons.push(`同题材(${medHits.slice(0, 3).join('/')})`);
      }
      if (genHits.length) {
        if (relatedIndustry) { score += 0.8 * Math.min(2, genHits.length); reasons.push(`同题材动作(${genHits.slice(0, 2).join('/')})`); }
        else { score += 0.3; reasons.push(`仅动作词(${genHits.slice(0, 1).join('/')})，跨行业`); }
      }
    }
    // 3) 同行业（最弱）
    if (sameIndustry) { score += 1; reasons.push('同行业'); }
    else if (relatedIndustry) { score += 0.5; reasons.push('相邻医药行业'); }
    if (score > 1) scored.push({ c, score, reasons, mentionedTitles: (mentioned.get(c.code) || {}).titles || [] });
  }
  scored.sort((a, b) => b.score - a.score
    || ((b.c.news || []).length - (a.c.news || []).length)
    || String(a.c.name).localeCompare(String(b.c.name)));

  // **同行业兜底最多 3 家**（其余按同篇/同题材优先）
  const strong = scored.filter((x) => x.reasons.some((r) => /早参|同题材/.test(r)));
  const weak = scored.filter((x) => !x.reasons.some((r) => /早参|同题材/.test(r)));
  const picked = [...strong, ...weak].slice(0, 8);

  const peers = picked.map((x) => {
    const top = (x.c.news || []).slice(0, 2).map((n) => `${n.date || ''}｜${String(n.title || '').slice(0, 60)}`);
    return { c: x.c, score: x.score, reasons: x.reasons, topNews: top, mentionedTitles: x.mentionedTitles };
  });

  const note = peers.length
    ? `雷达覆盖内找到 ${peers.length} 家相关公司（${peers.map((p) => p.c.name).join('、')}），` +
      '其中**同篇早参/同题材**的是重点线索，**同行业**的只是弱相关，不能直接当竞对。' +
      '**真正的竞对很可能不在 619 家覆盖范围内**（未上市或非科创板标的），这部分要靠网络检索。'
    : '雷达覆盖内没有找到同题材公司，竞对多半在覆盖范围之外。';
  return { peers, note };
}


/** 证据清单（带编号） */
function formatEvidence(evidence) {
  if (!evidence.length) return '（按问题关键词没有检索到相关材料；请依据"当日上下文"回答，并说明材料不足。）';
  const L = [];
  evidence.forEach((e, i) => {
    const id = `E${i + 1}`;
    const head = `[${id}] （${e.kind === 'news' ? '要闻' : e.kind === 'research' ? '券商研报' : '公告'}）${e.date || ''}｜${e.name}（${e.code}）${e.industry ? '｜' + e.industry : ''}`;
    L.push(head);
    L.push(`    标题：${e.title || ''}`);
    if (e.kind === 'research') {
      const meta = [];
      if (e.broker) meta.push(`券商 ${e.broker}`);
      if (e.rating) meta.push(`评级 ${e.rating}`);
      if (e.target_price != null) meta.push(`目标价 ${fmt(e.target_price, 2)} 元`);
      if (meta.length) L.push(`    研报元数据：${meta.join('｜')}`);
      if (e.hasView && e.view_thesis) L.push(`    研报观点摘要（原文抽取）：${String(e.view_thesis).slice(0, 400)}`);
      else if (!e.hasView) L.push('    ⚠ 本条只有元数据，没有研报原文/摘要。');
    } else if (e.content) {
      L.push(`    摘要：${String(e.content).slice(0, 300)}`);
    }
    if (e.url) L.push(`    链接：${e.url}`);
  });
  return L.join('\n');
}

/**
 * 组装完整的提示词。
 */
function buildPrompt({ question, brief, dataset, retrieval, webResults = null, peers = null, webNote = '' }) {
  const context = buildContext(brief, dataset);
  const trust = buildTrustBoundary(brief, dataset, { webResults, competitiveNote: webNote });
  const evidenceText = formatEvidence(retrieval.evidence);
  const companyText = retrieval.companies.length
    ? retrieval.companies.map(companySlice).join('\n')
    : '（问题未点名公司，也没有检索到相关公司）';

  // **同赛道公司（竞争类问题）**：雷达覆盖内的竞品线索
  const peerText = peers && peers.length
    ? peers.map((p) => {
      const lines = [`  - ${p.c.name}（${p.c.code}）｜${p.c.industry || '未分类'}｜入选理由：${(p.reasons || []).join('、')}`];
      // **必须带上要闻内容**，否则模型只能报公司名，讲不出"动向"
      if (p.mentionedTitles && p.mentionedTitles.length) {
        lines.push(`    与焦点公司同篇出现：${p.mentionedTitles.slice(0, 2).join('；')}`);
      }
      if (p.topNews && p.topNews.length) {
        lines.push(`    近期要闻：${p.topNews.join('；')}`);
      }
      return lines.join('\n');
    }).join('\n')
    : '';

  // **网络检索结果（W 编号）**：与 E 编号严格分开
  const webText = webResults && webResults.length
    ? webResults.map((w, i) => {
      const id = `W${i + 1}`;
      const site = (() => { try { return new URL(w.url).hostname; } catch { return '未知来源'; } })();
      return `[${id}] ${w.publishedAt ? w.publishedAt + '｜' : ''}${site}\n    标题：${w.title}\n`
        + `    摘要：${String(w.snippet || '').slice(0, 400)}\n`
        + (w.viaQuery ? `    检索式：${w.viaQuery}\n` : '')
        + `    链接：${w.url}`;
    }).join('\n')
    : '';

  const hasWeb = !!(webResults && webResults.length);
  const webRules = hasWeb
    ? `
- **【网络来源用 W 编号】**：来自【网络检索结果】的事实，句末标 **[W1]、[W2]**，并且**必须带来源站点和日期**，例如"据东方财富 2026-05-20 报道[W1]"。
- **W 编号和 E 编号是两套**：本地材料用 E，网页用 W，不能混着写、更不能把 W 说成本地数据。
- 网络结果**未经本地核验**，只能照原意转述，不要替它下结论。`
    : '';

  const system = `你是"科创板每日情报雷达"的分析助手，服务对象是公司 CFO。
你的唯一依据是下面提供的「项目背景 / 本期可信度边界 / 当日上下文 / 相关材料${hasWeb ? ' / 网络检索结果' : ''}」。

**【引用规则 —— 最重要，先看这条】**
- 答案里每一条**来自材料的事实**，句末都要标出来源编号，格式 **[E1]、[E2]**；一条结论来自多条材料就写 **[E2][E5]**。
- **没编号的依据不要写进答案** —— 没有编号，读者就没法回查；这条比"写得好看"重要。
- 来自「当日上下文」的数字（涨跌幅榜、市值榜、分位榜、覆盖度等）标注为（当日上下文）。
- 来自「相关公司切片」的数字要带公司名与口径，例如"寒武纪（688256.SH）｜2026-10-27 收盘 PE(TTM) 121.87"。${webRules}

其他规则：
1. 只依据给定材料回答；材料没覆盖的，明确说"本期数据没有覆盖"并指出缺什么，不要用常识或印象补齐。
2. 引用任何数字，必须带上它的日期与口径。
3. 不做投资建议、不预测股价、不给买卖判断。
4. 结论先行：先给直接回答，再列依据；每条依据后面标 [E编号]。
5. **长度预算：正文控制在 400 字以内，最多列 6 条依据。** 这不是客套话——模型的输出有长度上限，写太长会被砍掉后半段，交付半截答案比写短更糟。
6. 回答用中文，简洁、结论化，不写套话。`;

  const user = `${PROJECT_BACKGROUND}

${trust}

【当日上下文（数据日 ${brief.date || '未知'}）】
${context}

【相关材料 —— 每条都有编号，答案里必须回引这些编号】
⚠ 强制要求：凡是来自下面材料的结论，句末必须标出来源编号，格式 [E1]、[E2]，一条结论来自多条就写 [E2][E5]。
⚠ 没有编号的依据不要写进答案（读者要靠编号回查，没编号＝无法验证的事实）。
⚠ 只引用下面出现的编号，不要自己编 [E7] 这种不存在的编号。
${evidenceText}
${peerText ? `
【同赛道公司（雷达覆盖内，作为竞对线索）】
⚠ 这些是**科创板覆盖范围内**的同赛道公司，只能当"同赛道动向"讲，**不能直接说成竞对**（竞对关系要有依据）。
${peerText}` : ''}
${hasWeb ? `
【网络检索结果 —— 编号 W1 起，与上面的 E 编号严格分开】
⚠ 强制要求：凡是来自下面网页的结论，句末必须标 [W编号]，并写明来源站点和日期。
⚠ 这些是**外部网页，未经本地核验**；与本地数据冲突时以本地为准并说明冲突。
⚠ 检索有召回限制 —— 搜不到不代表不存在，只能说"本次检索未覆盖"，不能说"没有"。
${webText}` : ''}
【相关公司基本面与估值切片】
${companyText}

【CFO 的问题】
${String(question || '').trim()}

请据此回答。要求：结论先行；每条来自材料的结论句末标 [E编号]${hasWeb ? '；来自网页的标 [W编号]并注明来源与日期' : ''}；材料没覆盖的明确说"本期数据没有覆盖"并指出缺什么。`;

  return {
    system, user, evidence: retrieval.evidence, companies: retrieval.companies,
    context, trust, webResults: webResults || [], peers: peers || [],
  };
}

/** 证据的瘦载荷（给前端回显用：保留可核对的关键字段，不带大段正文） */
function slimEvidence(evidence) {
  return (evidence || []).map((e, i) => ({
    id: `E${i + 1}`,
    kind: e.kind,
    kindLabel: e.kind === 'news' ? '要闻' : e.kind === 'research' ? '券商研报' : '公告',
    date: e.date || null,
    code: e.code,
    name: e.name,
    industry: e.industry || '',
    title: e.title || '',
    url: e.url || '',
    broker: e.broker || null,
    rating: e.rating || null,
    target_price: e.target_price != null ? e.target_price : null,
    hasView: !!e.hasView,
    snippet: String(e.content || e.view_thesis || '').slice(0, 200),
    matched: (e.matched || []).slice(0, 5),
  }));
}

/** 网络检索结果的瘦载荷（W 编号，来源与日期必须能回查） */
function slimWeb(results) {
  return (results || []).map((w, i) => ({
    id: `W${i + 1}`,
    title: w.title || '',
    url: w.url || '',
    site: (() => { try { return new URL(w.url).hostname; } catch { return ''; } })(),
    publishedAt: w.publishedAt || null,
    viaQuery: w.viaQuery || '',
    snippet: String(w.snippet || '').slice(0, 300),
  }));
}

/**
 * **检索规划提示词**（2026-10-28 新增）。
 *
 * DeepSeek 网关支持 function 形式的 web_search，会返回标准 tool_calls
 * （实测还会自动把一个复杂问题拆成多个查询）—— 但**网关自己不执行搜索**，
 * 所以流程是：**模型决定搜什么 → 我们去搜 → 把结果喂回模型写答案**。
 *
 * 这一步就是把"决定搜什么"交给模型：它知道问题里的公司、行业、语境，
 * 能把"亚虹医药的竞对"翻译成"东方略 VGX-3100 宫颈癌前病变"这种真正能搜到东西的检索式。
 */
function buildSearchPlan(question, brief) {
  const date = (brief && brief.date) || '未知';
  const industry = (brief && brief.industryStats && brief.industryStats[0] && brief.industryStats[0].name) || '';
  return {
    system: `你是情报检索规划员，服务对象是公司 CFO 的"竞对/行业动向"类问题。
你的唯一任务是**决定该搜什么**，不回答问题。

规则：
1. 只用 web_search 工具提出检索式，**最多 3 个**，每个都要是具体的检索式而不是问题本身。
2. 检索式用中文，包含：关键公司名或产品代号、赛道/适应症、关键事件类型（临床/授权/获批/上市/财报）。
3. **提问方公司可以出现在检索式里，但必须搭配"竞品/竞对/同类/竞争格局"这类词** ——
   只写公司名的话，搜回来的全是它自己的消息，等于没搜（这是最容易犯的错）。
4. 优先搜**竞对公司名 + 事件**、**同靶点药物 + 竞品**、**赛道 + 竞争格局**。
5. 如果问题里的竞对很可能不在科创板（未上市、港股、美股），也要搜 —— 竞对常常不在。
6. 拿不准就把最可能的两种拆成两个检索式，分别搜。

反面例子（不要这样）：只写被问的那家公司的名字和它的业务（搜回来全是它自己）。
正面例子：把公司名和"竞品/竞对/竞争格局"绑在一起，或直接搜赛道 + 事件类型。`,
    user: `【当前数据日】${date}${industry ? `｜科创板最大行业：${industry}` : ''}
【CFO 的问题】
${String(question || '').trim()}

请提出检索式。`,
  };
}

module.exports = {
  buildPrompt, buildContext, buildTrustBoundary, retrieve, buildSearchPlan,
  extractTerms, matchCompanies, companySlice, formatEvidence, slimEvidence, slimWeb,
  detectWebNeed, expandCompetitive, COMPETITIVE_WORDS, PROJECT_BACKGROUND,
};
