'use strict';
/**
 * **问答历史顺序的确定性测试**（2026-10-28）。
 *
 * 背景：CFO 反馈"上条的问答还显示在上面，没有被新问题覆盖"。
 * 需求：**最新的放最上面，更早的折叠保留**（用户拍板）。
 *
 * 为什么用这个而不是浏览器点：
 * - 渲染逻辑是**纯字符串拼接**，可以脱离浏览器直接验，结果确定、可重复；
 * - 浏览器点击在窄窗口下会落空（sticky 容器遮挡 + 坐标过期），
 *   那是**另一个**问题（窄屏 tab 可达性），不该混进这次的验收里。
 *
 * 做法：把 public/app.js 与 Mini App 里的 renderAsk 抽出来，
 * 用假的 state / DOM 跑一遍，检查输出里的顺序。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..');
const MINI = path.join(WEB, '..', 'miniapps', 'kcb-intel');

/** 从源码里抠出 renderAsk 函数体 */
function extractRender(src) {
  const i = src.indexOf('function renderAsk(');
  if (i < 0) throw new Error('找不到 renderAsk');
  // 找到函数结尾（配对大括号）
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

/** 造一个最小沙箱：只需要 $ / $$ / esc / mdLite / state */
function runRender(src, history) {
  const code = extractRender(src);
  const state = { askHistory: history };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const mdLite = (s) => String(s || '').replace(/\n/g, '<br>');
  let html = '';
  const body = { innerHTML: '' };
  const sandbox = {
    state,
    askHistory: history,   // Mini App 用的是裸变量，看板用 state.askHistory
    esc,
    mdLite,
    $: (sel) => (sel === '#askBody' ? body : null),
    $$: () => [],
    document: { getElementById: () => null },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\n; renderAsk();', sandbox);
  html = body.innerHTML;
  return html;
}

const HISTORY = [
  { question: '第一个问题：睿创微纳业绩？', answer: '答案一', at: '10:00:00', evidence: [], prompt: 'P1' },
  { question: '第二个问题：今天谁涨最多？', answer: '答案二', at: '10:05:00', evidence: [], prompt: 'P2' },
  { question: '第三个问题：亚虹的竞对？', answer: '答案三', at: '10:10:00', evidence: [], prompt: 'P3' },
];

const TARGETS = [
  { name: '看板 public/app.js', file: path.join(WEB, 'public', 'app.js') },
  { name: 'Mini App client/app.js', file: path.join(MINI, 'miniapp', 'client', 'assets', 'app.js') },
];

let pass = 0, total = 0;
for (const t of TARGETS) {
  const src = fs.readFileSync(t.file, 'utf8');
  const html = runRender(src, HISTORY);
  const checks = [];
  // 1) 最新的问题排在最前
  const i3 = html.indexOf('第三个问题');
  const i2 = html.indexOf('第二个问题');
  const i1 = html.indexOf('第一个问题');
  checks.push(['最新问题在最前', i3 >= 0 && i3 < i2 && i2 < i1, `位置 最新=${i3} 次新=${i2} 最旧=${i1}`]);
  // 2) 更早的问答收进折叠块
  const fold = html.indexOf('qa-old');
  checks.push(['旧问答折叠保留', fold >= 0 && fold < i2, fold >= 0 ? `折叠块在第 ${fold} 位` : '没有折叠块']);
  // 3) 三条问答都在，且**只有最新那条在折叠块外面**
  //    （不能按 </details> 切块：每条问答内部还有 qa-ev / qa-prompt 的嵌套 details）
  const allQ = (html.match(/class="qa-q"/g) || []).length;
  const outside = fold >= 0 ? (html.slice(0, fold).match(/class="qa-q"/g) || []).length : -1;
  const inside = fold >= 0 ? (html.slice(fold).match(/class="qa-q"/g) || []).length : -1;
  checks.push(['三条问答都渲染了', allQ === 3, `共 ${allQ} 条`]);
  checks.push(['折叠块内含 2 条历史', inside === 2, `块内=${inside} 块外=${outside}`]);
  // 4) 最新一条不在折叠块里
  checks.push(['最新问答不在折叠块内', fold >= 0 && i3 < fold && outside === 1, `最新位置=${i3} 折叠起点=${fold} 块外条数=${outside}`]);

  console.log(`\n■ ${t.name}`);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}｜${detail}`);
    total++; if (ok) pass++;
  }
}

console.log(`\n问答历史顺序：通过 ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
