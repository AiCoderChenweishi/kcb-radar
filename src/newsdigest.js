'use strict';
/**
 * 要闻总结 / 大事板块总结 / 医药板块专章。
 *
 * ── 为什么要有这一层 ────────────────────────────────────
 * 原始要闻池有 5648 条，老板不可能看完。真正要回答的是三个问题：
 *   1. **今天科创板发生了什么**（要闻总结：要点 + 事件分布）
 *   2. **哪些板块今天有事**（大事板块：只有 3~5 个板块够得上"事"）
 *   3. **医药板块今天怎么样**（专章：119 家的温度 + 3~5 个重点主题 + 竞情提示）
 *
 * ── 三条硬规矩 ─────────────────────────────────────────
 * 1. **只做事实聚合，不编故事**。所有数字来自数据集字段，每个结论都能回查到条目与链接。
 * 2. **方向判断必须带依据**。判断与事实分开写，依据写成可核对的数字（依据项不足则降置信度或不给方向）。
 * 3. **口径写进字段**。窗口、阈值、命中规则都随结果一起返回，简报里直接引用，不靠提示词保证。
 *
 * ── 关键技术点：栏目稿拆解 ─────────────────────────────
 * 「医药早参」「科创板晚报」这类栏目稿把**多家公司**的动态塞进一条，
 * 且归属公司是随机的。实测 10-22 近 7 天至少 9 条：
 *   挂在"迈威生物"名下 → 实为**艾伯维与泽璟制药 ZG006 全球授权 + 1000 万美元里程碑款**
 *   挂在"微芯生物"名下 → 实为**和誉-B FGFR2/3 抑制剂获 EMA 孤儿药资格**
 *   挂在"荣昌生物"名下 → 实为**贝达药业 KRAS PROTAC 临床申请获受理**
 * 不拆解就会系统性漏掉最重要的 BD / 临床进展。
 * 拆解后按主体分三类：① 科创板内（但与归属不同 → 串台）；② 科创板内（与归属一致）；
 * ③ **非科创板主体 → 只作竞情提示**，不进建档体系。
 */
const { EVENT_TYPES, shiftDays } = require('./events');

/** 医药口径：申万二级 6 个医药子类 */
const PHARMA_INDUSTRIES = ['化学制药', '生物制品', '医疗器械', '医疗服务', '医疗美容', '动物保健Ⅱ'];

/** 事件方向权重（正=利好事实，负=利空事实，0=中性）。只用于方向判断，不进任何"评分榜"。 */
const EVENT_DIRECTION = {
  '业绩预增': 2, '研发里程碑': 2, '重大合同中标': 1, '股份回购': 1, '政府补助': 0.5,
  '股权激励': 0.5, '分红派息': 0.5, 'IPO受理': 0.5, '重大资产重组': 1, '控制权变更': 0,
  '对外投资': 0, '业绩说明会': 0, '投资者调研': 0, '董监高变动': 0, '大宗交易': 0,
  '再融资': -0.5, '股份解禁': -0.5, '股东减持': -1, '异常波动': -0.5,
  '业绩预亏': -2, '诉讼仲裁': -1.5, '监管问询处罚': -1.5, '风险警示': -2,
};

/** 医药主题：医药板块内部的"最重要的几件事" */
const PHARMA_TOPICS = [
  { key: '临床与注册', weight: 3, re: /临床试验|临床数据|临床申请|适应症|获批|注册证|上市许可|新药上市|说明书|Ⅰ期|Ⅱ期|Ⅲ期|I期|II期|III期|终点|入组|受理/i },
  { key: '对外授权与BD', weight: 3, re: /授权|License|license|里程碑付款|首付款|对外许可|独家许可|权益交易|\bBD\b|收购|合作开发|海外权益/i },
  { key: '业绩与经营', weight: 2, re: /业绩|净利润|营业收入|三季报|中报|预增|预亏|扭亏|毛利率|订单|产能|放量|销售额|商业化/i },
  { key: '资本动作', weight: 1, re: /回购|减持|增持|定增|再融资|股权激励|解禁|大宗交易|分红|可转债/i },
  { key: '风险与监管', weight: 2, re: /问询|处罚|诉讼|仲裁|风险警示|退市|\bST\b|终止|撤回|不予批准|召回|集采|带量采购/i },
];

