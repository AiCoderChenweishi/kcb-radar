'use strict';
/* 科创板每日情报雷达 · 前端 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  brief: null,
  date: null,
  tab: 'overview',
  valFilter: 'all',
  finFilter: 'all',
  valSort: { key: 'total_mv', dir: -1 },
  finSort: { key: 'total_mv', dir: -1 },
  allSort: { key: 'score', dir: -1 },
  page: 1,
  pageSize: 40,
};

const PAGE_SIZE = 40;

// ------------------------------------------------------------------ 工具

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(v, digits = 2) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('zh-CN');
}

function fmtMv(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' 万亿';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return fmtNum(n, 0);
}

function fmtPct(v, digits = 1) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%';
}

function signClass(v) {
  if (v == null || Number.isNaN(Number(v))) return 'flat';
  const n = Number(v);
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

function link(url, text) {
  if (!url) return esc(text);
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

// ------------------------------------------------------------------ 渲染：顶部

function renderTop() {
  const b = state.brief;
  const s = b.stats || {};
  $('#statusText').textContent = `${b.date} · ${b.latestDate || '—'} 数据日 · 覆盖 ${b.coverage.total} 家`;
  const chip = $('#statusChip');
  chip.classList.remove('ok', 'err');
  chip.classList.add(s.failureCount > 0 ? 'err' : 'ok');
  renderSourceScope();
}

/**
 * 数据口径 + iFinD 额度台账。
 *
 * **为什么把它放在看板最显眼的位置**：
 * iFinD 免费试用版是 2,000 次**永久总量**（不按月刷新），烧完就没有了。
 * 2026-10-21 的全量设计一天烧掉其中 3/4，而当时既没有计数器也没有入口，
 * 两天后才发现额度已经为 0。**额度消耗必须可见**，否则重蹈覆辙。
 */
function renderSourceScope() {
  const b = state.brief;
  const src = b.sources || {};
  const ifd = b.ifind || null;
  const el = $('#srcScope');
  if (!el) return;
  const parts = [];
  // **行情口径必须列出来**（2026-10-27 补）：回补日的行情来自历史逐日口径，
  // 不写出来的话读者会以为这是实时快照。
  if (src.quotes) parts.push(`<b>行情口径</b>：${esc(src.quotes)}`);
  if (src.financials) parts.push(`<b>财务口径</b>：${esc(src.financials)}`);
  if (src.consensus) parts.push(`<b>一致预期</b>：${esc(src.consensus)}`);
  if (src.percentile) parts.push(`<b>估值分位</b>：${esc(src.percentile)}`);
  if (src.breadth) parts.push(`<b>市场宽度</b>：${esc(src.breadth)}`);
  if (ifd) {
    const byTool = (ifd.byTool || []).map((t) => `${t.tool} ${t.calls}`).join('、');
    parts.push(`<b>iFinD 额度</b>：本期实际请求 ${ifd.attempts} 次（成功 ${ifd.calls} / 失败 ${ifd.errors}）`
      + `｜模式 ${esc(ifd.mode)}｜补充口径覆盖 ${ifd.ifindCovered || 0} 家`
      + (byTool ? `｜明细 ${esc(byTool)}` : '')
      + '｜免费试用版为 2,000 次永久总量、不按月刷新');
  }
  el.innerHTML = `<b>本期数据来源</b>：${parts.join('｜')}`;
}

