'use strict';
const https = require('https');

function t(url, headers) {
  return new Promise((r) => {
    const req = https.get(url, { headers: headers || {}, timeout: 20000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => r({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => r({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); r({ status: 0, body: 'timeout' }); });
  });
}

(async () => {
  const codes = ['sh688008', 'sh688001', 'sh688176', 'sh688012', 'sh688036'];
  const url = 'https://qt.gtimg.cn/q=' + codes.join(',');
  const r = await t(url, { Referer: 'https://gu.qq.com/' });
  console.log('HTTP', r.status, 'len', r.body.length);
  const line = r.body.split('\n')[0];
  const inner = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
  const f = inner.split('~');
  console.log('字段数:', f.length);
  const labels = { 3: '现价', 4: '昨收', 5: '今开', 30: '涨跌', 31: '涨跌幅', 32: '最高', 33: '最低', 36: '换手率', 37: 'PE(TTM)', 41: '振幅', 42: '流通市值', 43: '总市值', 44: '市净率', 45: '涨停价', 46: '跌停价' };
  for (const k of Object.keys(labels)) console.log(`  [${k}] ${labels[k]} = ${f[k]}`);

  // 批量压力测试：一次 60 只
  const many = Array.from({ length: 60 }, (_, i) => 'sh688' + String(i).padStart(3, '0'));
  const r2 = await t('https://qt.gtimg.cn/q=' + many.join(','), { Referer: 'https://gu.qq.com/' });
  const lines = r2.body.split('\n').filter((x) => x.includes('v_sh'));
  const ok = lines.filter((x) => !/"";/.test(x) && x.length > 50);
  console.log('\n批量 60 只: HTTP', r2.status, '返回行数', lines.length, '有效', ok.length);
})();
