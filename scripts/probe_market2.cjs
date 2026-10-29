'use strict';
const { callTool } = require('../src/connector');

(async () => {
  // A) iFinD 指数市场
  try {
    const d = await callTool('connector__thsifind__get_security_indicators', {
      market: 'A股',
      query: '科创50指数(000688)的收盘价、涨跌幅、成交额',
    });
    console.log('=== A iFinD 000688 ===');
    console.log(String(d && d.answer ? d.answer : JSON.stringify(d)).slice(0, 900));
  } catch (e) { console.log('=== A FAIL:', e.message); }

  // B) 恒生 search_instruments
  try {
    const d = await callTool('connector__hengsheng_market__search_instruments', { keyword: '科创50' });
    console.log('=== B hengsheng search ===');
    console.log(JSON.stringify(d).slice(0, 1200));
  } catch (e) { console.log('=== B FAIL:', e.message); }

  // C) 恒生 latest quote
  try {
    const d = await callTool('connector__hengsheng_market__get_latest_quote', { symbol: '688176.SH' });
    console.log('=== C hengsheng quote ===');
    console.log(JSON.stringify(d).slice(0, 900));
  } catch (e) { console.log('=== C FAIL:', e.message); }
})();
