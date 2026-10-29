'use strict';
/**
 * 把雷达数据同步到 Mini App（kcb-intel）并生成发布清单。
 * 实际的小程序发布由调用方用 miniapp publish 完成。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadDataset, latestDate } = require('../src/store');
const { build } = require('../src/board');

const ROOT = path.join(__dirname, '..');
const MINI_ROOT = path.join(ROOT, '..');
const CLIENT_DIR = path.join(MINI_ROOT, 'miniapps', 'kcb-intel', 'miniapp', 'client');

function main() {
  const date = process.argv[2] || latestDate();
  if (!date) { console.error('没有可用数据日期'); process.exit(1); }
  const ds = loadDataset(date);
  if (!ds) { console.error(`未找到 ${date} 的数据`); process.exit(1); }

  const board = build(ds);

  const dataDir = path.join(CLIENT_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(board), 'utf8');

  // 简报 markdown：优先判断层，没有则用基线版兜底
  // （2026-10-22：判断层缺失时只有 brief-baseline-<日期>.md，
  //   原来不拷 → Mini App 里当天没有简报可看）
  const briefJudged = path.join(ROOT, 'out', `brief-${date}.md`);
  const briefBase = path.join(ROOT, 'out', `brief-baseline-${date}.md`);
  const briefSrc = fs.existsSync(briefJudged) ? briefJudged : briefBase;
  if (fs.existsSync(briefSrc)) {
    fs.copyFileSync(briefSrc, path.join(dataDir, `brief-${date}.md`));
    console.log(`简报副本: ${path.basename(briefSrc)} -> brief-${date}.md`);
  } else {
    console.log('⚠ 未找到任何简报文件（判断层与基线版都缺），Mini App 将无当日简报');
  }

  // cache busting：静态资源 token
  const assetsDir = path.join(CLIENT_DIR, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const token = files.map((f) =>
    crypto.createHash('md5').update(fs.readFileSync(path.join(assetsDir, f))).digest('hex').slice(0, 8)
  ).join('').slice(0, 8);

  const htmlFile = path.join(CLIENT_DIR, 'index.html');
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, 'utf8').replace(/(\?v=)[0-9a-f]+/gi, '$1' + token);
    fs.writeFileSync(htmlFile, html, 'utf8');
  }

  // client 资源是否变更 —— 只有改了前端代码才需要重新 publish；
  // 纯数据更新由运行时的 node 服务每次请求读盘，刷新浏览器即生效。
  const baselineFile = path.join(ROOT, 'data', 'miniapp-assets-baseline.json');
  const assetsHash = crypto.createHash('md5')
    .update(files.map((f) => f + ':' + crypto.createHash('md5').update(fs.readFileSync(path.join(assetsDir, f))).digest('hex')).join('|'))
    .digest('hex');
  let assetsChanged = false;
  if (fs.existsSync(baselineFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
      assetsChanged = prev.assetsHash !== assetsHash;
    } catch { assetsChanged = true; }
  } else {
    assetsChanged = true; // 首次运行：无基线，视为需发布一次
  }

  const manifest = {
    date,
    at: new Date().toISOString(),
    packagePath: path.join(MINI_ROOT, 'miniapps', 'kcb-intel'),
    clientDir: CLIENT_DIR,
    dataFile: path.join(dataDir, 'latest.json'),
    dataDate: board.date,
    companies: board.meta.universe,
    focus: board.meta.focusCount,
    assetToken: token,
    // 数据已写入磁盘（data/latest.json + brief-<date>.md）
    dataStaged: true,
    dataStagedAt: new Date().toISOString(),
    // 运行时每次请求从磁盘直读数据文件，cache-control: no-cache
    // ⇒ 每日只需刷新浏览器，不需要重新 publish
    runtimeServesFromDisk: true,
    // 前端资源是否变更：变了才需要 miniapp publish 重启运行时
    assetsChanged,
    republishRequired: assetsChanged,
    publishCommand: assetsChanged
      ? 'miniapp publish --plugin-id kcb-intel --source-path <packagePath>'
      : '(前端资源未变更，无需重新发布；运行时已从磁盘直读当日数据)',
  };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({ assetsHash, token, at: manifest.at }, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'data', 'publish-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(JSON.stringify(manifest, null, 2));
}

main();
