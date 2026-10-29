'use strict';
/**
 * 科创板事件与主题层。
 *
 * 背景：iFinD 的分行业热点（带热度算法）因额度不可用时，只剩泛市场快讯。
 * 但"今天科创板发生了什么"完全可以从已采到的公告/要闻里精确算出来。
 *
 * 两条线：
 *   A. 事件类型（词典 + 正则）—— 减持/回购/预增/补助/重组… 精确、可解释、可对比昨日
 *   B. 卖方关注行业 —— 研报按行业聚合 + 评级分布 + 目标价空间，直接回答"钱在看哪"
 *
 * **教训**：中文没有空格，用 n-gram 切主题词会切出"议公""年第"这种碎片，
 * 事件识别必须用词典+正则，不能靠字面切分。
 */

/** 科创板常见事件类型。顺序即展示优先级。 */
const EVENT_TYPES = [
  { key: '业绩预增', re: /业绩预增|预增|业绩大增|净利润.{0,6}(增长|同比.{0,4}(增|升))|扭亏为盈|大幅上升/i, cat: '业绩' },
  { key: '业绩预亏', re: /业绩预减|预亏|业绩预降|净利润.{0,6}(下滑|下降)|由盈转亏|亏损扩大/i, cat: '业绩' },
  { key: '股东减持', re: /减持|拟减持|减持计划|询价转让/i, cat: '股东行为' },
  { key: '股份回购', re: /回购|提议回购|回购方案/i, cat: '股东行为' },
  { key: '控制权变更', re: /控制权|协议转让|实际控制人变更|表决权委托/i, cat: '资本运作' },
  { key: '重大资产重组', re: /重大资产重组|发行股份购买资产|吸收合并|并购|收购/i, cat: '资本运作' },
  { key: '再融资', re: /定向增发|非公开发行|可转债|募集资金|配股|募资/i, cat: '资本运作' },
  { key: '对外投资', re: /对外投资|设立.{0,6}公司|设立子公司|增资|投资设立|合资/i, cat: '资本运作' },
  { key: '股权激励', re: /股权激励|员工持股|限制性股票/i, cat: '治理' },
  { key: '政府补助', re: /政府补助|财政补贴|奖励资金|专项资金/i, cat: '经营' },
  { key: '重大合同中标', re: /中标|重大合同|框架协议|签署.{0,10}(合同|协议|订单)|订单/i, cat: '经营' },
  { key: '研发里程碑', re: /临床试验|获批|批准上市|注册证|上市许可|新药|适应症|专利|授权|认证证书|GMP|定點/i, cat: '经营' },
  { key: 'IPO受理', re: /受理|招股意向书|注册生效|过会|上市委会议/i, cat: '资本市场' },
  { key: '监管问询处罚', re: /问询函|监管问询|警示函|处罚|立案|违规|监管措施|纪律处分/i, cat: '风险' },
  { key: '诉讼仲裁', re: /诉讼|仲裁|判决|和解|起诉/i, cat: '风险' },
  { key: '风险警示', re: /退市风险|实施.{0,4}风险警示|ST|摘牌|终止上市/i, cat: '风险' },
  { key: '股份解禁', re: /限售股上市流通|解禁/i, cat: '股东行为' },
  { key: '董监高变动', re: /辞职|辞去|聘任|选举|换届|独立董事/i, cat: '治理' },
  { key: '分红派息', re: /分红|派息|利润分配|转增/i, cat: '股东行为' },
  { key: '大宗交易', re: /大宗交易/i, cat: '交易' },
  { key: '异常波动', re: /异常波动|风险提示|停牌核查/i, cat: '交易' },
  { key: '投资者调研', re: /调研|接待.{0,8}投资者|路演|业绩说明会/i, cat: '关注度' },
  { key: '业绩说明会', re: /业绩说明会/i, cat: '关注度' },
];

/**
 * 把 YYYY-MM-DD 往前推 n 天，返回 YYYY-MM-DD。
 */
function shiftDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 统计事件类型分布。
 *
 * **必须带时间窗口**：要闻池是"按公司名检索"的结果，天然横跨数月
 * （实测 5,607 条里 33% 超过 90 天）。不做窗口的话，"热点事件"呈现的
 * 是四个多月的累计数，读者会误以为是当期热度。
 *
 * @param {Array} companies
 * @param {Object} opts
 *   - since: 起始日期（含），YYYY-MM-DD；不传＝全量存量
 *   - to:    结束日期（含），用于标注窗口
 *   - label: 窗口标签，写进每条记录，简报直接引用，避免口径歧义
 *   - compact: true 时不返回完整 companyList（只给 12 家样本），用于多窗口并存
 * @returns {Array} [{key, cat, companies, mentions, companyList, samples, window}]
 */
function extractEvents(companies, opts = {}) {
  const { since = null, to = null, label = '全量存量（无时间窗口）', compact = false } = opts;
  const buckets = new Map();
  let dated = 0, undated = 0;

  for (const c of companies) {
    const items = []
      .concat((c.news || []).map((n) => ({ title: n.title || '', date: n.date, url: n.url, type: '要闻' })))
      .concat((c.notices || []).map((n) => ({ title: n.title || '', date: n.date, url: n.url, type: '公告' })));

    const hit = new Set();   // 同一家公司同一事件类型只计一次"覆盖"，但计多次"提及"
    for (const it of items) {
      // 窗口过滤：没有日期的条目无法归入任何时间窗，只计入全量存量
      if (since) {
        const d = (it.date || '').slice(0, 10);
        if (!d) { undated++; continue; }
        if (d < since) continue;
        if (to && d > to) continue;
        dated++;
      }
      for (const et of EVENT_TYPES) {
        if (!et.re.test(it.title)) continue;
        if (!buckets.has(et.key)) {
          buckets.set(et.key, { ...et, map: new Map() });
        }
        const b = buckets.get(et.key);
        if (!b.map.has(c.code)) b.map.set(c.code, { count: 0, samples: [] });
        const rec = b.map.get(c.code);
        rec.count++;
        if (rec.samples.length < 3) rec.samples.push({ title: it.title, date: it.date, url: it.url, type: it.type });
        hit.add(et.key);
      }
    }
  }

  const win = { label, since: since || '', to: to || '' };
  return [...buckets.values()]
    .map((b) => {
      const list = [...b.map.entries()].map(([code, rec]) => ({
        code,
        name: (companies.find((x) => x.code === code) || {}).name || code,
        count: rec.count,
        samples: rec.samples,
      })).sort((x, y) => y.count - x.count);
      return {
        key: b.key, cat: b.cat,
        companies: list.length,
        mentions: list.reduce((a, x) => a + x.count, 0),
        companyList: compact ? [] : list,
        companySamples: list.slice(0, 12).map((x) => x.name),
        samples: list[0] ? list[0].samples : [],
        window: win,
      };
    })
    .filter((x) => x.companies >= 2)
    .sort((a, b) => b.companies - a.companies || b.mentions - a.mentions);
}

/**
 * 多时间窗的事件分布：当日 / 近7天 / 近30天 / 全量存量。
 * 「热点」看 d1、d7；全量存量只作背景，不能当当期热度用。
 */
function extractEventsByWindow(companies, baseDate) {
  // **锚点必须用"数据里最新的日期"，不能用采集日**（2026-10-21 模拟"第二天"时发现）：
  // 07:30 采集时当天新闻还没出来，最新的一条要闻往往还是昨天的 ——
  // 若把 d1 锚在采集日，"当日热点事件"会恒为 0，简报第一节直接空掉
  // （实测模拟 10-22 采集：d1 只有 8 类、newsFreshness.d1 = 0 条）。
  // 所以先取全库最新日期作为 asOf，所有窗口相对它计算，并把这个事实明示出来。
  // 取**数据里的最大日期**（可能早于采集日）——不是"在采集日基础上取更大"，
  // 否则 07:30 采到昨天新闻时 asOf 仍会停在采集日，d1 依旧为 0。
  let maxDate = '';
  for (const c of companies) {
    for (const n of (c.news || []).concat(c.notices || [])) {
      const d = (n.date || '').slice(0, 10);
      if (d && d > maxDate) maxDate = d;
    }
  }
  const asOf = maxDate || baseDate;
  const mk = (days, label) => extractEvents(companies, {
    since: days > 0 ? shiftDays(asOf, days - 1) : null,
    to: asOf,
    label: days > 0 ? `近${days}天（${shiftDays(asOf, days - 1)} ~ ${asOf}）` : label,
    compact: true,
  });
  return {
    asOfDate: asOf,
    collectionDate: baseDate,
    anchorNote: asOf === baseDate
      ? `数据最新日期与采集日一致（${asOf}）`
      : `**数据最新日期 ${asOf} 早于采集日 ${baseDate}**（07:30 采集时当天新闻尚未发布），窗口一律相对 ${asOf} 计算`,
    d1: mk(1, '全量存量'),
    d7: mk(7, '全量存量'),
    d30: mk(30, '全量存量'),
    all: mk(0, '全量存量（无时间窗口）'),
  };
}

