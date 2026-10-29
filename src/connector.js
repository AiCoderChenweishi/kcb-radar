'use strict';
/**
 * mcode-tools 直连封装。
 *
 * 为什么不用 `.cmd` shim：
 *   1) Windows 下 `.cmd` 是批处理 shim，JSON 参数里的引号会被吃掉（实测报 "Connector arguments must be valid JSON"）；
 *   2) Node 的 spawnSync 不带 shell 时无法执行 `.cmd`（ENOENT，status=null）。
 *
 * 真实入口是 Electron 二进制以 Node 模式运行 cli.mjs：
 *   "MiniMax Code.exe" "resources/resources/mcode-tools/cli.mjs" <args>
 * 环境变量（认证 broker 的命名管道 + capability 文件）必须原样继承，否则连不上远程目录。
 *
 * 本模块在运行时解析 shim 脚本反向得到 exe/cli 路径与环境变量，避免硬编码路径失效。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_HOME = os.homedir();
const MINIMAX_HOME = path.join(USER_HOME, '.minimax');
const BIN_DIR = path.join(MINIMAX_HOME, 'bin');

// shim 里显式清空的变量：必须从子进程环境里剔除，否则会覆盖本地运行时注入的凭据
const CLEARED_KEYS = [
  'MAVIS_ACCESS_TOKEN', 'MAVIS_DATA_DIR', 'MINIMAX_DATA_DIR', 'MAVIS_PORT', 'MAVIS_PROFILE',
  'IS_SANDBOX', 'MCODE_API_BASE_URL', 'MCODE_AUTH_BASE_URL', 'MCODE_CLIENT_ID', 'MCODE_SCOPE',
  'MCODE_AUTH_PROVIDER', 'MCODE_AUTH_BROKER_ENDPOINT', 'MCODE_AUTH_BROKER_CAPABILITY_FILE',
  'MCODE_EXTRA_HEADERS', 'MCODE_CONFIG_DIR', 'MCODE_REGION',
];

let cached = null;

/** 解析 shim，拿到 { exe, cli, env } */
function resolveEntrypoint() {
  if (cached) return cached;

  const shimNames = ['mcode-tools-cn.cmd', 'mcode-tools-global.cmd'];
  let shimPath = null;
  let shimText = null;

  for (const name of shimNames) {
    const p = path.join(BIN_DIR, name);
    if (fs.existsSync(p)) { shimPath = p; shimText = fs.readFileSync(p, 'utf8'); break; }
  }
  if (!shimPath) {
    throw new Error(`找不到 mcode-tools shim，目录：${BIN_DIR}`);
  }

  const shimEnv = {};
  // 形如：set "KEY=VALUE"
  // 值必须逐字透传：命名管道端点 "\\.\pipe\xxx" 里的反斜杠一旦被二次转义，
  // 会被 cli 判定为非 canonical lease 路径而直接拒绝连接。
  const setRe = /^\s*set\s+"([^=]+)=(.*)"\s*$/gm;
  let m;
  while ((m = setRe.exec(shimText)) !== null) {
    shimEnv[m[1]] = m[2];
  }

  // 形如："C:\path\to\MiniMax Code.exe" "C:\path\to\cli.mjs" %*
  const cmdRe = /"([^"]*\.exe)"\s+"([^"]*cli\.mjs)"/i;
  const cmdMatch = cmdRe.exec(shimText);
  if (!cmdMatch) {
    throw new Error(`无法从 shim 解析 exe/cli 入口：${shimPath}`);
  }

  const env = { ...process.env };
  for (const k of CLEARED_KEYS) delete env[k];
  // 运行时注入的上下文变量必须剥离（shim 里也在清）
  for (const k of Object.keys(env)) {
    if (k.startsWith('__MAVIS_PARENT_') || k.startsWith('__MAVIS_RUNTIME_') ||
        k.startsWith('AGENTARCHON_') || k.startsWith('AGENT_ARCHON_')) {
      delete env[k];
    }
  }
  Object.assign(env, shimEnv, { ELECTRON_RUN_AS_NODE: '1' });

  cached = { exe: cmdMatch[1], cli: cmdMatch[2], env, shimPath };
  return cached;
}

/** shim 里的命名管道端点需要双反斜杠，node 侧要还原成单对 */
function normalizePipe(v) {
  return typeof v === 'string' ? v.replace(/\\\\\.\\pipe\\/g, '\\\\.\\pipe\\') : v;
}

let tmpCounter = 0;

function cleanupTmp(maxAgeMs = 30 * 60 * 1000) {
  try {
    const dir = path.join(__dirname, '..', '.tmp');
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('args_') || !f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function writeArgsFile(args) {
  const dir = path.join(__dirname, '..', '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  if (tmpCounter % 50 === 0) cleanupTmp();
  const file = path.join(dir, `args_${process.pid}_${Date.now()}_${tmpCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify(args), 'utf8');
  return file;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 启动一个 mcode-tools 调用并等待结果。
 *
 * 为什么不用 spawnSync：Windows 上 spawnSync 的 timeout 只能杀掉直接子进程，
 * 而 mcode-tools 是 Electron 以 Node 模式跑的，stdout 管道被子进程持有，
 * 于是超时后 spawnSync 仍然不返回——实测有 search_news / get_security_indicators
 * 两个调用永久挂住，整个采集停在那里 40 分钟不出结果。
 *
 * 现在改成异步 spawn + 超时后用 taskkill /T /F 杀整棵进程树。
 */
function runCli(args, opts = {}) {
  const { exe, cli, env } = resolveEntrypoint();
  const timeoutMs = opts.timeoutMs || 120000;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, [cli, ...args], {
        windowsHide: true,
        env: proxyState.broken ? stripProxyEnv(env) : env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: `spawn 异常: ${e.message}`, timedOut: false });
      return;
    }

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;

    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // 杀完再给 3 秒收尾窗口，仍不退出就强制结算
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ code: -1, stdout: out, stderr: `调用超时 ${timeoutMs}ms，已强制终止进程树`, timedOut: true });
        }
      }, 3000);
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: -1, stdout: out, stderr: `spawn 失败: ${e.message}`, timedOut });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
  });
}

/**
 * 全局自适应限流器。
 *
 * 实测：iFinD 连接器会随机瞬时失败
 * （connector_tool_error / latency_ms=0 —— 是瞬时拒绝，不是超时）。
 * 串行单次调用也有约 33% 概率失败，所以问题不在并发。
 *
 * 并发基准（每档 24 次调用，重试 1 次）：
 *   并发 4 → 成功率 75%   并发 6 → 88%   并发 8 → 96%   并发 12 → 83%
 * 失败率与并发不成正比，是随机抖动；**拉长间隔并不能提高成功率，只会整体变慢**。
 * 因此这里的间隔只做温和兜底（封顶 500ms），
 * 真正保证覆盖率的手段是「多次重试 + 失败修复轮」（见 collector.js 的 runWithRepair）。
 */
const throttle = {
  gapMs: 120,
  minGapMs: 60,
  maxGapMs: 500,
  lastStart: 0,
  errors: 0,
  totalCalls: 0,
  totalErrors: 0,
  /**
   * **真正消耗账户额度的调用次数**（成功 + 失败 + 重试都算）。
   *
   * 为什么必须单独记一个 `totalAttempts`：
   * `totalCalls` 只在成功时自增，而 iFinD 的失败同样扣账户额度
   * （2026-10-23 实测：额度为 0 时，每次调用都返回 HTTP 200 + 「用量已耗尽」正文，
   *   走的是失败分支，`totalCalls` 一路为 0 —— 看它会以为"一次都没调"）。
   * 「额度烧完了才发现」正是我们要避免的事，所以记账必须按**实际发出的请求数**算。
   */
  totalAttempts: 0,
  /** 按工具名分组的实际请求数，用来定位"额度到底被哪个阶段吃掉" */
  attemptsByTool: {},
};

/** 额度耗尽的特征串 */
const QUOTA_RE = /用量已耗尽|加购增量包|产品订阅界面选购|升级权益/;

/**
 * **平台级不可达**的特征串。
 *
 * 背景（2026-10-21 实测）：connector 后端本身挂掉时，报错是
 * `Network request failed for /minimax-cloud/api/v1/connectors/connected-tools/list: fetch failed`。
 * 这种情况下每次调用都要跑满重试 × 内部退避，
 * 15 个调用（8 个 breadth + 7 个 trending）把整轮采集从 62 秒拖到 **836 秒**。
 *
 * 因此加一道熔断：连续 N 次判定为平台不可达后，后续调用**立即失败**，不再重试。
 * 与额度熔断同一思路 —— 不可恢复的失败不做无意义的重试。
 */
const OUTAGE_RE = /Network request failed|connected-tools\/list|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i;

/**
 * 本地代理不可达的特征（与 scripts/lark.cjs 同一套判据）。
 *
 * 实测（2026-10-21 20:40）：HTTP_PROXY/HTTPS_PROXY = http://127.0.0.1:7892，
 * 但代理客户端没运行 → connector 全部报 connected-tools/list: fetch failed，
 * 而直连完全正常。于是 connector 侧的"平台不可达"其实大半是**代理挂了**。
 * 识别到代理故障后，摘掉代理环境变量重试一次直连。
 */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const PROXY_ERR_RE = /proxyconnect|proxy refused|dial tcp .*:7892|socks proxy|ECONNREFUSED/i;
const proxyState = { broken: false, detectedAt: null };

function stripProxyEnv(env) {
  const e = { ...env };
  for (const k of PROXY_VARS) delete e[k];
  e.NO_PROXY = '*';
  e.no_proxy = '*';
  return e;
}

function proxyStatus() {
  return { ...proxyState };
}
const outageState = { down: false, detectedAt: null, consecutive: 0, message: null, threshold: 3 };

function isOutageError(msg) {
  return OUTAGE_RE.test(String(msg || ''));
}

/**
 * 全局额度状态。一旦判定额度耗尽，后续 iFinD 阶段直接跳过，
 * 不再做无意义的批量快失败（124 批 × 每次一秒也是一分钟）。
 */
const quotaState = { exhausted: false, detectedAt: null, message: null };

function throttleSlot() {
  const now = Date.now();
  const wait = throttle.lastStart + throttle.gapMs - now;
  throttle.lastStart = now + Math.max(0, wait);
  return wait > 0 ? sleep(wait) : Promise.resolve();
}

function onCallError() {
  throttle.errors++;
  throttle.totalErrors++;
  throttle.gapMs = Math.min(throttle.maxGapMs, Math.round(throttle.gapMs * 1.5));
  // 连续失败时短暂冷启动，给服务端一点缓冲
  const cool = Math.min(600, 100 * throttle.errors);
  return sleep(cool);
}

function onCallSuccess() {
  throttle.totalCalls++;
  if (throttle.errors > 0) throttle.errors--;
  else throttle.gapMs = Math.max(throttle.minGapMs, Math.round(throttle.gapMs * 0.92));
}

/**
 * 调用一个 connector 工具。
 * @param {string} toolName 形如 connector__thsifind__get_stock_summary
 * @param {object} args      工具参数对象
 * @param {object} opts      { timeoutMs, retries }
 * @returns {Promise<any>}   已解析的业务 payload（去掉 MCP 外层 text 包装）
 */
async function callTool(toolName, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const retries = opts.retries == null ? 2 : opts.retries;

  // 平台不可达熔断：已判定挂了就直接失败，不重试
  if (outageState.down) {
    const err = new Error(`CONNECTOR_OUTAGE: connector 平台不可达（${outageState.message || '网络错误'}），已跳过本轮剩余调用`);
    err.outage = true;
    throw err;
  }

  let argsFile = null;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!argsFile) argsFile = writeArgsFile(args);
      await throttleSlot();
      // 额度记账：**放在真正发请求之前**，这样一次调用里的每次重试都算一次。
      // 账户额度是按实际请求扣的，重试同样扣 —— 记在调用外层会少算。
      throttle.totalAttempts++;
      throttle.attemptsByTool[toolName] = (throttle.attemptsByTool[toolName] || 0) + 1;
      const r = await runCli(
        ['connector', 'call', toolName, '--args-file', argsFile],
        { timeoutMs }
      );

      if (r.timedOut) throw new Error(`调用超时 ${timeoutMs}ms`);
      if (r.code !== 0) {
        const err = (r.stderr || '').split('\n').filter((l) => l && !/UNDICI-EHPA|trace-warnings/.test(l)).join(' | ');
        const msg = `退出码 ${r.code}: ${err.slice(0, 400)}`;
        // 代理故障：这不是"平台挂了"，切直连重试一次（本轮后续调用都直连）
        if (!proxyState.broken && PROXY_ERR_RE.test(msg)) {
          proxyState.broken = true;
          proxyState.detectedAt = new Date().toISOString();
          const direct = new Error(`代理不可达，已切换直连重试：${msg}`);
          direct.proxySwitch = true;
          throw direct;
        }
        throw new Error(msg);
      }

      const stdout = (r.stdout || '').trim();
      if (!stdout) throw new Error('空响应');

      const outer = JSON.parse(stdout);
      const text = Array.isArray(outer) ? outer.map((x) => x.text).join('') : stdout;
      const inner = JSON.parse(text);

      if (inner.code !== 1 && inner.code !== 0) {
        throw new Error(`业务错误 code=${inner.code} msg=${inner.msg || inner.subMsg || ''}`);
      }

      // 额度熔断：iFinD MCP 额度耗尽时返回的是 HTTP 200 + 正常业务结构，
      // 正文里是一句"当前账户MCP请求用量已耗尽"。如果不单独识别，
      // 采集会把它当成"这家查无数据"，整轮跑完得到一份看似正常的空数据 —— 最危险的静默失败。
      const payloadText = typeof inner.data === 'string'
        ? inner.data
        : JSON.stringify(inner.data || '');
      if (QUOTA_RE.test(payloadText)) {
        quotaState.exhausted = true;
        quotaState.detectedAt = new Date().toISOString();
        quotaState.message = 'iFinD MCP 请求额度已耗尽';
        const err = new Error('QUOTA_EXHAUSTED: iFinD MCP 请求额度已耗尽，需在 ifind-mcp 官网升级或加购增量包');
        err.quotaExhausted = true;
        throw err;
      }

      onCallSuccess();
      outageState.consecutive = 0;
      return inner.data;
    } catch (e) {
      lastErr = e;
      // 额度耗尽重试没有意义，直接上抛
      // （这一次请求同样扣了账户额度，必须计失败，否则台账会显示"没失败过"）
      if (e && e.quotaExhausted) { throttle.totalErrors++; throw e; }
      // 代理故障 → 同一 attempt 用直连重试一次（不消耗重试预算）
      if (e && e.proxySwitch) {
        await throttleSlot();
        const r2 = await runCli(['connector', 'call', toolName, '--args-file', argsFile], { timeoutMs });
        throttle.totalAttempts++;
        throttle.attemptsByTool[toolName] = (throttle.attemptsByTool[toolName] || 0) + 1;
        if (r2.code === 0 && (r2.stdout || '').trim()) {
          const outer2 = JSON.parse(r2.stdout.trim());
          const text2 = Array.isArray(outer2) ? outer2.map((x) => x.text).join('') : r2.stdout.trim();
          const inner2 = JSON.parse(text2);
          if (inner2.code === 1 || inner2.code === 0) {
            const payload2 = typeof inner2.data === 'string' ? inner2.data : JSON.stringify(inner2.data || '');
            if (QUOTA_RE.test(payload2)) {
              quotaState.exhausted = true;
              quotaState.detectedAt = new Date().toISOString();
              quotaState.message = 'iFinD MCP 请求额度已耗尽';
              const qe = new Error('QUOTA_EXHAUSTED: iFinD MCP 请求额度已耗尽，需在 ifind-mcp 官网升级或加购增量包');
              qe.quotaExhausted = true;
              throw qe;
            }
            onCallSuccess();
            outageState.consecutive = 0;
            return inner2.data;
          }
        }
        throw e;
      }
      // 平台不可达：累计判定，够了就熔断整轮；不重试（平台挂了重试也没用）
      if (isOutageError(e && e.message)) {
        throttle.totalErrors++;
        outageState.consecutive++;
        outageState.message = String((e && e.message) || '').slice(0, 200);
        if (outageState.consecutive >= outageState.threshold) {
          outageState.down = true;
          outageState.detectedAt = new Date().toISOString();
        }
        throw e;
      }
      if (attempt < retries) {
        await onCallError();
        await sleep(400 * Math.pow(2, attempt) + Math.floor(Math.random() * 300));
      }
    }
  }
  throw lastErr;
}

/** 限流器状态，供诊断输出 */
function throttleStats() {
  return {
    gapMs: throttle.gapMs,
    consecutiveErrors: throttle.errors,
    totalCalls: throttle.totalCalls,
    totalErrors: throttle.totalErrors,
    totalAttempts: throttle.totalAttempts,
    attemptsByTool: { ...throttle.attemptsByTool },
  };
}

/**
 * 额度消耗视图：写进数据集与看板，让"额度被谁吃掉了"可见。
 *
 * 判据：**额度型外部依赖必须自带可观测的消耗计数**。
 * 2026-10-21 的教训是"全量设计一天烧掉试用账号 2,000 次永久额度的 3/4"，
 * 而当时既没有计数器也没有看板入口，两天后才发现额度已经为 0。
 */
function usageStats() {
  const byTool = Object.entries(throttle.attemptsByTool)
    .map(([tool, n]) => ({ tool: tool.replace(/^connector__thsifind__/, ''), calls: n }))
    .sort((a, b) => b.calls - a.calls);
  return {
    calls: throttle.totalCalls,
    errors: throttle.totalErrors,
    attempts: throttle.totalAttempts,
    quotaExhausted: quotaState.exhausted,
    quotaDetectedAt: quotaState.detectedAt,
    byTool,
  };
}

/** iFinD 额度是否已耗尽 */
function quotaBlocked() {
  return quotaState.exhausted;
}

function quotaInfo() {
  return { ...quotaState };
}

/** connector 平台是否判定为不可达（已熔断） */
function outageBlocked() {
  return outageState.down;
}

function outageInfo() {
  return { ...outageState };
}

/** 简单的并发闸门 */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  }
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = { callTool, createLimiter, resolveEntrypoint, throttleStats, usageStats, quotaBlocked, quotaInfo, outageBlocked, outageInfo, proxyStatus };
