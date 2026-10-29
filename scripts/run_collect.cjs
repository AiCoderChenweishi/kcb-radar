'use strict';
/**
 * 采集入口。
 *   node scripts/run_collect.cjs            采集当天
 *   node scripts/run_collect.cjs --date=2026-10-20
 *   node scripts/run_collect.cjs --serve    采集完成后直接起服务
 */
const fs = require('fs');
const path = require('path');
const { collectAll } = require('../src/collector');
const { buildBrief } = require('../src/insight');
const store = require('../src/store');
function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

(async () => {
  const dateArg = arg('date', null);
  const limit = arg('limit', null);
  const runDate = dateArg ? new Date(`${dateArg}T08:00:00+08:00`) : new Date();

  // 并发保护：同一时间只允许一个采集进程，避免抢同一个输出文件
  //
  // **教训（2026-10-21 实测）**：原来用"锁文件存在即退出"的写法，
  // 一旦进程被外部终止（后台任务被回收 / 强杀），锁就残留在磁盘上，
  // 下一轮采集会以 exit 3 直接退出 —— 表现为"每天 07:30 自动采集没产出"。
  // 现在改成：锁里记 PID + 启动时间；启动时判定锁是否还"活着"，
  // 死锁自动接管，活锁才拒绝；释放时带重试，避免 Windows 上偶发 EPERM。
  const cfg = require('../src/config');
  const lockFile = path.join(cfg.DATA_DIR, 'collecting.lock');
  const STALE_MS = 20 * 60 * 1000;   // 超过 20 分钟视为死锁

  function lockInfo() {
    try {
      const raw = fs.readFileSync(lockFile, 'utf8').trim();
      try { return JSON.parse(raw); } catch { /* 旧格式：纯时间戳 */ }
      return { startedAt: Number(raw) || 0 };
    } catch { return null; }
  }

  function pidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM 说明进程存在但当前用户无权发信号
      return e.code === 'EPERM';
    }
  }

  const existing = lockInfo();
  if (existing) {
    const age = Date.now() - (existing.startedAt || 0);
    const alive = pidAlive(existing.pid);
    if (age < STALE_MS && alive) {
      console.error(`已有采集任务在运行（PID ${existing.pid || '未知'}，锁文件 ${Math.round(age / 1000)}s 前创建），本次退出`);
      process.exit(3);
    }
    log(`检测到残留锁（PID ${existing.pid || '未知'}，${Math.round(age / 1000)}s 前，存活=${alive}），已接管`);
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  let released = false;
  const releaseLock = () => {
    if (released) return;
    released = true;
    // Windows 上偶发 EPERM/EBUSY（索引器或杀软短暂占用），重试几次
    for (let i = 0; i < 6; i++) {
      try {
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        return;
      } catch {
        try { fs.unlinkSync(lockFile); return; } catch { /* retry */ }
        const until = Date.now() + 300;
        while (Date.now() < until) { /* 短等待，避免同步阻塞过久 */ }
      }
    }
    console.warn('⚠ 锁文件未能释放（Windows 文件占用），若下次采集被拒请手动删除 data/collecting.lock');
  };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  let dataset = null;
  let error = null;
  const startedAt = Date.now();

  try {
    dataset = await collectAll({ log, runDate, limit: limit ? Number(limit) : null });
  } catch (e) {
    error = e;
    log(`采集失败: ${e.stack || e.message}`);
  }

  if (!dataset) {
    store.saveStatus({
      ok: false, date: dateArg || new Date().toISOString().slice(0, 10),
      error: error ? (error.message || String(error)) : '未知错误',
      finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    });
    releaseLock();
    process.exit(1);
  }

  const prevDate = store.previousDate(dataset.date);
  const prev = prevDate ? store.loadDataset(prevDate) : null;
  const brief = buildBrief(dataset, prev);

  // 券商观点正文：从研报详情页抓「投资要点」——让"观点"是原文而不是元数据
  // 抓「近期新增 + 全部被覆盖公司最新一篇」共约 231 篇，
  // 让第 2 层「券商观点原文」覆盖到 229/229 家（原来只抓 55 篇 → 53 家）。
  // 并发 3 / 间隔 250ms 是实测出来的安全值：并发 5 会触发东财瞬时限流
  // （同一批 231 篇成功数在 119↔230 之间跳），并发 3 + 失败慢速重试可稳定到 230/231。
  let viewStats = { targets: 0, ok: 0, hit: 0, failed: 0 };
  try {
    const { pickReportTargets, fetchReportViews, applyViews } = require('../src/report');
    const t = pickReportTargets(dataset, brief);
    viewStats.targets = t.codes.length;
    if (t.codes.length) {
      const views = await fetchReportViews(t.codes, { concurrency: 3, max: 260, gapMs: 250, log });
      viewStats.ok = [...views.values()].filter((v) => v.ok).length;
      viewStats.failed = viewStats.targets - viewStats.ok;
      viewStats.hit = applyViews(dataset, views);
      log(`[研报正文] 目标 ${viewStats.targets} 篇，成功 ${viewStats.ok} 篇，贴回 ${viewStats.hit} 处`);
    }
  } catch (e) {
    log(`研报正文抓取失败（不阻断）：${e.message}`);
  }

  // **抽样复跑必须与全量数据集隔离**（2026-10-21 实测事故）：
  // 08:30 巡检 Bot 按提示跑 `run_collect.cjs --limit=40`，
  // 结果和全量采集写进同一个 `data/daily/<日期>.json`，
  // 当天 619 家 / 4962KB 的完整数据集被覆盖成 40 家 / 402KB，
  // 连 status.json 和 digest 也一起被改写 —— 晨报的数据基础被毁。
  // 现在：带 --limit 的运行写到 `data/samples/<日期>-limit<N>.json`，
  // 不碰主数据集、不碰 status.json、不生成正式 digest。
  const isSample = !!limit;
  let p;
  if (isSample) {
    const sampleDir = path.join(cfg.DATA_DIR, 'samples');
    fs.mkdirSync(sampleDir, { recursive: true });
    p = path.join(sampleDir, `${dataset.date}-limit${Number(limit)}.json`);
    fs.writeFileSync(p, JSON.stringify(dataset), 'utf8');
    log(`⚠ 抽样复跑结果已隔离保存，未覆盖当日全量数据集：${p}`);
  } else {
    p = store.saveDataset(dataset);
  }

  // 自动生成给 Bot 用的精简摘要（否则 Bot 得读 5MB 的原始 JSON，会超时）
  // 抽样运行不生成正式摘要 —— 那会把给 Bot 用的全量摘要换成 40 家的版本
  let digestPath = null;
  if (!isSample) {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync(process.execPath, [path.join(__dirname, 'digest.cjs'), dataset.date], { encoding: 'utf8' });
      digestPath = out.split('\n')[0].trim();
      log(`摘要已生成：${digestPath}`);
    } catch (e) {
      log(`摘要生成失败（不阻断）：${e.message}`);
    }
  }
  const statusObj = {
    ok: true,
    date: dataset.date,
    previousDate: prevDate,
    file: p,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    stats: dataset.stats,
    ifind: dataset.ifind || null,
    coverage: brief.coverage,
    universeSource: dataset.universeSource,
    reportViews: viewStats,
    highSignal: brief.highlights.slice(0, 10).map((h) => ({
      code: h.code, name: h.name, score: h.score,
      signals: h.signals.slice(0, 3).map((s) => s.label),
    })),
  };
  if (isSample) {
    statusObj.sample = true;
    statusObj.limit = Number(limit);
    statusObj.note = '抽样复跑结果，未覆盖当日全量数据集与正式摘要';
    fs.writeFileSync(path.join(cfg.DATA_DIR, `status-sample-limit${Number(limit)}.json`), JSON.stringify(statusObj, null, 2), 'utf8');
    log('抽样运行状态已另存，未覆盖 data/status.json');
  } else {
    store.saveStatus(statusObj);
  }

  log(`已保存 ${p}`);
  log(`覆盖：财务 ${brief.coverage.withFinancials}/${brief.coverage.total}，估值 ${brief.coverage.withValuation}，分位 ${brief.coverage.withPercentile}`);
  log(`条目：要闻 ${brief.coverage.newsItems}，研报 ${brief.coverage.researchItems}，公告 ${brief.coverage.noticeItems}，高信号公司 ${brief.highlights.length}`);
  if (brief.highlights.length) {
    log('Top 高信号：');
    for (const h of brief.highlights.slice(0, 8)) {
      log(`  ${h.name}(${h.code}) score=${h.score} :: ${h.signals.slice(0, 3).map((s) => s.label).join(' | ')}`);
    }
  }

  if (process.argv.includes('--serve')) {
    require('../src/server').start();
  }
  releaseLock();
})();
