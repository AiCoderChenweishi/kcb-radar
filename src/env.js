'use strict';
/**
 * 读 `data/radar.env`。
 *
 * **为什么延迟读而不是启动时读一次**：
 * 模型接口的 key 会轮换、也可能临时停用，如果只在进程启动时读一次，
 * 改一次配置就得重启服务（而服务是被计划任务托管的，重启窗口正好撞上采集就麻烦）。
 * 延迟读 → 改完 key 立刻生效，不用重启。
 *
 * **优先级：data/radar.env > 进程环境变量**（2026-10-27 改过）。
 * 原来是"进程环境变量优先"，但启动脚本（start_web.cmd / healthcheck --repair）
 * **会把 env 文件灌进进程环境** —— 于是进程环境是一份启动时的快照，
 * 之后改文件永远不生效（实测：改了 MAX_TOKENS，接口仍返回旧值 2000，
 * 看起来像"配置读不到"，其实是被启动时的快照盖住了）。
 * 现在以文件为准：改完即刻生效；进程环境只在文件里没写这一项时兜底。
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', 'data', 'radar.env');

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

function get(key, fallback) {
  try {
    const parsed = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
    const v = parsed[key];
    if (v != null && v !== '') return v;
  } catch { /* 文件不存在则退回进程环境 */ }
  const env = process.env[key];
  if (env != null && env !== '') return env;
  return fallback;
}

/** 读一组键，返回对象（值不打印，避免 key 进日志） */
function getAll(keys) {
  const out = {};
  for (const k of keys) {
    const v = get(k, null);
    if (v != null) out[k] = v;
  }
  return out;
}

module.exports = { get, getAll, parseEnv, ENV_FILE };