/** 栏目稿识别：这类稿一条里有多家公司的动态 */
const COLUMN_RE = /早参|晚报|早报|午间|快讯|盘点|汇总|早知道|速览|资讯|简报|每日播报/;
/** 栏目稿切段：标题用「；｜」切，正文用「NO.1」编号切 */
const COLUMN_SPLIT_TITLE = /[；;｜|]/;
const COLUMN_SPLIT_BODY = /\s*NO\.\d+\s*/i;
/** 段落主体：段首词（"和誉-B FGFR2/3…" → 和誉-B） */
const SUBJECT_LEAD = /^([\u4e00-\u9fa5A-Za-z*＋\-]{2,12})(?=[\s:：，,、。｜|]|$)/;
/** 段落主体：动词前的公司名（"贝达药业公告称" → 贝达药业） */
const SUBJECT_VERB = /([\u4e00-\u9fa5A-Za-z*＋\-]{2,12})(?=公告称|公告|披露|发布|拟|将|获得|获批|签署|宣布|启动|完成|收到|受理|推进|中标|上涨|下跌|停牌|复牌|撤回|签订)/g;
/** 医药语境的关键词（用于判断"非科创板主体"是否属于医药竞情） */
const PHARMA_CONTEXT = /药|医药|生物|单抗|抗体|ADC|双抗|CXO|CRO|CDMO|器械|疫苗|诊断|细胞|基因|临床|适应症|获批|注册证|新药|创新药|license|授权|许可|里程碑|EMA|FDA|NMPA|CDE|医保|集采|GLP|PD-?1|HER2|BCMA|CDK|KRAS|FGFR|CLDN|USP1/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 事件识别：复用 events.js 的词典与顺序（顺序即优先级） */
function classifyEvent(text) {
  const t = String(text || '');
  for (const t2 of EVENT_TYPES) {
    if (t2.re.test(t)) return { key: t2.key, cat: t2.cat };
  }
  return { key: null, cat: null };
}

/**
 * 栏目稿拆解：把一条栏目稿切成"主体 + 事件描述"若干段。
 *
 * 主体识别只有两条硬规则（宁可漏也不错报）：
 *  1. **科创板公司名按最长匹配精确命中** —— 段里出现哪个科创板公司名，主体就是谁。
 *  2. **非科创板主体必须"名字 + 公司动作动词"**，且名字后面不能紧跟药品剂型/品类词
 *     （否则"司美格鲁肽注射液在华获批"会把药名当公司）。
 *     另认港股后缀（-B/-U/-W/-S），如"和誉-B"。
 * @returns {Array<{subject:string, text:string, source:'title'|'body', inBoard:boolean}>}
 */
function splitColumn(item, boardNames = []) {
  const segs = [];
  for (const part of String(item.title || '').split(COLUMN_SPLIT_TITLE)) {
    const t = clean(part);
    if (t) segs.push({ text: t, source: 'title' });
  }
  for (const part of String(item.content || '').split(COLUMN_SPLIT_BODY)) {
    const t = clean(part);
    if (t.length > 4) segs.push({ text: t, source: 'body' });
  }
  const out = [];
  const seen = new Set();
  for (const seg of segs) {
    const subject = extractSubject(seg.text, boardNames);
    if (!subject) continue;
    const key = subject.name + '|' + seg.text.slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject: subject.name, inBoard: subject.inBoard, text: seg.text, source: seg.source });
  }
  return out;
}

/** 药名/剂型/品类词：出现在候选主体里就说明认错了（药名不是公司） */
const NOT_NAME_WORDS = /注射液|胶囊|颗粒|口服液|分散片|缓释|混悬|贴膏|凝胶|试剂|疫苗|单抗|抗体|药物|新药|抑制剂|口服|片|肽|剂|散|膏|粉/;
/** 常见非公司名词：动词前的两个字可能是这些，不是公司名 */
const NON_COMPANY_WORDS = /^(项目|产品|业务|战略|合作|技术|服务|方案|管线|研发|临床|市场|行业|领域|本次|相关|有关|上述|该司|母公司|子公司|股份|公告|披露|发布|设立|完成|推进|启动|中标|收购|签署|获得|收到|受理|拟|将|关于|对|与|和|及|或|等|其|此|the|and)$/;

