'use strict';
// 校准：iFinD 的「市盈率(PE,TTM)分位数」用的是近3年窗口，对齐一下
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

async function history(code) {
  const bare = code.split('.')[0];
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_VALUEANALYSIS_DET'
    + '&columns=SECURITY_CODE%2CTRADE_DATE%2CPE_TTM%2CPB_MRQ'
    + `&filter=(SECUCODE%3D%22${bare}.SH%22)&pageNumber=1&pageSize=2000`
    + '&sortColumns=TRADE_DATE&sortTypes=-1&source=HSF10&client=PC';
  const j = JSON.parse(await get(url));
  return (j.result && j.result.data) || [];
}

function pct(rows, field, curV, windowRows) {
  if (!Number.isFinite(curV) || curV <= 0) return null;
  const w = windowRows ? rows.slice(0, windowRows) : rows;
  const hist = w.map((r) => Number(r[field])).filter((v) => Number.isFinite(v) && v > 0);
  if (hist.length < 60) return null;
  return +((hist.filter((v) => v < curV).length / hist.length) * 100).toFixed(1);
}

// iFinD 侧实测值（来自本轮采集的 indicators 结果）
const IFIND = {
  '688008.SH': 100, // 澜起科技
  '688001.SH': 100, // 华兴源创
  '688012.SH': 100, // 中微公司
  '688253.SH': null,
};

(async () => {
  for (const code of Object.keys(IFIND)) {
    const rows = await history(code);
    if (!rows.length) { console.log(code, 'no data'); continue; }
    const curPE = Number(rows[0].PE_TTM);
    const curPB = Number(rows[0].PB_MRQ);
    const w3 = 750; // 近3年约 750 个交易日
    const w1 = 250; // 近1年
    console.log(`${code} ${rows[0].SECURITY_NAME_ABBR || ''}  PE=${curPE.toFixed(2)} PB=${curPB.toFixed(2)}  iFinD分位=${IFIND[code]}`);
    console.log(`   全历史(${rows.length}): PE ${pct(rows, 'PE_TTM', curPE)} | 近3年(${w3}): PE ${pct(rows, 'PE_TTM', curPE, w3)} | 近1年(${w1}): PE ${pct(rows, 'PE_TTM', curPE, w1)}`);
    console.log(`   PB 全历史 ${pct(rows, 'PB_MRQ', curPB)} | 近3年 ${pct(rows, 'PB_MRQ', curPB, w3)}`);
    const peHist = rows.map((r) => Number(r.PE_TTM)).filter((v) => Number.isFinite(v) && v > 0);
    console.log(`   PE_TTM 分布: min ${Math.min(...peHist).toFixed(1)} max ${Math.max(...peHist).toFixed(1)} median ${peHist.sort((a, b) => a - b)[Math.floor(peHist.length / 2)].toFixed(1)}`);
  }
})();
