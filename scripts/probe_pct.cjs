'use strict';
// 用东财历史估值序列自算 PE/PB 历史分位，并与 iFinD 口径对照
const https = require('https');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36', Referer: 'https://data.eastmoney.com/' };

function get(url) {
  return new Promise((r) => {
    const q = https.get(url, { headers: H, timeout: 30000 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => r(b)); });
    q.on('error', (e) => r('ERR ' + e.message));
    q.on('timeout', () => { q.destroy(); r('timeout'); });
  });
}

/** 拉一只股票的历史估值序列并算分位 */
async function percentile(code) {
  const bare = code.split('.')[0];
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_VALUEANALYSIS_DET'
    + '&columns=SECURITY_CODE%2CTRADE_DATE%2CPE_TTM%2CPB_MRQ%2CPS_TTM%2CCHANGE_RATE%2CCLOSE_PRICE'
    + `&filter=(SECUCODE%3D%22${bare}.SH%22)&pageNumber=1&pageSize=2000`
    + '&sortColumns=TRADE_DATE&sortTypes=-1&source=HSF10&client=PC';
  const b = await get(url);
  const j = JSON.parse(b);
  const rows = (j.result && j.result.data) || [];
  if (!rows.length) return null;

  const cur = rows[0];
  const curPE = Number(cur.PE_TTM);
  const curPB = Number(cur.PB_MRQ);
  const calc = (field, curV) => {
    if (!Number.isFinite(curV) || curV <= 0) return null;
    const hist = rows.map((r) => Number(r[field])).filter((v) => Number.isFinite(v) && v > 0);
    if (hist.length < 60) return null;
    const below = hist.filter((v) => v < curV).length;
    return { pct: +((below / hist.length) * 100).toFixed(1), n: hist.length, cur: +curV.toFixed(2) };
  };
  return {
    code, date: String(cur.TRADE_DATE || '').slice(0, 10), rows: rows.length,
    pe: calc('PE_TTM', curPE),
    pb: calc('PB_MRQ', curPB),
    latest: { pe: curPE, pb: curPB, chg: cur.CHANGE_RATE, close: cur.CLOSE_PRICE },
  };
}

(async () => {
  for (const c of ['688008.SH', '688001.SH', '688012.SH', '688253.SH']) {
    const t0 = Date.now();
    const r = await percentile(c);
    console.log(`${c}  ${Date.now() - t0}ms  ${r ? JSON.stringify(r) : 'null'}`);
  }
})();
