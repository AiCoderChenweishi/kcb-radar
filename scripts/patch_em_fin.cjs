'use strict';
// 用脚本替换 em.js 里的 fetchFinancials（编辑工具在该文件上反复失配）
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'src', 'em.js');
let s = fs.readFileSync(p, 'utf8');

const start = s.indexOf('/**\n * F10 利润表');
const endMarker = '\n// ---------------------------------------------------------------- 指数';
const end = s.indexOf(endMarker);
if (start < 0 || end < 0) { console.error('锚点未找到'); process.exit(1); }

const replacement = `/**
 * F10 财务：两张报表各取一次，按报告期倒序取最新一期。
 *
 *   RPT_LICO_FN_CPD              → 营收、归母净利、营收同比、净利同比、EPS、行业(BOARD_NAME)
 *   RPT_F10_FINANCE_MAINFINADATA → 加权ROE、销售毛利率、总资产、每股净资产
 *
 * 注意：两张表默认排序不同，必须显式 sortColumns=REPORT_DATE & sortTypes=-1，
 * 否则会拿到一年前的旧数据（踩过：澜起科技返回的是 2025-06-30 而不是 2026-06-30）。
 */
async function fetchFinancials(code) {
  const bare = String(code || '').split('.')[0];
  const base = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
  const url = (report) => base + '?reportName=' + report + '&columns=ALL'
    + '&filter=(SECUCODE%3D%22' + bare + '.SH%22)&pageNumber=1&pageSize=2'
    + '&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC';

  const [cpdRes, mainRes] = await Promise.allSettled([
    getJson(url('RPT_LICO_FN_CPD')),
    getJson(url('RPT_F10_FINANCE_MAINFINADATA')),
  ]);

  const cpd = cpdRes.status === 'fulfilled'
    ? (((cpdRes.value || {}).result || {}).data || [])[0] : null;
  const main = mainRes.status === 'fulfilled'
    ? (((mainRes.value || {}).result || {}).data || [])[0] : null;
  if (!cpd && !main) return null;

  const revenue = num(cpd && cpd.TOTAL_OPERATE_INCOME) ?? num(main && main.OPERATE_INCOME_PK);
  const netProfit = num(cpd && cpd.PARENT_NETPROFIT) ?? num(main && main.PARENTNETPROFIT);

  return {
    report_date: String((main && main.REPORT_DATE) || (cpd && cpd.REPORTDATE) || '').slice(0, 10),
    revenue,
    revenue_yoy: num(cpd && cpd.YSTZ) ?? num(main && main.OI_YOYRATIO_PK),
    net_profit: netProfit,
    net_profit_yoy: num(cpd && cpd.SJLTZ) ?? num(main && main.PARENTNETPROFITTZ),
    gross_profit: num(main && main.OPERATE_PROFIT_PK),
    gross_margin: num(main && main.XSMLL) ?? num(cpd && cpd.XSMLL),
    net_margin: revenue && netProfit != null ? +(netProfit / revenue * 100).toFixed(2) : null,
    roe: num(main && main.ROEJQ) ?? num(cpd && cpd.WEIGHTAVG_ROE),
    roe_deducted: num(main && main.ROEKCJQ),
    eps: num(cpd && cpd.BASIC_EPS) ?? num(main && main.EPSJB),
    bps: num(main && main.BPS) ?? num(cpd && cpd.BPS),
    total_assets: num(main && main.TOTAL_ASSETS_PK),
    industry: (cpd && cpd.BOARD_NAME) || null,
  };
}
`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s, 'utf8');
console.log('已替换 fetchFinancials');
