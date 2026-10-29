'use strict';
/**
 * 看板服务健康检查 / 自愈（2026-10-27 新增）。
 *
 * 背景：2026-10-27 13:23 看板服务**静默卡死**——
 *   端口还在监听（TCP 能握手）、日志不再更新、CPU 增量为 0，
 *   但所有 HTTP 请求都超时。而当天的计划任务报告 `LastResult=0`（"成功"），
 *   因为启动脚本只用 `netstat | findstr LISTENING` 判断"起来了"，
 *   卡死的服务同样满足这个条件。**没有真实请求，就发现不了它已经死了。**
 *
 * 用法：
 *   node scripts\healthcheck.cjs              探活并打印结果（退出码 0=健康 1=不健康）
 *   node scripts\healthcheck.cjs --wait 30    等到健康为止（最多 30 秒），给启动脚本用
 *   node scripts\healthcheck.cjs --repair     不健康就杀掉占端口的僵尸进程并重启
 *
 * 退出码：0 = 健康；1 = 不健康；2 = 自愈失败
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 7788);
const HOST = '127.0.0.1';
const PROBE_PATH = '/api/ping';
const PROBE_TIMEOUT_MS = 6000;
const LOG_FILE = path.join(DATA_DIR, 'health.log');
/** 服务进程自己的 stdout/stderr 落盘位置（崩溃现场） */
const SERVER_LOG_FILE = path.join(DATA_DIR, 'server.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* ignore */ }
}

function probe() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get({ host: HOST, port: PORT, path: PROBE_PATH, timeout: PROBE_TIMEOUT_MS }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({
        ok: res.statusCode === 200 && n > 0,
        status: res.statusCode,
        bytes: n,
        ms: Date.now() - t0,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
  });
}

/** 占用端口的监听进程 PID（没有则 0） */
function listenerPid() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { encoding: 'utf8', timeout: 20000 }).trim();
    return Number(out) || 0;
  } catch { return 0; }
}

function killListener(pid) {
  if (!pid) return false;
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch { return false; }
}

async function waitHealthy(maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last || { ok: false, err: 'no attempt' };
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);

  if (has('--repair')) {
    const first = await probe();
    if (first.ok) {
      log(`[health] healthy (${first.status}, ${first.bytes}B, ${first.ms}ms) — nothing to do`);
      process.exit(0);
    }
    log(`[health] UNHEALTHY (${first.err || first.status}) — repairing`);
    const pid = listenerPid();
    if (pid) {
      log(`[health] killing stuck listener PID ${pid}`);
      killListener(pid);
    } else {
      log('[health] no listener found — starting a new instance');
    }
    await new Promise((r) => setTimeout(r, 2000));

    let logFd;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      logFd = fs.openSync(SERVER_LOG_FILE, 'a');
    } catch { logFd = 'ignore'; }

    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT, detached: true,
      // **stdout/stderr 必须落盘**：之前用 'ignore'，服务一崩就什么线索都没有，
      // 只能靠"端口还在听"猜 —— 2026-10-27 两次静默卡死就是这么查不出来的。
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, RADAR_HOST: process.env.RADAR_HOST || '0.0.0.0', PORT: String(PORT) },
    });
    child.unref();
    log(`[health] started new server PID ${child.pid}`);

    const after = await waitHealthy(40);
    if (after.ok) {
      log(`[health] RECOVERED (${after.status}, ${after.bytes}B, ${after.ms}ms)`);
      process.exit(0);
    }
    log(`[health] RECOVERY FAILED (${after.err || after.status})`);
    process.exit(2);
  }

  if (has('--wait')) {
    const secs = Number(args[args.indexOf('--wait') + 1]) || 30;
    const r = await waitHealthy(secs);
    log(`[health] ${r.ok ? 'OK' : 'FAIL'} (${r.err || r.status}, ${r.ms}ms)`);
    process.exit(r.ok ? 0 : 1);
  }

  const r = await probe();
  log(`[health] ${r.ok ? 'OK' : 'FAIL'} status=${r.status || '-'} err=${r.err || '-'} bytes=${r.bytes || 0} ms=${r.ms}`);
  process.exit(r.ok ? 0 : 1);
}

main();