/** 段内主体识别（见 splitColumn 的两条规则） */
function extractSubject(text, boardNames = []) {
  // 规则 0（优先）：**动词前的公司名**。
  // 必须排在"文中出现公司名"之前 —— 栏目稿标题里常有多家公司，
  // "科创板晚报|仕佳光子Q3净利增长226% 微芯生物签订NW001合作开发协议"
  // 若按"先出现"取主体会错判成仕佳光子（实际主体是微芯生物）。
  // 名字必须是 2~6 个汉字；英文/数字词（KRAS、PROTAC、ADC 等）允许夹在名字与动词之间，
  // 否则会被当成名字本身（"贝达药业KRAS PROTAC获受理" → 曾误识别成 "PROTAC获"）。
  const m = text.match(/([\u4e00-\u9fa5]{2,6})(?:[A-Za-z0-9\-\/＋\. ]{0,14})?(?=公告称|公告|披露|发布|签署|获得|收到|受理|启动|完成|推进|中标|回购|减持|增持|收购|签订|上市|获批|获)/);
  if (m) {
    const cand = m[1];
    const after = text.slice(m.index + cand.length, m.index + cand.length + 10);
    // 名字里含药名/剂型词 → 认错了（"司美格鲁肽"、"肽注射液在华"）
    if (!NOT_NAME_WORDS.test(cand) && !NOT_NAME_WORDS.test(after) && !NON_COMPANY_WORDS.test(cand)) {
      return { name: cand, inBoard: boardNames.includes(cand) };
    }
  }
  // 规则 1：科创板公司名（长度降序，取最长命中）
  for (const nm of boardNames) {
    if (nm && text.includes(nm)) return { name: nm, inBoard: true };
  }
  // 规则 2：港股后缀
  const hk = text.match(/([\u4e00-\u9fa5]{2,6}[-－][BUWS])/);
  if (hk) return { name: hk[1], inBoard: false };
  return null;
}

/**
 * 标题是否点名了本公司 —— 决定这条能不能归因到这家公司。
 *
 * 为什么要这一步：要闻池里混着大量**综合稿**（"盘前必读｜…"、"10月21日晚间上市公司利好消息一览(附名单)"）
 * 和**他公司事项**（"市值1300亿元半导体设备龙头长川科技…"挂在华润微名下）。
 * 它们正文里提到了公司，所以被检索归到该公司，但**标题与公司无关**，
 * 直接当"这家公司发生了什么"写进要点/板块，会是硬伤（2026-10-22 实测踩到）。
 * 归因规则：标题里出现公司名（去掉 ST/*ST 前缀）才算归因可信；否则标"综合稿"。
 */
function titleMentions(title, name) {
  const t = String(title || '');
  if (!name) return false;
  if (t.includes(name)) return true;
  const stripped = String(name).replace(/^\*?ST/, '');
  return stripped.length >= 2 && t.includes(stripped);
}

/**
 * 把一个板块/主题的事实集合折成"方向判断"，依据写成可核对的句子。
 *
 * 口径：**按去重公司数计**，不按提及次数。
 * 否则同一家公司发 3 条回购公告就被算成 3 次方向，大公司/热门公司会主导整个板块的结论
 * （2026-10-22 实测：半导体曾出现"方向合计 +148"、板块均跌 1.6% 却判"偏正面"的荒谬结果）。
 * 零权重事件（投资者调研、董监高变动、大宗交易、业绩说明会…）不参与方向计算。
 */
