'use strict';
/**
 * 行业分类（申万二级）——**唯一权威源**。
 *
 * 为什么单独做这一层：
 * 原来的行业标签有三个来源，谁最后写谁赢：
 *   1. F10 公司概况 EM2016 末级（东财自有分类，76 类）
 *   2. 东财 push2 行情的 f100（申万二级，46 类）
 *   3. F10 财务摘要的 BOARD_NAME（申万二级，46 类）
 * 而 **push2 会被 IP 级封禁** → 一旦行情走备用源，标签就从申万二级漂成东财自有分类。
 * 实测：2026-10-21 数据集 76 个行业值，2026-10-22 数据集 46 个，同一批公司标签不同
 * （688001 其他专用机械 → 通用设备；688012 集成电路 → 半导体）。
 * 后果：行业筛选跨天漏公司、行业分布口径漂移、跨日差分把分类变化误读成"公司换行业"。
 *
 * 现在口径钉死在这里：
 * - 源：datacenter.eastmoney.com 的 RPT_LICO_FN_CPD.BOARD_NAME（申万二级）
 *   —— 与 push2 **不同域名体系**，不受 push2 封禁影响；实测值与行情 f100 完全一致。
 * - 缓存：data/industries.json。行业是慢变属性，命中即不再请求（每天 0 次）。
 * - 兜底：缓存没有的用 F10 概况的 EM2016 末级，并标记为 fallback。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./config');

const CACHE_FILE = path.join(DATA_DIR, 'industries.json');

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch { return {}; }
}

function writeCache(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 0), 'utf8');
  } catch { /* ignore */ }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        Referer: 'https://data.eastmoney.com/',
      },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('JSON 解析失败')); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/** 单家公司的申万二级行业名（BOARD_NAME） */
async function fetchIndustry(code) {
  const bare = String(code || '').split('.')[0];
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_LICO_FN_CPD&columns=ALL'
    + `&filter=(SECUCODE%3D%22${bare}.SH%22)&pageNumber=1&pageSize=1`
    + '&sortColumns=REPORTDATE&sortTypes=-1&source=HSF10&client=PC';
  const j = await getJson(url);
  const d = (((j || {}).result || {}).data || [])[0] || {};
  return d.BOARD_NAME || null;
}

/**
 * 批量取行业分类（带缓存，只补缺的）。
 * @returns {{map: Object, fetched: number, cached: number, failed: number}}
 */
async function fetchIndustries(universe, log = () => {}, opts = {}) {
  const cache = readCache();
  const map = {};
  const targets = opts.force ? universe : universe.filter((u) => !cache[u.code]);

  for (const u of universe) if (cache[u.code]) map[u.code] = cache[u.code];

  let fetched = 0, failed = 0, idx = 0;
  const concurrency = Math.max(4, opts.concurrency || 8);

  async function worker() {
    while (idx < targets.length) {
      const u = targets[idx++];
      try {
        const ind = await fetchIndustry(u.code);
        if (ind) {
          map[u.code] = ind;
          cache[u.code] = ind;
          fetched++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      if ((fetched + failed) % 100 === 0) {
        log(`  行业分类 ${fetched + failed}/${targets.length}`);
        writeCache(cache);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeCache(cache);
  const cachedCount = Object.keys(map).length - fetched;
  log(`行业分类：新取 ${fetched} 家，缓存命中 ${cachedCount} 家，失败 ${failed} 家`);
  return { map, fetched, cached: cachedCount, failed };
}

/**
 * 用钉死的口径重写一份数据集的行业字段。
 * 只改 industry，不动任何其它字段；返回改动明细。
 */
function applyPinnedIndustry(dataset, industryMap, fallbackProfiles = {}) {
  const changed = [];
  for (const c of dataset.companies || []) {
    const pinned = industryMap[c.code];
    const next = pinned || (fallbackProfiles[c.code] && fallbackProfiles[c.code].industry) || c.industry || '';
    if (c.industry !== next) {
      changed.push({ code: c.code, name: c.name, from: c.industry, to: next, source: pinned ? 'pinned' : 'fallback' });
      c.industry = next;
    }
  }
  return changed;
}

module.exports = { fetchIndustries, fetchIndustry, readCache, writeCache, applyPinnedIndustry, CACHE_FILE };
