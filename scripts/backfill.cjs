'use strict';
/**
 * **历史数据回补**（2026-10-27 新增）。
 *
 * 场景：2026-10-24/25/26 机器不可用，采集任务一次都没触发，数据集缺失。
 * 事后补采时**不能用实时行情快照**（那会把"此刻"的价格标成历史日期）。
 * 本脚本走 `collectAll({ backfill: true })`：
 *   - 行情/估值 → 东方财富历史日行情（push2his 日K + 逐日估值口径）
 *   - 研报/公告 → 按目标日期窗口重取（本来就有日期过滤）
 *   - 要闻 → 池子变大（每家 30 条）并**裁剪到目标日期为止**
 *   - 研报正文 → 从参考数据集按研报 id 复用（省掉 231 次重复抓取）
 *
 * 用法：
 *   node scripts\backfill.cjs 2026-10-24 2026-10-25 2026-10-26
 *   node scripts\backfill.cjs --dry-run 2026-10-26     只跑采集不落盘
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectAll } = require('../src/collector');
const { applyViews, infoCodeFromUrl } = require('../src/report');
const store = require('../src/store');
const cfg = require('../src/config');

const ROOT = path.join(__dirname, '..');

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

/** 从参考数据集里把「研报原文 + 摘要」按研报 id 抽出来，供新数据集复用 */
function extractViews(refDataset) {
  const views = new Map();
  for (const c of refDataset.companies || []) {
    for (const r of c.research || []) {
      const code = infoCodeFromUrl(r.url);
      if (code && r.view) views.set(code, { ok: true, excerpt: r.view, thesis: r.view_thesis || '' });
    }
    const sl = c.sell_side;
    if (sl && sl.covered) {
      const code = infoCodeFromUrl(sl.url);
      if (code && sl.view) views.set(code, { ok: true, excerpt: sl.view, thesis: sl.view_thesis || '' });
    }
  }
  return views;
}

async function backfillOne(dateStr, { dryRun = false } = {}) {
  log(`=== 回补 ${dateStr} ===`);
  const started = Date.now();
  const runDate = new Date(`${dateStr}T08:00:00+08:00`);
  const dataset = await collectAll({ log, runDate, backfill: true });
  if (!dataset) throw new Error(`回补 ${dateStr} 失败：采集返回空`);

  // 研报正文复用：研报池按研报 id 对齐，正文与日期无关
  const refDate = store.listDates().filter((d) => d !== dateStr)[0];
  let viewStats = { researchHits: 0, sellSideHits: 0, source: null };
  if (refDate) {
    const ref = store.loadDataset(refDate);
    if (ref) {
      const views = extractViews(ref);
      viewStats.researchHits = applyViews(dataset, views);
      // applyViews 的返回值只数 research 条目，**不含卖方覆盖那一层**，
      // 所以这里单独统计一次，否则日志会少报一大截（实测 21 vs 实际 224）。
      for (const c of dataset.companies || []) {
        const sl = c.sell_side;
        if (sl && sl.covered && sl.view) viewStats.sellSideHits++;
      }
      viewStats.source = refDate;
      log(`[研报正文] 复用参考数据集 ${refDate}：研报条目 ${viewStats.researchHits} 处 + 卖方覆盖 ${viewStats.sellSideHits} 家`);
    }
  }

  const bf = dataset.backfill || {};
  log(`[回补] 行情锚定 ${bf.quoteDate || '?'}｜${bf.tradingDay ? '当日为交易日' : '休市日（涨跌幅按 0）'}｜覆盖 ${bf.covered || 0}/${dataset.companies.length} 家｜精确命中 ${bf.exact || 0} 家`);
  log(`[回补] 覆盖：财务 ${dataset.stats.withFinancials}，估值 ${dataset.stats.withValuation}，分位 ${dataset.stats.withPercentile}，要闻 ${dataset.stats.newsCount}，卖方覆盖 ${dataset.stats.sellSideCompanies} 家`);

  if (dryRun) {
    log('[回补] dry-run：不落盘');
    return null;
  }

  // 落盘（saveDataset 会顺带清理超过保留期的旧数据集）
  const p = store.saveDataset(dataset);
  log(`[回补] 已保存 ${p}（${Math.round(fs.statSync(p).size / 1048576 * 100) / 100} MB）`);

  // 摘要 + 基线简报
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'digest.cjs'), dateStr], { encoding: 'utf8' });
    log(`[回补] 摘要：${out.split('\n')[0].trim()}`);
  } catch (e) {
    log(`[回补] 摘要生成失败（不阻断）：${e.message}`);
  }
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'build_brief.cjs'), dateStr], { encoding: 'utf8' });
    log('[回补] 基线简报已生成');
  } catch (e) {
    log(`[回补] 基线简报生成失败（不阻断）：${e.message}`);
  }

  // 状态另存，**不覆盖** data/status.json（那是"最近一次实时采集"的状态）
  const statusFile = path.join(cfg.DATA_DIR, `status-backfill-${dateStr}.json`);
  fs.writeFileSync(statusFile, JSON.stringify({
    ok: true,
    backfill: true,
    date: dateStr,
    file: p,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    stats: dataset.stats,
    backfillInfo: dataset.backfill,
    reportViews: viewStats,
    degraded: dataset.degraded,
    note: '历史回补数据集；行情锚定见 backfillInfo.quoteDate',
  }, null, 2), 'utf8');
  log(`[回补] 状态已另存 ${statusFile}（未覆盖 data/status.json）`);
  return p;
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) {
    console.error('用法：node scripts\\backfill.cjs [--dry-run] 2026-10-24 2026-10-25 2026-10-26');
    process.exit(1);
  }
  // 必须按时间升序：跨日差分要以上一日数据集为基准
  dates.sort();
  for (const d of dates) {
    try {
      await backfillOne(d, { dryRun });
    } catch (e) {
      console.error(`✗ 回补 ${d} 失败：${e.message}`);
      process.exitCode = 1;
    }
  }
  log('=== 回补结束 ===');
})();