function judgeDirection(facts, temp, ratingMix) {
  // 按事件类型去重公司数
  const byEvent = new Map();
  for (const f of facts) {
    const k = f.event || '未归类';
    if (!byEvent.has(k)) byEvent.set(k, new Set());
    byEvent.get(k).add(f.code);
  }
  const parts = [];
  let dirSum = 0;
  let companyCount = 0;
  const mix = [];
  for (const [k, codes] of byEvent) {
    const w = EVENT_DIRECTION[k] || 0;
    if (w === 0) continue;                       // 零权重事件不进方向
    dirSum += w * codes.size;
    companyCount += codes.size;
    mix.push({ key: k, companies: codes.size, weight: w });
  }
  mix.sort((a, b) => Math.abs(b.weight * b.companies) - Math.abs(a.weight * a.companies));
  if (mix.length) {
    parts.push(`有方向事件 ${companyCount} 家次（${mix.slice(0, 4).map((m) => `${m.key} ${m.companies} 家`).join('、')}）方向合计 ${dirSum > 0 ? '+' : ''}${dirSum}`);
  } else {
    parts.push('窗口内无可归类方向的事件');
  }
  const rel = (temp && temp.avg != null && temp.benchmark != null) ? +(temp.avg - temp.benchmark).toFixed(2) : null;
  if (temp && temp.avg != null) {
    parts.push(`板块均涨跌 ${temp.avg > 0 ? '+' : ''}${temp.avg}%${rel != null ? `（大盘 ${temp.benchmark}%，相对 ${rel > 0 ? '+' : ''}${rel}%）` : ''}`);
  }
  if (ratingMix && ratingMix.total) {
    parts.push(`卖方覆盖 ${ratingMix.total} 家，看多 ${ratingMix.bull} / 中性 ${ratingMix.neutral} / 看空 ${ratingMix.bear}`);
  }

  let label = '信号分散（无明确方向）';
  if (dirSum >= 3) label = rel != null && rel < -0.5 ? '基本面偏正面、但股价弱于大盘（背离）' : '偏正面';
  else if (dirSum <= -3) label = rel != null && rel > 0.5 ? '基本面承压、但股价强于大盘（背离）' : '偏负面';
  else if (rel != null && Math.abs(rel) >= 1.5) label = rel > 0 ? '股价强于大盘（事件面无明显方向）' : '股价弱于大盘（事件面无明显方向）';

  // 置信度：依据的"独立公司数"越多、方向越极端、相对涨跌越明显 → 越高
  let score = 0;
  score += companyCount >= 20 ? 2 : companyCount >= 8 ? 1 : 0;
  score += Math.abs(dirSum) >= 10 ? 2 : Math.abs(dirSum) >= 3 ? 1 : 0;
  score += rel != null && Math.abs(rel) >= 0.5 ? 1 : 0;
  score += ratingMix && ratingMix.total >= 10 ? 1 : 0;
  const confidence = score >= 5 ? '高' : score >= 3 ? '中' : '低';

  return { label, basis: parts.join('；'), confidence, dirSum, relative: rel, companyCount };
}

/** 板块温度（涨跌家数、均值、异动） */
function temperatureOf(cos) {
  const chg = cos.map((c) => c.quote && c.quote.change_pct).filter((x) => x != null);
  const up = cos.filter((c) => c.quote && c.quote.change_pct > 0).length;
  const down = cos.filter((c) => c.quote && c.quote.change_pct < 0).length;
  const avg = chg.length ? +(chg.reduce((a, b) => a + b, 0) / chg.length).toFixed(2) : null;
  const movers = cos.filter((c) => c.quote && c.quote.change_pct != null && Math.abs(c.quote.change_pct) >= 5)
    .sort((a, b) => Math.abs(b.quote.change_pct) - Math.abs(a.quote.change_pct))
    .map((c) => ({ code: c.code, name: c.name, chg: c.quote.change_pct, industry: c.industry || '' }));
  return { up, down, flat: cos.length - up - down, avg, movers, priced: chg.length };
}

/** 卖方覆盖统计（评级分布） */
function ratingMixOf(cos) {
  const covered = cos.filter((c) => c.sell_side && c.sell_side.covered);
  const withView = covered.filter((c) => c.sell_side.view_thesis);
  let bull = 0, bear = 0, neutral = 0, none = 0;
  for (const c of covered) {
    const r = c.sell_side.rating || '';
    if (/买入|增持|推荐|强烈/.test(r)) bull++;
    else if (/减持|卖出|谨慎/.test(r)) bear++;
    else if (r) neutral++;
    else none++;
  }
  return { total: covered.length, withView: withView.length, bull, bear, neutral, none };
}