function renderMarket() {
  const b = state.brief;
  const m = b.market || {};
  const br = m.breadth || {};
  const ix = m.index || {};
  const cov = b.coverage;

  const cards = [
    { k: '科创50指数', v: ix.kc50_point != null ? fmtNum(ix.kc50_point, 2) : '—',
      x: ix.kc50_change_pct != null ? fmtPct(ix.kc50_change_pct, 2) : '无数据', c: signClass(ix.kc50_change_pct) },
    { k: '科创综指', v: ix.kc_comp_point != null ? fmtNum(ix.kc_comp_point, 2) : '—',
      x: ix.kc_comp_change_pct != null ? fmtPct(ix.kc_comp_change_pct, 2) : '无数据', c: signClass(ix.kc_comp_change_pct) },
    { k: '科创板成交额', v: ix.total_amount_yi != null ? fmtNum(ix.total_amount_yi, 0) + ' 亿' : '—',
      x: ix.avg_turnover_pct != null ? `平均换手 ${fmtNum(ix.avg_turnover_pct, 2)}%` : '—', c: 'flat' },
    { k: '上涨 / 下跌', v: `${br.rising ?? '—'} / ${br.falling ?? '—'}`,
      x: br.rising != null && br.falling != null ? `上涨占比 ${((br.rising / (br.rising + br.falling)) * 100).toFixed(1)}%` : '—',
      c: br.rising > br.falling ? 'up' : 'down' },
    { k: '涨超5% / 跌超5%', v: `${br.up5 ?? '—'} / ${br.down5 ?? '—'}`,
      x: `涨停 ${br.up9 ?? '—'} · 跌停 ${br.down9 ?? '—'}`, c: 'flat' },
    { k: '今日要闻', v: fmtInt(cov.newsItems), x: `研报 ${cov.researchItems} · 公告 ${cov.noticeItems}`, c: 'flat' },
    { k: '高信号公司', v: fmtInt(b.highlights.length), x: '自动识别，无人工名单', c: 'flat' },
    { k: '覆盖完整度', v: `${cov.withFinancials}/${cov.total}`,
      x: `估值 ${cov.withValuation} · PE分位 ${cov.withPercentile}`, c: 'flat' },
  ];

  $('#marketStats').innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="stat-k">${esc(c.k)}</div>
      <div class="stat-v ${c.c}">${c.v}</div>
      <div class="stat-x">${c.x}</div>
    </div>`).join('');

  // 市场宽度
  const widthRows = [
    ['上涨', br.rising], ['下跌', br.falling],
    ['涨幅 >5%', br.up5], ['跌幅 >5%', br.down5],
    ['涨停（>9.5%）', br.up9], ['跌停（<-9.5%）', br.down9],
    ['市值 >200亿', br.mv_over_200yi], ['市值 >50亿', br.mv_over_50yi],
  ];
  $('#breadthSrc').textContent = m.source && m.source.breadth ? m.source.breadth : '';
  $('#breadthBody').innerHTML = `<div class="table-wrap"><table><tbody>${widthRows.map(([k, v]) =>
    `<tr><td class="l">${esc(k)}</td><td><b>${v == null ? '—' : fmtInt(v)}</b> 家</td></tr>`).join('')}</tbody></table></div>`;

  // 指数
  $('#indexSrc').textContent = m.source && m.source.index ? m.source.index : '';
  const ixRows = [
    ['科创50收盘', ix.kc50_point != null ? fmtNum(ix.kc50_point, 2) : '—', signClass(ix.kc50_change_pct)],
    ['科创50涨跌幅', ix.kc50_change_pct != null ? fmtPct(ix.kc50_change_pct, 2) : '—', signClass(ix.kc50_change_pct)],
    ['科创综指收盘', ix.kc_comp_point != null ? fmtNum(ix.kc_comp_point, 2) : '—', signClass(ix.kc_comp_change_pct)],
    ['科创综指涨跌幅', ix.kc_comp_change_pct != null ? fmtPct(ix.kc_comp_change_pct, 2) : '—', signClass(ix.kc_comp_change_pct)],
    ['板块平均涨幅', ix.avg_change_pct != null ? fmtPct(ix.avg_change_pct, 2) : '—', signClass(ix.avg_change_pct)],
    ['平均换手率', ix.avg_turnover_pct != null ? fmtNum(ix.avg_turnover_pct, 2) + '%' : '—', 'flat'],
    ['平均振幅', ix.avg_amplitude_pct != null ? fmtNum(ix.avg_amplitude_pct, 2) + '%' : '—', 'flat'],
    ['成交个股数', ix.traded_count != null ? fmtInt(ix.traded_count) + ' 只' : '—', 'flat'],
  ];
  let ixHtml = `<div class="table-wrap"><table><tbody>${ixRows.map(([k, v, c]) =>
    `<tr><td class="l">${esc(k)}</td><td class="${c}"><b>${v}</b></td></tr>`).join('')}</tbody></table></div>`;
  if (m.index_broadcast) {
    ixHtml += `<div class="d-item" style="margin-top:12px">
      <div class="t">${link(m.index_broadcast.url, m.index_broadcast.title)}</div>
      <div class="c">${esc(m.index_broadcast.content)}</div></div>`;
  }
  $('#indexBody').innerHTML = ixHtml;
}

function renderTrending() {
  // ① 科创板事件分布
  const evs = state.brief.events || [];
  if (!evs.length) {
    $('#eventBody').innerHTML = '<div class="empty">本期未识别到事件分布</div>';
  } else {
    const max = evs[0].companies;
    $('#eventBody').innerHTML = `<div class="stat-grid">${evs.slice(0, 12).map((e) => `
      <div class="stat" style="cursor:default">
        <div class="stat-k">${esc(e.cat)}｜${esc(e.key)}</div>
        <div class="stat-v">${e.companies}<span style="font-size:12px;color:var(--ink-3)"> 家</span></div>
        <div class="stat-x">${e.mentions} 次提及 · ${esc(e.companyList.slice(0, 4).map((c) => c.name).join('、'))}</div>
        <div class="heat-bar"><div class="heat-fill" style="width:${(e.companies / max * 100).toFixed(1)}%"></div></div>
      </div>`).join('')}</div>
      <div class="table-wrap" style="margin-top:14px"><table>
        <thead><tr><th class="l">事件类型</th><th class="l">类别</th><th>覆盖公司</th><th>提及次数</th><th class="l">涉及公司（前 10）</th><th class="l">示例</th></tr></thead>
        <tbody>${evs.map((e) => `<tr>
          <td class="l name">${esc(e.key)}</td>
          <td class="l"><span class="tag">${esc(e.cat)}</span></td>
          <td>${e.companies}</td>
          <td>${e.mentions}</td>
          <td class="l" style="max-width:320px;white-space:normal">${esc(e.companyList.slice(0, 10).map((c) => c.name).join('、'))}</td>
          <td class="l" style="max-width:320px;white-space:normal">${link(e.samples[0] && e.samples[0].url, e.samples[0] && e.samples[0].title)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  // ② 卖方关注行业
  const indsAll = state.brief.sellSideByIndustry || [];
  const inds = byIndustry(indsAll);
  if (!inds.length) {
    $('#industryBody').innerHTML = '<div class="empty">本期无卖方覆盖数据</div>';
  } else {
    const max = inds[0].companies;
    $('#industrySrc').textContent = `近 90 天研报按行业聚合，共 ${inds.length} 个行业${activeIndustries() ? `（已按 ${[...activeIndustries()].join('、')} 收窄，全板 ${indsAll.length} 个）` : ''}`;
    $('#industryBody').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th class="l">行业</th><th>覆盖公司</th><th>研报篇数</th><th>看多占比</th><th>目标空间均值</th><th>有目标价</th><th class="l">最新日期</th><th class="l">代表公司</th></tr></thead>
      <tbody>${inds.map((x) => `<tr>
        <td class="l name">${esc(x.industry)}</td>
        <td>${x.companies}</td>
        <td>${x.reports}</td>
        <td class="${x.bull_ratio >= 60 ? 'up' : (x.bull_ratio != null && x.bull_ratio <= 40 ? 'down' : '')}">${x.bull_ratio != null ? x.bull_ratio + '%' : '—'}</td>
        <td class="${x.avg_upside > 0 ? 'up' : (x.avg_upside != null && x.avg_upside < 0 ? 'down' : '')}">${x.avg_upside != null ? fmtPct(x.avg_upside, 1) : '—'}</td>
        <td>${x.with_target}</td>
        <td class="l">${esc(x.latest)}</td>
        <td class="l" style="max-width:320px;white-space:normal">${esc(x.names.join('、'))}</td>
      </tr>`).join('')}</tbody></table></div>
      <div class="heat-bar" style="margin-top:10px"><div class="heat-fill" style="width:${(max / max * 100).toFixed(1)}%"></div></div>`;
  }

  // ③ 市场快讯
  const items = state.brief.trending || [];
  if (!items.length) { $('#trendingBody').innerHTML = '<div class="empty">暂无热点数据</div>'; return; }
  const maxHeat = Math.max(...items.map((x) => x.heat || 0), 1);
  $('#trendingBody').innerHTML = `<div class="feed">${items.map((it) => `
    <div class="feed-item">
      <div class="feed-meta">${esc(it.scope || '')}<br>${it.heat != null ? '热度 ' + it.heat.toFixed(1) : ''}</div>
      <div>
        <div class="feed-title">${link(it.url, it.title || '')}</div>
        <div class="feed-sub">${esc(it.source || '')}</div>
        <div class="feed-excerpt">${esc(it.content || '')}</div>
        <div class="heat-bar"><div class="heat-fill" style="width:${((it.heat || 0) / maxHeat * 100).toFixed(1)}%"></div></div>
      </div>
    </div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ 渲染：高信号

function renderSignals() {
  const all = state.brief.highlights || [];
  const list = byIndustry(all);
  const picked = activeIndustries();
  $('#signalSrc').textContent = picked
    ? `${list.length} 家有信号（全板 ${all.length} 家）· ${[...picked].join('、')}`
    : `${list.length} 家有信号 · 满分制自动排序`;
  if (!list.length) { $('#signalBody').innerHTML = '<div class="empty">当日无高信号公司</div>'; return; }
  $('#signalBody').innerHTML = `<div class="signal-grid">${list.map((c) => {
    const v = c.valuation || {};
    return `<div class="signal-card" data-code="${esc(c.code)}" tabindex="0" role="button">
      <div class="sc-head">
        <div>
          <div class="sc-name">${esc(c.name)}</div>
          <div class="sc-code">${esc(c.code)}</div>
        </div>
        <div class="sc-score">${c.score}</div>
      </div>
      <div class="sc-nums">
        <div><span>PE(TTM)</span>${v.pe_ttm != null ? fmtNum(v.pe_ttm, 1) : '—'}</div>
        <div><span>PE分位</span>${v.pe_percentile != null ? fmtNum(v.pe_percentile, 0) + '%' : '—'}</div>
        <div><span>总市值</span>${fmtMv(v.total_mv)}</div>
        <div><span>营收同比</span><span class="${signClass(c.growth && c.growth.revenue_yoy)}">${c.growth && c.growth.revenue_yoy != null ? fmtPct(c.growth.revenue_yoy) : '—'}</span></div>
      </div>
      <div class="sc-signals">${(c.signals || []).slice(0, 5).map((s) => {
        const cls = s.type === 'rating' || s.type === 'forecast' || s.type === 'valuation' ? 'star' : '';
        return `<span class="tag ${cls}">${esc(s.label)}</span>`;
      }).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

// ------------------------------------------------------------------ 渲染：要闻

const feedState = {
  news: { page: 1, size: 100, q: '', researchOnly: false, latestOnly: false, data: null, loading: false },
  research: { page: 1, size: 100, q: '', changedOnly: false, data: null, loading: false },
  notice: { page: 1, size: 100, q: '', data: null, loading: false },
};

// ---------------------------------------------------------------- 全局筛选（行业 + 日期范围）

const flt = {
  from: '', to: '',
  industries: [],
  industryCounts: new Map(),   // 行业 → 科创板家数（标签上直接标出来）
  active: false,      // 是否已启用（区别于"等于最新一天"）
  range: null,        // /api/range 的返回
  coverage: null,     // 要闻实际覆盖窗口（实测，"全部"要用）
  dates: [],          // 可用日期
  loading: false,
};

function fltQuery(extra) {
  const p = new URLSearchParams(extra || {});
  if (flt.from) p.set('from', flt.from);
  if (flt.to) p.set('to', flt.to);
  if (flt.industries.length) p.set('industry', flt.industries.join(','));
  return p;
}

/**
 * 当前生效的行业集合（null = 不限）。
 * 全局筛选必须对**所有公司级面板**一致生效，
 * 否则用户会看到"选了行业但估值/财务/覆盖表纹丝不动"（2026-10-22 实测踩到）。
 */
function activeIndustries() {
  return (flt.industries && flt.industries.length) ? new Set(flt.industries) : null;
}

/** 按生效行业过滤行（行需带 industry 字段） */
function byIndustry(rows) {
  const set = activeIndustries();
  if (!set) return rows || [];
  return (rows || []).filter((r) => set.has(r.industry));
}

/** 面板标题旁说明"本面板是否受行业筛选影响" */
function scopeNote(text) {
  return `<span class="scope-note">${text}</span>`;
}

function fltStatus() {
  const el = $('#fltStatus');
  if (!el) return;
  if (!flt.active) {
    el.textContent = '未启用区间筛选：当前显示「最新快照」的全部历史要闻；要按发布日期筛一段区间，请在上面选日期并点应用';
    el.className = 'fb-status';
    return;
  }
  const r = flt.range;
  if (!r || !r.available) {
    el.textContent = '区间筛选：' + (r && r.reason ? r.reason : '不可用');
    el.className = 'fb-status warn';
    return;
  }
  const ind = flt.industries.length
    ? flt.industries.map((k) => `${k}(${flt.industryCounts.get(k) ?? '?'})`).join('、')
    : `全部行业（${flt.industryCounts.size} 个）`;
  const s = r.stats;
  const warn = (r.warnings && r.warnings.length) ? '｜⚠ ' + r.warnings.join('；') : '';
  const cov = r.coverage && r.coverage.newsFrom
    ? `｜要闻覆盖 ${r.coverage.newsFrom} ~ ${r.coverage.newsTo}（${r.coverage.lookbackDays} 天）`
    : '';
  el.textContent = `区间 ${r.from} ~ ${r.to}（${s.rangeDays ?? s.days} 天${s.rangeDays && s.rangeDays !== s.days ? `，其中 ${s.days} 天有要闻` : ''}）｜${ind}｜要闻 ${fmtInt(s.news)}｜券商观点 ${fmtInt(s.research)}｜公告 ${fmtInt(s.notice)}｜覆盖 ${fmtInt(s.companiesWithNews)} 家（行业口径 ${fmtInt(s.companies)}/${fmtInt(s.universe)}）${cov}${r.truncated ? '｜' + r.truncated : ''}${warn}`;
  el.className = 'fb-status on' + (r.warnings && r.warnings.length ? ' warn' : '');
}

async function applyFilter() {
 try {
  flt.from = $('#fltFrom').value || '';
  flt.to = $('#fltTo').value || '';
  // 行业选择来自标签多选（不再用原生 select）
  flt.industries = Array.from(document.querySelectorAll('#fltIndustryChips .ind-chip.on'))
    .map((b) => b.getAttribute('data-ind')).filter(Boolean);
  // 区间与"最新一天"完全一致且没选行业 → 视为未启用，避免白白走一次聚合
  const latest = flt.dates[0] || '';
  flt.active = !!(flt.industries.length
    || (flt.from && flt.from !== latest)
    || (flt.to && flt.to !== latest)
    || (flt.from && flt.to && flt.from !== flt.to));
  flt.range = null;
  if (flt.active) {
    flt.loading = true;
    try {
      flt.range = await getJsonXhr(`/api/range?${fltQuery({ type: 'news', size: 1 }).toString()}`);
      if (flt.range && flt.range.coverage) flt.coverage = flt.range.coverage;
    } catch (e) {
      flt.range = { available: false, reason: '区间查询失败：' + e.message };
    } finally {
      flt.loading = false;
    }
  }
  // 区间模式下「仅看最新数据日」与区间语义冲突，显式禁用而不是让它静默失效
  const lo = $('#newsLatestOnly');
  if (lo) {
    lo.disabled = flt.active;
    lo.title = flt.active ? '已启用区间筛选：条目按发布日期落在所选区间内，无需再限最新数据日' : '';
  }
  // 筛选生效时，**所有公司级面板**都要跟着重画，
  // 否则用户会看到"选了行业但估值/财务/覆盖表纹丝不动"（2026-10-22 实测踩到）。
  feedState.news.page = feedState.research.page = feedState.notice.page = 1;
  state.page = 1;
  fltStatus();
  await renderNews();
  await renderResearch();
  await renderNotices();
  renderAll();
  renderNewsDigest();
  renderSignals();
  renderValuation();
  renderFinancial();
  renderCoverage();
  renderSectors();
 } catch (e) {
  // 筛选失败必须**说出来**，不能静默（2026-10-22 实测：静默时用户以为筛选没生效）
  const el = $('#fltStatus');
  if (el) { el.textContent = '筛选失败：' + (e && e.message ? e.message : String(e)); el.className = 'fb-status warn'; }
  console.error('[applyFilter]', e);
 }
}

function resetFilter() {
  flt.from = '';
  flt.to = '';
  flt.industries = [];
  flt.active = false;
  flt.range = null;
  $('#fltFrom').value = '';
  $('#fltTo').value = '';
  renderIndustryChips();
  const lo = $('#newsLatestOnly');
  if (lo) { lo.disabled = false; lo.title = ''; }
  fltStatus();
  renderAll();
  loadFeed('news').then(renderNews);
  loadFeed('research').then(renderResearch);
  loadFeed('notice').then(renderNotices);
}

function fillFilterOptions(dates) {
  flt.dates = dates || [];
  // 行业清单 + **科创板家数**（标签上直接标出来，让人一眼知道选的是哪些科创板公司）
  const counts = new Map();
  for (const c of (state.brief && state.brief.companies) || []) {
    if (!c.industry) continue;
    counts.set(c.industry, (counts.get(c.industry) || 0) + 1);
  }
  flt.industryCounts = counts;
  renderIndustryChips();
  const latest = flt.dates[0] || '';
  if (!flt.from) $('#fltFrom').value = flt.dates.length > 1 ? flt.dates[flt.dates.length - 1] : latest;
  if (!flt.to) $('#fltTo').value = latest;
}

/** 行业标签（可搜索、可点选、带家数） */
function renderIndustryChips() {
  const row = $('#fltIndustryChips');
  const meta = $('#fltIndustryMeta');
  if (!row) return;
  const q = (($('#fltIndustrySearch') || {}).value || '').trim().toLowerCase();
  const all = [...flt.industryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
  const list = q ? all.filter(([k]) => k.toLowerCase().includes(q)) : all;
  if (!all.length) {
    row.innerHTML = '<span class="chip-empty">行业清单加载中…</span>';
    if (meta) meta.textContent = '—';
    return;
  }  row.innerHTML = list.length
    ? list.map(([k, v]) => {
      const on = flt.industries.includes(k);
      return `<button type="button" class="ind-chip${on ? ' on' : ''}" data-ind="${esc(k)}">${esc(k)}<span class="chip-n">${v}</span></button>`;
    }).join('')
    : '<span class="chip-empty">没有匹配「' + esc(q) + '」的行业</span>';
  // 选中数与覆盖家数
  if (meta) {
    const picked = flt.industries;
    const allCounts = flt.industryCounts;
    if (!picked.length) {
      const total = [...allCounts.values()].reduce((a, b) => a + b, 0);
      meta.textContent = `未选行业＝全部 ${total} 家（${allCounts.size} 个行业）`;
    } else {
      const cov = picked.reduce((a, k) => a + (allCounts.get(k) || 0), 0);
      meta.textContent = `已选 ${picked.length} 个行业，覆盖 ${cov} 家科创板公司`;
    }
  }
}

/** 按需拉取信息流分页（首屏不带全量正文） */
async function loadFeed(type) {
  const st = feedState[type];
  if (!st || st.loading) return;
  st.loading = true;
  const params = new URLSearchParams({ type, page: st.page, size: st.size });
  if (st.q) params.set('q', st.q);
  if (type === 'news') {
    if (st.researchOnly) params.set('researchOnly', '1');
    if (st.latestOnly) params.set('latestOnly', '1');
  }
  try {
    if (flt.active) {
      // 区间 + 行业筛选：走 /api/range（关键词与"仅看研报"同样要带，否则会静默失效）
      const q = fltQuery({ type, page: st.page, size: st.size });
      if (st.q) q.set('q', st.q);
      if (type === 'news' && st.researchOnly) q.set('researchOnly', '1');
      st.data = await getJsonXhr(`/api/range?${q.toString()}`);
    } else {
      st.data = await getJsonXhr(`/api/feeds?${params.toString()}`);
    }
  } catch (e) {
    st.data = { items: [], total: 0, pages: 1, page: st.page, size: st.size };
  } finally {
    st.loading = false;
  }
}

function feedPager(type, total, pages, page) {
  return `<div class="pager" data-feed="${type}">
    <button data-act="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pg-info">第 ${page} / ${pages} 页 · 共 ${total} 条</span>
    <button data-act="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
  </div>`;
}

async function renderNews() {
  const st = feedState.news;
  st.q = ($('#newsSearch').value || '').trim();
  st.researchOnly = $('#newsResearchOnly').checked;
  st.latestOnly = $('#newsLatestOnly').checked;
  await loadFeed('news');
  const d = st.data || { items: [], total: 0, pages: 1, page: 1 };
  $('#newsCount').textContent = `${fmtInt(d.total)} 条`;
  if (!d.items.length) { $('#newsBody').innerHTML = '<div class="empty">没有匹配的要闻</div>'; return; }
  const slice = d.items;
  $('#newsBody').innerHTML = `<div class="feed">${slice.map((x) => `
    <div class="feed-item">
      <div class="feed-meta">${esc(x.date || '')}<br><b>${esc(x.name)}</b></div>
      <div>
        <div class="feed-title">${link(x.url, x.title || '')}</div>
        ${x.content ? '<div class="feed-excerpt">' + esc(x.content) + '</div>' : ''}
        <div class="feed-sub">
          ${x.kind === 'broker_report' ? '<span class="tag star">券商报告</span>' : x.kind === 'consensus' ? '<span class="tag">卖方一致预期</span>' : ''}
          ${x.match === 'weak' ? '<span class="tag weak">仅行业/概念关联</span>' : ''}
          ${x.broker ? `<span class="tag">${esc(x.broker)}</span>` : ''}
          ${x.rating ? `<span class="tag">${esc(x.rating)}</span>` : ''}
          ${x.target_price != null ? `<span class="tag">目标价 ${fmtNum(x.target_price, 2)} 元</span>` : ''}
          ${x.institution_count ? `<span class="tag">${x.institution_count} 家机构覆盖</span>` : ''}
          <span class="tag plain">${esc(x.code)}</span>
        </div>
      </div>
    </div>`).join('')}</div>${feedPager('news', d.total, d.pages, d.page)}`;
}

// ------------------------------------------------------------------ 渲染：券商观点

async function renderResearch() {
  const st = feedState.research;
  st.q = ($('#researchSearch').value || '').trim();
  st.changedOnly = $('#researchChanged').checked;
  await loadFeed('research');
  const d = st.data || { items: [], total: 0, pages: 1, page: 1 };
  let list = d.items;
  // 「仅看观点变化」：评级相对上次发生变化（此前这个勾选框一直是死的）
  if (st.changedOnly) {
    list = list.filter((x) => x.last_rating && x.rating && x.last_rating !== x.rating);
  }
  $('#researchCount').textContent = `${fmtInt(st.changedOnly ? list.length : d.total)} 篇${st.changedOnly && d.total ? `（共 ${fmtInt(d.total)} 篇中筛出）` : ''}`;
  if (!list.length) {
    $('#researchBody').innerHTML = st.changedOnly
      ? '<div class="empty">该窗口内没有评级发生变化的研报（评级变化集中在「卖方覆盖」页的 90 天窗口）</div>'
      : '<div class="empty">没有匹配的研报观点</div>';
    return;
  }
  $('#researchBody').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th class="l">日期</th><th class="l">公司</th><th class="l">类型</th><th class="l">券商</th><th class="l">评级</th>
      <th>目标价</th><th class="l">盈利预测</th><th class="l">内容总结</th><th class="l">标题</th>
    </tr></thead><tbody>
    ${list.map((x) => {
      const f = x.forecast || {};
      const ftxt = [
        f.revenue_forecast ? `营收 ${f.revenue_forecast.join('/')} 亿` : '',
        f.profit_forecast ? `归母净利 ${f.profit_forecast.join('/')} 亿` : '',
        f.eps && f.eps.this_year != null ? `EPS ${f.eps.this_year}/${f.eps.next_year}/${f.eps.next_two_year}` : '',
      ].filter(Boolean).join('，');
      const kindTag = x.kind === 'broker_report'
        ? '<span class="tag star">券商报告</span>'
        : x.kind === 'consensus'
          ? `<span class="tag">一致预期${x.institution_count ? ' · ' + x.institution_count + '家' : ''}</span>`
          : '<span class="tag plain">提及</span>';
      return `<tr data-code="${esc(x.code)}">
        <td class="l">${esc(x.date || '')}</td>
        <td class="l name">${esc(x.name)}</td>
        <td class="l">${kindTag}</td>
        <td class="l">${esc(x.broker || '—')}</td>
        <td class="l">${x.rating ? `<span class="tag ${/买入|增持|推荐/.test(x.rating) ? 'up' : ''}">${esc(x.rating)}</span>` : '—'}</td>
        <td>${x.target_price != null ? fmtNum(x.target_price, 2) : '—'}</td>
        <td class="l">${ftxt || '—'}</td>
        <td class="l" style="max-width:520px;white-space:normal"><div class="cell-view">${esc(x.summary || x.view_thesis || x.content || '（未取到正文摘要）')}</div></td>
        <td class="l" style="max-width:260px;white-space:normal">${link(x.url, x.title || '')}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>${feedPager('research', d.total, d.pages, d.page)}`;
}

// ------------------------------------------------------------------ 渲染：要闻总结 / 板块焦点

/** 今日要闻总结：要点 + 事件分布（事实与判断分栏，判断带依据） */
function renderNewsDigest() {
  const nd = (state.brief && state.brief.newsDigest) || null;
  const src = $('#digestSrc');
  const body = $('#digestBody');
  if (!nd || !nd.overview) { if (body) body.innerHTML = '<div class="empty">本期未生成要闻总结</div>'; return; }
  const ov = nd.overview, c = ov.counts;
  const picked = activeIndustries();
  if (src) {
    src.textContent = `当日 ${c.d1} 条 / ${c.d1Companies} 家｜近7天 ${fmtInt(c.d7)} 条 / ${c.d7Companies} 家｜`
      + `要闻 ${fmtInt(c.newsTotal)} + 公告 ${fmtInt(c.noticeTotal)}｜栏目稿 ${c.columnItems} 条`
      + (picked ? `｜已按 ${[...picked].join('、')} 收窄要点` : '');
  }
  if (!body) return;
  // 今日要点按生效行业收窄（要点带 industry 字段）
  const allPoints = ov.topPoints || [];
  const pts = byIndustry(allPoints);
  const points = pts.map((p, i) => `
    <li class="digest-point">
      <span class="dp-idx">${i + 1}</span>
      <div>
        <div class="dp-head">
          <b>${esc(p.name)}</b>
          <span class="dp-ind">${esc(p.industry || '')}</span>
          <span class="dp-date">${esc(p.date || '')}</span>
          ${p.event ? `<span class="tag">${esc(p.event)}</span>` : ''}
          ${p.isColumn ? '<span class="tag weak">栏目稿</span>' : ''}
          ${p.attributed === false ? '<span class="tag weak">综合稿（标题未点名公司）</span>' : ''}
        </div>
        <div class="dp-title">${link(p.url, p.title || '')}</div>
        ${p.summary ? `<div class="dp-sum">${esc(p.summary)}</div>` : ''}
      </div>
    </li>`).join('');
  const mix = (ov.eventMix && ov.eventMix.d7) || [];
  const mixHtml = mix.length ? `
    <div class="digest-mix">
      <div class="mix-title">事件类型分布（近 7 天${picked ? '，全板口径，不随行业筛选变化' : ''}）</div>
      <div class="mix-tags">${mix.slice(0, 12).map((e) =>
    `<span class="tag">${esc(e.key)} ${e.companies}家/${e.mentions}次</span>`).join('')}</div>
    </div>` : '';
  body.innerHTML = `<ol class="digest-list">${points}</ol>`
    + (pts.length ? '' : `<div class="empty">所选行业在今日要点里没有条目（全板共 ${allPoints.length} 条，要看全板要点请清空行业筛选）</div>`)
    + mixHtml;
}

/** 板块焦点：大事板块 3~5 个 + 医药专章 */
function renderSectors() {
  const nd = (state.brief && state.brief.newsDigest) || null;
  const src = $('#sectorsSrc');
  const body = $('#sectorsBody');
  if (!nd) { if (body) body.innerHTML = '<div class="empty">本期未生成板块焦点</div>'; return; }
  const secsAll = nd.sectors || [];
  const picked = activeIndustries();
  // 板块级聚合：只显示选中的行业（医药专章跨 6 个医药子行业，单独标注，不做收窄）
  const secs = picked ? secsAll.filter((s) => picked.has(s.industry)) : secsAll;
  const ph = nd.pharma || {};
  if (src) src.textContent = `入选板块 ${secs.length} 个${picked ? `（已按 ${[...picked].join('、')} 收窄，全板 ${secsAll.length} 个）` : ''}｜医药 ${ph.scope ? ph.scope.companies : 0} 家（${ph.scope ? ph.scope.sharePct : 0}%）｜窗口 ${nd.d7from} ~ ${nd.baseDate}`;

  const secHtml = secs.length ? secs.map((s) => `
    <div class="card sector-card">
      <div class="card-head">
        <h2>${esc(s.industry)}</h2>
        <span class="src">${s.companies} 家｜重要度 ${s.score}</span>
      </div>
      <div class="sector-facts">
        <span>要闻 ${s.basis.news}</span><span>公告 ${s.basis.notices}</span><span>研报 ${s.basis.research} 家</span>
        <span>均涨跌 ${fmtPct(s.basis.avgChg)}${s.basis.benchmark != null ? '（大盘 ' + fmtPct(s.basis.benchmark) + '）' : ''}</span>
        ${(s.basis.events || []).map((e) => `<span class="tag">${esc(e.key)} ${e.companies}家</span>`).join('')}
      </div>
      <div class="sector-dir ${s.direction && /负面|承压/.test(s.direction.label) ? 'neg' : (/正面/.test(s.direction.label) ? 'pos' : '')}">
        <b>方向：${esc(s.direction ? s.direction.label : '—')}</b>（置信度 ${esc(s.direction ? s.direction.confidence : '—')}）<br>
        <span class="sector-basis">依据：${esc(s.direction ? s.direction.basis : '')}</span>
      </div>
      <ul class="sector-points">${(s.keyPoints || []).map((k) =>
    `<li><span class="dp-date">${esc(k.date || '')}</span> <b>${esc(k.name)}</b> ${k.event ? '<span class="tag">' + esc(k.event) + '</span>' : ''}${k.attributed === false ? '<span class="tag weak">综合稿</span>' : ''} ${link(k.url, k.title || '')}</li>`).join('')}</ul>
    </div>`).join('')
    : (picked
      ? `<div class="card sector-card"><div class="card-head"><h2>本期大事板块里没有你选的行业</h2>
          <span class="src">已按 ${[...picked].join('、')} 收窄</span></div>
          <p class="hint">全板入选 ${secsAll.length} 个：${secsAll.map((s) => s.industry).join('、')}。
          大事板块只取重要度最高的几个，所以选中行业未必在列——该行业的动态看下面的医药专章与要闻总结。</p></div>`
      : '');

  const phHtml = ph.scope ? (() => {
    // 医药专章跨 6 个医药子行业：只有当用户选中的行业**落在医药里**时才收窄，
    // 否则保持医药口径并在标题里说明（否则选"半导体"会把整个医药专章清空）。
    const codeInd = new Map(((state.brief && state.brief.companies) || []).map((c) => [c.code, c.industry]));
    const pharmaSel = picked ? [...picked].filter((x) => (ph.scope.industries || []).includes(x)) : [];
    const narrow = pharmaSel.length > 0;
    const inScope = (k) => !narrow || pharmaSel.includes(codeInd.get(k.code));
    const pharmaScopeNote = narrow
      ? `本次按 ${pharmaSel.join('、')} 收窄（医药 ${ph.scope.companies} 家中该子行业 ${pharmaSel.reduce((a, x) => a + ((state.brief.companies || []).filter((c) => c.industry === x).length), 0)} 家）`
      : picked ? '医药口径（跨 6 个医药子行业，不随行业筛选收窄）' : '';
    return `
    <div class="card sector-card pharma-card">
      <div class="card-head">
        <h2>医药板块专章</h2>
        <span class="src">${ph.scope.companies} 家 / ${ph.scope.sharePct}%｜${(ph.scope.breakdown || []).map((x) => esc(x.industry) + ' ' + x.companies).join('、')}</span>
      </div>
      ${pharmaScopeNote ? `<div class="scope-note">${esc(pharmaScopeNote)}</div>` : ''}
      <div class="sector-facts">
        <span>涨 ${ph.temperature.up} / 跌 ${ph.temperature.down} / 平 ${ph.temperature.flat}</span>
        <span>板块均涨跌 ${fmtPct(ph.temperature.avg)}${ph.temperature.benchmark != null ? '（大盘 ' + fmtPct(ph.temperature.benchmark) + '，相对 ' + fmtPct(ph.temperature.relative) + '）' : ''}</span>
        <span>卖方覆盖 ${ph.sellSide.total} 家（带原文 ${ph.sellSide.withView}）｜看多 ${ph.sellSide.bull} / 中性 ${ph.sellSide.neutral} / 看空 ${ph.sellSide.bear}</span>
        <span>窗口内要闻+公告 ${ph.scope.items} 条</span>
      </div>
      <div class="sector-dir">
        <b>方向：${esc(ph.direction ? ph.direction.label : '—')}</b>（置信度 ${esc(ph.direction ? ph.direction.confidence : '—')}）<br>
        <span class="sector-basis">依据：${esc(ph.direction ? ph.direction.basis : '')}</span>
      </div>
      ${(ph.topics || []).map((t) => {
        const kps = (t.keyPoints || []).filter(inScope);
        if (narrow && !kps.length) return '';
        return `
        <div class="pharma-topic">
          <div class="pt-head"><b>${esc(t.key)}</b><span class="src">${narrow ? kps.length : t.items} 条 / ${t.companies.length} 家公司${narrow ? '（全板 ' + t.items + ' 条）' : ''}</span></div>
          <div class="sector-dir small ${/负面|承压/.test(t.direction.label) ? 'neg' : (/正面/.test(t.direction.label) ? 'pos' : '')}">
            <b>${esc(t.direction.label)}</b>（置信度 ${esc(t.direction.confidence)}）<span class="sector-basis">依据：${esc(t.direction.basis)}</span>
          </div>
          <ul class="sector-points">${kps.map((k) =>
    `<li><span class="dp-date">${esc(k.date || '')}</span> <b>${esc(k.name)}</b> ${k.event ? '<span class="tag">' + esc(k.event) + '</span>' : ''}${k.attributed === false ? '<span class="tag weak">综合稿</span>' : ''} ${link(k.url, k.title || '')}</li>`).join('')}</ul>
        </div>`;
      }).join('')}
      ${(ph.misattributed || []).length ? `
        <div class="pharma-topic">
          <div class="pt-head"><b>归属修正</b><span class="src">栏目稿里挂着别家公司的条目</span></div>
          <ul class="sector-points">${ph.misattributed.map((m) =>
    `<li>稿件挂在 <b>${esc(m.attributed)}</b> 名下 → 实际主体 <b class="fix-subject">${esc(m.actual)}</b>（${esc(m.actualIndustry)}） ${esc(m.date)} ${link(m.url, m.title || '')}</li>`).join('')}</ul>
        </div>` : ''}
      ${(ph.external || []).length ? `
        <div class="pharma-topic">
          <div class="pt-head"><b>竞情提示</b><span class="src">非科创板主体，仅作提示，不进建档体系</span></div>
          <ul class="sector-points">${ph.external.map((e) =>
    `<li><b class="fix-subject">${esc(e.name)}</b> <span class="dp-date">${esc(e.date)}</span> <span class="tag">${esc((e.reason || []).join('、'))}</span> ${esc(e.what)} ${link(e.url, e.sourceTitle || '')}<span class="muted">（经 ${esc(e.via)} 命中）</span></li>`).join('')}</ul>
        </div>` : ''}
      ${(ph.sellSide && ph.sellSide.topViews || []).length ? `
        <div class="pharma-topic">
          <div class="pt-head"><b>卖方观点原话</b><span class="src">可引用</span></div>
          <ul class="sector-points">${ph.sellSide.topViews.map((v) =>
    `<li><b>${esc(v.name)}</b>（${esc(v.code)}｜${esc(v.industry)}）｜${esc(v.broker || '—')} ${esc(v.rating || '—')}：<span class="cell-view">${esc(v.thesis)}</span></li>`).join('')}</ul>
        </div>` : ''}
    </div>`;
  })() : '';

  if (body) body.innerHTML = secHtml + phHtml;
}

// ------------------------------------------------------------------ 渲染：卖方覆盖

const covState = { filter: 'all', q: '', sort: { key: 'report_count', dir: -1 } };
const RATING_RANK = { 买入: 5, 增持: 4, 推荐: 4, 强烈推荐: 5, 持有: 3, 中性: 3, 谨慎增持: 3, 减持: 2, 卖出: 1 };

function renderCoverage() {
  const b = state.brief;
  const st = b.sellSideStats || {};
  const picked = activeIndustries();
  const all = byIndustry(b.sellSide || []);
  $('#coverageSrc').textContent = st.covered_companies
    ? (picked
      ? `近90天：${all.length}/${st.covered_companies} 家被覆盖（已按 ${[...picked].join('、')} 收窄）・${st.brokers} 家券商・${st.with_target_price} 篇有目标价`
      : `近90天：${st.covered_companies}/${st.total_companies} 家被覆盖（${st.coverage_rate}%）・${st.brokers} 家券商・${st.with_target_price} 篇有目标价`)
    : '';

  let rows = all;
  if (covState.filter === 'buy') rows = rows.filter((r) => (RATING_RANK[r.rating] || 0) >= 4);
  else if (covState.filter === 'tp') rows = rows.filter((r) => r.target_price != null);
  else if (covState.filter === 'upgrade') {
    rows = rows.filter((r) => r.last_rating && r.last_rating !== r.rating
      && (RATING_RANK[r.rating] || 0) > (RATING_RANK[r.last_rating] || 0));
  }
  if (covState.q) {
    const lq = covState.q.toLowerCase();
    rows = rows.filter((r) => `${r.name}${r.code}${r.broker || ''}${r.rating || ''}${r.title || ''}`.toLowerCase().includes(lq));
  }
  // "共 X 家"必须是**全板口径**（未按行业收窄前的总数），否则会显示成"共 15 家"这种自指数字
  $('#covCount').textContent = `${fmtInt(rows.length)} 家 / 共 ${fmtInt((b.sellSide || []).length)} 家`;
  if (!rows.length) { $('#covBody').innerHTML = '<div class="empty">没有匹配的卖方覆盖记录</div>'; return; }

  const cols = [
    { key: 'code', label: '代码', align: 'l', get: (r) => `<span class="code">${esc(r.code)}</span>` },
    { key: 'name', label: '简称', align: 'l', get: (r) => esc(r.name) },
    { key: 'industry', label: '行业', align: 'l', get: (r) => esc(r.industry || '—') },
    { key: 'rating', label: '最新评级', align: 'l', get: (r) => {
        const chg = r.last_rating && r.last_rating !== r.rating ? ` <span class="tag">${esc(r.last_rating)}→${esc(r.rating)}</span>` : '';
        return `${r.rating ? `<span class="tag ${(RATING_RANK[r.rating] || 0) >= 4 ? 'up' : ''}">${esc(r.rating)}</span>` : '—'}${chg}`;
      } },
    { key: 'broker', label: '券商', align: 'l', get: (r) => esc(r.broker || '—') },
    { key: 'target_price', label: '目标价', get: (r) => r.target_price != null ? fmtNum(r.target_price, 2) : '—' },
    { key: 'upside', label: '目标空间', get: (r) => r.upside != null ? fmtPct(r.upside, 1) : '—',
      cls: (r) => r.upside == null ? '' : (r.upside > 0 ? 'up' : 'down') },
    { key: 'report_count', label: '研报数', get: (r) => r.report_count },
    { key: 'summary', label: '券商观点总结', align: 'l', get: (r) => r.summary
        ? `<span class="cell-view">${esc(r.summary)}</span>`
        : (r.view_thesis
          ? `<span class="cell-view">${esc(String(r.view_thesis).slice(0, 120))}</span>`
          : '<span class="cell-muted">未取到正文</span>') },
    { key: 'date', label: '最新日期', align: 'l', get: (r) => esc(r.date || '—') },
    { key: 'pe_percentile', label: 'PE分位', get: (r) => r.pe_percentile != null ? fmtNum(r.pe_percentile, 0) + '%' : '—',
      cls: (r) => r.pe_percentile == null ? '' : (r.pe_percentile >= 95 ? 'up' : r.pe_percentile <= 10 ? 'down' : '') },
    { key: 'change_pct', label: '涨跌幅', get: (r) => fmtPct(r.change_pct), cls: (r) => signClass(r.change_pct) },
    { key: 'title', label: '最新研报', align: 'l', get: (r) => link(r.url, r.title || '—') },
  ];
  $('#covBody').innerHTML = sortableTable(rows, cols, covState.sort, null, (r) => `data-code="${esc(r.code)}"`);
}

// ------------------------------------------------------------------ 渲染：表格

function sortableTable(rows, cols, sort, onSort, rowAttrs) {
  const head = cols.map((c) => {
    const active = sort.key === c.key;
    return `<th class="${c.align === 'l' ? 'l' : ''} ${active ? 'sorted' : ''}" data-key="${c.key}">${esc(c.label)}${active ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</th>`;
  }).join('');
  const body = rows.map((r) => `<tr ${rowAttrs ? rowAttrs(r) : ''}>${cols.map((c) => {
    const raw = c.get(r);
    const cls = c.cls ? c.cls(r) : '';
    return `<td class="${c.align === 'l' ? 'l' : ''} ${cls}">${raw == null ? '—' : raw}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function applySort(rows, sort, accessors) {
  const arr = rows.slice();
  arr.sort((a, b) => {
    const va = accessors[sort.key] ? accessors[sort.key](a) : a[sort.key];
    const vb = accessors[sort.key] ? accessors[sort.key](b) : b[sort.key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb), 'zh-CN') * sort.dir;
    }
    return (Number(va) - Number(vb)) * sort.dir;
  });
  return arr;
}

function renderValuation() {
  let rows = byIndustry(state.brief.valuationTable || []);
  const f = state.valFilter;
  if (f === 'high') rows = rows.filter((r) => r.pe_percentile != null && r.pe_percentile >= 95);
  else if (f === 'low') rows = rows.filter((r) => r.pe_percentile != null && r.pe_percentile <= 10);
  else if (f === 'large') rows = rows.filter((r) => r.total_mv != null && r.total_mv >= 2e10);
  const q = ($('#valSearch').value || '').trim();
  if (q) {
    const lq = q.toLowerCase();
    rows = rows.filter((r) => `${r.name}${r.code}`.toLowerCase().includes(lq));
  }
  const accessors = {
    name: (r) => r.name, code: (r) => r.code,
    pe_ttm: (r) => r.pe_ttm, pb: (r) => r.pb, ps_ttm: (r) => r.ps_ttm,
    pe_percentile: (r) => r.pe_percentile, pb_percentile: (r) => r.pb_percentile,
    change_pct: (r) => r.change_pct, total_mv: (r) => r.total_mv,
    revenue_yoy: (r) => r.revenue_yoy, net_profit_yoy: (r) => r.net_profit_yoy, roe: (r) => r.roe,
    score: (r) => r.score,
  };
  rows = applySort(rows, state.valSort, accessors);
  $('#valCount').textContent = `${fmtInt(rows.length)} 家 / 共 ${fmtInt(state.brief.valuationTable.length)} 家`;
  if (!rows.length) { $('#valBody').innerHTML = '<div class="empty">没有匹配的公司</div>'; return; }

  const cols = [
    { key: 'code', label: '代码', align: 'l', get: (r) => `<span class="code">${esc(r.code)}</span>` },
    { key: 'name', label: '简称', align: 'l', get: (r) => esc(r.name) },
    { key: 'change_pct', label: '涨跌幅', get: (r) => fmtPct(r.change_pct), cls: (r) => signClass(r.change_pct) },
    { key: 'total_mv', label: '总市值', get: (r) => fmtMv(r.total_mv) },
    { key: 'pe_ttm', label: 'PE(TTM)', get: (r) => fmtNum(r.pe_ttm, 1), cls: () => '' },
    { key: 'pb', label: 'PB', get: (r) => fmtNum(r.pb, 2) },
    { key: 'ps_ttm', label: 'PS(TTM)', get: (r) => fmtNum(r.ps_ttm, 1) },
    { key: 'pe_percentile', label: 'PE分位', get: (r) => r.pe_percentile != null ? fmtNum(r.pe_percentile, 0) + '%' : '—',
      cls: (r) => r.pe_percentile == null ? '' : (r.pe_percentile >= 95 ? 'up' : r.pe_percentile <= 10 ? 'down' : '') },
    { key: 'pb_percentile', label: 'PB分位', get: (r) => r.pb_percentile != null ? fmtNum(r.pb_percentile, 0) + '%' : '—',
      cls: (r) => r.pb_percentile == null ? '' : (r.pb_percentile >= 95 ? 'up' : r.pb_percentile <= 10 ? 'down' : '') },
    { key: 'revenue_yoy', label: '营收同比', get: (r) => fmtPct(r.revenue_yoy), cls: (r) => signClass(r.revenue_yoy) },
    { key: 'net_profit_yoy', label: '净利同比', get: (r) => fmtPct(r.net_profit_yoy), cls: (r) => signClass(r.net_profit_yoy) },
    { key: 'roe', label: 'ROE', get: (r) => fmtNum(r.roe, 2) },
    { key: 'score', label: '信号分', get: (r) => r.score > 0 ? `<b>${r.score}</b>` : '—' },
  ];
  $('#valBody').innerHTML = sortableTable(rows, cols, state.valSort, null, (r) => `data-code="${esc(r.code)}"`);
}

function renderFinancial() {
  let rows = byIndustry(state.brief.financialTable || []);
  const f = state.finFilter;
  if (f === 'up') rows = rows.filter((r) => r.revenue_yoy != null && r.revenue_yoy > 30);
  else if (f === 'down') rows = rows.filter((r) => r.revenue_yoy != null && r.revenue_yoy < -30);
  const q = ($('#finSearch').value || '').trim();
  if (q) {
    const lq = q.toLowerCase();
    rows = rows.filter((r) => `${r.name}${r.code}`.toLowerCase().includes(lq));
  }
  const accessors = {
    name: (r) => r.name, code: (r) => r.code, revenue: (r) => r.revenue,
    revenue_yoy: (r) => r.revenue_yoy, net_profit_yoy: (r) => r.net_profit_yoy,
    gross_profit_yoy: (r) => r.gross_profit_yoy, roe: (r) => r.roe,
    gross_margin: (r) => r.gross_margin, net_margin: (r) => r.net_margin,
    total_mv: (r) => r.total_mv, score: (r) => r.score,
  };
  rows = applySort(rows, state.finSort, accessors);
  $('#finCount').textContent = `${fmtInt(rows.length)} 家 / 共 ${fmtInt(state.brief.financialTable.length)} 家`;
  if (!rows.length) { $('#finBody').innerHTML = '<div class="empty">没有匹配的公司</div>'; return; }

  const cols = [
    { key: 'code', label: '代码', align: 'l', get: (r) => `<span class="code">${esc(r.code)}</span>` },
    { key: 'name', label: '简称', align: 'l', get: (r) => esc(r.name) },
    { key: 'change_pct', label: '涨跌幅', get: (r) => fmtPct(r.change_pct), cls: (r) => signClass(r.change_pct) },
    { key: 'revenue', label: '营业总收入', get: (r) => fmtMv(r.revenue) },
    { key: 'revenue_yoy', label: '营收同比', get: (r) => fmtPct(r.revenue_yoy), cls: (r) => signClass(r.revenue_yoy) },
    { key: 'net_profit_attr', label: '归母净利', get: (r) => fmtMv(r.net_profit_attr) },
    { key: 'net_profit_yoy', label: '净利同比', get: (r) => fmtPct(r.net_profit_yoy), cls: (r) => signClass(r.net_profit_yoy) },
    { key: 'gross_profit_yoy', label: '毛利同比', get: (r) => fmtPct(r.gross_profit_yoy), cls: (r) => signClass(r.gross_profit_yoy) },
    { key: 'roe', label: 'ROE', get: (r) => fmtNum(r.roe, 2) },
    { key: 'gross_margin', label: '毛利率', get: (r) => fmtNum(r.gross_margin, 1) },
    { key: 'net_margin', label: '净利率', get: (r) => fmtNum(r.net_margin, 1) },
    { key: 'total_mv', label: '总市值', get: (r) => fmtMv(r.total_mv) },
    { key: 'score', label: '信号分', get: (r) => r.score > 0 ? `<b>${r.score}</b>` : '—' },
  ];
  $('#finBody').innerHTML = sortableTable(rows, cols, state.finSort, null, (r) => `data-code="${esc(r.code)}"`);
}

async function renderNotices() {
  const st = feedState.notice;
  st.q = ($('#noticeSearch').value || '').trim();
  await loadFeed('notice');
  const d = st.data || { items: [], total: 0, pages: 1, page: 1 };
  const list = d.items;
  $('#noticeCount').textContent = `${fmtInt(d.total)} 条`;
  if (!list.length) { $('#noticeBody').innerHTML = '<div class="empty">没有匹配的公告</div>'; return; }
  $('#noticeBody').innerHTML = `<div class="feed">${list.map((x) => `
    <div class="feed-item" data-code="${esc(x.code)}">
      <div class="feed-meta">${esc(x.date || '')}<br><b>${esc(x.name)}</b></div>
      <div>
        <div class="feed-title">${esc(x.title || '')}</div>
      </div>
    </div>`).join('')}</div>${feedPager('notice', d.total, d.pages, d.page)}`;
}

// ------------------------------------------------------------------ 渲染：全量

function renderAll() {
  const q = ($('#allSearch').value || '').trim();
  const withNews = $('#allWithNews').checked;
  const industry = $('#allIndustry').value;
  let rows = state.brief.companies || [];
  // 区间 + 行业筛选生效时：先按服务端聚合出的公司集合收敛，再叠加区间涨跌
  const rangeOn = flt.active && flt.range && flt.range.available;
  if (rangeOn) {
    const m = new Map((flt.range.companies || []).map((c) => [c.code, c]));
    rows = rows.filter((r) => m.has(r.code)).map((r) => {
      const x = m.get(r.code);
      return Object.assign({}, r, {
        rangeChg: x.rangeChg, rangeNews: x.newsCount, rangeResearch: x.researchCount,
      });
    });
  }
  if (withNews) rows = rows.filter((r) => (rangeOn ? (r.rangeNews || 0) > 0 : (r.news.length || r.notices.length)));
  if (industry) rows = rows.filter((r) => r.industry === industry);
  if (q) {
    const lq = q.toLowerCase();
    rows = rows.filter((r) => `${r.name}${r.code}`.toLowerCase().includes(lq));
  }
  const accessors = {
    name: (r) => r.name, code: (r) => r.code,
    industry: (r) => r.industry,
    total_mv: (r) => (r.valuation || {}).total_mv,
    pe_ttm: (r) => (r.valuation || {}).pe_ttm,
    pb: (r) => (r.valuation || {}).pb,
    pe_percentile: (r) => (r.valuation || {}).pe_percentile,
    change_pct: (r) => (r.quote || {}).change_pct,
    revenue_yoy: (r) => (r.growth || {}).revenue_yoy,
    net_profit_yoy: (r) => (r.growth || {}).net_profit_yoy,
    roe: (r) => (r.profitability || {}).roe_weighted,
    news: (r) => (r.news_count != null ? r.news_count : (r.news || []).length),
    research: (r) => (r.research_count != null ? r.research_count : (r.research || []).length),
    rangeChg: (r) => r.rangeChg,
    score: (r) => r.score,
  };
  rows = applySort(rows, state.allSort, accessors);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;
  const pageRows = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  $('#allCount').textContent = `${fmtInt(rows.length)} 家 / 共 ${fmtInt(state.brief.companies.length)} 家`;

  const cols = [
    { key: 'code', label: '代码', align: 'l', get: (r) => `<span class="code">${esc(r.code)}</span>` },
    { key: 'name', label: '简称', align: 'l', get: (r) => esc(r.name) },
    { key: 'industry', label: '行业', align: 'l', get: (r) => esc(r.industry || '—') },
    { key: 'change_pct', label: '涨跌幅', get: (r) => fmtPct((r.quote || {}).change_pct),
      cls: (r) => signClass((r.quote || {}).change_pct) },
    { key: 'total_mv', label: '总市值', get: (r) => fmtMv((r.valuation || {}).total_mv) },
    { key: 'pe_ttm', label: 'PE(TTM)', get: (r) => fmtNum((r.valuation || {}).pe_ttm, 1) },
    { key: 'pe_percentile', label: 'PE分位', get: (r) => {
        const p = (r.valuation || {}).pe_percentile;
        return p != null ? fmtNum(p, 0) + '%' : '—';
      }, cls: (r) => {
        const p = (r.valuation || {}).pe_percentile;
        return p == null ? '' : (p >= 95 ? 'up' : p <= 10 ? 'down' : '');
      } },
    { key: 'revenue_yoy', label: '营收同比', get: (r) => fmtPct((r.growth || {}).revenue_yoy),
      cls: (r) => signClass((r.growth || {}).revenue_yoy) },
    { key: 'roe', label: 'ROE', get: (r) => fmtNum((r.profitability || {}).roe_weighted, 2) },
    { key: 'news', label: '要闻', get: (r) => (r.news_count != null ? r.news_count : (r.news || []).length) || '—' },
    { key: 'research', label: '研报', get: (r) => (r.research_count != null ? r.research_count : (r.research || []).length) || '—' },
    { key: 'score', label: '信号分', get: (r) => r.score > 0 ? `<b>${r.score}</b>` : '—' },
  ];
  // 区间筛选生效时，多给一列「区间涨跌」（from 日 vs to 日收盘价）
  if (rangeOn) {
    cols.splice(4, 0, {
      key: 'rangeChg', label: '区间涨跌', get: (r) => r.rangeChg == null ? '—' : fmtPct(r.rangeChg),
      cls: (r) => signClass(r.rangeChg),
    });
  }

  let html = sortableTable(pageRows, cols, state.allSort, null, (r) => `data-code="${esc(r.code)}"`);
  if (!pageRows.length) html = '<div class="empty">没有匹配的公司</div>';
  $('#allBody').innerHTML = html;

  $('#allPager').innerHTML = `
    <button id="prevPage" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pg-info">第 ${state.page} / ${totalPages} 页</span>
    <button id="nextPage" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>`;
}

// ------------------------------------------------------------------ 抽屉

async function openDrawer(code) {
  // 首屏是瘦载荷，公司详情（含新闻/公告/研报正文）按需拉取
  let c = (state.brief.companies || []).find((x) => x.code === code);
  if (!c) return;
  try {
    const full = await getJsonXhr(`/api/company?code=${encodeURIComponent(code)}`);
    if (full && full.code) c = full;
  } catch (e) { /* 用列表里的精简数据继续 */ }
  const v = c.valuation || {}, g = c.growth || {}, p = c.profitability || {};
  const kv = (k, val, cls) => `<div class="kv-item"><div class="k">${esc(k)}</div><div class="v ${cls || ''}">${val == null ? '—' : val}</div></div>`;

  const researchHtml = (c.research || []).length ? `<div class="d-list">${c.research.map((r) => `
    <div class="d-item">
      <div class="t">${esc(r.title || '')}</div>
      <div class="m">${esc(r.date || '')} ·
        ${r.kind === 'broker_report' ? '券商报告' : r.kind === 'consensus' ? '卖方一致预期' : '提及'}
        ${r.broker ? ' · ' + esc(r.broker) : ''}${r.rating ? ' · ' + esc(r.rating) : ''}
        ${r.target_price != null ? ' · 目标价 ' + fmtNum(r.target_price, 2) + ' 元' : ''}
        ${r.institution_count ? ' · ' + r.institution_count + ' 家机构覆盖' : ''}</div>
      ${(r.rating_distribution || []).length ? `<div class="m">评级分布：${r.rating_distribution.map((d) => `${d.rating} ${d.count} 家`).join('，')}</div>` : ''}
      <div class="c">${esc(r.content || '')}</div>
    </div>`).join('')}</div>` : '<div class="empty">窗口期内无券商研报命中</div>';

  const newsHtml = (c.news || []).length ? `<div class="d-list">${c.news.map((n) => `
    <div class="d-item">
      <div class="t">${link(n.url, n.title || '')}</div>
      <div class="m">${esc(n.date || '')}${n.broker ? ' · ' + esc(n.broker) : ''}${n.rating ? ' · ' + esc(n.rating) : ''}</div>
      <div class="c">${esc(n.content || '')}</div>
    </div>`).join('')}</div>` : '<div class="empty">窗口期内无要闻</div>';

  const noticeHtml = (c.notices || []).length ? `<div class="d-list">${c.notices.map((n) => `
    <div class="d-item">
      <div class="t">${esc(n.title || '')}</div>
      <div class="m">${esc(n.date || '')}</div>
      <div class="c">${esc(n.content || '')}</div>
    </div>`).join('')}</div>` : '<div class="empty">窗口期内无公告</div>';

  $('#drawerTitle').textContent = c.name;
  $('#drawerSub').textContent = `${c.code} · ${c.board || '科创板'}`;
  $('#drawerBody').innerHTML = `
    ${c.score > 0 ? `<div class="d-section"><h3>信号（${c.score} 分）</h3>
      <div class="sc-signals">${(c.signals || []).map((s) => `<span class="tag star">${esc(s.label)}</span>`).join('')}</div>
      ${(c.viewpoint_change || []).length ? `<div class="d-item" style="margin-top:8px"><div class="t">观点变化</div><div class="c">${c.viewpoint_change.map(esc).join('；')}</div></div>` : ''}
    </div>` : ''}
    <div class="d-section"><h3>估值</h3><div class="kv">
      ${kv('PE(TTM)', fmtNum(v.pe_ttm, 2))}${kv('PB', fmtNum(v.pb, 2))}
      ${kv('PS(TTM)', fmtNum(v.ps_ttm, 2))}${kv('PE历史分位', v.pe_percentile != null ? fmtNum(v.pe_percentile, 0) + '%' : '—',
        v.pe_percentile != null && v.pe_percentile >= 95 ? 'up' : v.pe_percentile != null && v.pe_percentile <= 10 ? 'down' : '')}
      ${kv('总市值', fmtMv(v.total_mv))}${kv('流通市值', fmtMv(v.float_mv))}
    </div></div>
    <div class="d-section"><h3>财务</h3><div class="kv">
      ${kv('营业总收入', fmtMv(c.revenue))}${kv('营收同比', fmtPct(g.revenue_yoy), signClass(g.revenue_yoy))}
      ${kv('归母净利', fmtMv(c.net_profit_attr))}${kv('净利同比', fmtPct(g.net_profit_yoy), signClass(g.net_profit_yoy))}
      ${kv('ROE(加权)', fmtNum(p.roe_weighted, 2))}${kv('毛利率', fmtNum(p.gross_margin, 1))}
      ${kv('净利率', fmtNum(p.net_margin, 1))}${kv('总资产', fmtMv(c.total_assets))}
    </div></div>
    <div class="d-section"><h3>券商观点（${(c.research || []).length}）</h3>${researchHtml}</div>
    <div class="d-section"><h3>要闻（${(c.news || []).length}）</h3>${newsHtml}</div>
    <div class="d-section"><h3>公告（${(c.notices || []).length}）</h3>${noticeHtml}</div>`;

  $('#drawer').hidden = false;
  requestAnimationFrame(() => {
    $('#drawer').classList.add('on');
    $('#drawerMask').classList.add('on');
  });
}

function closeDrawer() {
  $('#drawer').classList.remove('on');
  $('#drawerMask').classList.remove('on');
  setTimeout(() => { $('#drawer').hidden = true; }, 260);
}

// ------------------------------------------------------------------ 数据加载

/** 用 XHR 取 JSON：部分嵌入式浏览器对 fetch 的响应体结算不可靠，XHR 更稳 */
function getJsonXhr(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 120000;
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) {
        try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
      } else {
        reject(new Error(`HTTP ${x.status}`));
      }
    };
    x.onerror = () => reject(new Error('网络错误'));
    x.ontimeout = () => reject(new Error('请求超时'));
    x.send();
  });
}

/**
 * 取服务器状态：决定「刷新」按钮是否可用。
 * 看板开放到局域网后，写接口（POST /api/collect）对非本机来源是锁死的，
 * 与其让别的 PC 点「刷新」拿到一个看不懂的 403，不如直接禁用并说明原因。
 */
async function loadStatus() {
  try {
    const st = await getJsonXhr('/api/status');
    state.serverStatus = st;
    const btn = $('#refreshBtn');
    if (btn && st && st.writeAllowed === false) {
      btn.disabled = true;
      btn.title = '从其他电脑访问：写操作已锁（刷新只能在运行看板的这台机器上触发）';
    }
    renderLanChip(st);
  } catch (e) { /* 状态取不到不影响看板使用 */ }
}

/**
 * **局域网访问地址**（2026-10-28 新增）。
 *
 * 为什么要在页面上显示而不是写进文档：内网 IP 是 DHCP 分配的，**会变**。
 * 写死的地址过几天就失效了 —— 而"保证局域网能访问"这件事最怕的就是
 * 大家都拿着一个过期地址打不开。
 * 所以地址由服务端实时取，页面实时显示，点一下就复制。
 */
function renderLanChip(st) {
  const el = $('#lanChip');
  if (!el) return;
  const lan = st && st.lan;
  // **优先显示"当前这台机器上你正在用的地址"**：
  // 部署到云端后，服务端的内网 IP(172.31.x.x) 对公网访客毫无意义，
  // 而 location.origin 正是访客能用的那个。
  const here = (location.hostname && !/^(127\.|localhost$)/.test(location.hostname))
    ? location.origin : null;
  const url = here || (lan && lan.primary ? `http://${lan.primary}:${lan.port}` : null);
  if (!url) {
    el.textContent = '局域网 —';
    el.classList.remove('ok');
    el.title = '未取到局域网地址（服务可能只监听本机）';
    return;
  }
  el.textContent = `访问地址 ${url}`;
  el.classList.add('ok');
  el.title = `主机名：${(lan && lan.host) || '—'}\n本机访问：${location.host}\n`
    + (here ? '（当前就是公网可达地址；内网地址 ' + (lan && lan.primary ? lan.primary : '—') + ' 仅同 VPC 内可达）'
            : '（内网 IP 由 DHCP 分配，变了以本页面显示为准）');
  if (!el._lanBound) {
    el._lanBound = true;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const text = url;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast('已复制：' + text), () => toast(text));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('已复制：' + text); } catch (e) { toast(text); }
        document.body.removeChild(ta);
      }
    });
  }
}

