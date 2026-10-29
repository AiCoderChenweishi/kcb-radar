'use strict';
/**
 * 落盘与历史。
 * 每日一份完整数据集，保留 N 天，用于观点变化对比（评级/目标价跨日变动）。
 */
const fs = require('fs');
const path = require('path');
const { DAILY_DIR, DATA_DIR, DATASET_CACHE_MAX } = require('./config');

const KEEP_DAYS = 120;

/**
 * **数据集进程级缓存**（2026-10-27 新增）。
 *
 * 为什么必须有：一份全量数据集是 5MB 的 JSON，`JSON.parse` 之后在 V8 里要占 30~60MB。
 * 而看板首屏会打出**几十个**区间请求，`aggregateRange` 每次都要把窗口内的每一天
 * 重新读盘 + 重新解析一遍 —— 30 个请求 ≈ 120 次全量解析，实测把 CPU 打满 9 秒、
 * 探活一度超时 8 秒（2026-10-27 实测）。
 *
 * 失效策略：按**文件 mtime + size** 判定。采集任务写的是新文件（mtime 变），
 * 所以缓存会自动失效，不会出现"看板看到昨天的数据"。
 *
 * 容量上限：默认 20 份（见 config.DATASET_CACHE_MAX）——
 * **必须 ≥ range.js 的 MAX_LOAD_DAYS(16)**，否则区间聚合会把预热装好的数据集挤掉，
 * 首屏又退回冷启动（实测 9 秒）。
 */
const datasetCache = new Map(); // date -> { mtimeMs, size, data, at }

function loadDataset(date) {
  const p = datasetPath(date);
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  const hit = datasetCache.get(date);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // 命中：刷新 LRU 位置
    datasetCache.delete(date);
    datasetCache.set(date, hit);
    return hit.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    datasetCache.set(date, { mtimeMs: st.mtimeMs, size: st.size, data, at: Date.now() });
    while (datasetCache.size > DATASET_CACHE_MAX) {
      const oldest = datasetCache.keys().next().value;
      datasetCache.delete(oldest);
    }
    return data;
  } catch { return null; }
}

/** 手动清空数据集缓存（采集刚写完新数据时可调用） */
function clearDatasetCache() {
  datasetCache.clear();
}

function datasetPath(date) {
  return path.join(DAILY_DIR, `${date}.json`);
}

function saveDataset(dataset) {
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  const p = datasetPath(dataset.date);
  fs.writeFileSync(p, JSON.stringify(dataset), 'utf8');
  pruneOld();
  return p;
}

function loadDatasetUncached(date) {
  const p = datasetPath(date);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 可用日期列表，降序 */
function listDates() {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs.readdirSync(DAILY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

function latestDate() {
  const d = listDates();
  return d.length ? d[0] : null;
}

/** 上一日（早于 date 的最近一个已存日期） */
function previousDate(date) {
  const all = listDates().filter((d) => d < date).sort().reverse();
  return all.length ? all[0] : null;
}

function pruneOld() {
  const dates = listDates();
  for (const d of dates.slice(KEEP_DAYS)) {
    try { fs.unlinkSync(datasetPath(d)); } catch { /* ignore */ }
  }
}

/** 采集运行状态（用于前端展示"最近一次采集结果"） */
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

function saveStatus(status) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), 'utf8');
}

function loadStatus() {
  if (!fs.existsSync(STATUS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return null; }
}

module.exports = { saveDataset, loadDataset, loadDatasetUncached, clearDatasetCache, listDates, latestDate, previousDate, saveStatus, loadStatus, datasetPath };
