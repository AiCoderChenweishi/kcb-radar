'use strict';
/**
 * 构建云端发布包（2026-10-29 新增）。
 *
 * **这个包里绝不能有密钥**：`data/radar.env` 里的 LLM key / 搜索 key / 写接口 token
 * 一律排除，改为在云端用**环境变量**注入（systemd EnvironmentFile）。
 * 这是硬规矩 —— 发布包一旦带上密钥，git/OSS/任何一次 scp 都会泄露。
 *
 * 包含：
 *   src/ scripts/ public/ docs/      源码与脚本
 *   data/star_market_list.csv        619 家名单（采集必需）
 *   data/industries.json             行业映射
 *   deploy/                          云端部署脚本（systemd / cron / nginx）
 * 不含：
 *   data/radar.env                   ← 密钥
 *   data/daily/ data/raw/ samples/   ← 数据由云端自己采集
 *   *.log  ask-log.jsonl             ← 日志
 *
 * 用法：node scripts\build_release.cjs [输出目录]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'release');

const INCLUDE_DIRS = ['src', 'scripts', 'public', 'docs', 'deploy'];
const INCLUDE_FILES = ['package.json'];
const INCLUDE_DATA = ['star_market_list.csv', 'industries.json'];

/** 永远不进包的东西 */
const DENY = [
  /radar\.env$/i,          // 密钥
  /\.log$/i,                // 日志
  /ask-log\.jsonl$/i,
  /^\.env/i,
  /id_rsa|\.pem$|\.key$/i, // 私钥
];

function denied(rel) {
  const base = path.basename(rel);
  if (DENY.some((re) => re.test(base))) return true;
  // node_modules / 临时目录
  if (/(^|[\\/])node_modules([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])\.tmp([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])data[\\/]daily([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])data[\\/]raw([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])data[\\/]samples([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])out([\\/]|$)/.test(rel)) return true;
  if (/(^|[\\/])release([\\/]|$)/.test(rel)) return true;
  return false;
}

function copyDir(rel) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (denied(r)) continue;
    const src = path.join(ROOT, r);
    const dst = path.join(OUT, r);
    if (e.isDirectory()) { n += copyDir(r); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    n++;
  }
  return n;
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let files = 0;
  for (const d of INCLUDE_DIRS) files += copyDir(d);
  for (const f of INCLUDE_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src) && !denied(f)) { fs.copyFileSync(src, path.join(OUT, f)); files++; }
  }
  for (const f of INCLUDE_DATA) {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
      fs.copyFileSync(src, path.join(OUT, 'data', f));
      files++;
    } else {
      console.warn(`⚠ 缺少 data/${f}（采集必需），发布包可能采不到数据`);
    }
  }

  // 密钥占位（提醒云端要填，但不写真值）
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'data', 'radar.env.example'), [
    '# 云端密钥清单（复制成 data/radar.env 或 systemd EnvironmentFile 后填写真实值）',
    '# ⚠ 真实值只放云端，别回传到本地仓库 / OSS / 聊天窗口',
    'RADAR_HOST=0.0.0.0',
    'PORT=7788',
    'RADAR_WRITE_TOKEN=',
    'RADAR_LLM_BASE_URL=https://api.deepseek.com/v1',
    'RADAR_LLM_API_KEY=',
    'RADAR_LLM_MODEL=deepseek-flash',
    'RADAR_LLM_TIMEOUT_MS=180000',
    'RADAR_LLM_TEMPERATURE=0.2',
    'RADAR_LLM_MAX_TOKENS=8000',
    'RADAR_LLM_THINKING=off',
    'RADAR_SEARCH_PROVIDER=duckduckgo',
    'RADAR_SEARCH_API_KEY=',
    'RADAR_SEARCH_MODE=auto',
    'RADAR_SEARCH_MAX_RESULTS=6',
    'RADAR_ASK_RPM=8',
    'RADAR_ASK_SEARCH_RPM=3',
    'RADAR_ASK_DAILY_CAP=300',
    '',
  ].join('\n'), 'utf8');

  // 打包
  const tgz = path.join(ROOT, 'out', `radar-release-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  fs.mkdirSync(path.dirname(tgz), { recursive: true });
  try {
    execFileSync('tar', ['-czf', tgz, '-C', path.dirname(OUT), path.basename(OUT)], { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠ tar 打包失败（Windows 上可能没有 tar），目录已就绪：' + OUT);
  }

  const size = fs.existsSync(tgz) ? fs.statSync(tgz).size : 0;
  console.log(`发布包已生成：${OUT}`);
  console.log(`  文件数：${files}`);
  console.log(`  压缩包：${tgz}${size ? `（${(size / 1024).toFixed(0)} KB）` : ''}`);
  console.log('\n✅ 已排除：radar.env（密钥）、data/daily、data/raw、日志、临时文件');
  console.log('📌 云端需要做的：把 data/radar.env.example 复制成真实 env 并填 key（见 deploy/README-部署.md）');
}

main();
