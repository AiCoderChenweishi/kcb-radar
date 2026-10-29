'use strict';
/**
 * 解析层：把 iFinD 返回的 Markdown 表格 / JSON 字符串转成结构化字段。
 *
 * 三个必须处理的现实问题：
 *  1) 同一个 Markdown 里可能有多个表格，且表格之间没有标题分隔（indicators 接口）。
 *  2) 板块标题顺序不固定（summary 接口），必须按 "# 标题"切段，不能按位置。
 *  3) 语义检索会串台——查 A 公司的研报会返回 B 公司的内容，必须做归属校验。
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- Markdown 表格

/** 把一段 markdown 拆成若干表格：[{ headers: [], rows: [[...]] }] */
function parseTables(md) {
  const tables = [];
  let cur = null;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    // 空行 / 标题 / 说明文字都作为表格分隔
    if (!line || line.startsWith('#') || !line.startsWith('|')) {
      if (cur) { tables.push(cur); cur = null; }
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    // 分隔行 |---|---|  只跳过，不能在这里结束表格：
    // 否则首行数据会被当成表头，第二行开始的数据行就丢了。
    if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!cur) {
      cur = { headers: cells, rows: [] };
    } else {
      cur.rows.push(cells);
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

/** 把表格转成以首列为 key 的对象数组 */
function tableToObjects(table) {
  return table.rows.map((row) => {
    const o = {};
    table.headers.forEach((h, i) => { o[h] = row[i] === undefined ? '' : row[i]; });
    return o;
  });
}

/**
 * 解析 get_stock_summary 的输出。
 * 返回 { '688176.SH': { pe_ttm: ..., pb: ..., total_mv: ..., roe: ... } }
 * 字段名用 snake_case，值统一转数字（空/非数保留 null）。
 */
const SUMMARY_FIELD_MAP = {
  '市盈率(PE,TTM)': 'pe_ttm',
  '市净率(PB,最新)': 'pb',
  '市销率(PS,TTM)': 'ps_ttm',
  '市现率(PCF,经营现金流TTM)': 'pcf_ttm',
  'PEG值（LYR）': 'peg_lyr',
  '企业倍数(EV1/EBITDA)': 'ev_ebitda',
  '总市值': 'total_mv',
  '流通市值': 'float_mv',
  '资产总计': 'total_assets',
  '营业总收入': 'revenue',
  '净资产收益率ROE(加权,公布值)': 'roe_weighted',
  '净资产收益率ROE(扣除／加权)': 'roe_deducted',
  '净资产收益率ROE(TTM)': 'roe_ttm',
  '总资产报酬率ROA': 'roa',
  '销售毛利率': 'gross_margin',
  '销售净利率': 'net_margin',
  '基本每股收益(同比增长率)': 'eps_yoy',
  '营业总收入(同比增长率)': 'revenue_yoy',
  '净利润(同比增长率)': 'net_profit_yoy',
  '毛利(同比增长率)': 'gross_profit_yoy',
  '经营活动产生的现金流量净额(同比增长率)': 'ocf_yoy',
  '研发费用': 'rd_expense',
  '归属于母公司所有者的净利润': 'net_profit_attr',
  '存货周转天数': 'inventory_days',
  '应收账款周转天数': 'ar_days',
  '总资产周转率': 'asset_turnover',
};

function toNum(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 识别表格里的「代码列」和「名称列」。
 *
 * iFinD 的表头与数据列顺序不一致：表头写「证券代码|证券简称|市盈率…」，
 * 实际数据行却是「容百科技|688005.SH|-1545.5184|…」——代码和名称是反的。
 * 硬按表头下标取会把公司名当代码，导致整张表挂到错误的 key 上、数据全部匹配不上。
 * 因此以数据行实际形态为准做校正。
 */
const CODE_RE = /^\d{6}\.(SH|SZ)$/;

function identifyCols(headers, sampleRow) {
  let codeIdx = headers.indexOf('证券代码');
  let nameIdx = headers.indexOf('证券简称');
  if (codeIdx < 0 || nameIdx < 0) return { codeIdx, nameIdx };

  if (sampleRow) {
    const atCode = sampleRow[codeIdx];
    if (!atCode || !CODE_RE.test(atCode.trim())) {
      const alt = sampleRow.findIndex((x) => x && CODE_RE.test(x.trim()));
      if (alt >= 0) {
        nameIdx = codeIdx;
        codeIdx = alt;
      }
    }
  }
  return { codeIdx, nameIdx };
}

/** 从 summary markdown 解析出按证券代码索引的结构化记录 */
function parseSummary(md) {
  const out = {};
  const sections = String(md || '').split(/^#\s+/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const tables = parseTables(section);
    for (const t of tables) {
      if (!t.headers.includes('证券代码')) continue;
      const { codeIdx, nameIdx } = identifyCols(t.headers, t.rows[0]);
      for (const row of t.rows) {
        const code = (row[codeIdx] || '').trim();
        if (!code || !CODE_RE.test(code)) continue;
        if (!out[code]) out[code] = { code, name: (row[nameIdx] || '').trim() };
        t.headers.forEach((h, i) => {
          const key = SUMMARY_FIELD_MAP[h];
          if (!key) return;
          const val = row[i];
          if (val === undefined) return;
          const num = toNum(val);
          if (num !== null) out[code][key] = num;
        });
      }
    }
  }
  return out;
}

/**
 * 解析 get_security_indicators 的 answer（可能含多张表）。
 * 指标名 → 字段名，未识别的原样保留为指标名（便于前端兜底展示）。
 */
const INDICATOR_FIELD_MAP = {
  '市盈率(PE,TTM)分位数': 'pe_percentile',
  '市盈率(PE,TTM)': 'pe_ttm',
  '市净率(PB,最新)': 'pb',
  '总市值（单位：元）': 'total_mv_raw',
  '总市值': 'total_mv',
  '营业总收入': 'revenue',
  '归属母公司股东的净利润': 'net_profit_attr',
};

function parseIndicators(answer) {
  const out = {};
  for (const t of parseTables(answer)) {
    if (!t.headers.includes('证券代码')) continue;
    const { codeIdx, nameIdx } = identifyCols(t.headers, t.rows[0]);
    for (const row of t.rows) {
      const code = (row[codeIdx] || '').trim();
      if (!code || !CODE_RE.test(code)) continue;
      if (!out[code]) out[code] = { code, name: (row[nameIdx] || '').trim() };
      t.headers.forEach((h, i) => {
        const raw = row[i];
        if (raw === undefined) return;
        const key = INDICATOR_FIELD_MAP[h] || h.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '_');
        const num = toNum(raw);
        if (num !== null) out[code][key] = num;
        else if (raw && raw.trim()) out[code][key] = raw.trim();
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 研报抽取

const BROKER_NAMES = [
  '中信证券', '中金公司', '国泰君安', '海通证券', '招商证券', '广发证券', '华泰证券',
  '中信建投', '申万宏源', '兴业证券', '东方证券', '光大证券', '长江证券', '国金证券',
  '东吴证券', '浙商证券', '西南证券', '天风证券', '方正证券', '国盛证券', '民生证券',
  '东北证券', '华安证券', '国信证券', '东兴证券', '银河证券', '西南证券', '德邦证券',
  '华西证券', '开源证券', '首创证券', '国元证券', '长城证券', '太平洋证券', '红塔证券',
  '西南证券', '财通证券', '浙富控股', '中银证券', '国海证券', '宝城证券', '华宝证券',
];

/** 评级关键词 → 统一标签 */
const RATING_PATTERNS = [
  [/买入|强烈推荐|强推|best\s*buy/i, '买入'],
  [/增持|outperform|推荐/i, '增持'],
  [/谨慎推荐|审慎增持/i, '谨慎增持'],
  [/中性|持有|neutral|hold/i, '持有'],
  [/减持|underweight/i, '减持'],
  [/卖出|sell/i, '卖出'],
  [/首次覆盖/i, '首次覆盖'],
  [/维持[“"]?(买入|增持|中性|持有|卖出)/i, '维持'],
];

function detectBroker(text) {
  for (const b of BROKER_NAMES) if (text.includes(b)) return b;
  // 兜底：常见「XX证券」模式
  const m = /([一-龥]{2,6}证券)/.exec(text);
  return m ? m[1] : null;
}

function detectRating(text) {
  for (const [re, label] of RATING_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/**
 * 目标价：必须紧邻"目标价"字样。
 * 早期版本有宽松兜底 `/(\d+)\s*元/`，结果把"预测2026年每股收益 0.92 元"
 * 当成目标价 —— 每股收益和目标价长得一样，但含义完全不同，误差会被直接带进简报。
 */
function detectTargetPrice(text) {
  // 目标价区间 12.30-15.60 元 → 取中值
  const range = /目标价[^0-9]{0,6}(\d+(?:\.\d+)?)\s*[-~—至]\s*(\d+(?:\.\d+)?)/.exec(text);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return (a + b) / 2;
  }
  const m = /目标价[^0-9]{0,6}(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v > 10000) return null;
  return v;
}

/** 一致预期：参与预测的机构家数 */
function detectInstitutionCount(text) {
  const m = /共有\s*(\d+)\s*家机构/.exec(text);
  return m ? Number(m[1]) : null;
}

/** 评级分布：3家机构"买入"，1家机构"增持" */
function detectRatingDistribution(text) {
  const re = /(\d+)\s*家机构[“"']?(买入|增持|中性|持有|减持|卖出)[”"']?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ rating: m[2], count: Number(m[1]) });
  return out.length ? out : null;
}

/** 盈利预测：营收 / 归母净利润 的多年预测 */
function detectForecast(text) {
  const res = {};
  const rev = /(?:营业)?收入(?:分别)?为?\s*([\d\.\/]+)\s*亿元/.exec(text) ||
             /营业收入[^，。]{0,20}?([\d\.]+(?:\/[\d\.]+){1,3})\s*亿元/.exec(text);
  if (rev) {
    res.revenue_forecast = rev[1].split('/').map(Number);
  }
  const np = /(?:归母)?净利润(?:分别)?为?\s*([\-\d\.\/]+)\s*亿元/.exec(text) ||
             /净利润[^，。]{0,20}?([\-\d\.]+(?:\/[\-\d\.]+){1,3})\s*亿元/.exec(text);
  if (np) {
    res.profit_forecast = np[1].split('/').map(Number);
  }
  return Object.keys(res).length ? res : null;
}

/**
 * 判断一条资讯是否属于研报/机构观点类
 */
function isResearchItem(title, content) {
  const t = `${title} ${content}`;
  return /研报|评级|目标价|盈利预测|首次覆盖|维持[“"]|券商|研究部|出具.{0,6}评级|推荐/.test(t);
}

/**
 * 区分两类机构观点：
 *  - consensus      同花顺汇总的「盈利预测-业绩预测详表-研报评级」＝卖方一致预期
 *  - broker_report  某家券商的具体报告（如"西南证券-亚虹医药-…-261008"）
 * 两者混在一起会让人误以为每条都是独立券商观点，必须分开标注。
 */
function classifyResearch(title, content, broker) {
  const t = `${title} ${content}`;
  if (broker) return 'broker_report';
  if (/盈利预测|业绩预测详表|研报评级/.test(t)) return 'consensus';
  return 'mention';
}

/** 从一条资讯抽取研报结构化字段 */
function extractResearch(item) {
  const title = item['资讯标题'] || '';
  const content = item['资讯内容'] || '';
  const text = `${title} ${content}`;
  const broker = detectBroker(text);
  const rating = detectRating(text);
  const targetPrice = detectTargetPrice(text);
  const forecast = detectForecast(text);
  const kind = classifyResearch(title, content, broker);
  return {
    broker,
    rating,
    target_price: targetPrice,
    forecast,
    kind,
    institution_count: detectInstitutionCount(text),
    rating_distribution: detectRatingDistribution(text),
    is_research: isResearchItem(title, content),
  };
}

// ---------------------------------------------------------------- 串台过滤

/**
 * 归属校验：这条资讯讲的是不是目标公司。
 *
 * 实测踩坑：`\b英诺特\b` 永远匹配不上——中文不是 `\w` 字符，
 * "。英诺特：" 前后都不是词字符，不存在词边界。中文公司名只能用 includes 判定。
 *
 * 判定分级：
 *   matched   命中目标公司（名称或代码）→ 保留
 *   crosstalk 全文没提目标公司，却提了另一家科创板公司 → 串台，丢弃
 *   weak      既没提目标、也没提别家（泛行业内容）→ 保留但标记，靠搜索相关性兜底
 */
function buildCrossTalkDetector(universe) {
  const names = (universe || []).map((u) => u.name).filter((n) => n && n.length >= 2);
  const nameSet = new Set(names);

  function classify(target, text) {
    if (!text) return { status: 'empty', other: null };

    const bare = target.code.replace(/\.(SH|SZ)$/, '');
    const mentioned = text.includes(target.name) ||
      text.includes(target.code) ||
      new RegExp(`(?<![0-9])${bare}(?![0-9])`).test(text);

    if (mentioned) return { status: 'matched', other: null };

    // 目标没提 → 看看是不是讲的是别人
    for (const n of names) {
      if (n === target.name) continue;
      if (text.includes(n)) return { status: 'crosstalk', other: n };
    }
    // 其他科创板公司的股票代码
    const codeRe = /(?<![0-9])(\d{6})\.(?:SH|SZ)(?![0-9])/g;
    let cm;
    while ((cm = codeRe.exec(text)) !== null) {
      if (cm[1] !== bare) return { status: 'crosstalk', other: cm[1] };
    }
    return { status: 'weak', other: null };
  }

  return classify;
}

/**
 * iFinD 会把 F10 导航页的标题当成资讯片段返回，例如
 *   "天准科技(688003) 资讯列表-新闻与股价联动 公告列表 热点新闻列表 研报列表"
 *   "博汇科技(688004) 公司大事-近期重要事件 高管持股变动 股东持股变动 担保明细…"
 * 这些不是新闻，是数据商自己的页面菜单，直接混进要闻流会污染看板。
 */
const NOISE_TITLE_RE = new RegExp([
  '资讯列表', '新闻列表', '公告列表', '研报列表', '热点新闻列表', '股价联动',
  '股东研究', '十大流通股东', '十大股东', '十大债券持有人', '控股层级关系',
  '公司大事', '高管持股变动', '股东持股变动', '担保明细', '违规处理',
  '机构调研', '投资者互动', '公司资料', '经营分析', '发行相关',
  '公司大事记', '财务分析', '股本结构', '利润表', '资产负债表', '现金流量表',
].join('|'));

function isNoiseTitle(title) {
  const t = String(title || '');
  if (!t) return true;
  // 标题里出现多个 F10 菜单项，或命中菜单关键词且没有实质内容
  return NOISE_TITLE_RE.test(t);
}

/**
 * 市场级快讯的噪声过滤。
 *
 * 东方财富按公司名检索时，会把「该公司所在 ETF / 指数 / 板块」的行情快讯也带出来，
 * 例如 "20cm速递 | 科创100ETF国泰（588120）标的指数涨超2%，资金持续净流入"。
 * 这类内容讲的是板块不是公司，混进"公司要闻"会污染每家公司的画像。
 * 市场层面的内容由热点层单独承载，所以这里直接剔除。
 */
const MARKET_NOISE_RE = new RegExp([
  'ETF', '指数涨', '指数跌', '涨超', '跌超', '涨逾', '跌逾',
  '板块', '概念股', '概念板块',
  '资金持续', '资金净流', '净流入', '净流出', '主力资金', '北向资金', '南向资金',
  '龙虎榜', '融资融券', '融资客', '融资余额', '两融', '融券余额', '获.*资金大比例持有',
  '涨幅居前', '跌幅居前', '领涨', '领跌', '居前',
  '速递\\s*\\|', '盘前速递', '复盘速览', '午间速览',
  '沪指', '深证成指', '创业板指', '科创50指', '北证50', '恒生', '三大指数',
  '市值超', '总市值超', '成交额超', '换手率超', '平均涨幅', '平均跌幅',
].join('|'));

function isMarketLevelNoise(title) {
  const t = String(title || '');
  if (!t) return true;
  return MARKET_NOISE_RE.test(t);
}

/**
 * 资讯是否提到目标公司（保留兼容旧调用）
 */
function mentionsTarget(target, text) {
  if (!text) return false;
  const bare = target.code.replace(/\.(SH|SZ)$/, '');
  return text.includes(target.name) ||
    text.includes(target.code) ||
    new RegExp(`(?<![0-9])${bare}(?![0-9])`).test(text);
}

module.exports = {
  parseTables, tableToObjects, parseSummary, parseIndicators, toNum,
  extractResearch, isResearchItem, classifyResearch, detectBroker, detectRating,
  detectTargetPrice, detectForecast, detectInstitutionCount, detectRatingDistribution,
  buildCrossTalkDetector, mentionsTarget, isNoiseTitle, isMarketLevelNoise,
  RATING_PATTERNS, SUMMARY_FIELD_MAP, NOISE_TITLE_RE, MARKET_NOISE_RE,
};
