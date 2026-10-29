'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const LIST_FILE = path.join(DATA_DIR, 'star_market_list.csv');
const TMP_DIR = path.join(ROOT, '.tmp');

for (const d of [DATA_DIR, DAILY_DIR, RAW_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

module.exports = {
  ROOT,
  DATA_DIR,
  DAILY_DIR,
  RAW_DIR,
  LIST_FILE,
  TMP_DIR,
  PORT: Number(process.env.PORT || 7788),

  // 看板监听地址。
  //
  // **默认仍是 127.0.0.1（仅本机可访问）** —— 这是当前的安全默认值，不要擅自改。
  // 要让局域网内其他电脑打开（例如领导直接访问），用环境变量显式开启：
  //   set RADAR_HOST=0.0.0.0 && node src\server.js
  // 该开关只改监听地址，**读接口不做任何鉴权**——开启即意味着同网段任何人都能看全部数据，
  // 因此必须由用户明确拍板后再启用。
  // 写接口（POST /api/collect）另有保护：非回环来源必须带对 `RADAR_WRITE_TOKEN`
  // （请求头 X-Radar-Token），否则 403。本机回环始终放行。
  HOST: process.env.RADAR_HOST || '127.0.0.1',
  WRITE_TOKEN: process.env.RADAR_WRITE_TOKEN || '',

  /** 数据集进程级缓存的份数上限（见下方 DATASET_CACHE_MAX 注释） */
  DATASET_CACHE_MAX: Number(process.env.DATASET_CACHE_MAX || 20),

  // 采集并发数。实测基准（每档 24 次调用、重试 1 次）：
  //   并发 4 → 75%  6 → 88%  8 → 96%  12 → 83%
  // 失败是随机瞬时失败，与并发不成正比，所以取成功率最高且不过载的 8 路。
  // 覆盖率靠「重试 3 次 + 失败修复轮」保证，不靠调低并发。
  CONCURRENCY: Number(process.env.COLLECT_CONCURRENCY || 8),

  // 单阶段的看门狗时限。超时后放弃该阶段，保留已采集数据继续往下走。
  // 没有这道闸，一个挂死的接口调用就能让整轮采集停住不动。
  PHASE_DEADLINE_MS: Number(process.env.COLLECT_PHASE_DEADLINE_MS || 25 * 60 * 1000),

  // 研报/新闻回溯窗口。研报发布频率低（周度甚至更低），只查当天会漏掉大部分观点
  NEWS_LOOKBACK_DAYS: Number(process.env.NEWS_LOOKBACK_DAYS || 7),

  // 单次 get_stock_summary 最多 5 只
  SUMMARY_BATCH: 5,
  // 2026-10-23 移除：INDICATOR_BATCH（get_security_indicators 交叉校验已整段下线）

  // 每家公司的新闻/研报条数上限
  NEWS_SIZE: 12,
  NOTICE_SIZE: 8,

  // ---- 数据集缓存容量（2026-10-27）----
  // **必须 ≥ src/range.js 的 MAX_LOAD_DAYS（16）**：
  // 区间聚合最多会加载 16 份数据集（研报并集），缓存比它小就会互相淘汰 ——
  // 预热装进去的数据集被挤掉，首屏又变回冷启动（实测 9 秒）。
  // 内存代价：单份解析后约 15MB，16 份约 250MB，可接受。
  DATASET_CACHE_MAX: Number(process.env.DATASET_CACHE_MAX || 20),

  // ---- 历史回补（2026-10-27 新增）----
  // 回补时每家要多取一些要闻：检索返回的是"此刻可见的池子"，
  // 只取 12 条往往盖不到目标日期（活跃公司几天就能刷掉 12 条）。
  NEWS_SIZE_BACKFILL: Number(process.env.NEWS_SIZE_BACKFILL || 30),
  // 回补要逐家取 2 个接口（push2his 日K + 逐日估值序列），并发不宜高
  BACKFILL_CONCURRENCY: Number(process.env.BACKFILL_CONCURRENCY || 5),

  // 科创板板块层面热点按行业覆盖。
  // 注意：search_trending_news 的 industry_name 只接受 30 个固定枚举值，
  // 传"半导体""生物医药"这类自定义词会被接口拒绝（-32602）。
  TRENDING_INDUSTRIES: [
    '电子', '医药生物', '计算机', '通信', '机械设备',
    '电力设备', '汽车', '有色金属', '基础化工', '国防军工',
    '公用事业', '非银金融', '传媒', '社会服务',
  ],

  // search_trending_news 的 time_scope 枚举：6小时 / 24小时 / 近一周
  TRENDING_TIME_SCOPE: '近一周',

  // ---------------------------------------------------------------- iFinD 额度管控
  //
  // **背景（2026-10-23 改造）**：iFinD 的免费试用版是 **2,000 次「永久总量」**，
  // 官方原文「免费试用版提供永久总计 2,000 次调用额度，额度不会按月刷新」——
  // 用完永不恢复。2026-10-21 的全量设计（619 家 × 多接口 ≈ 1,500 次/天）
  // 在一天之内就把试用额度烧光，此后再也调不通（2026-10-23 实测仍返回「用量已耗尽」）。
  //
  // **改造后的日耗**：271 → 139（砍掉 8 次市场宽度 + 124 次 PE 分位交叉校验，
  // 这 132 次的返回值本来就被免费源覆盖 / 口径已被证伪，见 docs/PROJECT.md 4.28）。
  //
  // IFIND_MODE:
  //   'lean' = 精简口径（默认，本次改造后的行为）
  //   'full' = 回到改造前的全量口径（仅供对照与回滚，会再次烧穿试用额度）
  // IFIND_TRENDING_LIMIT: 分行业热点查询的行业数（1 = 只查「科创板整体」，最省）
  // IFIND_DAILY_CALL_BUDGET: 0 = **不设硬闸**（用户 2026-10-23 明确选择
  //   「不设硬闸，只靠代码路径本身限制调用量」）；>0 时超预算即停止并披露。
  IFIND_MODE: process.env.IFIND_MODE || 'lean',
  IFIND_TRENDING_LIMIT: Number(process.env.IFIND_TRENDING_LIMIT || 15),
  IFIND_DAILY_CALL_BUDGET: Number(process.env.IFIND_DAILY_CALL_BUDGET || 0),
  /** 交叉校验（get_security_indicators）已整段移除：其「PE 分位数」实测不可信 */
  IFIND_CROSSCHECK: false,

  // 每日运行时间（本地时间）
  SCHEDULE: { hour: 7, minute: 30 },
};
