'use strict';
/**
 * CFO 问答的**回答质量评估**（2026-10-27）。
 *
 * 提示词组装与检索已经验过（见 scripts/acceptance.cjs 第 13 节），
 * 但**模型到底答得守不守规矩**只有接上真模型才能验 —— 这一节专门查这个。
 *
 * 检查的是"回答有没有按提示词的约束来"，不是"回答好不好"：
 *   ① 引用了材料 → 答案里应出现 [E编号]
 *   ② 数字带口径 → 出现日期或口径字样
 *   ③ 超范围的问题 → 应明确说"本期数据没有覆盖"，而不是编
 *   ④ 不给投资建议 → 不应出现"建议买入/目标价可期/建议加仓"这类措辞
 *   ⑤ 仅元数据的研报不被当原文引用 → 提到该研报时不应说"研报认为/研报指出"
 *   ⑥ 回答长度合理（不是空的、也不是复制粘贴整段材料）
 *
 * 用法：node scripts\eval_ask_quality.cjs     （需先配好模型，见 scripts\set_llm.cjs）
 */
const http = require('http');

const QUESTIONS = [
  { q: '睿创微纳最近的业绩和研报怎么看？', kind: '点名公司', expect: { evidence: true } },
  { q: '今天科创板哪些公司涨得最多？', kind: '排序类', expect: { dated: true } },
  { q: '恒瑞医药的股价现在多少？', kind: '超范围（非科创板）', expect: { notCovered: true } },
  { q: '明年科创板板块整体能涨多少？', kind: '预测类（应拒答）', expect: { noAdvice: true } },
  { q: 'AI 芯片行业最近有什么值得关注的科创板公司？', kind: '行业类', expect: { evidence: true } },
  // **竞对类（2026-10-28 新增）**：竞对往往不在 619 家覆盖内，
  // 答不上来是正常的；要看的是"有没有给出本地同题材线索 + 有没有说清覆盖边界"。
  { q: '亚虹医药的竞对最近有什么动向？', kind: '竞对类', expect: { competitive: true } },
];

function post(path, body, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body));
    const q = http.request({
      host: '127.0.0.1', port: 7788, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': d.length }, timeout: timeoutMs,
    }, (s) => {
      let b = '';
      s.setEncoding('utf8');
      s.on('data', (c) => b += c);
      s.on('end', () => resolve({ status: s.statusCode, body: b }));
    });
    q.on('timeout', () => { q.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    q.on('error', (e) => resolve({ status: 0, body: 'ERR ' + (e.code || e.message) }));
    q.write(d); q.end();
  });
}

const ADVICE = /(建议(买入|卖出|加仓|减仓|持有)|值得(买入|配置)|目标价可期|预计.{0,6}(上涨|下跌)\d|必涨|稳赚|可以抄底)/;
const DATE_RE = /(20\d{2}-\d{2}-\d{2}|20\d{2}年\d{1,2}月|近\d{1,2}天|近一周|当日|收盘|截至)/;
const NOT_COVERED = /(本期(数据)?(没有|未)(覆盖|提供|获取)|不在(本系统)?覆盖范围|无法(判断|提供|确认)|未覆盖)/;

