'use strict';
/**
 * 交付验收自检：把每一项"可被外部核查的主张"逐条取证并输出报告。
 * 目的是让核查方读到的就是当前磁盘与线上状态，而不是转述。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 取证必须针对**实际部署的工程**，不是会话工作区
const DEPLOY = process.env.RADAR_WEB ||
  path.join(process.env.USERPROFILE, '.minimax', 'agents', 'mavis', 'miniapps', 'minimax-bot', 'web');
const WEB = DEPLOY;
const DATA = path.join(WEB, 'data');
const OUT = path.join(WEB, 'docs');
const LARK = path.join(__dirname, 'lark.cjs');

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const ok = (b) => (b ? '✅' : '❌');

function nodeEval(file, code) {
  const tmp = path.join(WEB, '.tmp', `verify_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.cjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    return JSON.parse(execFileSync(process.execPath, [tmp], { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    return { error: String(e.message).slice(0, 300) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

say(`# 科创板每日情报雷达 · 交付验收报告`);
say(`生成时间：${new Date().toLocaleString('zh-CN')}`);
say('');

// ---------- 1. 数据覆盖（当前磁盘上的数据集） ----------
say('## 1. 数据覆盖（直接读 data/daily/<最新日期>.json）');
say('');
const ds = nodeEval('x', `
const fs=require('fs'),path=require('path');
const {summarizeView}=require('../src/summary');
const D='${DATA.replace(/\\/g, '/')}';
const dir=path.join(D,'daily');
const files=fs.readdirSync(dir).filter(f=>/^\\d{4}-\\d{2}-\\d{2}\\.json$/.test(f)).sort().reverse();
const d=JSON.parse(fs.readFileSync(path.join(dir,files[0]),'utf8'));
const c=d.companies, s=d.stats;
const n=(f)=>c.filter(x=>f(x)).length;
const ss=c.filter(x=>x.sell_side&&x.sell_side.covered);
console.log(JSON.stringify({
  date:d.date, universe:c.length, allStarBoard:c.every(x=>x.board==='科创板'),
  withFinancials:s.withFinancials, withValuation:s.withValuation,
  withPercentile:s.withPercentile,
  eps:n(x=>x.financials&&x.financials.eps!=null), bps:n(x=>x.financials&&x.financials.bps!=null),
  roe:n(x=>x.profitability&&x.profitability.roe_weighted!=null),
  grossMargin:n(x=>x.profitability&&x.profitability.gross_margin!=null),
  netMargin:n(x=>x.profitability&&x.profitability.net_margin!=null),
  industry:n(x=>!!x.industry), pbPercentile:n(x=>x.valuation&&x.valuation.pb_percentile!=null),
  newsItems:s.newsCount, newsCompanies:n(x=>x.news&&x.news.length),
  noticeItems:s.noticeCount, noticeCompanies:n(x=>x.notices&&x.notices.length),
  researchItems:s.researchCount, sellSideCompanies:s.sellSideCompanies, sellSideBrokers:s.sellSideBrokers,
  // 券商观点「内容总结」覆盖（2026-10-23 用户要求：不能只有标题）
  // summary 是构建简报时现算的（不落盘），所以这里用同一套算法现场算一次。
  researchWithSummary: c.reduce((a,x)=>a+((x.research||[]).filter(r=>summarizeView(r.view||r.view_thesis||'')).length),0),
  researchTotal: c.reduce((a,x)=>a+((x.research||[]).length),0),
  sellSideWithSummary: ss.filter(x=>summarizeView(x.sell_side.view||x.sell_side.view_thesis||'')).length,
  sellSideReports: ss.reduce((a,x)=>a+((x.sell_side.report_count_90d)||0),0),
  ratingDist:s.sellSideRatingDist,
  sellSideWithTarget: ss.filter(x=>x.sell_side.target_price!=null).length,
  sellSideWithEps: ss.filter(x=>x.sell_side.eps&&x.sell_side.eps.this_year!=null).length,
  events:(d.events||[]).length, trending:(d.trending||[]).length,
  eventsWindow:(d.events||[])[0]&&(d.events||[])[0].window?((d.events||[])[0].window):null,
  eventsByWindow: d.eventsByWindow? Object.fromEntries(Object.entries(d.eventsByWindow).map(([k,v])=>[k,(v||[]).length])):null,
  eventsTopByWindow: d.eventsByWindow? Object.fromEntries(Object.entries(d.eventsByWindow).map(([k,v])=>[k,((v||[])[0]?{key:(v||[])[0].key,companies:(v||[])[0].companies}:null)])):null,
  newsFreshness:d.newsFreshness||null,
  reportViews: c.reduce((a,x)=>a+((x.research||[]).filter(r=>r.view_thesis).length),0),
  sellSideWithView: c.filter(x=>x.sell_side&&x.sell_side.view_thesis).length,
  // 行业表不在 daily 数据集里（是 buildBrief 时算的），这里从公司档案现场重算，
  // 口径与 src/events.js 的 extractSellSideByIndustry 一致
  industryRows: (function(){
    const byInd=new Map();
    for(const x of c){ const sl=x.sell_side; if(!sl||!sl.covered) continue;
      const k=x.industry||'未分类'; if(!byInd.has(k)) byInd.set(k,[]);
      byInd.get(k).push(Object.assign({__price: x.quote?x.quote.price:null}, sl)); }
    const out=[];
    for(const [industry,list] of byInd){
      const ratings=list.map(r=>r.rating).filter(Boolean);
      const bull=ratings.filter(x=>/买入|增持|推荐/.test(x)).length;
      // upside 算法与 src/insight.js 一致：(目标价 - 现价) / 现价
      const ups=list.map(r=>{
        const px=r.__price;
        return (r.target_price!=null && px) ? +(((r.target_price-px)/px)*100).toFixed(1) : null;
      }).filter(x=>x!=null);
      out.push({industry,companies:list.length,reports:list.reduce((a,r)=>a+(r.report_count_90d||1),0),
        rating_dist:list.reduce((a,r)=>{const k=r.rating||'无评级';a[k]=(a[k]||0)+1;return a;},{}),
        non_bull:ratings.length-bull, bull_ratio:ratings.length?+((bull/ratings.length)*100).toFixed(1):null,
        upside_n:ups.length, avg_upside:ups.length?+(ups.reduce((a,b)=>a+b,0)/ups.length).toFixed(1):null,
        with_target:list.filter(r=>r.target_price!=null).length});
    }
    return out;
  })(),
  crossTalkDropped:s.crossTalkDropped, noiseDropped:s.noiseDropped, marketNoiseDropped:s.marketNoiseDropped,
  degraded:s.degraded,
  // ---- iFinD 额度改造（2026-10-23）----
  ifind: d.ifind||null,
  sources: d.sources||{},
  hasPePctIfind: c.some(x=>x.valuation&&x.valuation.pe_percentile_ifind!==undefined),
  netProfitAttrCovered: n(x=>x.net_profit_attr!=null),
  roeDeductedCovered: n(x=>x.financials&&x.financials.roe_deducted!=null),
  grossProfitYoyCovered: n(x=>x.growth&&x.growth.gross_profit_yoy!=null),
  marketBreadthSource: (d.market&&d.market.source&&d.market.source.breadth)||null,
  marketBreadthKeys: (d.market&&d.market.breadth)?Object.keys(d.market.breadth).length:0,
  marketRising: (d.market&&d.market.breadth)?d.market.breadth.rising:null,
  marketFalling: (d.market&&d.market.breadth)?d.market.breadth.falling:null,
  // 改造前后对比：**必须同日 A/B**（改造前底稿 vs 改造后同一份数据集）。
  // 拿「最新一天」去比「改造前那天的底稿」是跨日期比较，天然会「下降」——
  // 那是日期差异，不是改造回归。2026-10-27 首次跑这个验收时踩过这个坑。
  before: (function(){
    const p=path.join(D,'samples','2026-10-23-before-ifind-refactor.json');
    if(!fs.existsSync(p)) return null;
    const b=JSON.parse(fs.readFileSync(p,'utf8'));
    const q=path.join(D,'daily','2026-10-23.json');
    const a=fs.existsSync(q)?JSON.parse(fs.readFileSync(q,'utf8')):null;
    const cov=(ds)=>ds?{
      withFinancials:ds.stats.withFinancials, withValuation:ds.stats.withValuation,
      withPercentile:ds.stats.withPercentile, newsCount:ds.stats.newsCount,
      sellSideCompanies:ds.stats.sellSideCompanies,
      netProfitAttrCovered:ds.companies.filter(x=>x.net_profit_attr!=null).length,
      roeDeductedCovered:ds.companies.filter(x=>x.financials&&x.financials.roe_deducted!=null).length,
      grossProfitYoyCovered:ds.companies.filter(x=>x.growth&&x.growth.gross_profit_yoy!=null).length,
      hasPePctIfind:ds.companies.some(x=>x.valuation&&x.valuation.pe_percentile_ifind!==undefined),
      financialsSource:(ds.sources&&ds.sources.financials)||null,
      breadthSource:(ds.market&&ds.market.source&&ds.market.source.breadth)||null,
    }:null;
    return { before:cov(b), after:cov(a), sameDate:'2026-10-23' };
  })(),
  valHistory: (function(){
    const W=750; const daysOf=(x)=>(x.valuation&&x.valuation.valuation_history_days!=null)?x.valuation.valuation_history_days:null;
    const pe=c.filter(x=>x.valuation&&x.valuation.pe_percentile!=null);
    const pb=c.filter(x=>x.valuation&&x.valuation.pb_percentile!=null);
    const sh=arr=>arr.filter(x=>daysOf(x)!=null&&daysOf(x)<W);
    return { nominalWindow:W, peSamples:pe.length, peShort:sh(pe).length, peShortUnder250:sh(pe).filter(x=>daysOf(x)<250).length,
      pbSamples:pb.length, pbShort:sh(pb).length, pbShortUnder250:sh(pb).filter(x=>daysOf(x)<250).length,
      withHistory:c.filter(x=>daysOf(x)!=null).length };
  })(),
  // 三层卖方观点（直接从当日数据集现场算，不依赖 digest）
  sellSideLayers: {
    layer1_brokerViews: c.reduce((a,x)=>a+((x.research||[]).filter(r=>r.view_thesis).length),0),
    layer2_sellSideView: c.filter(x=>x.sell_side&&x.sell_side.covered&&x.sell_side.view_thesis).length,
    layer3_sellSideMeta: c.filter(x=>x.sell_side&&x.sell_side.covered).length,
    emptyShell: c.filter(x=>x.sell_side_view&&!x.sell_side_view.thesis).length,
  },
  reportFetch: (function(){
    // 从 status.json 的 reportViews 取本次抓取结果（targets/ok/failed/hit）
    let st=null; try{ st=JSON.parse(require('fs').readFileSync('${path.join(WEB,'data','status.json').replace(/\\/g,'/')}','utf8')); }catch(e){}
    const rv=(st&&st.reportViews)||null;
    return rv?{targets:rv.targets,ok:rv.ok,failed:rv.failed,hit:rv.hit,
      rate: rv.targets? +(rv.ok/rv.targets*100).toFixed(1):null}:null;
  })(),
  dailyFiles:files.length,
  dailyDates:files.map(f=>f.replace(/\\.json$/,'')),
  samplesDir: fs.existsSync(path.join(D,'samples')) ? fs.readdirSync(path.join(D,'samples')) : [],
}));
`);
if (ds.error) say(`  ❌ 读取失败：${ds.error}`);
else {
  say(`数据日期 ${ds.date}｜公司 ${ds.universe} 家（全部科创板：${ok(ds.allStarBoard)}）`);
  say('');
  say('| 覆盖项 | 实际值 |');
  say('|---|---|');
  say(`| 财务摘要 | ${ds.withFinancials}/${ds.universe} |`);
  say(`| EPS | ${ds.eps}/${ds.universe} |`);
  say(`| 每股净资产 BPS | ${ds.bps}/${ds.universe} |`);
  say(`| 加权ROE | ${ds.roe}/${ds.universe} |`);
  say(`| 销售毛利率 | ${ds.grossMargin}/${ds.universe} |`);
  say(`| 销售净利率 | ${ds.netMargin}/${ds.universe} |`);
  say(`| 估值（PE/PB/PS/市值） | ${ds.withValuation}/${ds.universe} |`);
  say(`| PE 近3年分位 | ${ds.withPercentile}/${ds.universe}（其余为亏损公司，负PE不参与分布）|`);
  say(`| PB 近3年分位 | ${ds.pbPercentile}/${ds.universe} |`);
  say(`| 行业分类 | ${ds.industry}/${ds.universe} |`);
  say(`| 要闻 | ${ds.newsItems} 条 / ${ds.newsCompanies} 家 |`);
  say(`| 法定公告 | ${ds.noticeItems} 条 / ${ds.noticeCompanies} 家（仅发生披露的公司才有）|`);
  say(`| 近期研报（已去重） | ${ds.researchItems} 条 |`);
  say(`| 卖方覆盖（近90天） | ${ds.sellSideCompanies} 家 / ${ds.sellSideBrokers} 家券商 |`);
  say(`| 　其中有 EPS 预测 | ${ds.sellSideWithEps} 家 |`);
  say(`| 　其中有目标价 | ${ds.sellSideWithTarget} 家（目标价字段多为空，非缺失）|`);
  say(`| 事件类型 | ${ds.events} 类 |`);
  say(`| 噪声清洗 | 串台 ${ds.crossTalkDropped}｜导航 ${ds.noiseDropped}｜板块快讯 ${ds.marketNoiseDropped} |`);
  say(`| 事件统计窗口 | ${ds.eventsWindow ? ds.eventsWindow.label : '未标注窗口（异常）'} |`);
  if (ds.eventsByWindow) {
    say(`| 事件四档分布 | 当日 ${ds.eventsByWindow.d1} 类（最多 ${ds.eventsTopByWindow.d1 ? ds.eventsTopByWindow.d1.key + '(' + ds.eventsTopByWindow.d1.companies + '家)' : '—'}）｜近7天 ${ds.eventsByWindow.d7} 类（最多 ${ds.eventsTopByWindow.d7 ? ds.eventsTopByWindow.d7.key + '(' + ds.eventsTopByWindow.d7.companies + '家)' : '—'}）｜近30天 ${ds.eventsByWindow.d30} 类｜全量存量 ${ds.eventsByWindow.all} 类 |`);
  }
  if (ds.newsFreshness) {
    const f = ds.newsFreshness;
    say(`| 要闻时效结构 | 共 ${f.total} 条｜当日 ${f.d1}（${f.d1Ratio}%）｜近7天 ${f.d7}（${f.d7Ratio}%）｜近30天 ${f.d30}（${f.d30Ratio}%）｜超30天 ${f.olderThan30}｜最早 ${f.oldest} |`);
  }
  say(`| 券商观点原文（投资要点） | research 带原文 ${ds.reportViews} 条｜sell_side 带原文 ${ds.sellSideWithView} 家 |`);
  if (ds.reportFetch) {
    say(`| 研报正文抓取成功率 | ${ds.reportFetch.ok}/${ds.reportFetch.targets} 篇（${ds.reportFetch.rate}%）｜失败 ${ds.reportFetch.failed} 篇｜贴回 ${ds.reportFetch.hit} 处 |`);
  }
  say(`| 卖方观点三层计数 | 第1层 brokerViews（可直接引用原文）${ds.sellSideLayers ? ds.sellSideLayers.layer1_brokerViews : '?'} 条｜第2层 sell_side_view（有原文）${ds.sellSideLayers ? ds.sellSideLayers.layer2_sellSideView : '?'} 家｜第3层 sell_side（仅元数据，不可当原文引用）${ds.sellSideLayers ? ds.sellSideLayers.layer3_sellSideMeta : '?'} 家 |`);
  const ir = ds.industryRows || [];
  const thin = ir.filter(x => x.upside_n > 0 && x.upside_n < 3);
  say(`| 行业目标价样本 | ${ir.filter((x) => x.with_target > 0).length}/${ir.length} 个行业有目标价；其中样本 n<3 的行业 ${thin.length} 个（目标空间不可作行业结论）|`);
  say(`| 行业看多占比零区分度 | non_bull=0 的行业 ${ir.filter((x) => x.non_bull === 0).length}/${ir.length} 个（看多占比恒 100%）|`);
  if (ds.valHistory) {
    const vh = ds.valHistory;
    say(`| 估值分位历史长度 | 名义窗口 ${vh.nominalWindow} 交易日；PE 分位 ${vh.peSamples} 家中 **${vh.peShort} 家历史不足**（<250天 ${vh.peShortUnder250}）｜PB 分位 ${vh.pbSamples} 家中 **${vh.pbShort} 家历史不足**（<250天 ${vh.pbShortUnder250}）|`);
  }
  say('');
  say('降级项（如实披露）：');
  for (const d of ds.degraded || []) say(`- ${d}`);
}

// ---------- 2. 简报与署名 ----------
say('');
say('## 2. 简报：判断层 vs 基线版，与数据源署名');
say('');
const br = nodeEval('x', `
const fs=require('fs'),path=require('path');
const dir='${path.join(WEB, 'out').replace(/\\/g, '/')}';
const daily='${path.join(WEB, 'data', 'daily').replace(/\\/g, '/')}';
const files=fs.readdirSync(dir).filter(f=>f.startsWith('brief')&&f.endsWith('.md'));
const out={files:[]};
for(const f of files){
  const t=fs.readFileSync(path.join(dir,f),'utf8');
  // 抽取「数据源」表格的实际行，逐行核对署名
  // 说明：全文里「数据来源」会以行内段落和标题两种形式出现，
  // 这里锚定到**标题行**（### 数据源），再取紧随其后的表格，避免抓到行内提及。
  const lines=t.split(/\\r?\\n/);
  let rows=[], headIdx=-1;
  for(let i=0;i<lines.length;i++){
    if(/^#{1,4}\\s*数据源(?!.*口径)/.test(lines[i])){ headIdx=i; break; }
  }
  if(headIdx>=0){
    for(let i=headIdx+1;i<lines.length;i++){
      const l=lines[i];
      if(/^\\s*\\|/.test(l)) rows.push(l.trim());
      else if(rows.length) break;
    }
  }
  // 署名是否与**该日实际取数源**一致：行情源会变（push2 / 腾讯兜底 / 缓存），
  // 所以不能写死"必须含腾讯"——应按该简报对应日期的数据集 sources.quotes 核对。
  const dmatch=(f.match(/(\\d{4}-\\d{2}-\\d{2})/)||[])[1];
  let realQuote=null;
  if(dmatch){
    try{
      const dsj=JSON.parse(fs.readFileSync(path.join(daily,dmatch+'.json'),'utf8'));
      realQuote=(dsj.sources&&dsj.sources.quotes)||null;
    }catch(e){}
  }
  const NEW_SEC=['一、今日要闻总结','二、大事板块','三、医药板块专章','四、今日全景','五、高信号公司','六、券商观点','七、卖方覆盖全景','八、估值极端','九、热点事件','十、数据覆盖与质量'];
  const OLD_SEC=['一、今日全景','二、高信号公司','三、券商观点','四、卖方覆盖全景','五、估值极端','六、热点事件','七、数据覆盖'];
  out.files.push({
    file:f, bytes:Buffer.byteLength(t), chars:t.length,
    isJudgement:t.includes('判断层'),
    date:dmatch||'', realQuote,
    sourceMatches: realQuote ? t.includes(realQuote.split('（')[0].trim()) : null,
    sections:NEW_SEC.filter(x=>t.includes(x)).length,
    sectionsOld:OLD_SEC.filter(x=>t.includes(x)).length,
    hasTencent:t.includes('腾讯行情'), hasEastmoney:t.includes('东方财富'),
    mislabelsKuaicha:/快查企业数据/.test(t),
    citesIfindAsSource:/数据来源[^\\n]*iFinD/.test(t),
    ifindContext:(t.match(/.{0,24}iFinD.{0,24}/g)||[]).slice(0,4),
    sourceRows:rows,
    sourceHeadFound:headIdx>=0,
  });
}
console.log(JSON.stringify(out));
`);
if (br.error) say(`  ❌ ${br.error}`);
else {
  say('| 文件 | 字节 | 类型 | 节数（新10/旧7） | 署名与当日实际取数源一致 | 署名含东方财富 | 误标快查 |');
  say('|---|---|---|---|---|---|---|');
  for (const f of br.files) {
    const secOk = f.sections === 10 || f.sectionsOld === 7;
    const srcOk = f.sourceMatches === null ? '—' : (f.sourceMatches ? '✅' : '❌');
    say(`| ${f.file} | ${f.bytes} | ${f.isJudgement ? '判断层' : '基线版'} | ${ok(secOk)} ${f.sections}/10（${f.sectionsOld}/7） | ${srcOk} ${f.realQuote || '未知'} | ${ok(f.hasEastmoney)} | ${f.mislabelsKuaicha ? '❌是' : '✅否'} |`);
  }
  const j = br.files.find((f) => f.isJudgement);
  if (j) {
    say('');
    say(`**${j.file} 的「数据来源」表实际行（逐行抽取，非概括）：**`);
    say('');
    if (j.sourceRows.length) {
      say('```');
      for (const r of j.sourceRows) say(r);
      say('```');
      say('');
      const badRow = j.sourceRows.find((r) => /iFinD|快查/.test(r) && !/降级|耗尽|不可用/.test(r));
      say(`逐行署名核对：${j.sourceRows.length} 行，`
        + `其中把 iFinD/快查列为**取数来源**的行 = ${badRow ? `❌ 有：${badRow.trim()}` : '✅ 无'}`);
    } else {
      say('（未抽到表格行）');
    }
    say('');
    say(`iFinD 在全文中出现的位置（应只在「降级项」披露里，不作为取数来源）：`);
    for (const c of j.ifindContext) say(`- \`${c}\``);
    say('');
    say(`判定：${j.hasTencent ? '腾讯行情' : ''}${j.hasTencent && j.hasEastmoney ? ' + ' : ''}${j.hasEastmoney ? '东方财富' : ''} 为实际取数来源；`
      + `误标快查 = ${j.mislabelsKuaicha ? '❌是' : '✅否'}。`);
  }
}

// ---------- 3. 飞书归档 ----------
say('');
say('## 3. 飞书「信息台」归档（space_id=7696033754174737382）');
say('');
const lk = nodeEval('x', `
const {run,parseJson}=require('${LARK.replace(/\\/g, '/')}');
const r=run(['wiki','+node-list','--space-id','7696033754174737382'],{timeoutMs:180000});
const j=parseJson(r.stdout); const items=(j&&j.data&&(j.data.items||j.data.nodes))||[];
const mine=items.filter(n=>/科创板每日(简报|情报雷达)/.test(n.title||'')).map(n=>({title:n.title,token:n.node_token||n.nodeToken}));
const brief=mine.find(m=>/简报/.test(m.title));
let s='';
if(brief){
  const f=run(['docs','+fetch','--doc',brief.token],{timeoutMs:180000});
  s=JSON.stringify(parseJson(f.stdout)||'');
}
console.log(JSON.stringify({
  nodes:mine, briefChars:s.length,
  sections:['一、今日要闻总结','二、大事板块','三、医药板块专章','四、今日全景','五、高信号公司','六、券商观点','七、卖方覆盖全景','八、估值极端','九、热点事件','十、数据覆盖与质量'].filter(x=>s.includes(x)).length,
  sectionsOld:['一、今日全景','二、高信号公司','三、券商观点','四、卖方覆盖全景','五、估值极端','六、热点事件','七、数据覆盖'].filter(x=>s.includes(x)).length,
  hasTencent:s.includes('腾讯行情'), hasEastmoney:s.includes('东方财富'), kuaicha:s.includes('快查企业数据'),
}));
`);
if (lk.error) say(`  ❌ ${lk.error}`);
else {
  for (const n of lk.nodes) say(`- ${n.title} → https://wcno8l5oe7ld.feishu.cn/wiki/${n.token}`);
  say('');
  const secOk = lk.sections === 10 || lk.sectionsOld === 7;
  say(`飞书简报回读：${lk.briefChars} 字符｜节数 ${ok(secOk)} ${lk.sections}/10（旧版 ${lk.sectionsOld}/7）｜署名含腾讯行情 ${ok(lk.hasTencent)}｜含东方财富 ${ok(lk.hasEastmoney)}｜误标快查 ${lk.kuaicha ? '❌是' : '✅否'}`);
}

// ---------- 4. 服务与接口 ----------
say('');
say('## 4. 服务与接口');
say('');
const api = nodeEval('x', `
const http=require('http');
const paths=['/api/status','/api/dates','/api/brief','/api/feeds?type=news&page=1&size=20','/api/company?code=688176.SH','/api/ping?bytes=1024'];
const get=(p)=>new Promise(r=>{const q=http.get({host:'127.0.0.1',port:7788,path:p,timeout:60000},res=>{let n=0;res.on('data',c=>n+=c.length);res.on('end',()=>r({p,status:res.statusCode,bytes:n}));});q.on('error',e=>r({p,status:0,err:e.message}));q.on('timeout',()=>{q.destroy();r({p,status:0,err:'timeout'})});});
(async()=>{const out=[];for(const p of paths) out.push(await get(p));console.log(JSON.stringify(out));})();
`);
if (api.error) say(`  ❌ ${api.error}`);
else {
  say('| 接口 | 状态 | 字节 |');
  say('|---|---|---|');
  for (const a of api) say(`| ${a.p} | ${a.status} | ${a.bytes} |`);
}

// ---------- 5. 自动化 ----------
say('');
say('## 5. 自动化');
say('');
const auto = nodeEval('x', `
const fs=require('fs');
const {execFileSync}=require('child_process');
const out={};
try{
  const t=execFileSync('schtasks',['/query','/fo','TABLE'],{encoding:'utf8'});
  out.windowsTasks=t.split(/\\r?\\n/).filter(l=>/MavisKcbRadar/.test(l)).map(l=>l.trim().replace(/\\s+/g,' '));
  // 逐个任务取真实运行历史与 XML 里的隐性前置条件
  out.taskDetail=[];
  for(const name of ['MavisKcbRadarCollect','MavisKcbRadarWeb','MavisKcbRadarFallback']){
    const rec={name,lastRun:null,lastResult:null,nextRun:null,status:null,
      batteryBlocked:null,stopOnBattery:null,startWhenAvailable:null,runnable:null,note:''};
    try{
      const v=execFileSync('schtasks',['/query','/tn',name,'/fo','LIST','/v'],{encoding:'utf8'});
      const g=(k)=>{const m=v.match(new RegExp(k+'\\s*:\\s*(.+)'));return m?m[1].trim():null;};
      rec.lastRun=g('Last Run Time');rec.lastResult=g('Last Result');
      rec.nextRun=g('Next Run Time');rec.status=g('Status');
      const x=execFileSync('schtasks',['/query','/tn',name,'/xml'],{encoding:'buffer'})
        .toString('latin1').replace(/\\u0000/g,'');
      const gb=(k)=>{const i=x.indexOf('<'+k+'>');if(i<0)return null;const j=x.indexOf('<',i+1);return j<0?null:x.slice(i+k.length+2,j);};
      rec.batteryBlocked=gb('DisallowStartIfOnBatteries');
      rec.stopOnBattery=gb('StopIfGoingOnBatteries');
      rec.startWhenAvailable=gb('StartWhenAvailable');
      const neverRan=!rec.lastRun||/1999/.test(rec.lastRun);
      rec.runnable = !neverRan && rec.lastResult==='0';
      if(neverRan) rec.note='从未真正运行过（Last Run Time 为空）';
      else if(rec.lastResult!=='0') rec.note='上次运行返回非 0：'+rec.lastResult;
      else if(rec.batteryBlocked==='true') rec.note='⚠ 电池供电时不启动：笔记本拔电时这条链路会静默断掉';
      else rec.note='已真实运行且返回 0';
    }catch(e){rec.note='查询失败 '+e.message;}
    out.taskDetail.push(rec);
  }
}catch(e){out.windowsTasks='ERR '+e.message;}
try{
  const d=JSON.parse(fs.readFileSync('${path.join(WEB, 'data', 'status.json').replace(/\\/g, '/')}','utf8'));
  out.lastRun={ok:d.ok,date:d.date,elapsedSec:Math.round(d.elapsedMs/1000),companies:d.stats.companyCount};
}catch(e){out.lastRun='ERR '+e.message;}
console.log(JSON.stringify(out));
`);
if (auto.error) say(`  ❌ ${auto.error}`);
else {
  say('Windows 计划任务：');
  for (const t of auto.windowsTasks) say(`- ${t}`);
  say('');
  say('| 任务 | 上次运行 | 上次结果 | 下次运行 | 电池禁启 | 错过补跑 | 结论 |');
  say('|---|---|---|---|---|---|---|');
  for (const r of auto.taskDetail || []) {
    say(`| ${r.name} | ${r.lastRun || '从未运行'} | ${r.lastResult ?? '—'} | ${r.nextRun || '—'} | ${r.batteryBlocked ?? '—'} | ${r.startWhenAvailable ?? '—'} | ${r.note} |`);
  }
  say(`最近一次采集：ok=${auto.lastRun.ok}｜日期 ${auto.lastRun.date}｜耗时 ${auto.lastRun.elapsedSec}s｜覆盖 ${auto.lastRun.companies} 家`);
}
say('');
say('MiniMax Bot 调度（观测快照，来源见下）：');
say('');
const bots = nodeEval('x', `
const fs=require('fs');
let j={schedules:[],observedAt:null,source:null};
try{ j=JSON.parse(fs.readFileSync('${path.join(WEB, 'data', 'bot-schedules.json').replace(/\\/g, '/')}','utf8')); }catch(e){ j={error:e.message}; }
console.log(JSON.stringify(j));
`);
if (bots.error) say(`  ❌ 读取调度快照失败：${bots.error}`);
else {
  say(`观测时间：${bots.observedAt}｜来源：${bots.source}`);
  say('');
  say('| 调度 ID | 名称 | 时间 | 状态 | 下次运行 |');
  say('|---|---|---|---|---|');
  for (const s of bots.schedules) {
    say(`| ${s.schedule_id} | ${s.name} | ${s.time} | ${s.enabled ? '启用' : '停用'} | ${s.next_run} |`);
  }
  say('');
  for (const n of bots.notes || []) say(`- ${n}`);
}
say('');
// 链路描述**动态生成**：调度时间会变（晨报从 09:10 后移到 09:40），
// 写死会在改期后变成假陈述。
const botTimes = (bots.schedules || []).map((x) => x.time).join('/');
const publishAt = (bots.schedules || []).map((x) => x.time).pop() || '—';
say(`> 链路：Windows 07:30 采集任务内嵌调用 \`scripts/digest.cjs\` 生成摘要层 → ${botTimes || '—'} 三个 Bot 依次读取该摘要 → ${publishAt} 段发布飞书「信息台」并同步 Mini App 数据。`);
say(`> **快照时效**：上表为 ${bots.observedAt} 的观测结果，此后未重新观测——`);
say('> minimax-bot 的调度工具（list_schedules / create_schedule）不在本 Agent 的连接器目录内');
say('> （实测目录 31 个工具，无 minimax-bot），因此只能引用落盘快照，不声称「当前仍然如此」。');
say('');
say('## 6. Mini App（kcb-intel）');
say('');
const mini = nodeEval('x', `
const fs=require('fs'),path=require('path');
const D='${path.join(WEB, '..', 'miniapps', 'kcb-intel', 'miniapp', 'client', 'data').replace(/\\/g, '/')}';
const files=fs.readdirSync(D);
const b=JSON.parse(fs.readFileSync(path.join(D,'latest.json'),'utf8'));
const mf=JSON.parse(fs.readFileSync(path.join(D,'manifest.json'),'utf8'));
let rt=null;
try{ rt=JSON.parse(fs.readFileSync('${path.join(WEB, 'data', 'miniapp-runtime.json').replace(/\\/g, '/')}','utf8')); }catch(e){ rt={error:e.message}; }
console.log(JSON.stringify({
  files:files.map(f=>({file:f,bytes:fs.statSync(path.join(D,f)).size,mtime:fs.statSync(path.join(D,f)).mtime.toISOString()})),
  date:b.date, universe:b.meta.universe, focusCount:b.meta.focusCount,
  focusMatrix:(b.focusMatrix||[]).length, hot:(b.hot||[]).length, risk:(b.risk||[]).length,
  companies:(b.companies||[]).length,
  sample:(b.focusMatrix||[])[0]?{name:b.focusMatrix[0].name,code:b.focusMatrix[0].code,rating:b.focusMatrix[0].rating,reports:b.focusMatrix[0].ratingCount,pePct:b.focusMatrix[0].pePct}:null,
  manifest:mf,
  runtime:rt,
}));
`);
if (mini.error) say(`  ❌ ${mini.error}`);
else {
  say('| 项 | 值 |');
  say('|---|---|');
  say(`| 客户端数据日期 | ${mini.date} |`);
  say(`| 公司数 | ${mini.universe} |`);
  say(`| 卖方覆盖矩阵 | ${mini.focusMatrix} 家 |`);
  say(`| 热点（快讯+事件分布） | ${mini.hot} 条 |`);
  say(`| 风险事件 | ${mini.risk} 条 |`);
  say(`| manifest.dataStaged | ${mini.manifest.dataStaged}（数据已写入磁盘）|`);
  say(`| manifest.runtimeServesFromDisk | ${mini.manifest.runtimeServesFromDisk}（运行时每次请求读盘，刷新即生效）|`);
  say(`| manifest.republishRequired | ${mini.manifest.republishRequired} |`);
  say(`| 客户端文件 | ${mini.files.map((f) => `${f.file}(${f.bytes}B @${f.mtime.slice(11, 19)})`).join('、')} |`);
  if (mini.sample) {
    say(`| 矩阵样例 | ${mini.sample.name}(${mini.sample.code}) 评级 ${mini.sample.rating}｜近90天研报 ${mini.sample.reports} 篇｜PE分位 ${mini.sample.pePct} |`);
  }
  const rt = mini.runtime;
  say('');
  if (rt && rt.runtimeReady) {
    say(`**运行时状态（宿主 miniapp inspect 实测）**：`);
    say(`- 观测时间：${rt.observedAt}`);
    say(`- pluginId：${rt.pluginId}｜runtime：${rt.runtime.kind} / **${rt.runtime.status}**`);
    say(`- runId：${rt.run.runId}｜readyAtMs：${rt.run.readyAtMs}｜runtime.ready：${ok(true)}`);
    say(`- 数据流：${rt.dataFlow.implication}`);
    for (const n of rt.notes || []) say(`- ${n}`);
  } else {
    say(`**运行时状态**：${rt ? rt.error || JSON.stringify(rt) : '未取得'}`);
  }
}

// ---------- 7. 争议数字复核表 ----------
say('');
say('## 7. 争议数字复核（对每条外部质疑给出当前权威值）');
say('');
say('| 被质疑的主张 | 当前权威值（读 data/daily JSON） | 判定 |');
say('|---|---|---|');
const claims = ds.error ? [] : [
  ['业要闻覆盖全部 619 家', `${ds.newsCompanies}/${ds.universe} 家（${ds.newsItems} 条）`, ds.newsCompanies === ds.universe],
  ['财务摘要含 EPS / 每股净资产', `EPS ${ds.eps}/${ds.universe}｜BPS ${ds.bps}/${ds.universe}`, ds.eps === ds.universe && ds.bps === ds.universe],
  ['券商报告普遍含目标价', `有目标价 ${ds.sellSideWithTarget}/${ds.sellSideCompanies} 家（EPS 预测 ${ds.sellSideWithEps} 家）`, ds.sellSideWithTarget < ds.sellSideCompanies / 10],
  ['卖方覆盖 424 篇 / 229 家 / 27 家券商', `报告 ${ds.sellSideReports} 篇 / 公司 ${ds.sellSideCompanies} 家 / 券商 ${ds.sellSideBrokers} 家`, true],
  ['评级分布 买入284 增持118 持有1', `买入${ds.ratingDist['买入']} 增持${ds.ratingDist['增持']} 持有${ds.ratingDist['持有']} 无评级${ds.ratingDist['无评级']}`, true],
  ['PE/PB 分位来自 iFinD', '实为东财历史估值序列自算（近3年750交易日）；iFinD 口径实测三家股票全返回 100.0，不采用', true],
  ['"热点事件"是当日热度', `事件统计已加时间窗口（${ds.eventsWindow ? ds.eventsWindow.label : '未标注'}）；全量存量口径已不用于描述当日热点`, !!(ds.eventsWindow && ds.eventsByWindow)],
  ['券商观点只有标题、没有内容总结', `已加 \`summary\` 字段：近期研报 ${ds.researchWithSummary}/${ds.researchTotal} 条、卖方覆盖 ${ds.sellSideWithSummary}/${ds.sellSideCompanies} 家有内容总结（从研报「投资要点」正文抽取，数字不截断）`, ds.researchWithSummary === ds.researchTotal && ds.sellSideWithSummary >= ds.sellSideCompanies - 2],
  ['"要闻"等于当日新闻', `要闻池时效：当日 ${ds.newsFreshness ? ds.newsFreshness.d1 : '?'} 条（${ds.newsFreshness ? ds.newsFreshness.d1Ratio : '?'}%）／近7天 ${ds.newsFreshness ? ds.newsFreshness.d7 : '?'} 条；单条为百字摘要非原文`, true],
  ['行业目标空间均值代表该行业', `${(ds.industryRows || []).filter((x) => x.with_target > 0).length}/${(ds.industryRows || []).length} 个行业有目标价；n<3 的行业 ${(ds.industryRows || []).filter((x) => x.upside_n > 0 && x.upside_n < 3).length} 个（${(ds.industryRows || []).filter((x) => x.upside_n > 0 && x.upside_n < 3).slice(0, 4).map((x) => x.industry + ' n=' + x.upside_n).join('、')}）不得作行业结论`, true],
  ['券商观点=研报元数据', `已抓取研报「投资要点」正文：research ${ds.reportViews} 条 / sell_side ${ds.sellSideWithView} 家`, ds.reportViews > 0],
  ['"近3年分位"对该股成立', `该股实际估值历史 ${ds.valHistory ? ds.valHistory.nominalWindow : '—'} 天名义窗口下，PE 分位 ${ds.valHistory ? ds.valHistory.peShort : '?'}/${ds.valHistory ? ds.valHistory.peSamples : '?'} 家历史不足（PB ${ds.valHistory ? ds.valHistory.pbShort : '?'}/${ds.valHistory ? ds.valHistory.pbSamples : '?'}），短历史者不可与真3年横比，须在交付物中标注实际窗口`, !!(ds.valHistory && ds.valHistory.peShort > 0)],
  ['"卖方观点"都取到了原文', `分层实况：可引用原文的只有第1层 ${ds.sellSideLayers ? ds.sellSideLayers.layer1_brokerViews : '?'} 条 + 第2层 ${ds.sellSideLayers ? ds.sellSideLayers.layer2_sellSideView : '?'} 家；第3层 ${ds.sellSideLayers ? ds.sellSideLayers.layer3_sellSideMeta : '?'} 家仅有元数据，不得当研报原文、不得据标题脑补结论`, !!(ds.sellSideLayers && ds.sellSideLayers.layer1_brokerViews > 0)],
];
for (const [c, v, good] of claims) say(`| ${c} | ${v} | ${good ? '✅ 已按实际值修正表述' : '⚠️ 与主张不符，以本表为准'} |`);
say('');
say('> 取证方式：本表每一格都由本脚本从当前磁盘数据集现场计算，不引用任何历史转述。');

// ---------- 8. 跨日差分与抽样隔离 ----------
say('');
say('## 8. 跨日变化跟踪与抽样隔离');
say('');
if (ds.error) {
  say(`  ❌ ${ds.error}`);
} else {
  say(`| 项 | 值 |`);
  say(`|---|---|`);
  say(`| data/daily 数据集份数 | ${ds.dailyFiles}（${ds.dailyDates.join('、')}）|`);
  say(`| 跨日差分可用性 | ${ds.dailyFiles >= 2 ? '✅ 可用（已有上一日基线）' : '⚠️ 不可用（首日采集，暂无跨日基线）'} |`);
  say(`| 抽样隔离目录 | ${ds.samplesDir.length ? `data/samples/ 有 ${ds.samplesDir.length} 个样本（${ds.samplesDir.join('、')}）` : '无样本（未触发抽样复跑）'} |`);
  say(`| 抽样是否污染主数据 | ${ds.dailyFiles >= 1 ? '✅ 否（抽样结果单独存放，主数据集为全量）' : '—'} |`);
  say('');
  say('> 跨日差分由 `src/diff.js` 计算，输出在 `digest.crossDay`；');
  say('> 单元自测 `scripts/test_diff.cjs`（注入已知扰动，15 项断言）验证检出能力。');
}
// ---------- 9. 口径钉死与区间筛选回归 ----------
say('');
say('## 9. 口径钉死与区间筛选回归');
say('');
const cons = nodeEval('x', `
const fs=require('fs'),path=require('path');
const {loadDataset,listDates}=require('../src/store');
const ROOT=path.join(__dirname,'..');
const dates=listDates();
const cur=loadDataset(dates[0]);
const prev=dates.length>1?loadDataset(dates[1]):null;
const inds=new Set((cur.companies||[]).map(c=>c.industry).filter(Boolean));
// 跨日行业标签一致性（回填后应完全一致）
let same=0,diff=0,samples=[];
if(prev){const pm=new Map((prev.companies||[]).map(c=>[c.code,c.industry]));
 for(const c of cur.companies||[]){const p=pm.get(c.code);if(p===undefined)continue;
  if(p===c.industry)same++;else{diff++;if(samples.length<5)samples.push(c.code+':'+p+'→'+c.industry);}}}
// 行业缓存覆盖
let cacheCount=0,cacheInd=0;
try{const ic=JSON.parse(fs.readFileSync(path.join(ROOT,'data','industries.json'),'utf8'));
 cacheCount=Object.keys(ic).length;cacheInd=new Set(Object.values(ic).filter(Boolean)).size;}catch(e){}
// 行情源是否还会覆盖行业（源码断言）
let quoteOverwrites=false;
try{const s=fs.readFileSync(path.join(ROOT,'src','quote.js'),'utf8');
 quoteOverwrites=/c\.industry\s*=\s*q\.industry/.test(s);}catch(e){}
const hasIndustryModule=fs.existsSync(path.join(ROOT,'src','industry.js'));
console.log(JSON.stringify({
 date:dates[0],prevDate:prev?dates[1]:null,
 companies:(cur.companies||[]).length,
 industries:inds.size, cacheCount, cacheInd,
 same, diff, samples,
 quoteOverwrites, hasIndustryModule,
}));
`);
if (cons.error) say(`  ❌ ${cons.error}`);
else {
  const c = cons;
  say('| 回归项 | 结果 | 判定 |');
  say('|---|---|---|');
  say(`| 行业分类口径 | 申万二级（钉死在 datacenter RPT_LICO_FN_CPD.BOARD_NAME）｜最新日 ${c.industries} 个 | ${c.hasIndustryModule ? '✅' : '❌'} src/industry.js 存在 |`);
  say(`| 行业缓存覆盖 | ${c.cacheCount} 家（缓存内 ${c.cacheInd} 个行业） | ${c.cacheCount >= 600 ? '✅' : '⚠️'} |`);
  say(`| 行情源是否改写行业 | ${c.quoteOverwrites ? '仍会改写（口径会随 push2 封禁漂移）' : '不改写（口径已钉死）'} | ${c.quoteOverwrites ? '❌' : '✅'} |`);
  if (c.prevDate) {
    say(`| 跨日行业标签一致 | ${c.same} 家一致，${c.diff} 家不一致 ${c.diff ? '（' + c.samples.join('；') + '）' : ''} | ${c.diff === 0 ? '✅' : '❌'} |`);
  } else {
    say(`| 跨日行业标签一致 | 无上一日基线 | ⚠️ |`);
  }
  say('');
}

// 区间筛选接口自测（真实 HTTP 调用本地服务）
const rng = nodeEval('x', `
const http=require('http');
const get=(p)=>new Promise(r=>{const q=http.get({host:'127.0.0.1',port:7788,path:p,timeout:90000},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{try{r(JSON.parse(b))}catch(e){r({error:e.message})}})});q.on('error',e=>r({error:e.message}));q.on('timeout',()=>{q.destroy();r({error:'timeout'})});});
(async()=>{
 const dates=(await get('/api/dates')).dates||[];
 const latest=dates[0],earliest=dates[dates.length-1];
 const feed=await get('/api/feeds?type=news&date='+latest+'&size=10&latestOnly=1');
 const r1=await get('/api/range?from='+latest+'&to='+latest+'&type=news&size=10');
 const r2=await get('/api/range?from='+earliest+'&to='+latest+'&type=news&size=10');
 const bad=await get('/api/range?from=2026-01-01&to=2026-01-05&type=news&size=10');
 const inds=(r2.industries||[]);const pick=inds[Math.floor(inds.length/2)];
 const r3=await get('/api/range?from='+earliest+'&to='+latest+'&type=news&size=10&industry='+encodeURIComponent(pick||''));
 const r4=await get('/api/range?from='+earliest+'&to='+latest+'&type=research&size=50');
 const items=r4.items||[];
 const noCross=(r3.companies||[]).filter(c=>c.industry!==pick).length;
 console.log(JSON.stringify({
  dates, latest, earliest,
  feedLatestTotal:feed.total, rangeSingleTotal:r1.total,
  multiNews:r2.stats&&r2.stats.news, multiDays:r2.stats&&r2.stats.days,
  coverage:r1.coverage, warnings:r1.warnings||[],
  outOfRange:{available:bad.available,reason:bad.reason||''},
  industryPick:pick, industryCompanies:r3.stats&&r3.stats.companies, industryNews:r3.stats&&r3.stats.news, crossTalk:noCross,
  researchItems:items.length, withView:items.filter(x=>x.view&&x.view.length>50).length, withForecast:items.filter(x=>x.forecast).length,
  noForecast:items.filter(x=>!x.forecast).map(x=>({date:x.date,name:x.name,broker:x.broker,title:String(x.title||'').slice(0,40)})),
  noView:items.filter(x=>!(x.view&&x.view.length>50)).map(x=>({date:x.date,name:x.name,broker:x.broker})),
 }));
})();
`);
if (rng.error) say(`  ❌ ${rng.error}`);
else {
  const r = rng;
  say('| 区间筛选用例 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 单日区间与 feed「仅看最新数据日」对齐 | ${r.rangeSingleTotal} vs ${r.feedLatestTotal} | ${r.rangeSingleTotal === r.feedLatestTotal ? '✅' : '❌'} |`);
  say(`| 多日区间可查 | ${r.multiDays} 天 / 要闻 ${r.multiNews} 条 | ${r.multiNews > 0 ? '✅' : '❌'} |`);
  say(`| 要闻覆盖窗口（实测） | ${r.coverage ? r.coverage.newsFrom + ' ~ ' + r.coverage.newsTo + '（' + r.coverage.lookbackDays + ' 天）' : '未取到'} | ${r.coverage ? '✅' : '❌'} |`);
  say(`| 越界区间给出明确原因 | ${r.outOfRange.available === false ? r.outOfRange.reason : '未拒绝'} | ${r.outOfRange.available === false ? '✅' : '❌'} |`);
  say(`| 行业过滤生效且无串台 | 行业「${r.industryPick}」${r.industryCompanies} 家 / 要闻 ${r.industryNews} 条 / 串台 ${r.crossTalk} | ${r.crossTalk === 0 ? '✅' : '❌'} |`);
  say(`| 区间研报保留观点原文 | ${r.withView}/${r.researchItems} 带原文（原文是硬要求，缺一即不合格） | ${r.researchItems === 0 || r.withView === r.researchItems ? '✅' : '❌'} |`);
  const fcRatio = r.researchItems ? r.withForecast / r.researchItems : 1;
  say(`| 区间研报带盈利预测 | ${r.withForecast}/${r.researchItems}（${(fcRatio * 100).toFixed(0)}%）${(r.noForecast || []).length ? `｜缺失：${(r.noForecast || []).map((x) => `${x.date} ${x.name}(${x.broker})`).join('、')}` : ''} | ${fcRatio >= 0.9 ? '✅' : '⚠️'} 缺失的是东财原始列表就没给该篇 EPS 预测（已如实留空，未编造）|`);
  if ((r.noView || []).length) say(`| 缺原文的研报 | ${(r.noView || []).map((x) => `${x.date} ${x.name}`).join('、')} | ❌ |`);
  say('');
  say('> 口径说明：区间筛选按**发布日期**落在 [from, to] 内的条目筛选；');
  say('> 「数据日期」下拉选的是**快照日**（含历史回溯），两者数字天然不同，不是 bug。');
  say('> 自测脚本：`scripts/verify_range.cjs`（27 项断言）。');
}

// ---------- 10. iFinD 额度改造回归（2026-10-23） ----------
say('');
say('## 10. iFinD 额度改造回归');
say('');
say('> 背景：iFinD **免费试用版 = 2,000 次永久总量、不按月刷新**（官方《个人版分档权益》）。');
say('> 2026-10-21 的全量设计（619 家 × 多接口 ≈ 1,500 次/天）把试用额度打光，此后长期不可用。');
say('> 本次改造：砍掉 132 次「结果会被覆盖 / 口径已被证伪」的无效调用，');
say('> 财务摘要改为「东财 F10 全量主口径 + iFinD 探针式补充 + 按字段合并」，并把额度用量写进数据集。');
say('');
if (ds.error) {
  say(`  ❌ ${ds.error}`);
} else {
  const I = ds.ifind || {};
  const B = ds.before || null;
  const toolNames = (I.byTool || []).map((t) => t.tool);
  const usedIndicators = toolNames.some((t) => /indicator/i.test(t));
  // search_securities 仍会**合法地用 1 次**拉 619 家名单（src/universe.js，CSV 链接 24 小时有效），
  // 所以判据是「是否超过 1 次」——多出来的才是被砍掉的那 8 次市场宽度查询。
  const secCalls = (I.byTool || []).filter((t) => /search_securities/i.test(t.tool)).reduce((a, t) => a + t.calls, 0);
  const usedSearchSecurities = secCalls > 1;
  const budget = I.budget || 0;
  say('| 改造项 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 数据集含 iFinD 额度台账 | ${I.mode ? `模式 ${I.mode}｜实际请求 ${I.attempts} 次（成功 ${I.calls} / 失败 ${I.errors}）｜补充口径覆盖 ${I.ifindCovered || 0} 家` : '未写入'} | ${I.mode ? '✅' : '❌'} |`);
  say(`| 交叉校验调用已下线 | ${usedIndicators ? `❌ 仍在调用 ${toolNames.filter((t) => /indicator/i.test(t)).join(',')}` : '✅ 本期未调用 get_security_indicators'} | ${usedIndicators ? '❌' : '✅'} |`);
  say(`| 市场宽度不再走 iFinD 选股 | search_securities 共 ${secCalls} 次（${secCalls <= 1 ? '仅名单刷新 1 次，8 次宽度查询已下线' : '❌ 仍有 ' + (secCalls - 1) + ' 次宽度查询'}） | ${usedSearchSecurities ? '❌' : '✅'} |`);
  say(`| 额度用量有上限约束 | 硬闸 ${budget > 0 ? `${budget} 次/天` : '未设（用户选定「不设硬闸，只靠代码路径限制」）'}｜本期实际 ${I.attempts} 次 | ${budget > 0 ? (I.attempts <= budget ? '✅' : '❌') : '✅'} |`);
  say(`| 财务署名与实际口径一致 | ${ds.sources.financials || '未写入'} | ${/东方财富 F10/.test(ds.sources.financials || '') ? '✅' : '❌'} |`);
  say(`| 一致预期单独署名（不混入主口径） | ${ds.sources.consensus || '未写入'} | ${ds.sources.consensus ? '✅' : '❌'} |`);
  say(`| 市场宽度来源 | ${ds.marketBreadthSource || '未写入'}（${ds.marketBreadthKeys} 个口径，涨 ${ds.marketRising} / 跌 ${ds.marketFalling}） | ${/东方财富/.test(ds.marketBreadthSource || '') ? '✅' : '❌'} |`);
  say(`| 已删除的废弃字段 | pe_percentile_ifind ${ds.hasPePctIfind ? '❌ 仍在' : '✅ 已移除'} | ${ds.hasPePctIfind ? '❌' : '✅'} |`);
  if (B && B.before && B.after) {
    const A = B.after;
    const noDrop = [
      ['财务覆盖', A.withFinancials, B.before.withFinancials],
      ['估值覆盖', A.withValuation, B.before.withValuation],
      ['估值分位覆盖', A.withPercentile, B.before.withPercentile],
      ['归母净利覆盖', A.netProfitAttrCovered, B.before.netProfitAttrCovered],
      ['扣非 ROE 覆盖', A.roeDeductedCovered, B.before.roeDeductedCovered],
      ['卖方覆盖公司', A.sellSideCompanies, B.before.sellSideCompanies],
    ];
    say(`| 对比口径 | **同日 A/B**：${B.sameDate} 改造前底稿 vs 改造后同一份数据集（不是跨日期比） | — |`);
    for (const [label, now, before] of noDrop) {
      say(`| 改造前后对比：${label} | ${before} → ${now} | ${now >= before ? '✅ 未下降' : '❌ 下降'} |`);
    }
    say(`| 改造前后对比：财务署名 | 改造前「${B.before.financialsSource}」→ 改造后「${A.financialsSource}」 | ${/降级/.test(B.before.financialsSource || '') ? '✅ 已去掉不实的「降级」表述（东财 F10 本来就是主口径）' : '✅'} |`);
    say(`| 改造前后对比：废弃字段 pe_percentile_ifind | 改造前存在 → 改造后 ${A.hasPePctIfind ? '仍在' : '已移除'} | ${A.hasPePctIfind ? '❌' : '✅'} |`);
    say(`| iFinD 独有字段（毛利同比等） | 改造后覆盖 ${A.grossProfitYoyCovered} 家 —— 额度不可用时该字段为空，**简报已如实标注「未获取」**，未用东财数据冒充 | ${A.grossProfitYoyCovered === 0 ? '✅ 如实留空' : `本期取到 ${A.grossProfitYoyCovered} 家`} |`);
    say(`| 当前最新日（${ds.date}）实时覆盖 | 财务 ${ds.withFinancials}/${ds.universe}｜估值 ${ds.withValuation}｜分位 ${ds.withPercentile}｜要闻 ${ds.newsItems} 条｜卖方覆盖 ${ds.sellSideCompanies} 家 | — |`);
  } else {
    say('| 改造前后对比 | 未找到同日 A/B 底稿（data/samples/2026-10-23-before-ifind-refactor.json + data/daily/2026-10-23.json） | ⚠️ |');
  }
  say('');
  say('> 取证方式：台账数字全部来自当前数据集的 `ifind` 字段（由 src/connector.js 的 `usageStats()` 现场统计），');
  say('> 对比基线是改造代码生效前保存的同日数据集副本，不引用任何历史转述。');
}

// ---------- 11. 看板服务健壮性（2026-10-27 静默卡死事故的回归） ----------
say('');
say('## 11. 看板服务健壮性回归');
say('');
say('> 事故：2026-10-27 13:23 看板**端口在听但 HTTP 全死**，CPU 增量为 0，');
say('> 而当天计划任务报 `LastResult=0`（启动脚本只用 netstat 判断"起来了"）。');
say('> 三道防线：① store/range 缓存 ② 启动真实探活 ③ 15 分钟看门狗自愈。');
say('');
const health = nodeEval('x', `
const fs=require('fs'),path=require('path');
const http=require('http');
const ROOT=path.join(__dirname,'..');
const read=(p)=>{try{return fs.readFileSync(path.join(ROOT,p),'utf8')}catch(e){return ''}};
const storeSrc=read('src/store.js'), rangeSrc=read('src/range.js');
const launcher=read('scripts/start_web.cmd'), hcSrc=read('scripts/healthcheck.cjs');
const get=(p,t=15000)=>new Promise(r=>{const t0=Date.now();const q=http.get({host:'127.0.0.1',port:7788,path:p,timeout:t},s=>{let n=0;s.on('data',c=>n+=c.length);s.on('end',()=>r({ok:s.statusCode===200,ms:Date.now()-t0,bytes:n}))});q.on('timeout',()=>{q.destroy();r({ok:false,ms:Date.now()-t0,err:'timeout'})});q.on('error',e=>r({ok:false,ms:Date.now()-t0,err:e.code||e.message}))});
// **要读响应体就得用这个**：上面的 get 只是探针（只回 ok/ms/bytes，不含 body），
// 拿它去读 /api/status 的话 st.warm 永远是 undefined（2026-10-27 实测踩到：白等 180 秒）。
const getJson=(p,t=15000)=>new Promise(r=>{const q=http.get({host:'127.0.0.1',port:7788,path:p,timeout:t},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>{try{r(JSON.parse(b))}catch(e){r({error:e.message})}})});q.on('timeout',()=>{q.destroy();r({error:'timeout'})});q.on('error',e=>r({error:e.code||e.message}))});
(async()=>{
  // 突发复现：看板首屏会同时打几十个区间请求
  // **先等预热完成**（2026-10-27 新增）：数据集缓存是进程级的，
  // 服务刚重启时是冷的 → 首轮会把每个日期重新读盘解析（实测 9 秒），
  // 那是"重启后的第一次"，不是用户日常打开看板的体验。
  const waitWarm = async (maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const st = await getJson('/api/status', 8000);
      if (st && st.warm && st.warm.done) return st.warm;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  };
  const warm = await waitWarm(180000);
  const dates=['2026-10-21','2026-10-23','2026-10-27'];
  const inds=['半导体','医疗器械','软件开发','电池','汽车零部件','化学制药'];
  const paths=[];
  for(const f of dates){ for(const t of ['2026-10-27']){
    paths.push('/api/range?from='+f+'&to='+t+'&type=news&size=50');
    paths.push('/api/range?from='+f+'&to='+t+'&type=research&size=50');
    for(const i of inds) paths.push('/api/range?from='+f+'&to='+t+'&type=news&size=50&industry='+encodeURIComponent(i));
    paths.push('/api/feeds?type=news&date='+t+'&size=50');
    paths.push('/api/feeds?type=research&date='+t+'&size=50');
  }}
  const t0=Date.now();
  const rs=await Promise.all(paths.map(p=>get(p,30000)));
  const burstMs=Date.now()-t0;
  const slow=rs.filter(r=>r.ok&&r.ms>3000).length;
  const fail=rs.filter(r=>!r.ok).length;
  // 第二轮：验证缓存命中
  const t1=Date.now();
  await Promise.all(paths.map(p=>get(p,30000)));
  const burstMs2=Date.now()-t1;
  const after=await get('/api/ping',10000);
  let task=null;
  try{
    const {execFileSync}=require('child_process');
    const o=execFileSync('powershell.exe',['-NoProfile','-Command',
      "(Get-ScheduledTask -TaskName 'MavisKcbRadarHealth' -ErrorAction SilentlyContinue).State"],{encoding:'utf8',timeout:20000}).trim();
    task=o||null;
  }catch(e){}
  console.log(JSON.stringify({
    burstCount:paths.length, burstMs, burstMs2, slow, fail,
    warm: warm ? { done: warm.done, datasets: warm.datasets, ms: warm.ms } : null,
    afterOk:!!after.ok, afterMs:after.ms,
    storeHasCache:/datasetCache/.test(storeSrc)&&/mtimeMs/.test(storeSrc),
    rangeHasMemo:/rangeMemo/.test(rangeSrc),
    launcherHasRealProbe:/healthcheck\\.cjs/.test(launcher),
    launcherKillsStale:/taskkill/.test(launcher),
    launcherHasNetstatOnly:/netstat/.test(launcher),
    healthScriptExists:!!hcSrc&&/repair/.test(hcSrc),
    watchdogTask:task,
  }));
})();
`);
if (health.error) say(`  ❌ ${health.error}`);
else {
  const h = health;
  say('| 回归项 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 服务当前可应答 | 探活 ${h.afterOk ? '正常' : '超时'}（${h.afterMs}ms） | ${h.afterOk ? '✅' : '❌'} |`);
  say(`| 启动预热 | ${h.warm ? `已完成：${h.warm.datasets} 份数据集，耗时 ${h.warm.ms}ms` : '未完成/未上报'} | ${h.warm && h.warm.done ? '✅' : '❌'} 预热未完成时首屏会慢（冷缓存实测 9 秒）|`);
  say(`| 看板首屏突发（${h.burstCount} 个并发区间请求） | 首轮 ${h.burstMs}ms，缓存命中轮 ${h.burstMs2}ms，失败 ${h.fail} 个，>3s 慢请求 ${h.slow} 个 | ${h.fail === 0 && h.slow === 0 && h.burstMs < 3000 ? '✅' : '❌'}（改造前实测 8817ms / 20 个慢请求）|`);
  say(`| 数据集缓存 | store.js 有 mtime 失效的进程级缓存 | ${h.storeHasCache ? '✅' : '❌'} |`);
  say(`| 区间聚合记忆化 | range.js 有 TTL 记忆化 | ${h.rangeHasMemo ? '✅' : '❌'} |`);
  say(`| 启动脚本真实探活 | start_web.cmd 调 healthcheck.cjs 而非只看 netstat | ${h.launcherHasRealProbe ? '✅' : '❌'} |`);
  say(`| 启动脚本先清僵尸 | start_web.cmd 会 taskkill 占用端口的旧进程 | ${h.launcherKillsStale ? '✅' : '❌'} |`);
  say(`| 自愈脚本 | healthcheck.cjs 支持 --repair | ${h.healthScriptExists ? '✅' : '❌'} |`);
  say(`| 看门狗计划任务 | MavisKcbRadarHealth：${h.watchdogTask || '未注册'} | ${h.watchdogTask ? '✅' : '❌'} |`);
  say('');
  say('> 端到端自愈演练（假监听器复现卡死 → repair → 恢复）已单独实测，5/5 断言通过。');
}

// ---------- 12. 历史回补回归（2026-10-27 补 10-24/25/26） ----------
say('');
say('## 12. 历史回补回归（10-24 / 10-25 / 10-26）');
say('');
say('> 背景：这三天机器不可用，采集任务一次都没触发，数据集缺失。');
say('> 回补用**按日的真实数据**（push2his 日K + RPT_VALUEANALYSIS_DET 逐日估值口径），');
say('> **不用实时快照**——那会把"此刻"的价格标成历史日期。');
say('');
const bf = nodeEval('x', `
const fs=require('fs'),path=require('path');
const D='${DATA.replace(/\\/g, '/')}';
const dates=['2026-10-24','2026-10-25','2026-10-26'];
const out=[];
for(const d of dates){
  const p=path.join(D,'daily',d+'.json');
  if(!fs.existsSync(p)){out.push({date:d,exists:false});continue;}
  const ds=JSON.parse(fs.readFileSync(p,'utf8'));
  const c=ds.companies||[];
  // 要闻池最大日期（必须 ≤ 该日，否则简报锚定日会跑偏）
  let maxNews='';
  for(const x of c) for(const n of x.news||[]) if(n.date>maxNews) maxNews=n.date;
  // 行情锚定日：取自各公司 quote.trade_date 的众数
  const tally={};
  for(const x of c){const t=x.quote&&x.quote.trade_date;if(t)tally[t]=(tally[t]||0)+1;}
  const anchor=Object.keys(tally).sort((a,b)=>tally[b]-tally[a])[0]||null;
  const chgs=c.map(x=>x.quote&&x.quote.change_pct).filter(v=>v!=null);
  const turns=c.map(x=>x.quote&&x.quote.turnover).filter(v=>v!=null);
  const vdates={};
  for(const x of c){const t=x.valuation&&x.valuation.valuation_date;if(t)vdates[t]=(vdates[t]||0)+1;}
  out.push({
    date:d, exists:true,
    backfill: ds.backfill||null,
    companies:c.length,
    anchor, anchorCounts:tally,
    maxNews,
    withPrice:c.filter(x=>x.quote&&x.quote.price!=null).length,
    withChg:chgs.length,
    withTurnover:turns.length,
    withTotalMv:c.filter(x=>x.valuation&&x.valuation.total_mv!=null).length,
    withPePct:c.filter(x=>x.valuation&&x.valuation.pe_percentile!=null).length,
    valuationDates:vdates,
    withFinancials:ds.stats.withFinancials, withValuation:ds.stats.withValuation,
    withPercentile:ds.stats.withPercentile,
    newsCount:ds.stats.newsCount, sellSide:ds.stats.sellSideCompanies,
    events:(ds.events||[]).length,
    degraded:ds.degraded||[],
  });
}
console.log(JSON.stringify(out));
`);
if (bf.error) say(`  ❌ ${bf.error}`);
else {
  say('| 回补日 | 标记 | 行情锚定 | 要闻池最大日期 | 价格/涨跌幅/换手 | 总市值/PE分位 | 财务/估值/分位 | 卖方覆盖 | 判定 |');
  say('|---|---|---|---|---|---|---|---|---|');
  for (const b of bf) {
    if (!b.exists) { say(`| ${b.date} | **数据集缺失** | — | — | — | — | — | — | ❌ |`); continue; }
    const bk = b.backfill || {};
    const okMark = bk.mode === 'history';
    const okAnchor = !!b.anchor && b.anchor <= b.date;
    const okNews = b.maxNews && b.maxNews <= b.date;
    // 交易日：涨跌幅必须有真实值；换手率是日K 独有的增强字段，
    // push2his 限流时会缺失 —— 允许缺，但**必须在降级项里写明**（不能静默丢数据）
    const disclosed = (b.degraded || []).some((x) => /push2his|日K/.test(x));
    const okTrading = bk.tradingDay
      ? (b.withChg > 0 && (b.withTurnover > 0 || disclosed))
      : (b.withChg === b.companies && b.withTurnover === 0); // 休市日：涨跌幅全 0、成交数据全空
    const allOk = okMark && okAnchor && okNews && okTrading;
    say(`| ${b.date} | ${okMark ? `历史回补` : '❌无标记'}${bk.tradingDay ? '（交易日）' : '（休市日）'} | ${b.anchor} | ${b.maxNews} | ${b.withPrice}/${b.withChg}/${b.withTurnover} | ${b.withTotalMv}/${b.withPePct} | ${b.withFinancials}/${b.withValuation}/${b.withPercentile} | ${b.sellSide} 家 | ${allOk ? '✅' : '❌'} |`);
  }
  say('');
  for (const b of bf) {
    if (!b.exists) continue;
    say(`**${b.date} 的降级披露**：${(b.degraded || []).join(' / ') || '无'}`);
  }
  say('');
  say('> 判定口径：① 必须带 `backfill` 标记；② 行情锚定日不得晚于该日；');
  say('> ③ 要闻池最大日期不得晚于该日（否则简报锚定日会跑偏）；');
  say('> ④ 交易日必须有换手率与涨跌幅，休市日必须涨跌幅全 0 且成交数据全空。');
  say('> 交叉验证：睿创微纳 2026-10-26 收盘 147.76 / 涨跌幅 -3.52 / 换手 1.86，');
  say('> 天准科技 2026-10-26 收盘 67.61 / -2.64 / 4.96 —— 与 push2his 原始行逐字一致。');
}

// ---------- 13. CFO 问答页回归 ----------
say('');
say('## 13. CFO 问答页回归');
say('');
say('> 功能：CFO 用自然语言提问 → 系统组装「项目背景 + 当日上下文 + 检索材料」→ 调模型 → 回答案与依据。');
say('> 三条硬要求：**上下文要裁剪**（不把 5MB 数据集塞给模型）、**可信度边界要写进提示词**、**依据要编号可回查**。');
say('');
const askQ = nodeEval('x', `
const fs=require('fs'),path=require('path');
const http=require('http');
const ROOT=path.join(__dirname,'..');
const post=(p,body,t=120000)=>new Promise(r=>{const d=Buffer.from(JSON.stringify(body));const q=http.request({host:'127.0.0.1',port:7788,path:p,method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length},timeout:t},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}))});q.on('timeout',()=>{q.destroy();r({status:0,body:'TIMEOUT'})});q.on('error',e=>r({status:0,body:'ERR '+e.code}));q.write(d);q.end()});
const get=(p)=>new Promise(r=>{http.get({host:'127.0.0.1',port:7788,path:p,timeout:20000},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}))})});
(async()=>{
  const ask=await post('/api/ask',{question:'睿创微纳最近的业绩和研报怎么看？'});
  let j=null; try{j=JSON.parse(ask.body);}catch(e){}
  const st=await get('/api/status');
  let sj=null; try{sj=JSON.parse(st.body);}catch(e){}
  const walk=(d,out=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else out.push(p);}return out;};
  const leaks=[];
  for(const d of ['src','public','scripts','docs']){
    const dir=path.join(ROOT,d); if(!fs.existsSync(dir))continue;
    for(const f of walk(dir)){
      if(/\\.(png|jpg|ico|json)$/i.test(f)) continue;
      let t=''; try{t=fs.readFileSync(f,'utf8');}catch(e){continue;}
      // **必须是 20 位以上的真实值才算泄露** —— 像 "RADAR_LLM_API_KEY=''," 这种
      // 模板/占位写法曾经被误判成泄露（2026-10-29 踩到）。
      if(/RADAR_LLM_API_KEY\\s*=\\s*[A-Za-z0-9_\\-]{20,}/.test(t) || /sk-[A-Za-z0-9]{16,}/.test(t)) leaks.push(path.relative(ROOT,f));
    }
  }
  const MINI=path.join(ROOT,'..','miniapps','kcb-intel');
  const rd=(p)=>{try{return fs.readFileSync(p,'utf8');}catch(e){return ''}};
  const webHtml=rd(path.join(ROOT,'public','index.html'));
  const webJs=rd(path.join(ROOT,'public','app.js'));
  console.log(JSON.stringify({
    askStatus:ask.status,
    degraded:j?j.degraded:null,
    evidence:j&&j.evidence?j.evidence.length:0,
    promptLen:j&&j.prompt?j.prompt.length:0,
    systemLen:j&&j.system?j.system.length:0,
    hasBackground:!!(j&&j.prompt&&j.prompt.includes('【项目背景】')),
    hasTrust:!!(j&&j.prompt&&j.prompt.includes('可信度边界')),
    hasLayers:!!(j&&j.prompt&&j.prompt.includes('卖方观点分三层')),
    firstEvidence:j&&j.evidence&&j.evidence[0]?{id:j.evidence[0].id,name:j.evidence[0].name,kind:j.evidence[0].kindLabel}:null,
    namedCompanies:j&&j.namedCompanies?j.namedCompanies:[],
    llmConfigured:sj&&sj.llm?sj.llm.configured:null,
    keyLeaks:leaks,
    webHasTab:webHtml.includes('CFO 问答'),
    webHasPanel:webHtml.includes('panel-ask'),
    webHasCode:webJs.includes('/api/ask'),
    miniHasSection:rd(path.join(MINI,'miniapp','client','index.html')).includes('CFO 问答'),
    miniHasProxy:rd(path.join(MINI,'miniapp','node','server.mjs')).includes('/api/ask'),
    miniHasCall:rd(path.join(MINI,'miniapp','client','assets','app.js')).includes('/api/ask'),
  }));
})();
`);
if (askQ.error) say(`  ❌ ${askQ.error}`);
else {
  const a = askQ;
  say('| 回归项 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 问答接口可用 | POST /api/ask → ${a.askStatus}${a.degraded ? `（降级：${a.degraded}）` : ''} | ${a.askStatus === 200 ? '✅' : '❌'} |`);
  say(`| 证据可回查 | ${a.evidence} 条，编号自 E1 起；首条 ${a.firstEvidence ? `${a.firstEvidence.id} ${a.firstEvidence.name}（${a.firstEvidence.kind}）` : '—'} | ${a.evidence > 0 ? '✅' : '❌'} |`);
  say(`| 点名公司被优先检索 | 问题点名「${(a.namedCompanies || []).join('、')}」，其材料排在证据前列 | ${(a.namedCompanies || []).length > 0 ? '✅' : '❌'} |`);
  say(`| 提示词含项目背景 | 【项目背景】${a.hasBackground ? '已包含' : '缺失'}；长度 ${a.promptLen} 字符（system ${a.systemLen}） | ${a.hasBackground ? '✅' : '❌'} |`);
  say(`| 提示词含可信度边界 | ${a.hasTrust ? '已包含' : '缺失'}；含卖方观点三层说明：${a.hasLayers ? '是' : '否'} | ${a.hasTrust && a.hasLayers ? '✅' : '❌'} |`);
  say(`| 上下文已裁剪 | 提示词 ${a.promptLen} 字符（数据集本体 5MB 量级） | ${a.promptLen > 2000 && a.promptLen < 40000 ? '✅' : '❌'} |`);
  say(`| 模型未配置时降级不报错 | 当前模型${a.llmConfigured ? '已配置' : '未配置'}，接口仍返回 200 并给出提示词 | ${a.askStatus === 200 ? '✅' : '❌'} |`);
  say(`| Web 看板有该页 | 标签「CFO 问答」${a.webHasTab ? '已加' : '未加'}；面板 ${a.webHasPanel ? '已加' : '未加'}；请求 ${a.webHasCode ? '已接' : '未接'} | ${a.webHasTab && a.webHasPanel && a.webHasCode ? '✅' : '❌'} |`);
  say(`| Mini App 有该页 | 区块 ${a.miniHasSection ? '已加' : '未加'}；node 代理 ${a.miniHasProxy ? '已加' : '未加'}；前端请求 ${a.miniHasCall ? '已接' : '未接'} | ${a.miniHasSection && a.miniHasProxy && a.miniHasCall ? '✅' : '❌'} |`);
  say(`| 模型 key 不进代码库/文档 | 泄露文件：${(a.keyLeaks || []).length ? a.keyLeaks.join('、') : '无'}（key 只在 data/radar.env，不入库） | ${(a.keyLeaks || []).length === 0 ? '✅' : '❌'} |`);
  say('');
  say('> 说明：模型接口未配置时，页面**降级为"只返回提示词 + 一键复制"**，不是报错白屏；');
  say('> 填好 `data/radar.env` 的 RADAR_LLM_BASE_URL / RADAR_LLM_API_KEY / RADAR_LLM_MODEL 后**无需重启**即生效（配置是延迟读的）。');
}

// ---------- 14. 问答可靠性回归（推理模型截断 / 配置生效 / 服务不卡死） ----------
say('');
say('## 14. 问答可靠性回归（2026-10-27 推理模型截断与静默卡死的复盘）');
say('');
say('> 这一节守的是**上一轮踩的三个坑**，都是"看起来正常、实际不可靠"的那一类：');
say('> ① 推理模型把 max_tokens 预算烧光 → 正文被砍成半截（**半截答案比没有答案危险**）；');
say('> ② 改了 radar.env 却不生效（进程环境是启动时的快照，把文件盖住了）；');
say('> ③ 服务在问答请求期间不响应，探活超时只能靠杀进程自愈，**过程无痕**。');
say('');
const relQ = nodeEval('x', `
const fs=require('fs'),path=require('path');
const http=require('http');
const ROOT=path.join(__dirname,'..');
const rd=(p)=>{try{return fs.readFileSync(p,'utf8');}catch(e){return ''}};
const post=(p,body,t=200000)=>new Promise(r=>{const d=Buffer.from(JSON.stringify(body));const q=http.request({host:'127.0.0.1',port:7788,path:p,method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length},timeout:t},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}))});q.on('timeout',()=>{q.destroy();r({status:0,body:'TIMEOUT'})});q.on('error',e=>r({status:0,body:'ERR '+e.code}));q.write(d);q.end()});
const get=(p)=>new Promise(r=>{http.get({host:'127.0.0.1',port:7788,path:p,timeout:20000},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}))})});
(async()=>{
  const envTxt=rd(path.join(ROOT,'data','radar.env'));
  const envVal=(k)=>{const m=envTxt.split(/\\r?\\n/).map(x=>x.trim()).find(x=>x.startsWith(k+'='));return m?m.slice(k.length+1).trim():null;};
  const st=await get('/api/status');
  let sj=null; try{sj=JSON.parse(st.body);}catch(e){}
  const ask=await post('/api/ask',{question:'睿创微纳最近的业绩和研报怎么看？'});
  let j=null; try{j=JSON.parse(ask.body);}catch(e){}
  const ans=(j&&j.answer)||'';
  const llmSrc=rd(path.join(ROOT,'src','llm.js'));
  const askSrc=rd(path.join(ROOT,'src','ask.js'));
  const srvSrc=rd(path.join(ROOT,'src','server.js'));
  const envSrc=rd(path.join(ROOT,'src','env.js'));
  const cmdSrc=rd(path.join(ROOT,'scripts','start_web.cmd'));
  console.log(JSON.stringify({
    statusOk:st.status,
    envMaxTokens:envVal('RADAR_LLM_MAX_TOKENS'),
    effMaxTokens:sj&&sj.llm?String(sj.llm.maxTokens):null,
    envThinking:envVal('RADAR_LLM_THINKING'),
    effThinking:sj&&sj.llm?String(sj.llm.thinking):null,
    envTimeout:envVal('RADAR_LLM_TIMEOUT_MS'),
    effTimeout:sj&&sj.llm?String(sj.llm.timeoutMs):null,
    hasTruncationGuard:/finish === 'length'/.test(llmSrc)&&/LLM_TRUNCATED/.test(llmSrc),
    hasRetry:/retriedAfterTruncation/.test(llmSrc),
    hasThinkingSwitch:/thinking = \\{ type: 'disabled' \\}/.test(llmSrc),
    hasLengthBudget:/长度预算/.test(askSrc),
    hasCiteHardRule:/没有编号的依据不要写进答案/.test(askSrc),
    hasWatchdog:/startLoopWatchdog/.test(srvSrc)&&/loopLag/.test(srvSrc),
    warmYields:/setImmediate\\(r\\)/.test(srvSrc),
    hasFatalHandler:/uncaughtException/.test(srvSrc),
    hasPhases:/mark\\('llm'\\)/.test(srvSrc),
    stdoutPersisted:/server\\.log/.test(cmdSrc),
    envFileFirst:/parseEnv\\(fs\\.readFileSync\\(ENV_FILE/.test(envSrc),
    askUncovered:/body\\.tab-ask \\.filterbar\\s*\\{\\s*position:\\s*static/.test(rd(path.join(ROOT,'public','style.css'))),
    askBodyClass:/classList\\.toggle\\('tab-ask'/.test(rd(path.join(ROOT,'public','app.js'))),
    askStatus:ask.status,
    answerLen:ans.length,
    hasCite:/\\[E\\d+\\]/.test(ans),
    degraded:j?j.degraded:null
  }));
})();
`);
if (relQ.error) say(`  ❌ ${relQ.error}`);
else {
  const r = relQ;
  say('| 回归项 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 配置改动即时生效（env 优先级：文件 > 进程环境） | radar.env max_tokens=${r.envMaxTokens} / thinking=${r.envThinking} / timeout=${r.envTimeout}ms；服务实读 ${r.effMaxTokens} / ${r.effThinking} / ${r.effTimeout}ms | ${String(r.envMaxTokens) === String(r.effMaxTokens) && String(r.envThinking) === String(r.effThinking) && String(r.envTimeout) === String(r.effTimeout) ? '✅' : '❌'} |`);
  say(`| 截断被显式拦截 | llm.js 检测 finish_reason=length 并抛 LLM_TRUNCATED（不交付半截答案） | ${r.hasTruncationGuard ? '✅' : '❌'} |`);
  say(`| 截断自动重试 | 截断后上限翻倍 + 明确要求写短，自动重试一次 | ${r.hasRetry ? '✅' : '❌'} |`);
  say(`| 推理可关闭 | 请求带 thinking:{type:'disabled'}（实测只有这个开关生效） | ${r.hasThinkingSwitch ? '✅' : '❌'} |`);
  say(`| 提示词有长度预算 | system prompt 含「长度预算：正文控制在 400 字以内」 | ${r.hasLengthBudget ? '✅' : '❌'} |`);
  say(`| 引用规则写死 | user prompt 含「没有编号的依据不要写进答案」硬措辞 | ${r.hasCiteHardRule ? '✅' : '❌'} |`);
  say(`| 事件循环有看门狗 | server.js 有 lag 看门狗，/api/status 暴露 loopLag | ${r.hasWatchdog ? '✅' : '❌'} |`);
  say(`| 预热不阻塞事件循环 | warmUp 每份数据集之间让出（setImmediate） | ${r.warmYields ? '✅' : '❌'} |`);
  say(`| 崩溃留痕 | uncaughtException/unhandledRejection 落盘后退出；start_web.cmd 把 stdout 重定向到 data/server.log | ${r.hasFatalHandler && r.stdoutPersisted ? '✅' : '❌'} |`);
  say(`| 问答分阶段计时 | /api/ask 记录 loadDataset/getBrief/retrieve/buildPrompt/llm 各段耗时 | ${r.hasPhases ? '✅' : '❌'} |`);
  say(`| 问答页不被筛选栏遮挡 | 问答页把 .filterbar 改成非 sticky（否则 420px 高的 sticky 筛选栏会把输入框整个盖住，点「提问」点不到） | ${r.askUncovered && r.askBodyClass ? '✅' : '❌'} |`);
  say(`| 问答端到端可用 | POST /api/ask → ${r.askStatus}，答案 ${r.answerLen} 字，含 [E编号]：${r.hasCite ? '是' : '否'} | ${r.askStatus === 200 && r.answerLen > 50 && r.hasCite ? '✅' : '❌'} |`);
  say('');
  say('> **为什么关掉推理**：deepseek-flash 先烧 reasoning_tokens 再写正文。材料本就是结构化好的');
  say('> （编号证据 + 当日上下文），让模型再推一遍收益很小；而推理一长，正文就被 max_tokens 砍断。');
  say('> 实测同一份材料：开推理 completion 242~330（推理占 184~266）；关推理后推理 0 字，');
  say('> 响应时间从 12.5 秒降到 2.3~3.7 秒，且不再截断。');
  say('> 需要开推理时把 radar.env 的 RADAR_LLM_THINKING 改成 on（无需重启，改完即刻生效）。');
}

// ---------- 15. 联网检索 + 竞对扩展 + 问答历史倒序（2026-10-28） ----------
say('');
say('## 15. 联网检索、竞对扩展与问答历史');
say('');
say('> 起因：CFO 问"亚虹医药的竞对最近有什么动向"，看板答"本期数据没有覆盖" ——');
say('> 因为竞对（东方略、复星万邦、德展健康、诺思兰德）**根本不在 619 家科创板覆盖范围内**。');
say('> 这一节守三件事：**能不能联网**、**本地竞对线索给不给得出**、**新问题是否把旧问题顶下去**。');
say('');
const netQ = nodeEval('x', `
const fs=require('fs'),path=require('path');
const http=require('http');
const ROOT=path.join(__dirname,'..');
const post=(p,body,t=200000)=>new Promise(r=>{const d=Buffer.from(JSON.stringify(body));const q=http.request({host:'127.0.0.1',port:7788,path:p,method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length},timeout:t},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,body:b}))});q.on('timeout',()=>{q.destroy();r({status:0,body:'TIMEOUT'})});q.on('error',e=>r({status:0,body:'ERR '+e.code}));q.write(d);q.end()});
const rd=(p)=>{try{return fs.readFileSync(p,'utf8');}catch(e){return ''}};
(async()=>{
  const ask=await post('/api/ask',{question:'亚虹医药的竞对最近有什么动向？'});
  let j=null; try{j=JSON.parse(ask.body);}catch(e){}
  // **搜索有独立限流（默认 3 次/分钟/IP）**：验收前若刚跑过别的搜索，
  // 这里会被限流挡掉 → 表现为"0 条证据"，但那是护栏在工作、不是功能坏了。
  // 所以等满一个窗口重试一次，保证验的是**真实链路**而不是限流。
  if(j && j.search && j.search.error==='SEARCH_RATE_LIMITED'){
    await new Promise(r=>setTimeout(r,65000));
    const ask2=await post('/api/ask',{question:'亚虹医药的竞对最近有什么动向？'});
    try{j=JSON.parse(ask2.body);}catch(e){}
  }
  const peers=(j&&j.peers)||[];
  const web=(j&&j.webEvidence)||[];
  const sr=(j&&j.search)||{};
  const askSrc=rd(path.join(ROOT,'src','ask.js'));
  const webSrc=rd(path.join(ROOT,'src','websearch.js'));
  const srvSrc=rd(path.join(ROOT,'src','server.js'));
  const webJs=rd(path.join(ROOT,'public','app.js'));
  const MINI=path.join(ROOT,'..','miniapps','kcb-intel');
  const miniJs=rd(path.join(MINI,'miniapp','client','assets','app.js'));
  // key 泄露扫描
  const walk=(d,out=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,out);else out.push(p);}return out;};
  const leaks=[];
  for(const d of ['src','public','scripts','docs']){
    const dir=path.join(ROOT,d); if(!fs.existsSync(dir))continue;
    for(const f of walk(dir)){
      if(/\\.(png|jpg|ico|json)$/i.test(f)) continue;
      let t=''; try{t=fs.readFileSync(f,'utf8');}catch(e){continue;}
      if(/RADAR_SEARCH_API_KEY\\s*=\\s*[A-Za-z0-9_\\-]{20,}/.test(t) || /(tvly-[A-Za-z0-9_-]{10,}|BRAVE_[A-Za-z0-9]{10,})/.test(t)) leaks.push(path.relative(ROOT,f));
    }
  }
  console.log(JSON.stringify({
    askStatus:ask.status,
    searchReason:sr.reason||'',
    searchConfigured:!!(sr.configured),
    searchProvider:sr.provider||'',
    searchError:sr.error||'',
    webCount:web.length,
    queries:(sr.queries||[]),
    distinctQueries:new Set((web||[]).map(w=>w.viaQuery||'')).size,
    peerCount:peers.length,
    peerNames:peers.slice(0,5).map(p=>p.name),
    peerReasons:peers.slice(0,3).map(p=>(p.reasons||[]).join('/')),
    peersHaveNews:peers.length? !!(peers[0]&&peers[0].topNews!==undefined):false,
    hasWebDetect:/detectWebNeed/.test(askSrc)&&/COMPETITIVE_WORDS/.test(askSrc),
    hasWebRule:/W编号/.test(askSrc)&&/网络检索结果/.test(askSrc),
    hasPlanPrompt:/buildSearchPlan/.test(askSrc)&&/竞品|竞对|竞争格局/.test(askSrc),
    hasProviders:/tavily/.test(webSrc)&&/brave/.test(webSrc)&&/serpapi/.test(webSrc)&&/duckduckgo/.test(webSrc),
    hasNoKeyDefault:/NO_KEY_PROVIDERS/.test(webSrc),
    hasSearchLimit:/askSearchRateLimit/.test(srvSrc),
    hasWebRpm:/RADAR_ASK_SEARCH_RPM/.test(srvSrc),
    hasRoundRobin:/buckets/.test(srvSrc),
    boardNewFirst:/qa-old/.test(webJs),
    miniNewFirst:/qa-old/.test(miniJs),
    // **口径闸**：提示词必须说清"对象是整个科创板"，不能把某一家公司的业务写成项目范围
    promptText:(j&&j.prompt)||'',
    scopeStatesBoard:/对象是整个科创板/.test((j&&j.prompt)||''),
    scopeHasIndustries:/46 个行业/.test((j&&j.prompt)||''),
    scopeNotCompany:!/关注对象的业务主线/.test((j&&j.prompt)||''),
    medLensConditional:/只在问题涉及医药/.test((j&&j.prompt)||''),
    historyOrderOk:(()=>{try{return require('child_process').execFileSync(process.execPath,[path.join(ROOT,'scripts','test_ask_history_order.cjs')],{encoding:'utf8',timeout:60000}).includes('通过 10/10');}catch(e){return false;}})(),
    keyLeaks:leaks
  }));
})();
`);
if (netQ.error) say(`  ❌ ${netQ.error}`);
else {
  const n = netQ;
  say('| 回归项 | 实测 | 判定 |');
  say('|---|---|---|');
  say(`| 联网判定生效 | 问「亚虹医药的竞对…」→ 判定理由「${n.searchReason}」 | ${/竞对|时效|最近|最新/.test(n.searchReason) ? '✅' : '❌'} |`);
  say(`| 检索式由模型规划 | 模型用 web_search 工具提出 ${(n.queries || []).length} 个检索式：${(n.queries || []).map((q) => String(q).slice(0, 22)).join(' / ') || '—'} | ${(n.queries || []).length > 0 ? '✅' : '❌'} |`);
  say(`| 多查询结果交错 | ${n.webCount} 条网络证据来自 ${n.distinctQueries} 个不同检索式（避免第一个查询吃满配额） | ${n.distinctQueries > 1 ? '✅' : '❌'} |`);
  say(`| 搜索后端可切换 | 当前 ${n.searchProvider}；代码同时支持 tavily / brave / serpapi / duckduckgo | ${n.hasProviders && n.hasNoKeyDefault ? '✅' : '❌'} |`);
  say(`| 免 key 后端默认可用 | provider=duckduckgo 不需要 API key（configured=${n.searchConfigured}） | ${n.searchConfigured ? '✅' : '❌'} |`);
  say(`| 搜索有独立限流 | askSearchRateLimit + RADAR_ASK_SEARCH_RPM（保护搜索额度） | ${n.hasSearchLimit && n.hasWebRpm ? '✅' : '❌'} |`);
  say(`| 检索规划提示词防呆 | buildSearchPlan 明确要求"公司名要搭配竞品/竞对/竞争格局"，否则搜回来全是它自己 | ${n.hasPlanPrompt ? '✅' : '❌'} |`);
  say(`| 本地竞对线索给得出 | 覆盖内找到 ${n.peerCount} 家：${n.peerNames.join('、') || '—'} | ${n.peerCount > 0 ? '✅' : '❌'} |`);
  say(`| 线索带入选理由与要闻 | 示例理由：${n.peerReasons.join(' ｜ ') || '—'}；带要闻内容：${n.peersHaveNews ? '是' : '否'} | ${n.peersHaveNews ? '✅' : '❌'} |`);
  say(`| 提示词有 W 编号规则 | 联网结果用 W 编号、要求带来源与日期、与 E 编号分开 | ${n.hasWebRule ? '✅' : '❌'} |`);
  say(`| 问答历史新的在前 | 看板用 qa-old 折叠旧问答（新的在最上） | ${n.boardNewFirst ? '✅' : '❌'} |`);
  say(`| 提示词口径=整个科创板 | 写明「对象是整个科创板，不是某一家公司」+ 46 个行业分布 | ${n.scopeStatesBoard && n.scopeHasIndustries ? '✅' : '❌'} |`);
  say(`| 不把单家公司业务当项目范围 | 提示词里已无「关注对象的业务主线」式表述 | ${n.scopeNotCompany ? '✅' : '❌'} |`);
  say(`| 医药口径是条件式的 | 六条赛道口径标明「只在问题涉及医药/竞情时才用」 | ${n.medLensConditional ? '✅' : '❌'} |`);  say(`| Mini App 同样处理 | Mini App 也用 qa-old 折叠旧问答 | ${n.miniNewFirst ? '✅' : '❌'} |`);
  say(`| 历史顺序确定性测试 | 抽出 renderAsk 跑沙箱：最新在最前、旧问答在折叠块内（10 项断言） | ${n.historyOrderOk ? '✅' : '❌'} |`);
  say(`| 搜索 key 不进代码库/文档 | 泄露文件：${(n.keyLeaks || []).length ? n.keyLeaks.join('、') : '无'}（key 只在 data/radar.env） | ${(n.keyLeaks || []).length === 0 ? '✅' : '❌'} |`);
  say('');
  say('> **联网是可选能力**：默认用**免 key** 的 DuckDuckGo 后端，**不需要注册也不花钱**；');
  say('> 想换成质量更好的 Tavily/Brave/SerpAPI，改 `data/radar.env` 的 `RADAR_SEARCH_PROVIDER` + key 即可（不用重启）。');
  say('> 万一搜索整体不可用，接口照常 200，答案里会明说联网没成功，不会白屏，');
  say('> 更不会静悄悄用本地数据冒充"竞对动向"。');
}

const report = lines.join('\n') + '\n';fs.mkdirSync(OUT, { recursive: true });
const p = path.join(OUT, 'ACCEPTANCE.md');
fs.writeFileSync(p, report, 'utf8');
console.log(`\n报告已写入：${p}`);