async function loadBrief(date) {
  const n = new URLSearchParams(location.search).get('n');
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (n) qs.set('n', n);
  const url = `/api/brief${qs.toString() ? '?' + qs.toString() : ''}`;
  const status = $('#statusText');
  status.textContent = '正在获取数据…';
  state.brief = await getJsonXhr(url);
  state.date = state.brief.date;
  renderAll2();
}

function renderAll2() {
  renderTop();
  renderNewsDigest();
  renderMarket();
  renderTrending();
  renderSignals();
  renderValuation();
  renderFinancial();
  renderCoverage();
  renderSectors();
  renderIndustries();
  // 行业下拉依赖 brief.companies，必须等 brief 就绪后再填
  // （init 里 loadDates() 与 loadBrief() 并行，先填会得到空下拉）
  fillFilterOptions(flt.dates);
  renderAll();
}

/** 行业下拉：数据源是东方财富的行业分类（随每次采集刷新） */
function renderIndustries() {
  const sel = $('#allIndustry');
  if (!sel) return;
  const cur = sel.value;
  const inds = [...new Set((state.brief.companies || []).map((c) => c.industry).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部行业</option>' +
    inds.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  if (inds.includes(cur)) sel.value = cur;
}

async function loadDates() {
  try {
    const j = await getJsonXhr('/api/dates');
    const dates = j.dates || [];
    const sel = $('#dateSelect');
    sel.innerHTML = dates.map((d) => `<option value="${d}">${d}</option>`).join('');
    if (dates.length) sel.value = dates[0];
    fillFilterOptions(dates);
    fltStatus();
  } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------------ CFO 问答

const ASK_SAMPLES = [
  '睿创微纳最近的业绩和研报怎么看？',
  '今天科创板哪些公司涨得最多？',
  '半导体板块最近有什么大事？',
  'PE 分位最低的 10 家公司有哪些？',
  '卖方覆盖最多、评级最积极的是哪几家？',
];

state.askHistory = state.askHistory || [];
state.askModel = state.askModel || null;

function postJson(url, body, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(j || {});
      else reject(new Error((j && (j.error || j.message)) || ('HTTP ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('网络错误，请检查看板服务是否在运行'));
    xhr.ontimeout = () => reject(new Error('请求超时（模型响应慢或额度不足）'));
    xhr.send(JSON.stringify(body));
  });
}

/** 轻量 markdown：转义后只处理粗体、标题、列表、换行（不要引入 md 库） */
function mdLite(text) {
  let s = esc(String(text || ''));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/^#{1,4}\s*(.+)$/gm, '<b class="md-h">$1</b>');
  s = s.replace(/^\s*[-*]\s+(.+)$/gm, '· $1');
  s = s.replace(/\r?\n/g, '<br>');
  return s;
}

function renderAskSamples() {
  const el = $('#askSamples');
  if (!el) return;
  el.innerHTML = ASK_SAMPLES.map((q, i) => `<button class="chip ask-chip" data-idx="${i}">${esc(q)}</button>`).join('');
  $$('.ask-chip', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = ASK_SAMPLES[Number(btn.dataset.idx)] || '';
      const input = $('#askInput');
      if (input) { input.value = q; input.focus(); }
    });
  });
}

function renderAsk() {
  const body = $('#askBody');
  if (!body) return;
  const h = state.askHistory;
  if (!h.length) {
    body.innerHTML = `<div class="card"><div class="empty">还没有提问。先在上面输入问题，或点下面的示例问题。</div></div>`;
    return;
  }
  const renderOne = (it, idx) => {
    const degraded = it.degraded;
    const head = `<div class="qa-q"><span class="qa-tag">问</span> ${esc(it.question)}
      <span class="qa-time">${esc(it.at || '')}</span></div>`;
    const ans = it.answer
      ? `<div class="qa-a"><span class="qa-tag ans">答</span><div class="qa-text">${mdLite(it.answer)}</div></div>`
      : `<div class="qa-a warn"><span class="qa-tag ans">答</span><div class="qa-text">${esc(it.message || '未取到回答')}</div></div>`;
    const ev = (it.evidence || []).length ? `<details class="qa-ev"><summary>依据 ${it.evidence.length} 条（可回查）</summary>
      <ul>${it.evidence.map((e) => `<li><b>${esc(e.id)}</b> <span class="qa-kind">${esc(e.kindLabel)}</span>
        <span class="qa-date">${esc(e.date || '')}</span>
        ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>` : esc(e.name)}
        <div class="qa-ev-t">${esc(e.title)}</div>
        ${e.broker ? `<div class="qa-ev-m">${esc(e.broker)}${e.rating ? '｜' + esc(e.rating) : ''}${e.target_price != null ? '｜目标价 ' + esc(e.target_price) : ''}${e.hasView ? '' : '｜⚠ 仅元数据，无研报原文'}</div>` : ''}
        ${e.snippet ? `<div class="qa-ev-s">${esc(e.snippet)}</div>` : ''}
      </li>`).join('')}</ul></details>` : '';
    // **网络来源（W 编号）**：与本地依据分开列，来源和日期必须能回查
    const wev = (it.webEvidence || []).length ? `<details class="qa-ev qa-web"><summary>网络来源 ${it.webEvidence.length} 条（外部网页，未经本地核验）</summary>
      <ul>${it.webEvidence.map((e) => `<li><b>${esc(e.id)}</b> <span class="qa-kind web">网络</span>
        <span class="qa-date">${esc(e.publishedAt || '')}</span>
        <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
        <div class="qa-ev-s">${esc(e.site || '')}</div>
        ${e.snippet ? `<div class="qa-ev-t">${esc(e.snippet)}</div>` : ''}
      </li>`).join('')}</ul></details>` : '';
    const pr = it.prompt ? `<details class="qa-prompt"><summary>查看本次提示词（${it.prompt.length} 字符，含项目背景与可信度边界）</summary>
      <pre>${esc(it.prompt)}</pre></details>` : '';
    const note = it.searchNote ? `<div class="qa-degraded">ℹ ${esc(it.searchNote)}</div>` : '';
    return `<div class="card qa" data-idx="${idx}">${head}${ans}${ev}${wev}${pr}${note}
      ${degraded ? `<div class="qa-degraded">⚠ ${esc(degraded)}</div>` : ''}</div>`;
  };
  // **最新的放最上面**（2026-10-28 改）：之前是历史在上、新的在下，
  // CFO 问完新问题后还要往下翻才看到答案。
  // 更早的问答折叠进一个 <details>，需要时能翻回去看依据和提示词。
  const latestIdx = h.length - 1;
  const older = [];
  for (let i = latestIdx - 1; i >= 0; i--) older.push(renderOne(h[i], i));
  body.innerHTML = renderOne(h[latestIdx], latestIdx)
    + (older.length ? `<details class="qa-old"><summary>历史问答（${older.length} 条，点击展开）</summary>${older.join('')}</details>` : '');
}

async function askSubmit() {
  const input = $('#askInput');
  const question = String((input && input.value) || '').trim();
  if (!question) { toast('请先输入问题'); return; }
  const btn = $('#askBtn');
  const status = $('#askStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = '正在检索材料并调用模型…';
  try {
    const r = await postJson('/api/ask', { question, date: state.date || undefined });
    state.askModel = r.llm || state.askModel;
    const sr = r.search || {};
    // 联网状态要在答案上方说清楚：搜了没搜到、为什么没搜到
    let searchNote = '';
    if (sr.error === 'SEARCH_NOT_CONFIGURED') searchNote = '未配置联网搜索，本次只用了雷达本地数据';
    else if (sr.error === 'SEARCH_RATE_LIMITED') searchNote = `联网搜索限流（${sr.error}）`;
    else if (sr.error) searchNote = `联网搜索失败：${sr.error}`;
    else if (sr.used) searchNote = `本次用了联网检索（${sr.results} 条外部来源，编号 W 开头）`;
    state.askHistory.push({
      question, at: new Date().toLocaleTimeString('zh-CN'),
      answer: r.answer || '', message: r.message || r.error || '',
      degraded: r.degraded ? (r.degraded === 'MODEL_NOT_CONFIGURED'
        ? '未配置模型：只返回了提示词（可在 data/radar.env 填 RADAR_LLM_BASE_URL / RADAR_LLM_API_KEY / RADAR_LLM_MODEL）'
        : `模型调用失败（${r.error || r.degraded}）：只返回了提示词`) : '',
      evidence: r.evidence || [], webEvidence: r.webEvidence || [], prompt: r.prompt || '',
      searchNote,
    });
    if (input) input.value = '';
    renderAsk();
    if (status) status.textContent = '';
    const copyBtn = $('#askCopy');
    if (copyBtn) copyBtn.hidden = false;
    // 新答案在最上面，滚到它，别让 CFO 停在半截页面
    const body = $('#askBody');
    if (body && body.firstElementChild) body.firstElementChild.scrollIntoView({ block: 'nearest' });
  } catch (e) {
    toast(e.message, 5000);
    if (status) status.textContent = e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyAskPrompt() {
  const last = state.askHistory[state.askHistory.length - 1];
  if (!last || !last.prompt) { toast('还没有可复制的提示词'); return; }
  const text = last.prompt;
  try {
    await navigator.clipboard.writeText(text);
    toast('提示词已复制到剪贴板');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('提示词已复制'); }
    catch (e2) { toast('复制失败，请手动选中提示词区内容'); }
    document.body.removeChild(ta);
  }
}

// ------------------------------------------------------------------ 事件绑定

function bind() {
  const activateTab = (btn) => {
    if (!btn) return;
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    const p = $(`#panel-${state.tab}`);
    if (p) p.classList.add('active');
    // **问答页把筛选栏解除 sticky**：筛选栏高约 420px 且 sticky，
    // 会把问答页最上面的输入框整个盖住 —— 看得见却点不到（CFO 无法提问）。
    // 详见 public/style.css 里 body.tab-ask .filterbar 的说明。
    document.body.classList.toggle('tab-ask', state.tab === 'ask');
    // 切到问答页时回到顶部：否则用户停在一屏很下面，切换后输入框在视口外
    if (state.tab === 'ask') window.scrollTo({ top: 0, behavior: 'auto' });
  };

  // 事件用捕获阶段监听：有些事件分发实现不冒泡，
  // 挂在祖先节点上的普通委托监听会收不到，捕获阶段则一定触发。
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activateTab(tab);
    // 信息流按需加载：点到哪个 tab 才拉哪个
    const t = tab.dataset.tab;
    if (t === 'news') renderNews();
    else if (t === 'research') renderResearch();
    else if (t === 'notice') renderNotices();
    else if (t === 'coverage') renderCoverage();
    else if (t === 'sectors') renderSectors();
    else if (t === 'ask') renderAsk();
  }, true);
  // 再给每个按钮直挂一份，双保险
  $$('.tab').forEach((btn) => btn.addEventListener('click', () => activateTab(btn)));

  // ---- CFO 问答 ----
  const askBtn = $('#askBtn');
  if (askBtn) askBtn.addEventListener('click', () => askSubmit());
  const askCopy = $('#askCopy');
  if (askCopy) askCopy.addEventListener('click', () => copyAskPrompt());
  const askInput = $('#askInput');
  if (askInput) {
    askInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); askSubmit(); }
    });
  }

  $('#dateSelect').addEventListener('change', (e) => loadBrief(e.target.value).catch((err) => toast(err.message)));

  // ---- 全局筛选：行业 + 日期范围（组合生效） ----
  const fltApply = $('#fltApply');
  if (fltApply) {
    fltApply.addEventListener('click', () => applyFilter());
    $('#fltReset').addEventListener('click', () => resetFilter());
    $$('#filterBar .fb-quick .btn').forEach((b) => b.addEventListener('click', () => {
      const days = Number(b.dataset.days || 0);
      const ds = flt.dates || [];
      const latest = ds[0] || '';
      if (!days) {
        // 「全部」= 要闻实测覆盖窗口的起点（不是"最早的快照日"，那只是快照日）
        const cov = (flt.coverage && flt.coverage.newsFrom) || (ds.length ? ds[ds.length - 1] : '');
        $('#fltFrom').value = cov;
        $('#fltTo').value = latest;
      } else {
        // 「近 N 天」= 自然日窗口（不是 N 个快照日——快照可能隔天才有）
        const t = Date.parse(latest);
        const from = Number.isNaN(t) ? latest
          : new Date(t - (days - 1) * 86400000).toISOString().slice(0, 10);
        $('#fltFrom').value = from;
        $('#fltTo').value = latest;
      }
      applyFilter();
    }));
    $('#fltFrom').addEventListener('change', applyFilter);
    $('#fltTo').addEventListener('change', applyFilter);
    // 行业标签多选：点标签即选中/取消（不需要 Ctrl/Shift）
    const chipRow = $('#fltIndustryChips');
    if (chipRow) {
      chipRow.addEventListener('click', (e) => {
        const b = e.target.closest('.ind-chip');
        if (!b) return;
        const ind = b.getAttribute('data-ind');
        if (!ind) return;
        const i = flt.industries.indexOf(ind);
        if (i >= 0) flt.industries.splice(i, 1); else flt.industries.push(ind);
        renderIndustryChips();
      });
    }
    const indSearch = $('#fltIndustrySearch');
    if (indSearch) indSearch.addEventListener('input', () => renderIndustryChips());
    const indClear = $('#fltIndustryClear');
    if (indClear) {
      indClear.addEventListener('click', () => { flt.industries = []; renderIndustryChips(); });
    }
  }

  $('#refreshBtn').addEventListener('click', async () => {
    toast('已触发后台采集，完成后自动刷新…');
    try {
      const r = await fetch('/api/collect', { method: 'POST' });
      if (r.status === 403) {
        const j = await r.json().catch(() => ({}));
        toast(j.error || '写操作在非本机访问时已锁，请在运行看板的机器上触发刷新', 6000);
        return;
      }
    } catch (e) { toast('触发失败：' + e.message, 6000); }
  });

  ['newsSearch', 'newsLatestOnly', 'newsResearchOnly'].forEach((id) =>
    $('#' + id).addEventListener('input', () => { feedState.news.page = 1; renderNews(); }));
  ['researchSearch', 'researchChanged'].forEach((id) =>
    $('#' + id).addEventListener('input', () => { feedState.research.page = 1; renderResearch(); }));
  ['valSearch'].forEach((id) => $('#' + id).addEventListener('input', renderValuation));
  ['finSearch'].forEach((id) => $('#' + id).addEventListener('input', renderFinancial));
  ['noticeSearch'].forEach((id) =>
    $('#' + id).addEventListener('input', () => { feedState.notice.page = 1; renderNotices(); }));
  ['allSearch', 'allWithNews', 'allIndustry'].forEach((id) =>
    $('#' + id).addEventListener('input', () => { state.page = 1; renderAll(); }));

  $('#valSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    $$('#valSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.valFilter = b.dataset.filter;
    renderValuation();
  });
  $('#covSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    $$('#covSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    covState.filter = b.dataset.filter;
    renderCoverage();
  });
  $('#covSearch').addEventListener('input', () => {
    covState.q = ($('#covSearch').value || '').trim();
    renderCoverage();
  });
  $('#finSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    $$('#finSeg .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.finFilter = b.dataset.filter;
    renderFinancial();
  });

  // 表头排序（捕获阶段）
  document.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const panel = th.closest('.panel').id;
    const key = th.dataset.key;
    if (panel === 'panel-valuation') {
      state.valSort = state.valSort.key === key ? { key, dir: -state.valSort.dir } : { key, dir: -1 };
      renderValuation();
    } else if (panel === 'panel-financial') {
      state.finSort = state.finSort.key === key ? { key, dir: -state.finSort.dir } : { key, dir: -1 };
      renderFinancial();
    } else if (panel === 'panel-all') {
      state.allSort = state.allSort.key === key ? { key, dir: -state.allSort.dir } : { key, dir: -1 };
      renderAll();
    } else if (panel === 'panel-coverage') {
      covState.sort = covState.sort.key === key ? { key, dir: -covState.sort.dir } : { key, dir: -1 };
      renderCoverage();
    }
  }, true);

  // 行/卡片点击 → 抽屉（捕获阶段）
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-code]');
    if (!row || e.target.closest('a')) return;
    openDrawer(row.dataset.code);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.signal-card[data-code]');
      if (card) { e.preventDefault(); openDrawer(card.dataset.code); }
    }
    if (e.key === 'Escape') closeDrawer();
  });

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);

  $('#allPager').addEventListener('click', (e) => {
    if (e.target.id === 'prevPage') { state.page--; renderAll(); }
    if (e.target.id === 'nextPage') { state.page++; renderAll(); }
  });

  // 信息流翻页
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.pager[data-feed] button');
    if (!btn) return;
    const type = btn.closest('.pager').dataset.feed;
    const st = feedState[type];
    if (!st) return;
    st.page = btn.dataset.act === 'next' ? st.page + 1 : Math.max(1, st.page - 1);
    if (type === 'news') renderNews();
    else if (type === 'research') renderResearch();
    else if (type === 'notice') renderNotices();
  }, true);
}

(async function init() {
  bind();
  renderAskSamples();
  renderAsk();
  await loadDates();
  try {
    await loadBrief();
    await loadStatus();
  } catch (e) {
    $('#statusText').textContent = e.message;
    toast(e.message, 6000);
    $('#main').innerHTML = `<div class="card"><div class="empty">${esc(e.message)}<br><br>
      请先运行 <code>node scripts/run_collect.cjs</code> 完成首次采集。</div></div>`;
  }
})();
