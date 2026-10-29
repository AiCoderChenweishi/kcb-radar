'use strict';
// 找免费的历史估值分位数据源（东财估值分析类报表）
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', Referer: 'https://data.eastmoney.com/' };

function get(url) {
  return new Promise((r) => {
    const q = https.get(url, { headers: H, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b)); });
    q.on('error', (e) => r('ERR ' + e.message));
    q.on('timeout', () => { q.destroy(); r('timeout'); });
  });
}

const reports = [
  'RPT_VALUEANALYSIS_DET', 'RPT_VALUEANALYSIS_DET', 'RPT_VALUATION_DET',
  'RPT_VALUEANALYSIS', 'RPT_STOCK_VALUATION', 'RPT_VALUEANALYSIS_YEAR',
];

(async () => {
  for (const rep of reports) {
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=${rep}`
      + '&columns=ALL&filter=(SECUCODE%3D%22688008.SH%22)&pageNumber=1&pageSize=3&source=HSF10&client=PC';
    const b = await get(url);
    try {
      const j = JSON.parse(b);
      const d = j.result && j.result.data;
      if (d && d.length) {
        console.log(`\n✅ ${rep}  count=${j.result.count} 字段${Object.keys(d[0]).length}`);
        console.log('  keys:', Object.keys(d[0]).join(', '));
        console.log('  样例:', JSON.stringify(d[0]).slice(0, 700));
      } else {
        console.log(`❌ ${rep}  ${(j && j.message) || 'no data'}`);
      }
    } catch (e) { console.log(`❌ ${rep}  ${String(b).slice(0, 90)}`); }
  }
})();
