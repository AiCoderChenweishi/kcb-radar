'use strict';
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
  // A) 研报：一周数据量与分页
  for (const days of [[3, '2026-10-19', '2026-10-21'], [7, '2026-10-15', '2026-10-21']]) {
    const [label, b, e] = days;
    const r = await get(`https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&pageSize=100&industry=*&rating=*&ratingChange=*`
      + `&beginTime=${b}&endTime=${e}&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1`);
    const j = JSON.parse(r.body);
    const kc = (j.data || []).filter((x) => String(x.stockCode).startsWith('688'));
    console.log(`研报 ${label}天: hits=${j.hits} 返回=${(j.data||[]).length} 科创板=${kc.length} totalPage=${j.totalPage}`);
    if (kc[0]) console.log('  科创板样例:', JSON.stringify(kc[0]).slice(0, 700));
  }

  // B) 研报详情（含目标价？）
  const r0 = await get(`https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&pageSize=3&industry=*&rating=*&ratingChange=*`
    + `&beginTime=2026-10-19&endTime=2026-10-21&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1`);
  const j0 = JSON.parse(r0.body);
  const sample = (j0.data || [])[0];
  if (sample) {
    console.log('\n=== 研报字段全集 ===');
    console.log(Object.keys(sample).join(', '));
    console.log('\n=== 单条研报 ===');
    console.log(JSON.stringify(sample, null, 1).slice(0, 2200));
  }

  // C) 全市场公告（不带 stock_list）
  const r3 = await get('https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=10&page_index=1&ann_type=A&client_source=web&stock_list=&f_node=0&s_node=0');
  console.log('\n=== 全市场公告 HTTP', r3.status, 'len', r3.body.length);
  try {
    const j = JSON.parse(r3.body);
    console.log('  total:', j.data && j.data.total_hits, '| got:', ((j.data && j.data.list) || []).length);
    const l = ((j.data && j.data.list) || [])[0];
    if (l) console.log('  sample:', JSON.stringify({ title: l.title, date: l.notice_date, codes: l.codes, columns: (l.columns||[]).map(c=>c.column_name) }));
  } catch (e) { console.log('  parse err', r3.body.slice(0, 200)); }
})();
