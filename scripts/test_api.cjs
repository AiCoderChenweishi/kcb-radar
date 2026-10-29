'use strict';
// 看板 API 验证
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:7788${path}`, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

(async () => {
  const r = await get('/api/brief');
  console.log('HTTP', r.status, 'bytes', r.body.length);
  const j = JSON.parse(r.body);
  console.log('date=', j.date, '| latestDate=', j.latestDate, '| companies=', j.coverage.total);
  console.log('覆盖: 财务', j.coverage.withFinancials, '/ 估值', j.coverage.withValuation,
    '/ PE分位', j.coverage.withPercentile, '/ 要闻', j.coverage.withNews,
    '/ 研报', j.coverage.withResearch, '/ 公告', j.coverage.withNotice);
  console.log('条目: 要闻', j.coverage.newsItems, '研报', j.coverage.researchItems, '公告', j.coverage.noticeItems);
  console.log('高信号', j.highlights.length, '| trending', j.trending.length);
  console.log('市场宽度:', JSON.stringify(j.market.breadth));
  console.log('指数:', JSON.stringify(j.market.index));
  console.log('\n--- Top 高信号 ---');
  for (const h of j.highlights.slice(0, 5)) {
    console.log(`${h.name}(${h.code}) score=${h.score} PE=${h.valuation.pe_ttm} 分位=${h.valuation.pe_percentile} :: ${h.signals.slice(0, 3).map((s) => s.label).join(' | ')}`);
  }
  console.log('\n--- 研报样例 ---');
  for (const x of j.researchFeed.slice(0, 4)) {
    console.log(`[${x.kind}] ${x.date} ${x.name} 券商=${x.broker || '-'} 评级=${x.rating || '-'} 目标价=${x.target_price ?? '-'} 机构数=${x.institution_count ?? '-'}`);
    console.log('   ' + String(x.title).slice(0, 70));
  }
  console.log('\n--- 要闻样例 ---');
  for (const x of j.newsFeed.slice(0, 3)) console.log(`${x.date} ${x.name} :: ${String(x.title).slice(0, 60)}`);
  console.log('\n--- 公告样例 ---');
  for (const x of j.noticeFeed.slice(0, 3)) console.log(`${x.date} ${x.name} :: ${String(x.title).slice(0, 70)}`);

  const c = await get('/api/company?code=' + (j.companies[0] ? j.companies[0].code : ''));
  console.log('\n/api/company ->', c.status, c.body.length, 'bytes');
})();
