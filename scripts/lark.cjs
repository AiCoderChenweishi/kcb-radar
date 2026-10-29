'use strict';
/**
 * 飞书（lark-cli）封装。
 *
 * 已知坑（都是踩过的）：
 *  1) 包名是 @larksuite/cli，不是 lark-cli；
 *  2) lark-cli.ps1 被 PowerShell 执行策略拦、lark-cli.cmd 会吃掉引号
 *     → 必须 spawnSync(process.execPath, [run.js, ...args]) 直连 JS 入口；
 *  3) docs +update --command overwrite 会把标题重置成 Markdown 的 H1
 *     → 让 H1 与节点标题逐字一致；
 *  4) --content '@文件路径' 在工作区里读不到（文件可能被回收）
 *     → 改用 --content - 经 stdin 管道灌入。
 */
const { spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');

const ENTRY = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
  '@larksuite', 'cli', 'scripts', 'run.js');

const ANSI = /\u001b\[[0-9;]*m/g;

function stripAnsi(s) { return String(s || '').replace(ANSI, ''); }

/**
 * 代理健康兜底。
 *
 * 实测（2026-10-21 20:40）：机器上设了 HTTP_PROXY/HTTPS_PROXY = http://127.0.0.1:7892，
 * 但那个本地代理客户端**没在运行**。于是：
 *   - 飞书 API：proxyconnect tcp: dial tcp 127.0.0.1:7892: connectex: 被拒绝
 *   - connector 平台：connected-tools/list: fetch failed
 * 而**直连完全正常**（open.feishu.cn 与 data.eastmoney.com 直接可达）。
 *
 * 也就是说整条链路唯一的单点故障就是这个本地代理。
 * 做法：从错误特征识别代理故障 → 摘掉代理环境变量直连重试一次，
 * 并记住"代理已坏"，后续所有调用都走直连。
 */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const PROXY_ERR_RE = /proxyconnect|proxy refused|127\.0\.0\.1:7892|socks proxy|dial tcp .*:7892/i;
const proxyState = { broken: false, detectedAt: null, reason: null };

function stripProxyEnv() {
  const env = { ...process.env };
  for (const k of PROXY_VARS) delete env[k];
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

function looksLikeProxyError(res) {
  const blob = `${res.stderr || ''}\n${res.stdout || ''}\n${res.error || ''}`;
  return PROXY_ERR_RE.test(blob);
}

function proxyStatus() {
  return { ...proxyState };
}

/**
 * @param {string[]} args
 * @param {object} opts { timeoutMs, stdin, retries }
 * @returns {{code:number, stdout:string, stderr:string}}
 */
function run(args, opts = {}) {
  const retries = opts.retries == null ? 2 : opts.retries;
  let last = { code: -1, stdout: '', stderr: '未执行', error: null };
  let useDirect = proxyState.broken;

  for (let attempt = 0; attempt <= retries; attempt++) {
    last = runOnce(args, opts, useDirect);
    if (last.code === 0) return last;

    // 代理故障：摘掉代理变量直连重试（只判定一次，之后所有调用都直连）
    if (!useDirect && looksLikeProxyError(last)) {
      proxyState.broken = true;
      proxyState.detectedAt = new Date().toISOString();
      proxyState.reason = '本地代理不可达，已切换为直连';
      useDirect = true;
      continue;
    }

    if (attempt < retries) {
      // lark-cli 偶发瞬时失败（网络/网关），退避后重试
      const r = spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},800)'], { timeout: 5000 });
      void r;
    }
  }
  return last;
}

function runOnce(args, opts = {}, direct = false) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    input: opts.stdin === undefined ? undefined : opts.stdin,
    env: direct ? stripProxyEnv() : process.env,
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: stripAnsi(r.stdout || ''),
    stderr: stripAnsi(r.stderr || ''),
    error: r.error ? r.error.message : null,
  };
}

function parseJson(out) {
  const start = out.indexOf('{');
  const arr = out.indexOf('[');
  let i = start;
  if (arr >= 0 && (start < 0 || arr < start)) i = arr;
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch { return null; }
}

module.exports = { run, parseJson, ENTRY, proxyStatus };
