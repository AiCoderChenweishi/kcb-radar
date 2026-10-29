'use strict';
/**
 * 把 Web 应用部署到稳定位置。
 *
 * 为什么必须部署：会话工作区（.minimax\sessions\<id>\workspace）会被回收，
 * 而每日 07:30 的定时采集需要长期存活的代码与数据目录。
 * 稳定位置 = Bot 团队的工作目录，Bot 的默认工作目录已经指向那里。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const DST = process.argv[2] ||
  path.join(process.env.USERPROFILE, '.minimax', 'agents', 'mavis', 'miniapps', 'minimax-bot', 'web');

const DIRS = ['src', 'public', 'scripts', 'docs'];
const FILES = ['package.json'];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  fs.mkdirSync(DST, { recursive: true });
  for (const d of DIRS) {
    const s = path.join(SRC, d);
    if (fs.existsSync(s)) { copyDir(s, path.join(DST, d)); console.log(`✓ ${d}/`); }
  }
  for (const f of FILES) {
    const s = path.join(SRC, f);
    if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(DST, f)); console.log(`✓ ${f}`); }
  }
  // 名单缓存：没有的话下次采集会自动重拉
  const listSrc = path.join(SRC, 'data', 'star_market_list.csv');
  if (fs.existsSync(listSrc)) {
    fs.mkdirSync(path.join(DST, 'data'), { recursive: true });
    fs.copyFileSync(listSrc, path.join(DST, 'data', 'star_market_list.csv'));
    console.log('✓ data/star_market_list.csv');
  }
  // 已有采集结果**不**从工作区带过去：
  // 稳定位置的 data/daily 才是数据真源，工作区只是开发时的临时副本。
  // 早期版本会覆盖，曾把 619 家的数据集冲成 12 家的调试数据。
  const daily = path.join(DST, 'data', 'daily');
  if (fs.existsSync(daily)) {
    const files = fs.readdirSync(daily);
    console.log(`· 保留稳定位置已有采集数据（${files.length} 份），不覆盖`);
  }
  console.log(`\n部署完成 → ${DST}`);
}

main();
