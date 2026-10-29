'use strict';
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', Referer: 'https://data.eastmoney.com/' };
function get(url) {
  return new Promise((r) => {
    const q = https.get(url, { headers: H, timeout: 30000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b));
    });
    q.on('error', (e) => r('ERR ' + e.message));
    q.on('timeout', () => { q.destroy(); r('timeout'); });
  });
}
(async () => {
  const tries = [
    ['LICO_FN_CPD 按报告期全市场', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(REPORTDATE%3D%272026-06-30%27)&pageNumber=1&pageSize=10&sortColumns=SECURITY_CODE&sortTypes=1&source=HSF10&client=PC'],
    ['LICO_FN_CPD 无过滤', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&pageNumber=1&pageSize=10&sortColumns=SECURITY_CODE&sortTypes=1&source=HSF10&client=PC'],
    ['MAINFINADATA 按报告期全市场', 'https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(REPORT_DATE%3D%272026-06-30%27)&pageNumber=1&pageSize=10&sortColumns=SECURITY_CODE&sortTypes=1&source=HSF10&client=PC'],
  ];
  for (const [label, url] of tries) {
    const b = await get(url);
    try {
      const j = JSON.parse(b);
      const d = j.result && j.result.data;
      console.log(`\n=== ${label} ===`);
      console.log('success=', j.success, 'count=', j.result && j.result.count, 'pages=', j.result && j.result.pages, 'got=', d ? d.length : 0, 'msg=', j.message || '');
      if (d && d[0]) {
        const row = d[0];
        console.log('  样例:', JSON.stringify({
          code: row.SECURITY_CODE, name: row.SECURITY_NAME_ABBR,
          report: row.REPORT_DATE, roe: row.WEIGHTAVG_ROE || row.ROEJQ,
          rev: row.TOTAL_OPERATE_INCOME, revYoy: row.TOTAL_OPERATE_INCOME_YOY,
          np: row.PARENT_NETPROFIT, gm: row.GROSS_PROFIT_RATIO, nm: row.NET_PROFIT_RATIO,
          assets: row.TOTAL_ASSETS,
        }));
        const ks = Object.keys(row).filter((k) => /RATIO|MARGIN|TOTAL_ASSETS/i.test(k));
        console.log('  率类字段:', ks.join(', '));
      }
    } catch (e) { console.log('  parse err', b.slice(0, 200)); }
  }
})();
