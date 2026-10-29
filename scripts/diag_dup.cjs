'use strict';
/**
 * 诊断：区间模式的重复条目到底从哪来？
 * 对照组：单日 feed 模式（/api/feeds）自己有没有重复。
 */
const http = require('http');
const BASE = 'http://127.0.0.1:7788';

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function dupKeys(items) {
  const m = new Map();
  for (const x of items) {
    const k = `${x.code}|${x.title}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.entries()].filter(([, v]) => v.length > 1);
}

(async () => {
  const D = '2026-10-22';
  const range = await get('/api/range?from=' + D + '&to=' + D + '&type=news&size=500');
  const feed = await get('/api/feeds?type=news&date=' + D + '&size=500');
  const feedLatest = await get('/api/feeds?type=news&date=' + D + '&size=500&latestOnly=1');

  console.log('range  total=', range.total, ' items=', range.items.length, ' dups=', dupKeys(range.items).length);
  console.log('feed   total=', feed.total, ' items=', feed.items.length, ' dups=', dupKeys(feed.items).length);
  console.log('feed(latestOnly=1) total=', feedLatest.total, ' items=', feedLatest.items.length, ' dups=', dupKeys(feedLatest.items).length);

  console.log('--- range 里的重复明细 ---');
  for (const [k, v] of dupKeys(range.items)) {
    console.log(k);
    for (const x of v) console.log('   ', x.date, '| is_research=', x.is_research, '| kind=', x.kind, '| broker=', x.broker, '| match=', x.match);
  }

  console.log('--- 构成 ---');
  console.log('range news 非研报:', range.items.filter((x) => !x.is_research).length);
  console.log('range news 研报  :', range.items.filter((x) => x.is_research).length);

  console.log('--- feed 各日期条数 ---');
  const byDate = {};
  for (const x of feed.items) byDate[x.date] = (byDate[x.date] || 0) + 1;
  console.log(JSON.stringify(byDate));
  console.log('feed is_research 条数:', feed.items.filter((x) => x.is_research).length);
})().catch((e) => { console.error(e); process.exit(1); });
