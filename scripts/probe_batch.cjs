'use strict';
const { callTool } = require('../src/connector');

(async () => {
  const names = ['亚虹医药', '澜起科技', '中微公司', '传音控股', '石头科技'];
  const t0 = Date.now();
  const d = await callTool('connector__thsifind__get_stock_summary', {
    query: `${names.join('、')} 最新估值水平 市值规模 盈利能力 成长能力 偿债能力 营运能力`,
  });
  console.log('elapsed_ms=', Date.now() - t0, 'len=', d.length);
  const sections = [...d.matchAll(/^# (.+)$/gm)].map((m) => m[1]);
  console.log('sections(', sections.length, '):', sections.join(' | '));
  const rows = [...d.matchAll(/^\|([^\|]+)\|([0-9]{6}\.(?:SH|SZ))\|/gm)].map((m) => m[2]);
  console.log('rows found:', rows.length, '->', [...new Set(rows)].join(','));
  const sample = d.split('\n').filter((l) => l.startsWith('|澜起科技')).slice(0, 2);
  console.log('sample:', sample.join('\n'));
})();
