'use strict';
const https = require('https');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://data.eastmoney.com/',
  Accept: '*/*',
};
function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: HEADERS, timeout: 20000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}
const C = 'SECURITY_CODE%2CSECURITY_NAME_ABBR%2CREPORT_DATE%2CTOTAL_OPERATE_INCOME%2CPARENT_NETPROFIT%2CWEIGHTAVG_ROE%2CPARENT_NETPROFIT_YOY%2CTOTAL_OPERATE_INCOME_YOY%2CBPS%2CPE_TTM%2CPB_MRQ%2CTOTAL_MARKET_CAP';
const tries = [
  ['securities api 业绩报表', `https://datacenter.eastmoney.com/securities/api/data/get?type=RPT_LICO_FN_CPD&sty=ALL&filter=(SECURITY_CODE%3D%22688008%22)&p=1&ps=5&sr=-1&st=REPORT_DATE&source=HSF10&client=PC`],
  ['datacenter-web 无 filter', `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=${C}&pageNumber=1&pageSize=5&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`],
  ['datacenter-web 业绩快报', `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=${C}&filter=(SECURITY_CODE%3D%22688008%22)&pageNumber=1&pageSize=5&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`],
  ['F10 主要指标', `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GINCOME&columns=ALL&filter=(SECUCODE%3D%22688008.SH%22)&pageNumber=1&pageSize=3&source=HSF10&client=PC`],
  ['业绩报表 全部市场', `https://datacenter.eastmoney.com/securities/api/data/get?type=RPT_LICO_FN_CPD&sty=ALL&filter=&p=1&ps=3&sr=-1&st=REPORT_DATE&source=HSF10&client=PC`],
];
(async () => {
  for (const [label, url] of tries) {
    const r = await get(url);
    let info = '';
    try {
      const j = JSON.parse(r.body);
      const d = j.result && (j.result.data || j.result.datas);
      info = `success=${j.success} msg=${j.message || j.msg || ''} count=${j.result && j.result.count} got=${d ? d.length : 0}`;
      if (d && d[0]) info += '\n   keys: ' + Object.keys(d[0]).slice(0, 26).join(',');
    } catch (e) { info = 'parse err: ' + r.body.slice(0, 120); }
    console.log(`[${label}] HTTP ${r.status} ${info}`);
  }
})();
