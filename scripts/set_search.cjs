'use strict';
/**
 * 写入联网搜索配置（只写 data/radar.env，不进代码库，**不打印 key**）。
 *
 * 用法：
 *   node scripts\set_search.cjs <provider> <api_key>      # tavily | brave | serpapi
 *   node scripts\set_search.cjs --check                    # 只看状态
 *   node scripts\set_search.cjs --clear                    # 清掉搜索配置
 *
 * 说明：
 * - 搜索配置是**延迟读**的：改完不用重启看板服务，刷新页面即可生效。
 * - key 只落在这一个文件里，**不要**贴进飞书文档、截图或代码。
 * - 三个供应商都支持，换 key 不用改代码（改 provider 即可）。
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', 'data', 'radar.env');
const KEYS = ['RADAR_SEARCH_PROVIDER', 'RADAR_SEARCH_API_KEY'];
/** 免 key 的后端（默认，直接可用） */
const NO_KEY = ['duckduckgo', 'so360'];
/** 需要 key 的后端（质量与稳定性更好，配了 key 会优先用） */
const NEED_KEY = ['tavily', 'brave', 'serpapi'];
/** auto = 按"key 后端 → 免 key 后端"的顺序自动降级 */
const PROVIDERS = ['auto'].concat(NO_KEY, NEED_KEY);

function readEnv() {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* ignore */ }
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return { text, map };
}

function writeEnv(text, updates) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const i = t.indexOf('=');
    if (i <= 0) return line;
    const k = t.slice(0, i).trim();
    if (!(k in updates)) return line;
    seen.add(k);
    return `${k}=${updates[k]}`;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, out.join('\n'), 'utf8');
}

function status() {
  const { map } = readEnv();
  const provider = (map.RADAR_SEARCH_PROVIDER || 'duckduckgo').toLowerCase();
  const noKey = NO_KEY.includes(provider);
  const ok = noKey ? true : !!map.RADAR_SEARCH_API_KEY;
  console.log('联网搜索配置：' + (ok ? '✅ 已配置' : '❌ 未配置'));
  console.log(`  RADAR_SEARCH_PROVIDER = ${provider}${noKey ? '（免 key，直接可用）' : ''}`);
  console.log(`  RADAR_SEARCH_API_KEY   = ${map.RADAR_SEARCH_API_KEY ? '<已填写>' : '<空>'}`);
  console.log(`  RADAR_SEARCH_MODE      = ${map.RADAR_SEARCH_MODE || 'auto（默认）'}`);
  console.log(`  RADAR_SEARCH_MAX_RESULTS = ${map.RADAR_SEARCH_MAX_RESULTS || '6（默认）'}`);
  if (!ok) {
    console.log('\n填法：node scripts\\set_search.cjs <provider> <api_key>');
    console.log('provider 可选：' + PROVIDERS.join(' / '));
    console.log('（duckduckgo 免 key，不用填 api_key；也可以用 --provider-only 单独切后端）');
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--check') { status(); return; }
  if (args[0] === '--clear') {
    const { text } = readEnv();
    writeEnv(text, { RADAR_SEARCH_PROVIDER: '', RADAR_SEARCH_API_KEY: '' });
    console.log('已清空搜索配置');
    return;
  }
  const [provider, key] = args;
  const p = String(provider || '').toLowerCase();
  if (!p || !PROVIDERS.includes(p)) {
    console.error('用法：node scripts\\set_search.cjs <provider> [api_key]');
    console.error('provider：' + PROVIDERS.join(' / '));
    console.error('（duckduckgo 免 key，api_key 可省略；也可以用 --provider-only 单独切后端）');
    process.exit(1);
  }
  if (NEED_KEY.includes(p) && !key) {
    console.error(`${p} 需要 api_key。`);
    console.error('不想注册就用免 key 的：node scripts\\set_search.cjs duckduckgo');
    process.exit(1);
  }
  const { text } = readEnv();
  writeEnv(text, {
    RADAR_SEARCH_PROVIDER: p,
    RADAR_SEARCH_API_KEY: key || '',
  });
  console.log('已写入 data/radar.env（key 不打印）');
  status();
  console.log('\n下一步：刷新看板的「CFO 问答」页即可提问，**不需要重启服务**。');
  console.log('提示：搜索有独立限流（默认 3 次/分钟/IP），避免把当月额度打光。');
}

main();
