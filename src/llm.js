'use strict';
/**
 * 大模型客户端（OpenAI 兼容 `chat/completions`）。
 *
 * **设计要点**
 * 1. **key 只在服务端**：配置从 `data/radar.env` 读，绝不下发到浏览器。
 * 2. **延迟读配置**：换 key / 停用模型不用重启服务（见 src/env.js 的说明）。
 * 3. **失败要能说清楚**：未配置 / 超时 / 4xx / 5xx 分别给不同的错误码，
 *    前端据此降级成"只出提示词"，而不是弹一个"出错了"。
 * 4. **URL 拼接要容错**：base 可能给到 `/v1`，也可能只给到域名。
 *    先试 `base + /chat/completions`，404 再试 `base + /v1/chat/completions`。
 */
const http = require('http');
const https = require('https');
const env = require('./env');

const DEFAULTS = {
  baseUrl: 'RADAR_LLM_BASE_URL',
  apiKey: 'RADAR_LLM_API_KEY',
  model: 'RADAR_LLM_MODEL',
  timeoutMs: 'RADAR_LLM_TIMEOUT_MS',
  temperature: 'RADAR_LLM_TEMPERATURE',
  maxTokens: 'RADAR_LLM_MAX_TOKENS',
  thinking: 'RADAR_LLM_THINKING',
};

function config() {
  const c = {
    baseUrl: String(env.get(DEFAULTS.baseUrl, '') || '').trim().replace(/\/+$/, ''),
    apiKey: String(env.get(DEFAULTS.apiKey, '') || '').trim(),
    model: String(env.get(DEFAULTS.model, '') || '').trim(),
    // **推理模型出文慢**：实测 2000 token 要 6~12 秒，
    // 放到 8000 token 可能要 40~60 秒。90 秒会在长回答上假报超时，
    // 所以默认放宽到 180 秒（可用 RADAR_LLM_TIMEOUT_MS 覆盖）。
    timeoutMs: Number(env.get(DEFAULTS.timeoutMs, 180000)) || 180000,
    temperature: Number(env.get(DEFAULTS.temperature, 0.2)),
    // **上限必须是够大的**（2026-10-27 实测）：
    // deepseek-flash 是**推理模型**，回答前要先烧 reasoning_tokens
    // （实测 306~1842 tokens 不等）。max_tokens=2000 时，
    // 推理把预算吃光 → 模型正文被截断，甚至返回**空内容**。
    // 实测日志里 completion_tokens 反复正好卡在 2000 —— 那不是"回答短"，是"被砍了"。
    // 8000 给足推理 + 正文的余量；仍不够时用 finish_reason=length 显式报错，
    // 而不是静悄悄交付半截答案。
    maxTokens: Number(env.get(DEFAULTS.maxTokens, 8000)) || 8000,
    // **是否开推理**（2026-10-27 实测探测出来的）。
    //
    // deepseek-flash 是推理模型，开着会先烧 reasoning_tokens 再写正文。
    // 实测（同一份材料）：开着 finish=stop 但 completion 242~330（其中推理 184~266）；
    // 传 `thinking:{type:'disabled'}` → **推理 0 字**，整个预算都留给正文。
    //
    // 为什么不默认开着：材料是**已经结构化好的**（编号证据 + 当日上下文），
    // 让模型自己再推一遍收益很小；而推理一旦变长，max_tokens 会被推理吃光，
    // 正文被砍成半截（finish_reason=length）—— **半截答案比没有答案危险得多**。
    //
    // 注意：`reasoning_effort:'low'` 和 `enable_thinking:false` 这两个写法
    // **实测都被接口忽略**（推理 token 不降），只有 `thinking` 字段有效。
    thinkingDisabled: String(env.get(DEFAULTS.thinking, 'off')).trim().toLowerCase() !== 'on',
  };
  return c;
}

/** 是否已配置（不暴露 key 内容） */
function status() {
  const c = config();
  return {
    configured: !!(c.baseUrl && c.apiKey && c.model),
    baseUrl: c.baseUrl || null,
    model: c.model || null,
    timeoutMs: c.timeoutMs,
    maxTokens: c.maxTokens,
    thinking: c.thinkingDisabled ? 'off' : 'on',
  };
}

function isConfigured() {
  return status().configured;
}

function request(urlStr, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(Object.assign(new Error('模型地址不合法：' + urlStr), { code: 'LLM_BAD_URL' })); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error(`模型调用超时（${timeoutMs}ms）`), { code: 'LLM_TIMEOUT' })); });
    req.on('error', (e) => reject(Object.assign(new Error('模型接口不可达：' + (e.code || e.message)), { code: 'LLM_NETWORK' })));
    req.write(payload);
    req.end();
  });
}

/**
 * **联网搜索工具声明**（2026-10-28 实测确定的写法）。
 *
 * DeepSeek 网关的规矩（实测三轮）：
 *   - `tools: [{type:'web_search'}]` → **422**（网关只接受 type=function）
 *   - `web_search: true` + 一个 **function 形式**的 web_search 工具 → 返回标准
 *     `tool_calls`（网关**不执行**搜索，把查询甩回客户端，由我们取回内容再喂回去）
 *   - 只传 `web_search: true` 不给 function 工具 → 模型把 <tool_call> 塞在正文里（能用但脏）
 *   - 网关只认 `deepseek-flash` / `deepseek-v4-pro` 两个模型，没有独立的搜索模型
 */
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网，返回相关网页的标题、网址与摘要。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
};

