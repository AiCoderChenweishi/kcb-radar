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
  // A) 公告 API：试日期参数 + 科创板过滤
  const tries = [
    ['日期参数 begin/end', 'https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=50&page_index=1&ann_type=A&client_source=web&stock_list=&f_node=0&s_node=0&begin_time=2026-10-20&end_time=2026-10-22'],
    ['板块参数', 'https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=50&page_index=1&ann_type=A&client_source=web&stock_list=&f_node=1&s_node=0'],
    ['无参数', 'https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=50&page_index=1&ann_type=A&client_source=web'],
  ];
  for (const [label, url] of tries) {
    try {
      const r = await get(url);
      const j = JSON.parse(r.body);
      const list = (j.data && j.data.list) || [];
      const dates = list.map((x) => (x.notice_date || x.date || '').slice(0, 10));
      const kc = list.filter((x) => ((x.codes || [])[0] || {}).stock_code || '').filter((x) => ((x.codes[0]||{}).stock_code||'').startsWith('688'));
      console.log(`[${label}] total=${j.data && j.data.total_hits} got=${list.length} 日期范围=${dates[0]}~${dates[dates.length-1]} 科创板=${kc.length}`);
      if (kc[0]) console.log('   科创板样例:', kc[0].title.slice(0, 50), '|', kc[0].codes[0].stock_code, '|', kc[0].notice_date);
    } catch (e) { console.log(`[${label}] ERR`, e.message); }
  }

  // B) 财务数据（datacenter 批量）
  const finUrl = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE%2CSECURITY_NAME_ABBR%2CTOTAL_OPERATE_INCOME%2CPARENT_NETPROFIT%2CWEIGHTAVG_ROE%2CBPS%2CPARENT_NETPROFIT_YOY%2CTOTAL_OPERATE_INCOME_YOY&filter=(SECURITY_CODE%3D%22688008%22)&pageNumber=1&pageSize=10&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB';
  try {
    const r = await get(finUrl);
    const j = JSON.parse(r.body);
    console.log('\n[财务 datacenter] success=', j.success, 'result=', j.result && j.result.data ? j.result.data.length : 0);
    if (j.result && j.result.data && j.result.data[0]) console.log('  样例:', JSON.stringify(j.result.data[0]).slice(0, 500));
  } catch (e) { console.log('\n[财务 datacenter] ERR', e.message); }

  // C) 财务：科创板全市场批量（不按个股）
  const allFin = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE%2CSECURITY_NAME_ABBR%2CTOTAL_OPERATE_INCOME%2CPARENT_NETPROFIT%2CWEIGHTAVG_ROE%2CPARENT_NETPROFIT_YOY%2CTOTAL_OPERATE_INCOME_YOY&filter=(REPORTDATE%3D%272026-09-30%27)&pageNumber=1&pageSize=5&sortColumns=SECURITY_CODE&sortTypes=1&source=WEB&client=WEB';
  try {
    const r = await get(allFin);
    const j = JSON.parse(r.body);
    console.log('\n[财务 全市场] success=', j.success, 'count=', j.result && j.result.count, 'pages=', j.result && j.result.pages);
    if (j.result && j.result.data && j.result.data[0]) console.log('  样例:', JSON.stringify(j.result.data[0]).slice(0, 400));
  } catch (e) { console.log('\n[财务 全市场] ERR', e.message); }

  // D) 个股新闻
  try {
    const r = await get('https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22%E6%BE%9C%E8%B5%B7%E7%A7%91%E6%8A%80%22%2C%22type%22%3A%5B%22cmsArticleWebOld%22%5D%2C%22client%22%3A%22web%22%2C%22clientType%22%3A%22web%22%2C%22clientVersion%22%3A%22curr%22%2C%22param%22%3A%7B%22cmsArticleWebOld%22%3A%7B%22searchScope%22%3A%22default%22%2C%22sort%22%3A%22default%22%2C%22pageIndex%22%3A1%2C%22pageSize%22%3A10%7D%7D%7D');
    console.log('\n[个股新闻] HTTP', r.status, 'len', r.body.length, '|', r.body.slice(0, 200).replace(/\n/g, ' '));
  } catch (e) { console.log('\n[个股新闻] ERR', e.message); }
})();