/**
 * 要闻时效结构：让读者知道"手上这池新闻有多少是今天的"。
 */
function newsFreshness(companies, baseDate) {
  const all = companies.flatMap((c) => (c.news || []).map((n) => ({ date: (n.date || '').slice(0, 10) })));
  const bucket = (from) => all.filter((n) => n.date && n.date >= from).length;
  const d1 = bucket(baseDate);
  const d7 = bucket(shiftDays(baseDate, 6));
  const d30 = bucket(shiftDays(baseDate, 29));
  const dated = all.filter((n) => n.date).length;
  return {
    total: all.length,
    undated: all.length - dated,
    d1, d7, d30,
    olderThan30: dated - d30,
    oldest: all.filter((n) => n.date).map((n) => n.date).sort()[0] || '',
    d1Ratio: all.length ? +((d1 / all.length) * 100).toFixed(1) : 0,
    d7Ratio: all.length ? +((d7 / all.length) * 100).toFixed(1) : 0,
    d30Ratio: all.length ? +((d30 / all.length) * 100).toFixed(1) : 0,
  };
}

/**
 * 卖方关注行业：把研报按公司行业聚合，回答"卖方在看哪些行业、看法如何"。
 *
 * **分母必须透明**：科创板样本里评级几乎全是买入/增持（46 个行业看多占比全是 100%），
 * 看多占比这一列因此零区分度；目标价更极端——全市场 229 家被覆盖公司只有 7 家有目标价，
 * 很多行业的"目标空间均值"其实只来自 1 家公司。因此这里同时给出：
 *   rating_dist / non_bull  → 判断"看多占比"是否有信息量
 *   upside_n / upside_reliable → 判断"目标空间均值"能不能代表这个行业
 */
function extractSellSideByIndustry(companies, sellSide) {
  const byInd = new Map();
  for (const r of sellSide || []) {
    const ind = r.industry || '未分类';
    if (!byInd.has(ind)) byInd.set(ind, []);
    byInd.get(ind).push(r);
  }
  const out = [];
  for (const [industry, list] of byInd) {
    const ratings = list.map((r) => r.rating).filter(Boolean);
    const bull = ratings.filter((x) => /买入|增持|推荐/.test(x)).length;
    const nonBull = ratings.length - bull;
    const ups = list.map((r) => r.upside).filter((x) => x != null);
    const ratingDist = {};
    for (const r of list) {
      const k = r.rating || '无评级';
      ratingDist[k] = (ratingDist[k] || 0) + 1;
    }
    out.push({
      industry,
      companies: list.length,
      reports: list.reduce((a, r) => a + (r.report_count || 1), 0),
      rating_dist: ratingDist,
      rating_total: ratings.length,
      non_bull: nonBull,
      bull_ratio: ratings.length ? +((bull / ratings.length) * 100).toFixed(1) : null,
      // 全样本无中性/看空评级时，看多占比恒为 100%，这一列没有区分度
      bull_ratio_informative: nonBull > 0,
      avg_upside: ups.length ? +(ups.reduce((a, b) => a + b, 0) / ups.length).toFixed(1) : null,
      upside_n: ups.length,
      // 目标价样本 <3 家时，均值不能代表整个行业
      upside_reliable: ups.length >= 3,
      with_target: list.filter((r) => r.target_price != null).length,
      latest: list.map((r) => r.date).sort().reverse()[0] || '',
      names: list.slice(0, 8).map((r) => r.name),
    });
  }
  return out.sort((a, b) => b.companies - a.companies || b.reports - a.reports);
}

module.exports = { extractEvents, extractEventsByWindow, extractSellSideByIndustry, newsFreshness, shiftDays, EVENT_TYPES };
