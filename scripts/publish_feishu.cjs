'use strict';
/**
 * 把项目文档发布到飞书「信息台」知识库。
 *
 * 落点铁律：必须落在 space_id=7696033754174737382（信息台），
 * `docs +create` 不带 wiki 参数会落到个人云盘根目录，那不算完成。
 * 落错位置要 `wiki +move` 迁回，迁移后 URL 变成 /wiki/<node_token>，旧 /docx/ 链接作废。
 *
 * 幂等：若知识库里已存在同名节点则复用，不重复建档。
 */
const fs = require('fs');
const path = require('path');
const { run, parseJson } = require('./lark.cjs');
const { sanitizeTildes, checkStrike } = require('./md_guard');

const SPACE_ID = '7696033754174737382';
const ROOT = path.join(__dirname, '..');

function fail(msg, r) {
  console.error(`✗ ${msg}`);
  if (r) {
    if (r.stdout) console.error('  stdout:', r.stdout.slice(0, 800));
    if (r.stderr) console.error('  stderr:', r.stderr.slice(0, 800));
  }
  process.exit(1);
}

function main() {
  const mdPath = process.argv[2] || path.join(ROOT, 'docs', 'PROJECT.md');
  const markdown = fs.readFileSync(mdPath, 'utf8');
  // 标题取 Markdown 的 H1（overwrite 会把文档标题重置成 H1，两者必须逐字一致）
  const h1 = (markdown.match(/^#\s+(.+)$/m) || [])[1];
  if (!h1) fail('Markdown 缺少 H1 标题');
  const title = h1.trim();
  console.log(`标题：${title}`);

  // 1) 查是否已存在同名节点
  const listRes = run(['wiki', '+node-list', '--space-id', SPACE_ID], { timeoutMs: 90000 });
  if (listRes.code !== 0) fail('wiki +node-list 失败', listRes);
  const listJson = parseJson(listRes.stdout);
  const nodes = (listJson && (listJson.data?.items || listJson.data?.nodes || listJson.items)) || [];
  const exists = (Array.isArray(nodes) ? nodes : []).find((n) => (n.title || '') === title);
  if (exists) {
    console.log(`发现同名节点，复用：${exists.node_token || exists.nodeToken}`);
  }

  let nodeToken, objToken, url;

  if (exists) {
    nodeToken = exists.node_token || exists.nodeToken;
    objToken = exists.obj_token || exists.objToken || nodeToken;
    url = exists.url;
  } else {
    // 2) 直接在知识库建节点（一步到位，优于"建云盘再搬"）
    const createRes = run([
      'wiki', '+node-create',
      '--space-id', SPACE_ID,
      '--obj-type', 'docx',
      '--title', title,
    ], { timeoutMs: 120000 });
    if (createRes.code !== 0) fail('wiki +node-create 失败', createRes);
    const cj = parseJson(createRes.stdout);
    const node = cj && (cj.data || cj);
    nodeToken = node && (node.node_token || node.nodeToken);
    objToken = node && (node.obj_token || node.objToken);
    url = node && node.url;
    if (!nodeToken || !objToken) {
      fail(`建档返回缺少 node_token/obj_token：${createRes.stdout.slice(0, 500)}`);
    }
    console.log(`已创建节点 node_token=${nodeToken} obj_token=${objToken}`);
  }

  // 3) 灌正文：--content - 走 stdin 管道（--content '@文件路径' 在工作区里读不到）
  // 防线一：发稿前把作为区间连接符的 ASCII `~` 换成 en dash（飞书会把成对 `~` 当删除线）
  const clean = sanitizeTildes(markdown);
  if (clean.replaced) {
    console.log(`⚠ 正文含 ${clean.replaced} 处 ASCII "~"（飞书会当删除线），已换成 en dash「–」`);
  }

  const upd = run([
    'docs', '+update',
    '--command', 'overwrite',
    '--doc', objToken,
    '--doc-format', 'markdown',
    '--content', '-',
  ], { timeoutMs: 180000, stdin: clean.text });
  if (upd.code !== 0) fail('docs +update 失败', upd);
  console.log('正文已写入');

  // 4) 落点校验
  const verifyList = run(['wiki', '+node-list', '--space-id', SPACE_ID], { timeoutMs: 90000 });
  const vj = parseJson(verifyList.stdout);
  const vnodes = (vj && (vj.data?.items || vj.data?.nodes || vj.items)) || [];
  const hit = (Array.isArray(vnodes) ? vnodes : []).find((n) => (n.node_token || n.nodeToken) === nodeToken);
  if (!hit) fail('落点校验失败：知识库列表中找不到该节点');
  console.log(`✓ 落点校验通过（信息台 space_id=${SPACE_ID}）`);

  // 5) 内容校验
  const fetchRes = run(['docs', '+fetch', '--doc', objToken], { timeoutMs: 120000 });
  const fj = parseJson(fetchRes.stdout);
  const body = JSON.stringify(fj || {});
  const keyWords = ['科创板', '券商', '估值', '串台', '信息台'];
  const missing = keyWords.filter((k) => !body.includes(k));
  if (missing.length) {
    console.warn(`⚠ 内容校验：以下关键词未在返回体中命中 ${JSON.stringify(missing)}`);
  } else {
    console.log('✓ 内容校验通过（关键段落均已写入）');
  }

  // 防线二：发稿后回读，确认没有被误转成删除线的内容
  const strike = checkStrike(fj);
  if (strike.count > 0) {
    console.error(`✗ 飞书端出现 ${strike.count} 处 <del>（正文被误显示为删除线），发布不可信：`);
    for (const s of strike.samples) console.error('   ' + s);
    process.exit(2);
  }
  console.log('✓ 删除线检查通过（<del> 0 处）');

  const finalUrl = url || `https://feishu.cn/wiki/${nodeToken}`;
  console.log('\n=== 发布完成 ===');
  console.log('标题:', title);
  console.log('URL :', finalUrl);
  console.log('空间: 信息台 (space_id=' + SPACE_ID + ')');
}

main();