/**
 * 调用模型。
 *
 * **截断自愈**：推理模型（deepseek-flash）会先烧 reasoning_tokens 再写正文，
 * max_tokens 给小了正文被砍（finish_reason=length），给大了推理又吃满预算。
 * 所以这里做一次**自动重试**：上限翻倍 + 明确要求"直接给结论、别展开推理"。
 * 交付半截答案比报错危险得多 —— 半截答案看起来是完整的。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{webSearch?:boolean, tools?:Array, maxTokens?:number, temperature?:number, model?:string, noRetry?:boolean}} opts
 * @returns {Promise<{text:string, model:string, usage:object, toolCalls:Array, raw:object}>}
 */
async function chat(messages, opts = {}) {
  const c = config();
  if (!c.baseUrl || !c.apiKey || !c.model) {
    throw Object.assign(new Error('未配置模型：请在 data/radar.env 填 RADAR_LLM_BASE_URL / RADAR_LLM_API_KEY / RADAR_LLM_MODEL'), { code: 'LLM_NOT_CONFIGURED' });
  }
  const headers = { Authorization: `Bearer ${c.apiKey}` };
  const candidates = [c.baseUrl + '/chat/completions'];
  if (!/\/v\d+$/.test(c.baseUrl)) candidates.push(c.baseUrl + '/v1/chat/completions');

  /** 单次请求（候选 URL 依次回退） */
  async function attempt(body) {
    let lastErr = null;
    for (const url of candidates) {
      try {
        const r = await request(url, body, headers, c.timeoutMs);
        if (r.status === 404 && url === candidates[0]) { lastErr = Object.assign(new Error('模型地址 404（base_url 可能需要带 /v1）'), { code: 'LLM_404' }); continue; }
        let j = null;
        try { j = JSON.parse(r.text); } catch { /* 非 JSON */ }
        if (r.status < 200 || r.status >= 300) {
          const msg = (j && (j.error && (j.error.message || j.error)) || r.text || '').toString().slice(0, 300);
          throw Object.assign(new Error(`模型返回 ${r.status}：${msg}`), { code: 'LLM_HTTP_' + r.status, status: r.status });
        }
        const choice = j && j.choices && j.choices[0];
        const m = (choice && choice.message) || {};
        const text = m.content;
        const finish = choice && choice.finish_reason;
        // **工具调用**：模型要搜索时会把查询放进 tool_calls（网关不执行，要我们自己取）
        const toolCalls = (m.tool_calls || []).map((tc) => {
          let args = {};
          try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch { args = {}; }
          return { id: tc.id, name: (tc.function && tc.function.name) || '', query: String(args.query || args.q || '').trim() };
        }).filter((x) => x.query);
        // **截断必须显式报错**：finish_reason=length 意味着正文被 max_tokens 砍断，
        // 后面会少掉引用编号、少掉结论 —— 这种"半截答案"比报错危险得多，
        // 因为它看起来是完整的。
        if (finish === 'length') {
          throw Object.assign(
            new Error(`模型输出被 max_tokens(${body.max_tokens}) 截断，未写完（推理模型先用掉了一部分预算）。`),
            { code: 'LLM_TRUNCATED', finishReason: finish, usage: j.usage || null, maxTokens: body.max_tokens }
          );
        }
        if (!text && !toolCalls.length) {
          throw Object.assign(
            new Error(`模型返回里没有正文（finish_reason=${finish || '-'}，choices 为空）`),
            { code: 'LLM_EMPTY', finishReason: finish, usage: j.usage || null }
          );
        }
        return {
          text: String(text || ''), model: body.model, usage: j.usage || null,
          finishReason: finish || null, toolCalls, raw: j,
        };
      } catch (e) {
        lastErr = e;
        if (e.code === 'LLM_HTTP_404' || e.code === 'LLM_404') continue;
        throw e;
      }
    }
    throw lastErr || Object.assign(new Error('模型调用失败'), { code: 'LLM_FAILED' });
  }

  const baseBody = {
    model: opts.model || c.model,
    messages,
    temperature: opts.temperature != null ? opts.temperature : c.temperature,
    max_tokens: opts.maxTokens != null ? opts.maxTokens : c.maxTokens,
    stream: false,
  };
  // 关推理：接口只认 `thinking:{type:'disabled'}`（实测 reasoning_effort / enable_thinking 都被忽略）
  if (c.thinkingDisabled) baseBody.thinking = { type: 'disabled' };
  // 工具调用：必须同时给 **function 形式**的工具和 web_search:true（实测其它写法无效）
  if (opts.webSearch) {
    baseBody.tools = opts.tools || [WEB_SEARCH_TOOL];
    baseBody.web_search = true;
  } else if (opts.tools) {
    baseBody.tools = opts.tools;
  }

  try {
    return await attempt(baseBody);
  } catch (e) {
    if (e.code !== 'LLM_TRUNCATED' || opts.noRetry) throw e;
    // **截断了就自愈重试一次**：上限翻倍，并明确要求写短一点。
    const retryBody = {
      ...baseBody,
      max_tokens: Math.min(32000, Math.max(4000, baseBody.max_tokens) * 2),
      messages: [
        ...messages,
        {
          role: 'user',
          content: '⚠ 上一轮回答因为超出长度上限被截断了。请直接给出结论，**正文控制在 400 字以内**，'
            + '最多列 6 条依据，每条依据后面照常标 [E编号]。不要展开推理过程，不要复述材料原文。',
        },
      ],
    };
    const r = await attempt(retryBody);
    r.retriedAfterTruncation = true;
    r.firstAttemptUsage = e.usage || null;
    return r;
  }
}

module.exports = { chat, status, isConfigured, config };
