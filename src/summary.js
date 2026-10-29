'use strict';
/**
 * 券商观点「内容总结」抽取器。
 *
 * ── 为什么需要它 ─────────────────────────────────────────
 * 1) 界面上券商观点只有标题 + 评级/目标价等元数据，**看不到研报到底说了什么**；
 *    但正文其实已经抓到了（`view` 字段，200~1200 字的"投资要点"），只是没用上。
 * 2) 现有的 `view_thesis` 是**硬截断**：直接 slice 到 150 字，会把数字切坏——
 *    实测出现"归母净利润28.47亿元，同比增长45." / "净利率（27.95%，+16.58p" 这种残缺。
 *    **总结的第一条纪律：绝不把数字切断。**
 *
 * ── 做法：抽取式（不做生成式） ────────────────────────────
 * 研报观点正文有稳定的结构（事件 / 观点 / 推荐逻辑 / 1) 2) 编号），
 * 所以用"切句 → 打分 → 按原顺序重组"来做摘要：
 *   - 含业绩数字、评级/目标价/关键动作的句子优先；
 *   - 选中的句子**保持原顺序**，读起来是连贯的一段话，不是碎片拼贴；
 *   - 超长时**只在句末截断**；实在必须切数字时，优先把数字补全，宁可多几个字。
 *
 * 全程确定性，不依赖任何模型，离线可用。
 */

const DEFAULT_MAX = 180;

/** 正文里的结构标签，去掉后句子更干净 */
const LEAD_LABEL = /^(报告摘要|投资要点|核心观点|事件|观点|推荐逻辑|投资建议|盈利预测|风险提示)+[：:]?\s*/;

/** 业绩数字：百分比 / 亿元 / 万元 / 倍 / 个百分点 … */
const FACT_RE = /[+\-−]?\d[\d,.]*\s*(%|pct|个百分点|亿|万元|万|元|倍|亿件|万件|台|家|支|人)/i;
/** 关键信息词：评级、目标价、业绩、订单、获批… */
const KEY_RE = /(目标价|评级|买入|增持|中性|推荐|首次覆盖|上调|下调|空间|业绩|营收|净利|毛利|净利率|订单|产能|获批|临床|适应症|里程碑|授权|许可|回购|定增|中标)/;
/** 句子切分：保留句末标点 */
const SENT_SPLIT = /(?<=[。；！？])|\n+/;
/** 编号项切分："1）xxx 2）yyy" */
const NUM_SPLIT = /(?=\d[）)])/;

function cleanText(t) {
  return String(t || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 切句（同时按编号项再切一层） */
function splitSentences(text) {
  const out = [];
  for (const raw of cleanText(text).split(SENT_SPLIT)) {
    for (const part of raw.split(NUM_SPLIT)) {
      const t = cleanText(part);
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * 数字安全截断：不让结尾停在数字 / 小数点 / 百分号中间。
 * 优先把数字补全（可略微超长），实在补不全就退到数字之前。
 */
function safeCut(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const m = cut.match(/([+\-−]?\d[\d,.]*)$/);
  if (m) {
    const tok = m[1];
    const start = cut.length - tok.length;
    const rest = text.slice(start);                 // 从这个数字开始的后文
    const fullNum = (rest.match(/^([+\-−]?\d[\d,.]*)/) || [''])[1] || tok;
    const afterNum = rest.slice(fullNum.length);
    // 数字后面还跟数字 → 说明这个数字没写完（"7.1" + "5亿"）
    const incomplete = /^\d/.test(afterNum) || /^\.\d/.test(afterNum);
    if (incomplete) {
      const unit = (afterNum.match(/^\s*(?:%|pct|个百分点|亿元|万元|万|元|倍)?/) || [''])[0];
      const cand = cut.slice(0, start) + fullNum + unit;
      if (cand.length <= maxLen + 16) return cand;  // 宁可略长，也不切数字
    }
    // 数字本身完整，只是后面的内容被切 → 退到这个数字之前
    const head = cut.slice(0, start).replace(/[，,、；;：:（(【\[]+\s*$/, '');
    return head + '…';
  }
  // 结尾不是数字：退到最近的句读
  const p = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf('、'));
  if (p > maxLen * 0.5) return cut.slice(0, p + 1);
  return cut.replace(/[，,、；;：:（(【\[]+\s*$/, '') + '…';
}

/**
 * 生成内容总结。
 * @param {string} view 研报观点正文（view 字段）
 * @param {Object} opts {maxLen}
 * @returns {string}
 */
function summarizeView(view, opts = {}) {
  const maxLen = opts.maxLen || DEFAULT_MAX;
  const text = cleanText(view);
  if (!text) return '';
  const sentences = splitSentences(text);
  if (!sentences.length) return safeCut(text, maxLen);

  // 打分
  const scored = sentences.map((s, i) => {
    let score = 0;
    if (FACT_RE.test(s)) score += 2;
    if (KEY_RE.test(s)) score += 1;
    if (/^(事件|观点|推荐逻辑|核心观点|投资建议)/.test(s)) score += 1;
    if (s.length > 140) score -= 1;
    if (s.length < 12) score -= 1;
    return { s, i, score };
  });
  const best = scored.slice().sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = best.filter((x) => x.score > 0).slice(0, 3);
  const chosen = (keep.length ? keep : best.slice(0, 1)).sort((a, b) => a.i - b.i);

  let out = chosen.map((x) => x.s.replace(LEAD_LABEL, '')).join('');
  out = cleanText(out);
  if (out.length > maxLen) {
    // 先尝试在句边界收
    const clipped = safeCut(out, maxLen);
    out = clipped;
  }
  return out;
}

/**
 * 摘要 + 原文一起给出（界面用摘要，详情用原文）。
 */
function buildViewSummary(item) {
  const view = item && (item.view || item.view_thesis || item.content);
  const summary = summarizeView(view, { maxLen: (item && item.summaryMaxLen) || DEFAULT_MAX });
  return {
    summary: summary || '',
    view: (item && item.view) || '',
    viewThesis: (item && item.view_thesis) || '',
  };
}

module.exports = { summarizeView, buildViewSummary, safeCut, splitSentences, DEFAULT_MAX };
