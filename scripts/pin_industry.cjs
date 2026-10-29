'use strict';
/**
 * 一次性动作：建立行业分类缓存（申万二级），并把历史数据集的行业字段回填成同一口径。
 *
 * 为什么必须做：
 * 2026-10-21 数据集用的是东财 EM2016 末级（76 类），2026-10-22 用的是申万二级（46 类），
 * 根因是行业标签被行情源（push2 f100）覆写，而 push2 会被封。
 * 不统一 → 行业筛选跨天漏公司、行业分布口径漂移、跨日差分把分类变化误读成"公司换行业"。
 *
 * 步骤：
 *   1. 拉 619 家的 BOARD_NAME（datacenter 源，与 push2 不同域名体系）→ data/industries.json
 *   2. 逐份数据集比对：只有与钉死口径不同的才回填（并打印明细）
 *   3. 写入回填记录 data/industry-backfill.json（可追溯）
 *
 * 用法：node scripts\pin_industry.cjs [--dry]
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, listDates, datasetPath } = require('../src/store');
const industry = require('../src/industry');
const profile = require('../src/profile');

const DRY = process.argv.includes('--dry');
const ROOT = path.join(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'data', 'industry-backfill.json');

(async () => {
  console.log('=== 1. 拉取行业分类（申万二级 / datacenter 源）===');
  const { loadCached } = require('../src/universe');
  const companies = loadCached();
  console.log(`公司数：${companies.length}`);

  const r = await industry.fetchIndustries(companies, (m) => console.log('  ' + m), { concurrency: 8 });
  const map = r.map;
  const vals = new Set(Object.values(map).filter(Boolean));
  console.log(`缓存结果：${Object.keys(map).length} 家，distinct 行业 ${vals.size} 个，失败 ${r.failed} 家`);
  if (r.failed) console.log('⚠ 有失败项，这些公司回填时用 F10 概况兜底（EM2016 末级）');

  if (DRY) {
    console.log('\n--dry 模式：不写数据集，仅打印差异 --');
    for (const d of listDates()) {
      const ds = loadDataset(d);
      const diff = industry.applyPinnedIndustry(JSON.parse(JSON.stringify(ds)), map, profile.readCache());
      console.log(`${d}: 需改 ${diff.length} 家；样例 ${JSON.stringify(diff.slice(0, 3))}`);
    }
    return;
  }

  console.log('\n=== 2. 回填历史数据集 ===');
  const record = { at: new Date().toISOString(), source: 'datacenter RPT_LICO_FN_CPD.BOARD_NAME', taxonomy: '申万二级', datasets: [] };
  for (const d of listDates()) {
    const ds = loadDataset(d);
    if (!ds) continue;
    const before = new Set((ds.companies || []).map((c) => c.industry).filter(Boolean));
    const changed = industry.applyPinnedIndustry(ds, map, profile.readCache());
    const after = new Set((ds.companies || []).map((c) => c.industry).filter(Boolean));
    if (changed.length) {
      fs.writeFileSync(datasetPath(d), JSON.stringify(ds), 'utf8');
      console.log(`${d}: 回填 ${changed.length} 家（行业数 ${before.size} → ${after.size}）`);
      for (const c of changed.slice(0, 5)) console.log(`    ${c.code} ${c.name}: ${c.from} → ${c.to}（${c.source}）`);
      if (changed.length > 5) console.log(`    …… 其余 ${changed.length - 5} 家从略`);
    } else {
      console.log(`${d}: 无需回填（已是钉死口径）`);
    }
    record.datasets.push({
      date: d, changed: changed.length,
      industriesBefore: before.size, industriesAfter: after.size,
      samples: changed.slice(0, 20),
    });
  }
  fs.writeFileSync(LOG_FILE, JSON.stringify(record, null, 2), 'utf8');
  console.log(`\n回填记录：${LOG_FILE}`);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
