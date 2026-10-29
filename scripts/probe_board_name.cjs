'use strict';
/**
 * 验证：东财数据中心 RPT_LICO_FN_CPD 的 BOARD_NAME 是否就是当前数据集用的申万二级口径。
 * 若是 → 可以把行业口径钉死在这个源（datacenter 域名，不受 push2 封禁影响）。
 */
const https = require('https');

const CODES = [
  ['688008', '澜起科技', '半导体'],
  ['688004', '博彦科技', 'IT服务Ⅱ'],
  ['688001', '华兴源创', '通用设备'],
  ['688010', '澜起科技?688010', '光学光电子'],
];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  for (const [bare, name, expect] of CODES) {
    const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
      + '?reportName=RPT_LICO_FN_CPD&columns=ALL'
      + `&filter=(SECUCODE%3D%22${bare}.SH%22)&pageNumber=1&pageSize=1`
      + '&sortColumns=REPORTDATE&sortTypes=-1&source=HSF10&client=PC';
    try {
      const j = await getJson(url);
      const d = (((j || {}).result || {}).data || [])[0] || {};
      console.log(`${bare} ${name}: BOARD_NAME="${d.BOARD_NAME || ''}"  (当前数据集口径应为 "${expect}")`);
    } catch (e) {
      console.log(`${bare} ${name}: 请求失败 ${e.message}`);
    }
  }
})();
