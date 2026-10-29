'use strict';
/**
 * 把每日简报发布到飞书「信息台」知识库。
 *
 * 用法：
 *   node scripts/publish_brief.cjs                # 发布当天简报（用 build_brief 生成的基线版）
 *   node scripts/publish_brief.cjs <md文件>        # 发布指定 Markdown（Bot 写的判断层版本）
 *
 * 落点铁律：必须落在 space_id=7696033754174737382（信息台）。
 * 每日一篇独立文档，标题含日期，历史可回溯。
 */
const fs = require('fs');
const path = require('path');
const { run, parseJson } = require('./lark.cjs');
const { latestDate } = require('../src/store');
const { sanitizeTildes, checkStrike } = require('./md_guard');

const SPACE_ID = '7696033754174737382';
const ROOT = path.join(__dirname, '..');

function fail(msg, r) {
  console.error(`✗ ${msg}`);
  if (r) {
    if (r.stdout) console.error('  stdout:', r.stdout.slice(0, 600));
    if (r.stderr) console.error('  stderr:', r.stderr.slice(0, 600));
  }
  process.exit(1);
}

/**
 * 从 Markdown 里取 H1 作为标题。
 * **必须先剥 BOM**：带 BOM 的文件会让 /^#/ 匹配失败，
 * 结果静默回落到默认标题（"科创板每日简报 · <今天>"），
 * 于是找错节点、覆盖到别的日期的文档上。
 */
function titleOf(markdown, fallback) {
  const clean = String(markdown || '').replace(/^\uFEFF/, '');
  const m = clean.match(/^#\s+(.+)$/m);
  const t = m ? m[1].trim() : '';
  if (!t) return fallback;
  return t.replace(/^\uFEFF/, '').trim();
}

function listNodes() {
  const r = run(['wiki', '+node-list', '--space-id', SPACE_ID], { timeoutMs: 90000 });
  if (r.code !== 0) fail('wiki +node-list 失败', r);
  const j = parseJson(r.stdout);
  const nodes = (j && (j.data?.items || j.data?.nodes || j.items)) || [];
  return Array.isArray(nodes) ? nodes : [];
}

function main() {
  const arg = process.argv[2];
  const date = latestDate();
  if (!date) fail('没有可用数据日期，请先执行采集');

  let mdPath = arg;
  if (!mdPath) {
    // 优先发判断层简报（Bot 写的），没有才回落到基线版
    const judged = path.join(ROOT, 'out', `brief-${date}.md`);
    const baseline = path.join(ROOT, 'out', `brief-baseline-${date}.md`);
    if (fs.existsSync(judged)) mdPath = judged;
    else if (fs.existsSync(baseline)) {
      mdPath = baseline;
      console.log('（未找到判断层简报，改发基线版）');
    } else {
      // **必须用子进程调用**：`build_brief.cjs` 里有 `if (require.main === module) main()`，
      // 直接 require 不会执行 main()，基线简报根本不会生成 ——
      // 结果"两条简报都没有"时保底发布必然失败（2026-10-22 实测踩到）。
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, [path.join(__dirname, 'build_brief.cjs'), date], { encoding: 'utf8' });
      mdPath = baseline;
      console.log('（判断层简报缺失，已生成确定性基线版保底）');
    }
  }
  if (!fs.existsSync(mdPath)) fail(`简报文件不存在：${mdPath}`);
  const markdown = fs.readFileSync(mdPath, 'utf8');
  // 标题里的日期优先用文件名里的日期（归档的锚点），
  // H1 里的日期可能被改写，两者不一致时以文件名为准并给出提示。
  const fileDate = (mdPath.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  const h1 = titleOf(markdown, '');
  const h1Date = (h1.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  let title = h1 || `科创板每日简报 · ${date}`;
  if (fileDate && h1Date && fileDate !== h1Date) {
    title = `科创板每日简报 · ${fileDate}`;
    console.log(`⚠ H1 日期(${h1Date})与文件名日期(${fileDate})不一致，按文件名归档`);
  }
  console.log(`标题：${title}`);

  // 幂等：同日同名则复用
  const nodes = listNodes();
  const exists = nodes.find((n) => (n.title || '') === title);
  let nodeToken, objToken, url;

  if (exists) {
    nodeToken = exists.node_token || exists.nodeToken;
    objToken = exists.obj_token || exists.objToken || nodeToken;
    url = exists.url;
    console.log(`复用已有节点：${nodeToken}`);
  } else {
    const r = run(['wiki', '+node-create', '--space-id', SPACE_ID, '--obj-type', 'docx', '--title', title],
      { timeoutMs: 120000 });
    if (r.code !== 0) fail('wiki +node-create 失败', r);
    const j = parseJson(r.stdout);
    const node = (j && (j.data || j)) || {};
    nodeToken = node.node_token || node.nodeToken;
    objToken = node.obj_token || node.objToken;
    url = node.url;
    if (!nodeToken || !objToken) fail('建档返回缺少 node_token/obj_token', r);
    console.log(`已创建节点：${nodeToken}`);
  }

  // 防线一：发稿前把作为区间连接符的 ASCII `~` 换成 en dash，
  // 否则飞书会把成对的 `~` 当删除线，把正文显示成划掉的（CLI 不会报错）。
  const clean = sanitizeTildes(markdown);
  if (clean.replaced) {
    console.log(`⚠ 正文含 ${clean.replaced} 处 ASCII "~"（飞书会当删除线），已换成 en dash「–」：`);
    for (const s of clean.samples) console.log(`   ${s}`);
  }

  const upd = run(['docs', '+update', '--command', 'overwrite', '--doc', objToken,
    '--doc-format', 'markdown', '--content', '-'], { timeoutMs: 180000, stdin: clean.text });
  if (upd.code !== 0) fail('docs +update 失败', upd);

  const after = listNodes();
  if (!after.find((n) => (n.node_token || n.nodeToken) === nodeToken)) {
    fail('落点校验失败：节点不在信息台知识库中');
  }
  console.log('✓ 落点校验通过（信息台）');

  // 防线二：发稿后回读，确认没有被误转成删除线的内容
  const chk = run(['docs', '+fetch', '--doc', objToken], { timeoutMs: 180000 });
  if (chk.code === 0) {
    const st = checkStrike(chk.stdout);
    if (st.count > 0) {
      console.error(`✗ 飞书端出现 ${st.count} 处 <del>（正文被误显示为删除线），发布不可信：`);
      for (const s of st.samples) console.error('   ' + s);
      process.exit(2);
    }
    console.log('✓ 删除线检查通过（<del> 0 处）');
  } else {
    console.warn('⚠ 回读校验失败（未能确认 <del> 数量）');
  }

  // 发布标记：记录"今天发的是哪一份、哈希是多少"，
  // 供 scripts/fallback_publish.cjs 判断是否需要保底动作
  try {
    const crypto = require('crypto');
    const md = fs.readFileSync(mdPath, 'utf8');
    fs.writeFileSync(path.join(ROOT, 'out', `.published-${date}.json`), JSON.stringify({
      date,
      source: path.basename(mdPath).startsWith('brief-baseline') ? 'baseline' : 'judged',
      bytes: Buffer.byteLength(md),
      sha1: crypto.createHash('sha1').update(md, 'utf8').digest('hex'),
      at: new Date().toISOString(),
      node: nodeToken,
      url: url || `https://feishu.cn/wiki/${nodeToken}`,
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn('⚠ 发布标记写入失败：' + e.message);
  }

  console.log('URL :', url || `https://feishu.cn/wiki/${nodeToken}`);
}

main();
