'use strict';
// 把最新浏览器截图复制到工程 docs 目录（作为交付物留档）
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(process.env.USERPROFILE, '.minimax', 'v2', 'assets', '2026', '10', '21');
const OUT = path.join(__dirname, '..', 'docs');

const picks = [
  { match: '18-06-15-170', out: 'dashboard-events.png' },
  { match: '17-52-40-348', out: 'dashboard-sellside.png' },
  { match: '17-40-32-257', out: 'dashboard-valuation.png' },
  { match: '17-23-16-690', out: 'dashboard-overview.png' },
  { match: '17-21-38-892', out: 'dashboard-research.png' },
];

const files = fs.readdirSync(ASSETS).filter((f) => f.includes('browser-screenshot.png'));
for (const p of picks) {
  const f = files.find((x) => x.includes(p.match));
  if (!f) { console.log('· 未找到', p.match); continue; }
  const dst = path.join(OUT, p.out);
  fs.copyFileSync(path.join(ASSETS, f), dst);
  console.log(`✓ ${p.out}  ${(fs.statSync(dst).size / 1024).toFixed(0)}KB`);
}
