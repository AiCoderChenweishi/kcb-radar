'use strict';
const { callTool } = require('../src/connector');

(async () => {
  const d = await callTool('connector__thsifind__get_security_indicators', {
    market: 'A股',
    query: '亚虹医药、澜起科技、中微公司 的最新市盈率(PE,TTM)、市盈率近三年分位数、市净率(PB)、总市值',
  });
  console.log('typeof=', typeof d);
  console.log('keys=', d && typeof d === 'object' ? Object.keys(d) : 'n/a');
  const s = JSON.stringify(d, null, 2);
  console.log('json_len=', s.length);
  console.log(s.slice(0, 2500));
})();
