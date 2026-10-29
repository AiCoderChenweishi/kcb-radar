'use strict';
/**
 * Mini App 问答代理的端到端验证（2026-10-27）。
 *
 * **为什么要起真实实例**：Mini App 的运行时端口在桌面端代理后面，
 * 本地扫端口扫不到 —— 所以不能靠"看它有没有监听"来判断代理通不通，
 * 只能自己起一个实例、把请求真发过去。
 *
 * 检查项：
 *   ① 代理返回 200（转发本身通）
 *   ② 代理拿到非空答案（不是空 JSON）
 *   ③ 答案带 [E编号] 引用（证据可回查）
 *   ④ 响应里**不含 API key**（key 只留在看板服务端）
 *   ⑤ 响应里含服务端提示词（前端能展示"我是怎么问的"）
 *
 * 用法：node scripts\test_miniapp_ask_proxy.cjs
 */
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, '..', 'miniapps', 'kcb-intel');
const SERVER_MJS = path.join(MINI, 'miniapp', 'node', 'server.mjs');
const PORT = Number(process.env.MINI_PROXY_TEST_PORT || 18777);

function post(port, p, body, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': d.length }, timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + (e.code || e.message) }));
    req.write(d); req.end();
  });
}

(async () => {
  const mod = await import(pathToFileURL(SERVER_MJS).href);
  const ac = new AbortController();
  const inst = await mod.start({
    pluginRoot: MINI,
    listen: { port: PORT, host: '127.0.0.1' },
    signal: ac.signal,
  });
  console.log(`Mini App node 服务已起：127.0.0.1:${PORT}\n`);

  const checks = [];
  try {
    const t0 = Date.now();
    const r = await post(PORT, '/api/ask', { question: '睿创微纳最近的业绩和研报怎么看？' });
    const ms = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* ignore */ }
    const ans = (j && j.answer) || '';
    checks.push(['代理返回 200', r.status === 200, `HTTP ${r.status}`]);
    checks.push(['代理拿到答案（非空）', ans.length > 50, `${ans.length} 字 · ${ms}ms`]);
    checks.push(['答案带 [E编号] 引用', /\[E\d+\]/.test(ans), /\[E\d+\]/.test(ans) ? '是' : '否']);
    checks.push(['响应里不含 API key', !/sk-[A-Za-z0-9]{16,}/.test(r.body), /sk-[A-Za-z0-9]{16,}/.test(r.body) ? '泄漏了！' : '未泄漏']);
    checks.push(['响应里含服务端提示词（可回查）', !!(j && j.prompt && j.prompt.length > 100), j && j.prompt ? `${j.prompt.length} 字符` : '缺失']);
    if (ans) console.log(`答案节选：${ans.slice(0, 240).replace(/\n/g, ' ')}\n`);
  } finally {
    await inst.dispose();
    ac.abort();
  }

  let pass = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}｜${detail}`);
    if (ok) pass++;
  }
  console.log(`\nMini App 代理：通过 ${pass}/${checks.length}`);
  process.exit(pass === checks.length ? 0 : 1);
})();
