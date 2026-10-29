'use strict';
/**
 * 写入 CFO 问答页的模型接口配置（只写 data/radar.env，不进代码库）。
 *
 * 用法：
 *   node scripts\set_llm.cjs <base_url> <api_key> <model>
 *   node scripts\set_llm.cjs --check          只看当前配置状态（不打印 key）
 *   node scripts\set_llm.cjs --clear         清掉模型配置
 *
 * 说明：
 * - base_url 填到 /v1 结尾即可；不带 /v1 也会自动再试一次 /v1/chat/completions。
 * - 配置是**延迟读**的：改完不用重启看板服务，刷新页面即可生效。
 * - key 只落在这一个文件里，**不要**贴进飞书文档、截图或代码。
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', 'data', 'radar.env');
const KEYS = ['RADAR_LLM_BASE_URL', 'RADAR_LLM_API_KEY', 'RADAR_LLM_MODEL'];

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
  const ok = KEYS.every((k) => map[k]);
  console.log('模型配置状态：' + (ok ? '✅ 已配置' : '❌ 未配置'));
  for (const k of KEYS) {
    const v = map[k];
    console.log(`  ${k} = ${v ? (k === 'RADAR_LLM_API_KEY' ? '<已填写>' : v) : '<空>'}`);
  }
  if (!ok) {
    console.log('\n填法：node scripts\\set_llm.cjs <base_url> <api_key> <model>');
    console.log('例：node scripts\\set_llm.cjs https://api.deepseek.com/v1 sk-xxxx deepseek-chat');
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--check') { status(); return; }
  if (args[0] === '--clear') {
    const { text } = readEnv();
    writeEnv(text, { RADAR_LLM_BASE_URL: '', RADAR_LLM_API_KEY: '', RADAR_LLM_MODEL: '' });
    console.log('已清空模型配置');
    return;
  }
  const [base, key, model] = args;
  if (!base || !key || !model) {
    console.error('用法：node scripts\\set_llm.cjs <base_url> <api_key> <model>');
    process.exit(1);
  }
  const { text } = readEnv();
  writeEnv(text, {
    RADAR_LLM_BASE_URL: base.replace(/\/+$/, ''),
    RADAR_LLM_API_KEY: key,
    RADAR_LLM_MODEL: model,
  });
  console.log('已写入 data/radar.env（key 不打印）');
  status();
  console.log('\n下一步：刷新看板的「CFO 问答」页即可提问，**不需要重启服务**。');
}

main();
