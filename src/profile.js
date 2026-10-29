'use strict';
/**
 * 公司档案层（东方财富 F10 公司概况）。
 *
 * 用途：补齐"行业分类"与公司基本信息。
 * 为什么不用行情接口带行业：东方财富 push2 有 IP 级防滥用，被封时行业会整列丢失。
 * F10 这个接口是另一个域名体系，不受影响。
 *
 * 行业、省份、主营范围、员工数都是**慢变属性**，
 * 所以带缓存：今天拉过���，明天直接用；拉失败的用缓存顶上。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const F10_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://emweb.securities.eastmoney.com/',
  Accept: '*/*',
};

const PROFILE_CACHE = path.join(DATA_DIR, 'profiles.json');

function readCache() {
  try {
    if (!fs.existsSync(PROFILE_CACHE)) return {};
    return JSON.parse(fs.readFileSync(PROFILE_CACHE, 'utf8'));
  } catch { return {}; }
}

function writeCache(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_CACHE, JSON.stringify(obj), 'utf8');
  } catch { /* ignore */ }
}

async function getJson(url) {
  const res = await fetch(url, { headers: F10_HEADERS, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') o[k] = obj[k];
  return o;
}

/** 拉一家公司的 F10 概况 */
async function fetchProfile(code) {
  const bare = String(code).split('.')[0];
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=SH${bare}`;
  const j = await getJson(url);
  const jb = Array.isArray(j.jbzl) ? j.jbzl[0] : (j.jbzl || null);
  if (!jb) return null;
  // EM2016 形如 "电子设备-电子设备制造-电子设备制造"，取最细一级
  const em = String(jb.EM2016 || '');
  const parts = em.split('-').filter(Boolean);
  return {
    industry: parts.length ? parts[parts.length - 1] : (em || null),
    industry_chain: em || null,
    industry_csrc: jb.INDUSTRYCSRC1 || null,
    province: jb.PROVINCE || null,
    sec_type: jb.SECURITY_TYPE || null,
    reg_capital: jb.REG_CAPITAL || null,
    employees: jb.EMP_NUM || null,
    website: jb.ORG_WEB || null,
    org_name: jb.ORG_NAME || null,
    main_business: jb.MAIN_BUSINESS || jb.ORG_PROFILE || null,
  };
}

/**
 * 批量拉取公司档案（带缓存 + 并发）。
 * @returns {{profiles: Object, fetched: number, cached: number, failed: number}}
 */
async function fetchProfiles(universe, log = () => {}, concurrency = 8, opts = {}) {
  const cache = readCache();
  const out = {};
  let fetched = 0, cached = 0, failed = 0;
  let idx = 0;

  // 行业等字段是慢变属性，缓存里有就不重复拉（收敛后每日 0 次调用）
  const targets = opts.skipCached === false
    ? universe
    : universe.filter((u) => !cache[u.code]);

  if (!targets.length) {
    for (const u of universe) if (cache[u.code]) { out[u.code] = cache[u.code]; cached++; }
    log(`公司档案：全部命中缓存（${cached} 家），本轮无需请求`);
    return { profiles: out, fetched: 0, cached, failed: 0 };
  }

  async function worker() {
    while (idx < targets.length) {
      const u = targets[idx++];
      try {
        const p = await fetchProfile(u.code);
        if (p) {
          out[u.code] = p;
          cache[u.code] = p;
          fetched++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      if ((fetched + failed) % 100 === 0) {
        log(`  档案 ${fetched + failed}/${targets.length}`);
        writeCache(cache);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  writeCache(cache);

  // 本次没取到的，用缓存补
  for (const u of universe) {
    if (!out[u.code] && cache[u.code]) { out[u.code] = cache[u.code]; cached++; }
  }

  log(`公司档案：新取 ${fetched} 家，缓存命中 ${cached} 家，失败 ${failed} 家`);
  return { profiles: out, fetched, cached, failed };
}

module.exports = { fetchProfiles, fetchProfile, readCache };
