'use strict';
const { callTool } = require('../src/connector');

(async () => {
  const q = process.argv[2] || '亚虹医药、澜起科技 最新估值水平';
  const tool = process.argv[3] || 'connector__thsifind__get_stock_summary';
  const d = await callTool(tool, { query: q });
  console.log('--- type:', typeof d, 'len:', (d && d.length) || 0, '---');
  console.log(typeof d === 'string' ? d : JSON.stringify(d, null, 2));
})();