/** 流程性公告：只有程序性内容，没有事实增量，不进要点 */
const PROCEDURAL_RE = /业绩说明会|投资者调研|法律意见书|核查意见|独立财务顾问|保荐|问询函的回复|召开.{0,8}(股东会|董事会)的通知|会议决议公告/;

/**
 * 挑要点：归因可信优先 → 排除流程性公告 → 同公司最多 N 条。
 */
function pickKeyPoints(items, max, maxPerCompany = 2) {
  const cnt = new Map();
  const out = [];
  const seen = new Set();
  const pass = (it, requireAttributed) => {
    if (requireAttributed && !it.attributed) return false;
    if (seen.has(it.title)) return false;
    if (PROCEDURAL_RE.test(it.title)) return false;
    const n = cnt.get(it.code) || 0;
    if (n >= maxPerCompany) return false;
    seen.add(it.title);
    cnt.set(it.code, n + 1);
    out.push(it);
    return true;
  };
  for (const it of items) { if (out.length >= max) break; pass(it, true); }
  for (const it of items) { if (out.length >= max) break; if (it.attributed) continue; pass(it, false); }
  return out.slice(0, max);
}

/**
 * 主入口。
 * @param {Array} companies 已 score 的公司数组（insight.js 的 scored）
 * @param {Object} opts
 *   - market: {index: {kc50_change_pct, ...}, breadth: {...}}
 *   - baseDate: 数据里的最新日期（事件锚点）
 *   - topPoints / topSectors: 每日输出条数（默认 8 / 3~5）
 */