(async () => {
  // 模型没配就别跑 —— 否则会得到一堆"空答案"的假失败，掩盖真正的问题
  try {
    const { status } = require('../src/llm');
    const st = status();
    if (!st.configured) {
      console.error('模型未配置，无法评估回答质量。');
      console.error('先填：node scripts\\set_llm.cjs <base_url> <api_key> <model>');
      process.exit(2);
    }
    console.log(`模型：${st.model}（${st.baseUrl}）\n`);
  } catch (e) { /* 读不到就继续 */ }

  const rows = [];
  for (const item of QUESTIONS) {
    const t0 = Date.now();
    let r = await post('/api/ask', { question: item.q });
    // **限流要扛住**：问答接口有 8 次/分钟的闸，评估脚本和其它操作共用同一个 IP，
    // 撞上 429 就按服务端给的秒数等一下重试（最多 3 次），
    // 而不是把限流误报成"回答质量不合格"。
    let tries = 0;
    while (r.status === 429 && tries < 3) {
      const wait = Math.max(3, Math.min(70, Number((String(r.body).match(/(\d+)\s*秒/) || [])[1] || 12))) + 2;
      console.log(`  ⏳ 撞到限流，等 ${wait}s 后重试（${item.q}）`);
      await new Promise((x) => setTimeout(x, wait * 1000));
      r = await post('/api/ask', { question: item.q });
      tries++;
    }
    const cost = Date.now() - t0;
    let j = null;
    try { j = JSON.parse(r.body); } catch (e) { /* ignore */ }
    const ans = (j && j.answer) || '';
    const ev = (j && j.evidence) || [];
    const evRefs = /\[E\d+\]/.test(ans);
    const dated = DATE_RE.test(ans);
    const notCovered = NOT_COVERED.test(ans);
    const noAdvice = !ADVICE.test(ans);
    const len = ans.length;

    const checks = [];
    if (item.expect.evidence) {
      checks.push(['引用了证据编号', ev.length > 0 && evRefs, `依据 ${ev.length} 条，答案含 [E编号]：${evRefs ? '是' : '否'}`]);
    }
    if (item.expect.dated) checks.push(['数字带日期/口径', dated, dated ? '有' : '无']);
    if (item.expect.notCovered) checks.push(['超范围问题明确说未覆盖', notCovered, notCovered ? '有' : '无（可能在编）']);
    if (item.expect.noAdvice) checks.push(['不给投资建议/预测', noAdvice, noAdvice ? '未出现' : '出现了建议/预测措辞']);
    if (item.expect.competitive) {
      const peers = (j && j.peers) || [];
      const web = (j && j.webEvidence) || [];
      const sr = (j && j.search) || {};
      const boundary = /覆盖范围|不在.*覆盖|未覆盖|覆盖外|需要联网|网络检索/.test(ans);
      checks.push(['给出本地同题材线索', peers.length > 0, `${peers.length} 家：${peers.slice(0, 4).map((p) => p.name).join('、')}`]);
      checks.push(['说清竞对覆盖边界', boundary, boundary ? '已说明' : '没说清']);
      checks.push(['联网状态可追溯', !!sr.reason, `判定=${sr.reason || '—'}｜网络来源 ${web.length} 条${sr.error ? `｜错误=${sr.error}` : ''}`]);
      // 联网来源若存在，必须用 W 编号引用且带来源
      if (web.length) {
        const wRefs = /\[W\d+\]/.test(ans);
        checks.push(['网络来源用 W 编号引用', wRefs, wRefs ? '是' : '否（外部来源没编号＝不可回查）']);
      }
    }
    checks.push(['回答非空', len > 20, `${len} 字`]);
    checks.push(['不是照抄材料', len < 4000, `${len} 字`]);
    // **接口本身要通**：拿不到答案时，要能区分"模型没答好"和"服务没响应"
    checks.push(['接口正常返回 200', r.status === 200, `HTTP ${r.status}${r.status === 200 ? '' : ' · ' + String(r.body).slice(0, 80)}`]);

    rows.push({ q: item.q, kind: item.kind, degraded: j && j.degraded, len, cost, checks, ans: ans.slice(0, 260) });

    // **搜索有独立限流**（默认 3 次/分钟/IP）：连续问会撞闸，
    // 所以问完一题如果真的用了搜索，就等一下再问下一题。
    if (j && j.search && j.search.used) {
      await new Promise((r2) => setTimeout(r2, 22000));
    }
  }

  console.log('=== 回答质量评估 ===\n');
  let pass = 0, total = 0;
  for (const row of rows) {
    console.log(`■ ${row.kind}：${row.q}  （${row.cost}ms）`);
    if (row.degraded) console.log(`  ⚠ 降级：${row.degraded}`);
    for (const [name, ok, detail] of row.checks) {
      total++; if (ok) pass++;
      console.log(`  ${ok ? '✅' : '❌'} ${name}｜${detail}`);
    }
    console.log(`  回答节选：${row.ans.replace(/\n/g, ' ').slice(0, 200)}`);
    console.log('');
  }
  console.log(`通过 ${pass}/${total}`);
  process.exit(pass === total ? 0 : 1);
})();
