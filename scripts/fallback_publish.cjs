'use strict';
/**
 * 每日简报**保底发布**。
 *
 * **为什么需要它**：晨报的判断层由 MiniMax Bot 在 09:40 生成。
 * 一旦 Bot 服务/连接器不可用（2026-10-22 实测：minimax-bot 连接器不在线，
 * 09:40 那段没执行，brief-<日期>.md 根本没生成），
 * 那天就没有任何简报交付——而这条流水线每天都要给老板一份东西。
 *
 * 定位：**这不是替代判断层，而是"绝不断更"的兜底**。
 * - 判断层在（且已发布同一份）→ 什么都不做，不覆盖。
 * - 判断层在但没发布 → 补发判断层。
 * - 判断层不在 → 生成**确定性基线版**（全部数字来自采集数据、无模型推断）并发布，
 *   并在简报开头注明"本期为基线版：判断层未生成"，让读者一眼知道口径差异。
 *
 * 由 Windows 计划任务在 10:30 触发（给 09:40 那段留 50 分钟余量）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { latestDate } = require('../src/store');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');

function sha1OfFile(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

function main() {
  const date = latestDate();
  if (!date) { console.error('没有可用数据日期（先跑采集）'); process.exit(1); }

  const judged = path.join(OUT, `brief-${date}.md`);
  const baseline = path.join(OUT, `brief-baseline-${date}.md`);
  const marker = path.join(OUT, `.published-${date}.json`);

  const hasJudged = fs.existsSync(judged);
  const hasBaseline = fs.existsSync(baseline);
  let published = null;
  if (fs.existsSync(marker)) {
    try { published = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { published = null; }
  }

  // 情况一：判断层已存在，且发布标记与它一致 → 无需动作
  if (hasJudged && published && published.sha1 === sha1OfFile(judged) && published.source === 'judged') {
    console.log(`✓ ${date} 判断层简报已发布（${published.bytes}B @ ${published.at}），保底无需动作`);
    return;
  }

  if (hasJudged) {
    console.log(`• ${date} 判断层简报存在但未确认发布 → 补发判断层`);
  } else {
    console.log(`• ${date} 缺少判断层简报（Bot 阶段可能未执行）→ 保底发布`);
    if (!hasBaseline) {
      console.log('  生成确定性基线简报…');
      execFileSync(process.execPath, [path.join(__dirname, 'build_brief.cjs'), date], { encoding: 'utf8' });
    }
    // 基线版开头明确标注口径差异，避免被当成完整判断层
    if (fs.existsSync(baseline)) {
      const md = fs.readFileSync(baseline, 'utf8');
      if (!md.includes('基线版')) {
        const note = '> **本期为确定性基线版**：判断层简报（人工/模型判断部分）未生成，'
          + '本篇全部数字来自采集数据、无模型推断。判断层缺失通常意味着上游 Bot 调度未执行。\n\n';
        fs.writeFileSync(baseline, note + md, 'utf8');
        console.log('  已加注：本期为基线版（判断层未生成）');
      }
    }
  }

  // publish_brief 优先用判断层，没有则用基线
  const out = execFileSync(process.execPath, [path.join(__dirname, 'publish_brief.cjs')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(out);
  console.log('保底发布完成。');
}

main();
