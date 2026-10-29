'use strict';
/**
 * 飞书 Markdown 发布守卫。
 *
 * **为什么要这个**：飞书的 markdown→HTML 转换把**成对的 ASCII `~`** 当作删除线标记
 * （GitHub 风格 `~~删除~~`），生成 `<del>`。结果是原文成段内容在飞书端显示为**划掉的删除线**，
 * 而 lark-cli 全程报成功、"✓ 落点校验通过"照常打印，**没有任何错误提示**。
 * 实测（2026-10-21 科创板晨报）：正文 40 处 `~` → 8 段被包成 `<del>`，
 * 其中「同比增加68%~75%；扣非归母净利润18.65亿元~19.48亿元」整段被划掉。
 *
 * 两道防线：
 *   1) 发稿前：把正文里作为区间连接符的 ASCII `~` 换成 en dash `–`（语义不变）。
 *      **代码块与行内代码一律不动**（`~/.minimax/bin/...` 这类路径不能被改）。
 *   2) 发稿后：回读文档，`<del>` 数量必须为 0，否则判定发布失败并报出原文。
 *
 * **通用判据**：凡是"转换器把某个字符当标记"的平台，CLI 不会告诉你，
 * 只有回读产物本身能验证。
 */

const FENCE_RE = /^(\s*)(```|~~~)/;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * 把正文里的 ASCII `~` 换成 en dash `–`（只处理非代码区）。
 * @returns {{text:string, replaced:number, samples:string[]}}
 */
function sanitizeTildes(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let inFence = false;
  let replaced = 0;
  const samples = [];

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;       // 围栏代码块开关
      out.push(line);
      continue;
    }
    if (inFence) { out.push(line); continue; }

    // 行内代码先摘出来保护，替换完再放回去
    const parts = [];
    let last = 0;
    let m;
    INLINE_CODE_RE.lastIndex = 0;
    while ((m = INLINE_CODE_RE.exec(line)) !== null) {
      parts.push({ text: line.slice(last, m.index), code: true });
      parts.push({ text: m[0], code: true });
      last = m.index + m[0].length;
    }
    parts.push({ text: line.slice(last), code: false });

    const rebuilt = parts.map((p) => {
      if (p.code || !p.text.includes('~')) return p.text;
      const n = (p.text.match(/~/g) || []).length;
      replaced += n;
      if (samples.length < 5) {
        const idx = p.text.indexOf('~');
        samples.push(p.text.slice(Math.max(0, idx - 24), idx + 24).trim());
      }
      return p.text.replace(/~/g, '–');
    }).join('');

    out.push(rebuilt);
  }

  return { text: out.join('\n'), replaced, samples };
}

/**
 * 检查飞书返回体里有没有被误转成删除线的 `<del>`。
 * @returns {{count:number, samples:string[]}}
 */
function checkStrike(body) {
  const s = String(body || '');
  const count = (s.match(/<del>/g) || []).length;
  const samples = [];
  let i = -1;
  while ((i = s.indexOf('<del>', i + 1)) >= 0 && samples.length < 5) {
    samples.push(s.slice(i, i + 120));
  }
  return { count, samples };
}

module.exports = { sanitizeTildes, checkStrike };
