'use strict';
/**
 * 诊断：14:19 那次全量采集前后，数据集与已发布简报的口径差异。
 *
 * 背景：14:17:47 有一次 POST /api/collect，14:19:49 写盘，重写了 10-22 数据集
 * （要闻 5507→5648，行业 76→46）。已发布的 10-22 基线简报是 13:50 生成的，
 * 基于旧数据 → 必须核对关键数字是否还对得上。
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, listDates } = require('../src/store');

const ROOT = path.join(__dirname, '..');
const dates = listDates();

for (const d of dates) {
  const ds = loadDataset(d);
  const inds = new Set((ds.companies || []).map((c) => c.industry).filter(Boolean));
  let news = 0, notice = 0, research = 0, withNews = 0;
  for (const c of ds.companies || []) {
    news += (c.news || []).length;
    notice += (c.notices || []).length;
    research += (c.research || []).length;
    if ((c.news || []).length) withNews++;
  }
  console.log(`${d}: 公司=${(ds.companies || []).length} 行业=${inds.size} 要闻=${news} 覆盖=${withNews} 公告=${notice} 研报=${research}`);
}

// 已发布的基线简报里的关键数字
const briefPath = path.join(ROOT, 'out', 'brief-baseline-2026-10-22.md');
if (fs.existsSync(briefPath)) {
  const md = fs.readFileSync(briefPath, 'utf8');
  const st = fs.statSync(briefPath);
  console.log(`\n基线简报: ${path.basename(briefPath)}  ${st.size}B  mtime=${st.mtime.toLocaleString('zh-CN')}`);
  const picks = [
    /要闻[^0-9]{0,12}([0-9,]+)\s*条/g,
    /覆盖[^0-9]{0,12}([0-9,]+)\s*家/g,
    /([0-9,]+)\s*家\s*公司/g,
  ];
  const seen = new Set();
  for (const re of picks) {
    let m;
    while ((m = re.exec(md)) !== null) {
      const line = md.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).replace(/\n/g, ' ');
      const k = m[0].trim() + '|' + m[1];
      if (!seen.has(k)) { seen.add(k); console.log('  ·', m[0].trim(), '→', line.trim().slice(0, 110)); }
      if (seen.size > 18) break;
    }
  }
} else {
  console.log('\n未找到基线简报');
}

// digest 里的要闻数（摘要层）
const dg = path.join(ROOT, 'out', 'digest-2026-10-22.json');
if (fs.existsSync(dg)) {
  const j = JSON.parse(fs.readFileSync(dg, 'utf8'));
  console.log('\ndigest:', path.basename(dg), 'mtime=', fs.statSync(dg).mtime.toLocaleString('zh-CN'));
  console.log('  coverage=', JSON.stringify(j.coverage));
  console.log('  industryStats 数=', (j.industryStats || []).length);
}
