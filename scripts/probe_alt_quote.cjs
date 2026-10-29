'use strict';
const https = require('https');

function t(url, headers) {
  return new Promise((r) => {
    const req = https.get(url, { headers: headers || {}, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => r({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => r({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); r({ status: 0, body: 'timeout' }); });
  });
}

(async () => {
  // 腾讯：一次可查多只，返回分号分隔
  const r1 = await t('https://qt.gtimg.cn/q=sh688008,sh688001,sh688176', { Referer: 'https://gu.qq.com/' });
  console.log('=== 腾讯 qt.gtimg.cn HTTP', r1.status, 'len', r1.body.length);
  console.log(r1.body.slice(0, 700));
  console.log();

  // 新浪
  const r2 = await t('https://hq.sinajs.cn/list=sh688008,sh688001', { Referer: 'https://finance.sina.com.cn/' });
  console.log('=== 新浪 hq.sinajs.cn HTTP', r2.status, 'len', r2.body.length);
  console.log(r2.body.slice(0, 500));
})();
