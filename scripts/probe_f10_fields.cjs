'use strict';
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', Referer: 'https://emweb.securities.eastmoney.com/' };
function get(url) {
  return new Promise((r) => {
    const q = https.get(url, { headers: H, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b));
    });
    q.on('error', (e) => r('ERR ' + e.message));
  });
}
(async () => {
  const j = JSON.parse(await get('https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GINCOME&columns=ALL&filter=(SECUCODE%3D%22688008.SH%22)&pageNumber=1&pageSize=2&source=HSF10&client=PC'));
  const row = (j.result && j.result.data && j.result.data[0]) || {};
  const keys = Object.keys(row);
  console.log('字段总数:', keys.length);
  console.log('\n== 含 ROE / 率 / 资产 的字段 ==');
  for (const k of keys) {
    if (/ROE|RATIO|ASSET|EQUITY|MARGIN|ASSETS/i.test(k)) {
      console.log(`  ${k} = ${JSON.stringify(row[k])}`);
    }
  }
  console.log('\n== 营收/净利 ==');
  for (const k of ['TOTAL_OPERATE_INCOME', 'TOTAL_OPERATE_INCOME_YOY', 'PARENT_NETPROFIT', 'PARENT_NETPROFIT_YOY', 'TOTAL_OPERATE_PROFIT', 'REPORT_DATE']) {
    console.log(`  ${k} = ${JSON.stringify(row[k])}`);
  }
})();
