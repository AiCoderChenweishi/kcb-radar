'use strict';
/**
 * 验证东方财富的免费接口能否替代 iFinD 的高频调用。
 * iFinD MCP 额度有限，全量 619 家 × (要闻+公告+研报) 每天 1500 次调用会打爆额度。
 * 东方财富无此限制。
 */
const https = require('https');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://data.eastmoney.com/',
  Accept: '*/*',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, timeout: 25000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  // 1) 研报中心：支持按股票代码过滤
  const r1 = await get('https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&pageSize=10&industry=*&rating=*&ratingChange=*'
    + '&beginTime=2026-10-01&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=688008&rcode=&p=1&pageNum=1');
  console.log('=== 1) 研报 API (code=688008) HTTP', r1.status, 'len', r1.body.length);
  try {
    const j = JSON.parse(r1.body);
    console.log('  hits:', j.hits, '| totalPage:', j.totalPage);
    const d = (j.data || [])[0];
    if (d) console.log('  sample:', JSON.stringify({
      title: d.title, stockCode: d.stockCode, stockName: d.stockName,
      orgSName: d.orgSName, emRatingName: d.emRatingName,
      predictNextYearEps: d.predictNextYearEps, predictNextTwoYearEps: d.predictNextTwoYearEps,
      sRatingName: d.sRatingName, infoCode: d.infoCode, publishDate: d.publishDate,
    }));
  } catch (e) { console.log('  parse err', e.message, r1.body.slice(0, 200)); }

  // 2) 个股公告
  const r2 = await get('https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=5&page_index=1&ann_type=A&client_source=web&stock_list=688008&f_node=0&s_node=0');
  console.log('\n=== 2) 公告 API (688008) HTTP', r2.status, 'len', r2.body.length);
  try {
    const j = JSON.parse(r2.body);
    const list = (j.data && j.data.list) || [];
    console.log('  total:', j.data && j.data.total_hits, '| got:', list.length);
    if (list[0]) console.log('  sample:', JSON.stringify({
      title: list[0].title, notice_date: list[0].notice_date,
      columns: (list[0].columns || []).map((c) => c.column_name),
    }));
  } catch (e) { console.log('  parse err', e.message, r2.body.slice(0, 200)); }

  // 3) 行业研报（一次拿全市场，不按个股）
  const r3 = await get('https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&pageSize=5&industry=*&rating=*&ratingChange=*'
    + '&beginTime=2026-10-18&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1');
  console.log('\n=== 3) 全市场研报 (code=*) HTTP', r3.status, 'len', r3.body.length);
  try {
    const j = JSON.parse(r3.body);
    console.log('  hits:', j.hits);
    const d = (j.data || [])[0];
    if (d) console.log('  sample:', d.stockCode, d.stockName, '|', d.orgSName, '|', d.emRatingName, '|', String(d.title).slice(0, 40));
  } catch (e) { console.log('  parse err', e.message, r3.body.slice(0, 200)); }
})();