function buildNewsDigest(companies, opts = {}) {
  const all = companies || [];
  const baseDate = opts.baseDate || (all[0] && all[0].quote && all[0].quote.list_date) || '';
  // 注意 events.js 的 shiftDays(date, n) 约定是"往回推 n 天"（n 为正数），
  // 传负数会推到未来，窗口会变空（2026-10-22 实测踩到）。
  const d7from = baseDate ? shiftDays(baseDate, 6) : '';
  const d3from = baseDate ? shiftDays(baseDate, 2) : '';
  const mkt = opts.market || {};
  const idx = mkt.index || {};
  const benchmark = idx.kc50_change_pct != null ? idx.kc50_change_pct
    : (idx.kc_comp_change_pct != null ? idx.kc_comp_change_pct : null);

  // 名称 → 公司（用于栏目稿主体匹配）
  const byName = new Map();
  for (const c of all) if (c.name) byName.set(c.name, c);

  // ---------- 收集条目 ----------
  const items = [];
  for (const c of all) {
    for (const n of c.news || []) {
      items.push({
        kind: 'news', date: n.date, code: c.code, name: c.name, industry: c.industry || '',
        title: n.title, url: n.url, content: n.content || '', isResearch: !!n.is_research,
        match: n.match || 'matched', broker: n.broker || '', rating: n.rating || '',
        targetPrice: n.target_price ?? null, view: n.view || null, viewThesis: n.view_thesis || null,
      });
    }
    for (const n of c.notices || []) {
      items.push({
        kind: 'notice', date: n.date, code: c.code, name: c.name, industry: c.industry || '',
        title: n.title, url: n.url, content: n.content || '', isResearch: false, match: 'matched',
      });
    }
  }
  for (const it of items) {
    const ev = classifyEvent(`${it.title} ${it.content}`);
    it.event = ev.key; it.eventCat = ev.cat;
    it.weight = it.event ? (EVENT_DIRECTION[it.event] || 0) : 0;
    it.isColumn = COLUMN_RE.test(String(it.title || ''));
    // 归因可信性：标题是否点名了本公司（决定能不能算作"这家公司发生了什么"）
    it.attributed = titleMentions(it.title, it.name);
  }

  const inWin = (it, from) => it.date && it.date >= from && it.date <= baseDate;
  const d1Items = items.filter((it) => it.date === baseDate);
  const d3Items = items.filter((it) => inWin(it, d3from));
  const d7Items = items.filter((it) => inWin(it, d7from));

  // ---------- ① 每日要闻总结 ----------
  // 今日要点：**只收归因可信的条目**（标题点名了本公司），
  // 不足时再补综合稿并标注；排序 = 归因可信 → 要闻优先（带摘要，信息密度高）
  // → 事件方向权重 → 有卖方观点 → 当日；同一家公司最多 2 条，避免刷屏。
  const scorePoint = (it) => {
    const days = it.date ? Math.max(0, Math.round((Date.parse(baseDate) - Date.parse(it.date)) / 86400000)) : 9;
    return (it.attributed ? 10 : 0) + (it.kind === 'news' ? 3 : 0)
      + Math.max(0, 4 - days)                       // 近因加权：越近越靠前
      + (it.weight || 0) * 2
      + (it.viewThesis ? 2 : 0) + (it.isResearch ? 1 : 0)
      + (it.event ? 1 : 0) + (it.date === baseDate ? 3 : 0);
  };
  const attributedPool = [...d1Items, ...d7Items]
    .filter((it) => it.attributed)
    .sort((a, b) => scorePoint(b) - scorePoint(a));
  const perCompany = new Map();
  const maxPerCompany = opts.maxPerCompany || 2;
  const pool = [];
  const seenTitle = new Set();
  const take = (it, requireAttributed) => {
    if (requireAttributed && !it.attributed) return false;
    if (seenTitle.has(it.title)) return false;
    const n = perCompany.get(it.code) || 0;
    if (n >= maxPerCompany) return false;
    seenTitle.add(it.title);
    perCompany.set(it.code, n + 1);
    pool.push(it);
    return true;
  };
  for (const it of attributedPool) {
    if (pool.length >= (opts.topPoints || 8)) break;
    take(it, true);
  }
  // 归因可信的条目不够时，才补综合稿（明确标注，不冒充是该公司的事项）
  for (const it of [...d1Items, ...d7Items].sort((a, b) => scorePoint(b) - scorePoint(a))) {
    if (pool.length >= (opts.topPoints || 8)) break;
    if (it.attributed || seenTitle.has(it.title)) continue;
    take(it, false);
  }
  const topPoints = pool.slice(0, opts.topPoints || 8).map((it) => ({
    date: it.date, code: it.code, name: it.name, industry: it.industry,
    title: it.title, url: it.url, summary: clip(it.content, 120),
    event: it.event, eventCat: it.eventCat, kind: it.kind,
    isColumn: it.isColumn, attributed: it.attributed,
    broker: it.broker || null, rating: it.rating || null,
    hasView: !!it.viewThesis,
  }));

  const eventMix = (arr) => {
    const m = new Map();
    for (const it of arr) {
      if (!it.event || !it.attributed) continue;   // 只统计归因可信的条目
      const k = it.event;
      if (!m.has(k)) m.set(k, { key: k, cat: it.eventCat, count: 0, companies: new Set() });
      const e = m.get(k);
      e.count++;
      e.companies.add(it.code);
    }
    return [...m.values()].map((e) => ({ key: e.key, cat: e.cat, mentions: e.count, companies: e.companies.size }))
      .sort((a, b) => b.companies - a.companies || b.mentions - a.mentions);
  };

  const overview = {
    baseDate, d7from,
    counts: {
      newsTotal: items.filter((x) => x.kind === 'news').length,
      noticeTotal: items.filter((x) => x.kind === 'notice').length,
      d1: d1Items.length, d3: d3Items.length, d7: d7Items.length,
      d1Companies: new Set(d1Items.map((x) => x.code)).size,
      d7Companies: new Set(d7Items.map((x) => x.code)).size,
      columnItems: d7Items.filter((x) => x.isColumn).length,
    },
    topPoints,
    eventMix: { d1: eventMix(d1Items), d7: eventMix(d7Items) },
  };

  // ---------- 板块聚合 ----------
  const byInd = new Map();
  for (const c of all) {
    const ind = c.industry || '未分类';
    if (!byInd.has(ind)) byInd.set(ind, []);
    byInd.get(ind).push(c);
  }
  const sectorRows = [];
  for (const [ind, cos] of byInd) {
    const indItems = d7Items.filter((it) => it.industry === ind);
    const evs = eventMix(indItems);
    const evScore = evs.reduce((s, e) => s + (EVENT_DIRECTION[e.key] || 0) * e.companies, 0);
    const temp = temperatureOf(cos);
    const research = cos.filter((c) => (c.research || []).length).length;
    const notices = indItems.filter((it) => it.kind === 'notice').length;
    const news = indItems.filter((it) => it.kind === 'news').length;
    const score = evScore * 2 + notices * 0.3 + news * 0.3 + temp.movers.length * 3 + research * 0.5;
    sectorRows.push({ ind, cos, indItems, evs, temp, research, notices, news, score, evScore });
  }

  // ---------- ② 大事板块（医药单列，这里给其他板块 3~5 个） ----------
  const pharmaSet = new Set(PHARMA_INDUSTRIES);
  const others = sectorRows.filter((r) => !pharmaSet.has(r.ind) && r.indItems.length > 0)
    .sort((a, b) => b.score - a.score);
  const topN = opts.topSectors || 5;
  const minN = opts.minSectors || 3;
  const sectors = others.slice(0, topN).map((r) => {
    // 板块要点：归因可信优先、排除流程性公告、同公司最多 2 条
    const kp = [...r.indItems].sort((a, b) => (b.attributed - a.attributed)
      || ((b.weight || 0) - (a.weight || 0)) || (b.date > a.date ? 1 : -1));
    const keyPoints = pickKeyPoints(kp, 6).map((it) => ({
      date: it.date, code: it.code, name: it.name, title: it.title, url: it.url,
      summary: clip(it.content, 100), event: it.event, attributed: it.attributed,
    }));
    const facts = r.indItems.filter((it) => it.event && it.attributed);
    const direction = judgeDirection(facts, { avg: r.temp.avg, benchmark }, ratingMixOf(r.cos));
    return {
      industry: r.ind,
      companies: r.cos.length,
      score: +r.score.toFixed(1),
      basis: {
        news: r.news, notices: r.notices, research: r.research,
        events: r.evs.slice(0, 5).map((e) => ({ key: e.key, companies: e.companies, mentions: e.mentions })),
        movers: r.temp.movers.slice(0, 4),
        avgChg: r.temp.avg, benchmark,
      },
      keyPoints,
      direction,
    };
  });
  const sectorNote = sectors.length < minN
    ? `窗口内只有 ${sectors.length} 个非医药板块达到入选门槛（门槛：窗口内有条目且重要度排序进前 ${topN}）`
    : `按"事件方向合计×2 + 公告数×0.3 + 要闻数×0.3 + 异动家数×3 + 研报覆盖数×0.5"排序取前 ${sectors.length} 个`;

  // ---------- ③ 医药板块专章 ----------
  const pharmaCos = all.filter((c) => pharmaSet.has(c.industry));
  const pharmaItems = d7Items.filter((it) => pharmaSet.has(it.industry));
  const pharmaTemp = temperatureOf(pharmaCos);
  const pharmaRating = ratingMixOf(pharmaCos);

  // 主题归并
  const topics = [];
  for (const t of PHARMA_TOPICS) {
    const hit = pharmaItems.filter((it) => t.re.test(`${it.title} ${it.content}`));
    if (!hit.length) continue;
    const cos = [...new Set(hit.map((it) => it.code))];
    const facts = hit.filter((it) => it.event && it.attributed);
    topics.push({
      key: t.key,
      weight: t.weight,
      items: hit.length,
      attributedItems: hit.filter((it) => it.attributed).length,
      companies: cos.map((code) => {
        const c = byName.get(code);
        return { code, name: c ? c.name : code, industry: c ? c.industry : '' };
      }),
      keyPoints: pickKeyPoints(
        [...hit].sort((a, b) => (b.attributed - a.attributed) || (b.date > a.date ? 1 : -1)), 6)
        .map((it) => ({
          date: it.date, code: it.code, name: it.name, title: it.title, url: it.url,
          summary: clip(it.content, 120), event: it.event, attributed: it.attributed,
        })),
      direction: judgeDirection(facts, { avg: pharmaTemp.avg, benchmark }, pharmaRating),
    });
  }
  topics.sort((a, b) => b.weight * b.items - a.weight * a.items);
  const topTopics = topics.slice(0, opts.topPharmaTopics || 5);

  // 栏目稿拆解：主体 ≠ 归属（科创板内串台）/ 主体非科创板（竞情提示）
  const misattributed = [];
  const external = [];
  const seenExt = new Set();
  const boardNamesSorted = [...byName.keys()].sort((a, b) => b.length - a.length);
  for (const it of pharmaItems) {
    if (!it.isColumn) continue;
    const segs = splitColumn(it, boardNamesSorted);
    for (const seg of segs) {
      if (seg.inBoard) {
        const inBoard = byName.get(seg.subject);
        if (!inBoard || inBoard.code === it.code) continue;   // 主体就是归属公司，正常
        misattributed.push({
          attributed: it.name, attributedCode: it.code,
          actual: inBoard.name, actualCode: inBoard.code, actualIndustry: inBoard.industry || '',
          date: it.date, title: it.title, url: it.url,
          detail: clip(seg.text, 90),
        });
      } else {
        // 非科创板主体：只在**医药语境**下才提示，避免把栏目稿里所有公司都拉进来
        if (!PHARMA_CONTEXT.test(seg.text)) continue;
        const key = seg.subject + '|' + seg.date;
        if (seenExt.has(key)) continue;
        seenExt.add(key);
        const hits = PHARMA_TOPICS.filter((t) => t.re.test(seg.text)).map((t) => t.key);
        external.push({
          name: seg.subject, date: it.date,
          what: clip(seg.text, 110), sourceTitle: it.title, url: it.url,
          via: it.name,
          reason: hits.length ? hits.slice(0, 2) : ['医药栏目稿内非科创板主体'],
        });
      }
    }
  }

  const pharma = {
    scope: {
      industries: PHARMA_INDUSTRIES,
      companies: pharmaCos.length,
      universe: all.length,
      sharePct: all.length ? +(pharmaCos.length / all.length * 100).toFixed(1) : null,
      breakdown: PHARMA_INDUSTRIES.map((ind) => ({ industry: ind, companies: pharmaCos.filter((c) => c.industry === ind).length })),
      window: `近 7 天（${d7from} ~ ${baseDate}）`,
      items: pharmaItems.length,
    },
    temperature: { ...pharmaTemp, benchmark, relative: benchmark != null && pharmaTemp.avg != null ? +(pharmaTemp.avg - benchmark).toFixed(2) : null },
    sellSide: {
      ...pharmaRating,
      topViews: pharmaCos.filter((c) => c.sell_side && c.sell_side.view_thesis)
        .sort((a, b) => (b.sell_side.date || '').localeCompare(a.sell_side.date || ''))
        .slice(0, 8)
        .map((c) => ({
          code: c.code, name: c.name, industry: c.industry || '',
          broker: c.sell_side.broker, rating: c.sell_side.rating, date: c.sell_side.date,
          thesis: clip(c.sell_side.view_thesis, 160),
        })),
    },
    topics: topTopics,
    misattributed,
    external,
    direction: judgeDirection(
      pharmaItems.filter((it) => it.event && it.attributed),
      { avg: pharmaTemp.avg, benchmark }, pharmaRating),
  };

  return {
    generatedAt: new Date().toISOString(),
    baseDate, d7from, d3from,
    benchmark,
    rules: {
      topPoints: opts.topPoints || 8,
      topSectors: topN, minSectors: minN,
      topPharmaTopics: opts.topPharmaTopics || 5,
      sectorScore: '事件方向合计×2 + 公告数×0.3 + 要闻数×0.3 + 异动家数×3 + 研报覆盖数×0.5',
      pharmaIndustries: PHARMA_INDUSTRIES,
      pharmaWindow: '近 7 天（以数据最新日期为锚点）',
      columnSplit: '标题按「；｜」切段，正文按「NO.N」切段，取段首词或动词前公司名为主体',
      directionWeights: EVENT_DIRECTION,
    },
    overview,
    sectors,
    sectorNote,
    pharma,
  };
}

module.exports = { buildNewsDigest, classifyEvent, splitColumn, judgeDirection, PHARMA_INDUSTRIES, PHARMA_TOPICS, EVENT_DIRECTION, COLUMN_RE };
