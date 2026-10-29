'use strict';
// 查东财研报中心：为什么全市场 7 天只有 97 篇？是不是参数用法不对？
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', Referer: 'https://data.eastmoney.com/report/' };

function get(url) {
  return new Promise((r) => {
    const q = https.get(url, { headers: H, timeout: 25000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b)); });
    q.on('error', (e) => r('ERR ' + e.message));
    q.on('timeout', () => { q.destroy(); r('timeout'); });
  });
}

const base = (q) => 'https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&industry=*&rating=*&ratingChange=*' + q;

const tries = [
  ['code=* 7天 pageSize=200', base('&pageSize=200&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1')],
  ['code= 空 7天', base('&pageSize=200&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=&rcode=&p=1&pageNum=1')],
  ['code=* 30天', base('&pageSize=200&beginTime=2026-09-21&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1')],
  ['code=* 90天', base('&pageSize=200&beginTime=2026-07-23&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1')],
  ['pageNo=2 7天', base('&pageSize=200&beginTime=2026-10-14&endTime=2026-10-21&pageNo=2&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=2')],
  ['单只 688008 30天', base('&pageSize=50&beginTime=2026-09-21&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=688008&rcode=&p=1&pageNum=1')],
  ['单只 688008.SH 30天', base('&pageSize=50&beginTime=2026-09-21&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=688008.SH&rcode=&p=1&pageNum=1')],
];

(async () => {
  for (const [label, url] of tries) {
    const b = await get(url);
    try {
      const j = JSON.parse(b);
      const d = j.data || [];
      const kc = d.filter((x) => String(x.stockCode || '').startsWith('688'));
      console.log(`${label.padEnd(26)} hits=${String(j.hits).padStart(5)} 返回=${String(d.length).padStart(4)} 科创板=${String(kc.length).padStart(3)}`);
      if (d[0]) console.log(`      样例: ${d[0].stockCode} ${d[0].stockName} | ${d[0].orgSName} | ${String(d[0].title).slice(0, 34)} | ${String(d[0].publishDate).slice(0, 10)}`);
    } catch (e) { console.log(`${label.padEnd(26)} ERR ${String(b).slice(0, 110)}`); }
  }
})();
