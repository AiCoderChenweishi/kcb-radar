'use strict';
/**
 * 核查：行业筛选框筛出来的条目，是不是都在讲科创板这家公司？
 *
 * 判据与简报总结层一致：**标题点名了本公司**才算归因可信。
 * 标题讲的是别家公司（综合稿 / 他公司事项）→ 挂靠公司只是"正文里提到了它"。
 */
const http = require('http');
const { loadDataset, listDates } = require('../src/store');

function get(p) {
  return new Promise((r) => {
    http.get('http://127.0.0.1:7788' + p, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { r(JSON.parse(b)); } catch (e) { r({ error: e.message }); } });
    });
  });
}

// 标题里出现的"公司名"，用于判断标题主体是谁
const NAME = /([\u4e00-\u9fa5A-Za-z*＋\-]{2,10})(?=[:：]|完成|拟|预计|签署|获批|上涨|下跌|净利|Q3|前三季度|紧急|将|与|及|中报|半年报|回购|涨停|跌停|新|首)/g;

(async () => {
  const ds = loadDataset(listDates()[0]);
  const nameOf = new Map(ds.companies.map((c) => [c.code, c.name]));
  const names = ds.companies.map((c) => c.name);
  const isBoard = (s) => names.includes(s);

  for (const ind of ['半导体', '化学制药', '医疗器械']) {
    const j = await get('/api/range?from=2026-10-16&to=2026-10-22&type=news&size=300&industry=' + encodeURIComponent(ind));
    const items = j.items || [];
    let cross = 0;
    const samples = [];
    for (const x of items) {
      const t = x.title || '';
      const m = [...t.matchAll(NAME)].map((v) => v[1]);
      // 标题里出现了一个"像公司名"的词，且不是挂靠公司 → 标题讲的是别家
      const other = m.find((n) => n !== x.name && !t.includes(x.name) && n.length >= 3);
      if (other) {
        cross++;
        if (samples.length < 4) samples.push(`挂在 ${x.name}(${x.code}) 名下 → 标题「${t.slice(0, 44)}」（标题主体疑似「${other}」，${isBoard(other) ? '是科创板公司' : '非科创板'}）`);
      }
    }
    console.log(`\n【${ind}】近7天 ${j.total} 条，本次抽样 ${items.length} 条`);
    console.log(`  标题讲的是别家公司的：${cross} 条（占抽样 ${((cross / Math.max(1, items.length)) * 100).toFixed(1)}%）`);
    for (const s of samples) console.log('   · ' + s);
  }
})();
