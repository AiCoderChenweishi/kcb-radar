'use strict';
// 东财研报中心参数排查：近期数据稀薄是参数问题还是数据问题
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

const R = 'https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&industry=*&rating=*&ratingChange=*';

const tries = [
  ['A 7天 p=1 pageNum=1', R + '&pageSize=100&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1'],
  ['B 7天 去 p/pageNum', R + '&pageSize=100&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode='],
  ['C 7天 qType=1', R + '&pageSize=100&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=1&orgCode=&code=*&rcode=&p=1&pageNum=1'],
  ['D 7天 带 sortField', R + '&pageSize=100&beginTime=2026-10-14&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1&sortField=&sortType='],
  ['E 无日期 pageNo=1', R + '&pageSize=100&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1'],
  ['F 90天 pageNo=1 看日期分布', R + '&pageSize=100&beginTime=2026-07-23&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1'],
  ['G 单只 688008 90天', R + '&pageSize=50&beginTime=2026-07-23&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=688008&rcode=&p=1&pageNum=1'],
  ['H 单只 688041 90天', R + '&pageSize=50&beginTime=2026-07-23&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=688041&rcode=&p=1&pageNum=1'],
];

(async () => {
  for (const [label, url] of tries) {
    const b = await get(url);
    try {
      const j = JSON.parse(b);
      const d = j.data || [];
      const byDate = {};
      for (const x of d) { const dd = String(x.publishDate || '').slice(0, 10); byDate[dd] = (byDate[dd] || 0) + 1; }
      const kc = d.filter((x) => String(x.stockCode || '').startsWith('688'));
      const dates = Object.keys(byDate).sort();
      console.log(`${label.padEnd(30)} hits=${String(j.hits).padStart(5)} 返回=${String(d.length).padStart(4)} 科创板=${String(kc.length).padStart(3)} 日期跨度=${dates[0]}~${dates[dates.length-1]}`);
      if (d.length) console.log(`      分布: ${dates.slice(0, 6).map((x) => x + ':' + byDate[x]).join(' ')}`);
    } catch (e) { console.log(`${label.padEnd(30)} ERR ${String(b).slice(0, 110)}`); }
  }
})();
