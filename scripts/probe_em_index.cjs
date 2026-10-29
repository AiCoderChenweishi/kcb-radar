'use strict';
const https = require('https');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
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
(async () => {
  // A) 科创50 指数（沪市 1.000688）与科创综指（沪市 1.000680 附近）
  for (const [name, secid] of [['科创50', '1.000688'], ['科创综指', '1.000680'], ['科创100', '1.000698']]) {
    const r = await get(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f116,f117,f86`);
    try {
      const j = JSON.parse(r.body);
      const d = j.data;
      if (d) {
        console.log(`[${name}] ${d.f58} 价=${(d.f43/100).toFixed(2)} 涨跌=${(d.f170/100).toFixed(2)}% 涨跌幅=${(d.f169/100).toFixed(2)}% 成交额=${(d.f48/1e8).toFixed(1)}亿 昨收=${(d.f60/100).toFixed(2)}`);
      } else console.log(`[${name}] no data: ${r.body.slice(0, 120)}`);
    } catch (e) { console.log(`[${name}] ERR`, r.body.slice(0, 120)); }
  }

  // B) 东财 7x24 快讯
  const r2 = await get('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=345&order=1&needInteractData=0&page_index=1&page_size=10&req_trace=1&fields=code,showTime,title,mediaName,summary,url,uniqueUrl,Np_dst&types=1,20');
  console.log('\n[7x24快讯] HTTP', r2.status, 'len', r2.body.length);
  try {
    const j = JSON.parse(r2.body);
    const list = (j.data && j.data.list) || [];
    console.log('  条数:', list.length);
    if (list[0]) console.log('  样例:', JSON.stringify(list[0]).slice(0, 400));
  } catch (e) { console.log('  ERR', r2.body.slice(0, 200)); }

  // C) 东财 全球财经快讯（另一列）
  const r3 = await get('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=350&order=1&needInteractData=0&page_index=1&page_size=5&req_trace=1&fields=code,showTime,title,mediaName,summary,url&types=1,20');
  console.log('\n[快讯 col=350] HTTP', r3.status);
  try {
    const j = JSON.parse(r3.body);
    const list = (j.data && j.data.list) || [];
    console.log('  条数:', list.length, list[0] ? '| ' + String(list[0].title).slice(0, 60) : '');
  } catch (e) { console.log('  ERR', r3.body.slice(0, 150)); }
})();
