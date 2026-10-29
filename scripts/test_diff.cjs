'use strict';
/**
 * 跨日差分的自测。
 *
 * 做法：把"当日"数据集复制一份作为 today，然后对**互不相同**的公司注入已知扰动，
 * 相当于模拟"今天相对昨天发生了这些变化"，逐条断言差分引擎能检出且不误报。
 *
 * 关键点：每个用例必须挑**不同的公司**。早期版本按属性挑但没去重，
 * 结果多个用例落在同一家公司上，后面的断言被前面的 if-else 分支遮蔽，
 * 出现"5 个断言假失败"。这类测试假失败比没有测试更误导。
 *
 * 用法：node scripts/test_diff.cjs
 */
const fs = require('fs');
const path = require('path');
const { loadDataset, latestDate } = require('../src/store');
const { diffDatasets } = require('../src/diff');

const real = loadDataset(latestDate());
if (!real) { console.error('没有可用数据集'); process.exit(1); }

// today = 当日数据集的扰动副本；prev = 真实的上一日（本例即同一份真实数据）
const prev = real;
const today = JSON.parse(JSON.stringify(real));
const realByCode = new Map(real.companies.map((c) => [c.code, c]));
const todayByCode = new Map(today.companies.map((c) => [c.code, c]));

const used = new Set();
/** 按属性挑一家**尚未被其他用例占用**的公司 */
function pick(pred, label) {
  const hit = real.companies.find((c) => !used.has(c.code) && (() => { try { return pred(c); } catch { return false; } })());
  if (!hit) { console.error(`用例前提不满足：找不到「${label}」`); process.exit(1); }
  used.add(hit.code);
  return hit.code;
}

const expected = {};

// 1) 营收归零（今天归零）
{
  const code = pick((c) => c.revenue != null && c.revenue !== 0, '有营收的公司');
  todayByCode.get(code).revenue = 0;
  expected.revenueZero = code;
}
// 2) PE 变号
{
  const code = pick((c) => c.valuation.pe_ttm != null && c.valuation.pe_ttm !== 0, '有 PE 的公司');
  todayByCode.get(code).valuation.pe_ttm = -Math.abs(realByCode.get(code).valuation.pe_ttm);
  expected.peFlip = code;
}
// 3) 评级变动（昨天 买入 → 今天 增持）
{
  const code = pick((c) => c.sell_side && c.sell_side.covered && c.sell_side.rating === '买入', '被覆盖且评级为买入的公司');
  todayByCode.get(code).sell_side.rating = '增持';
  expected.ratingChange = code;
}
// 4) 目标价调整
{
  const code = pick((c) => c.sell_side && c.sell_side.target_price != null, '有目标价的公司');
  todayByCode.get(code).sell_side.target_price = realByCode.get(code).sell_side.target_price * 1.3;
  expected.targetChange = code;
}
// 5) 覆盖消失
{
  const code = pick((c) => c.sell_side && c.sell_side.covered, '被覆盖的公司');
  todayByCode.get(code).sell_side.covered = false;
  expected.coverageLost = code;
}
// 6) 涨跌幅异动
{
  const code = pick(() => true, '任意公司');
  todayByCode.get(code).quote = todayByCode.get(code).quote || {};
  todayByCode.get(code).quote.change_pct = 12.5;
  expected.quoteMove = code;
}
// 7) 净利同比突变
{
  const code = pick((c) => (c.growth && c.growth.net_profit_yoy != null)
    || (c.financials && c.financials.net_profit_yoy != null), '有净利同比的公司');
  const base = (realByCode.get(code).growth && realByCode.get(code).growth.net_profit_yoy)
    ?? realByCode.get(code).financials.net_profit_yoy;
  todayByCode.get(code).growth = todayByCode.get(code).growth || {};
  todayByCode.get(code).growth.net_profit_yoy = base - 80;
  expected.growthShift = code;
}
// 8) PE 分位消失
{
  const code = pick((c) => c.valuation.pe_percentile != null, '有 PE 分位的公司');
  todayByCode.get(code).valuation.pe_percentile = null;
  expected.percentileLost = code;
}
// 9) 新增覆盖（昨天没覆盖，今天覆盖）
{
  const code = pick((c) => c.sell_side && !c.sell_side.covered, '未被覆盖的公司');
  todayByCode.get(code).sell_side = Object.assign({}, todayByCode.get(code).sell_side, {
    covered: true, broker: '测试券商', rating: '买入', date: real.date,
  });
  expected.newCover = code;
}

const d = diffDatasets(prev, today);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

console.log('=== 跨日差分自测 ===');
console.log(`数据日期 ${real.date}，公司 ${real.companies.length} 家，注入扰动 ${used.size} 家（互不相同）`);
console.log('');
console.log('检出断言：');
check('营收归零被检出', d.financialAnomalies.some((x) => x.code === expected.revenueZero && x.type === '营收归零'),
  `实际 ${JSON.stringify(d.financialAnomalies.map((x) => x.type))}`);
check('PE 变号被检出', d.valuationAnomalies.some((x) => x.code === expected.peFlip && x.type === 'PE 变号'));
check('评级变动被检出', d.sellSideChanges.some((x) => x.code === expected.ratingChange && /评级/.test(x.type)),
  `实际 ${JSON.stringify(d.sellSideChanges.map((x) => x.type))}`);
check('目标价调整被检出', d.sellSideChanges.some((x) => x.code === expected.targetChange && x.type === '目标价调整'));
check('覆盖消失被检出', d.sellSideChanges.some((x) => x.code === expected.coverageLost && x.type === '覆盖消失'));
check('新增覆盖被检出', d.sellSideChanges.some((x) => x.code === expected.newCover && x.type === '首次覆盖'));
check('涨跌幅异动被检出', d.quoteMoves.some((x) => x.code === expected.quoteMove));
check('净利同比突变被检出', d.growthShifts.some((x) => x.code === expected.growthShift));
check('PE 分位消失被检出', d.valuationAnomalies.some((x) => x.code === expected.percentileLost && x.type === 'PE 分位消失'),
  `实际 ${JSON.stringify(d.valuationAnomalies.map((x) => x.type))}`);

console.log('');
console.log('结构自检：');
check('items 非空', d.items.length > 0, `len=${d.items.length}`);
check('items 按严重度排序', d.items.every((x, i) => i === 0
  || ({ critical: 3, high: 2, medium: 1, low: 0 }[d.items[i - 1].severity] || 0)
    >= ({ critical: 3, high: 2, medium: 1, low: 0 }[x.severity] || 0)));
check('headline 不超过 12 条', d.headline.length <= 12);
check('公司总数一致（无进出）', d.added.length === 0 && d.removed.length === 0, `added=${d.added.length} removed=${d.removed.length}`);
check('每条 item 都有名字与代码', d.items.every((x) => x.name && x.code && x.type));
check('目标价无浮点噪声', d.sellSideChanges.filter((x) => x.type === '目标价调整')
  .every((x) => !/\d{6,}\.\d/.test(x.detail)), JSON.stringify(d.sellSideChanges.filter((x) => x.type === '目标价调整').map((x) => x.detail)));

console.log('');
console.log('样本 head（最多 8 条）：');
for (const h of d.headline.slice(0, 8)) console.log('  - ' + h);

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
