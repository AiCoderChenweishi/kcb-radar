'use strict';
/**
 * 科创板全量名单。
 *
 * iFinD 的 search_securities 命中 619 家时，接口只回显前 100 行，
 * 完整清单放在 answer 里的 CSV 下载链接（有效期 24 小时），
 * 因此每次采集都要重新拉一次链接并下载。
 */
const fs = require('fs');
const path = require('path');
const https = require('http');
const { callTool } = require('./connector');
const { LIST_FILE } = require('./config');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(url, { timeout: 90000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(dest, Buffer.concat(chunks));
        resolve(dest);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
  });
}

function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [code, name, board] = line.split(',');
    if (!code || !name) continue;
    rows.push({ code: code.trim(), name: name.trim(), board: (board || '').trim() });
  }
  return rows;
}

/** 从 search_securities 的 answer 里抠出 CSV 下载链接 */
function extractCsvLink(answer) {
  const m = /(https?:\/\/[^\s)]+\.csv)/.exec(String(answer || ''));
  return m ? m[1] : null;
}

/** 读本地缓存的名单 */
function loadCached() {
  if (!fs.existsSync(LIST_FILE)) return [];
  try {
    return parseCsv(fs.readFileSync(LIST_FILE, 'utf8'));
  } catch { return []; }
}

/**
 * 刷新名单：优先走接口 + CSV 下载；失败则回落到本地缓存。
 * @returns {Promise<{list: Array, source: string, total: number, note?: string}>}
 */
async function refreshUniverse() {
  try {
    const data = await callTool('connector__thsifind__search_securities', {
      market: '股票',
      query: '科创板股票',
    });
    const answer = data && data.answer ? data.answer : '';
    const link = extractCsvLink(answer);
    const total = (data && data.selectedSecuritiesCount) || null;

    if (link) {
      const tmp = path.join(path.dirname(LIST_FILE), `list_${Date.now()}.csv`);
      await download(link, tmp);
      const list = parseCsv(fs.readFileSync(tmp, 'utf8'));
      fs.unlinkSync(tmp);
      if (list.length > 100) {
        fs.writeFileSync(LIST_FILE, `股票代码,股票简称,上市板块\n` +
          list.map((r) => `${r.code},${r.name},${r.board || '科创板'}`).join('\n') + '\n', 'utf8');
        return { list, source: 'ifind-csv', total: total || list.length };
      }
    }
    // 没给链接就退回解析 markdown 前 N 行
    const list = parseCsv(String(answer).replace(/^\|/gm, '').replace(/\|/g, ','));
    if (list.length) return { list, source: 'ifind-md-partial', total: total || list.length };

    throw new Error('接口未返回可用名单');
  } catch (e) {
    const cached = loadCached();
    if (cached.length) return { list: cached, source: 'cache', total: cached.length, note: e.message };
    throw e;
  }
}

module.exports = { refreshUniverse, loadCached, parseCsv, extractCsvLink };
