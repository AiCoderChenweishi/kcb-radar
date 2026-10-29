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
const names = [
  'RPT_F10_FINANCE_MAINFINADATA', 'RPT_F10_FINANCE_MAINFINA', 'RPT_F10_FINANCE_GINCOMEQC',
  'RPT_F10_FINANCE_MAINFINADATA_NEW', 'RPT_F10_FINANCE_BENEFIT', 'RPT_F10_FINANCE_ZCFZ',
  'RPT_DMSK_FN_MAINFINADATA', 'RPT_LICO_FN_CPD', 'RPT_F10_FINANCE_GINCOMEBAL',
];
(async () => {
  for (const n of names) {
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=${n}&columns=ALL&filter=(SECUCODE%3D%22688008.SH%22)&pageNumber=1&pageSize=1&source=HSF10&client=PC`;
    try {
      const j = JSON.parse(await get(url));
      if (j.success && j.result && j.result.data && j.result.data[0]) {
        const row = j.result.data[0];
        const ks = Object.keys(row);
        const hit = ks.filter((k) => /ROE|RATIO|MARGIN|TOTAL_ASSETS|EPS|BPS/i.test(k));
        console.log(`✅ ${n}  字段${ks.length}  命中: ${hit.slice(0, 12).join(', ')}`);
        if (hit.length) {
          for (const k of hit.slice(0, 10)) console.log(`      ${k} = ${JSON.stringify(row[k])}`);
        }
      } else {
        console.log(`❌ ${n}  ${(j && j.message) || 'no data'}`);
      }
    } catch (e) { console.log(`❌ ${n}  ${e.message.slice(0, 60)}`); }
  }
})();
