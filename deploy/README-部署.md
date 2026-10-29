# 云端部署说明（阿里云轻量应用服务器 / ECS）

> 部署对象：**科创板每日情报雷达**的 Web 看板（Node 服务 + 每日自动采集 + 实时问答 + 联网搜索）。
> 这不是静态站 —— 看板依赖 `/api/brief` `/api/range` `/api/ask` 等接口，所以必须有一台能跑 Node 的机器。

## 一、准备

| 项 | 说明 |
|---|---|
| 服务器 | 阿里云轻量应用服务器或 ECS，Linux（推荐 Ubuntu 22.04 / Alibaba Cloud Linux 3） |
| 规格建议 | 2 核 2G 起步（看板要读 57MB 数据集，内存峰值约 300–500MB）；3Mbps 带宽起步 |
| 端口 | 7788（看板）—— 安全组要放行 7788；若用 nginx 反代则放行 80/443 |
| 域名（可选） | 给了就自动配 nginx 反代 + 可选 certbot HTTPS |
| 备案 | **大陆地域的服务器对外提供网站必须 ICP 备案**；用香港/海外地域可免备案 |

## 二、部署（两条路，选一条）

### 路线 A：从本地传包（推荐）

本地执行：

```bash
# 1) 构建发布包（不含密钥）
node web/scripts/build_release.cjs
#    → web/out/radar-release-<日期>.tar.gz

# 2) 传到服务器
scp web/out/radar-release-<日期>.tar.gz root@<服务器IP>:/tmp/

# 3) 远程执行部署
ssh root@<服务器IP> 'cd /tmp && tar -xzf radar-release-*.tar.gz && cd radar-release-* && sudo bash deploy.sh'
```

### 路线 B：直接在服务器上拉代码

```bash
ssh root@<服务器IP>
# 把 radar-release 包 git clone 下来，或直接 scp 源码目录
cd radar-release-* && sudo bash deploy.sh
```

## 三、部署完必须做的一步：填密钥

```bash
ssh root@<服务器IP>
nano /etc/radar/radar.env      # 至少填 RADAR_LLM_API_KEY
systemctl restart radar
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `RADAR_LLM_API_KEY` | ✅ | 模型 key（DeepSeek 等）。**不填则问答页只返回提示词，不返回答案** |
| `RADAR_LLM_BASE_URL` / `RADAR_LLM_MODEL` | | 默认 `https://api.deepseek.com/v1` / `deepseek-flash` |
| `RADAR_SEARCH_PROVIDER` | | 默认 `duckduckgo`（**免 key**）；改成 `tavily/brave/serpapi` 需同时填 `RADAR_SEARCH_API_KEY` |
| `RADAR_LLM_THINKING` | | `off`（默认，推理模型关推理才不会被截断）/ `on` |
| `RADAR_ASK_DAILY_CAP` | | 全局问答日限，默认 300；`0` = 不限。**公网开放时建议保留** |
| `RADAR_WRITE_TOKEN` | | 写接口（采集）令牌，**非回环来源必须带 `X-Radar-Token`** |

> ⚠ **密钥只放这台机器**。发布包不含 `radar.env`；填好后别再把文件 scp 回本地。

## 四、部署后它自己会做什么

| 任务 | 计划 | 说明 |
|---|---|---|
| 看板服务 | 常驻（systemd，崩溃自动重启） | 监听 `0.0.0.0:7788` |
| 每日采集 | 每天 07:30 | `systemctl list-timers \| grep radar` 可查 |
| 健康自愈 | 每 15 分钟 | 探活失败就重启服务 |

**采集在云端能跑通吗？能。** 主口径全部走东方财富 HTTP（行情/F10/研报中心/公告/快讯），**不需要任何凭证**；
iFinD 补充口径在云端没有 `mcode-tools`，会自动降级并写进简报的"降级披露"里，**不影响主口径**。

## 五、验证

```bash
# 本机
curl -s http://127.0.0.1:7788/api/ping
# 公网（换成本机公网 IP）
curl -s http://<公网IP>:7788/api/status | head -c 400
# 问一个问题（会真的调模型）
curl -s -X POST http://<公网IP>:7788/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"今天科创板哪些公司涨得最多？"}' | head -c 600
```

## 六、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打开是空白 | 看 `journalctl -u radar -n 50`；多半是 `RADAR_LLM_API_KEY` 没填或 `data/` 软链坏了 |
| 问答返回"未配置模型" | `RADAR_LLM_API_KEY` 没填 → `systemctl restart radar` |
| 采集 0 家 | 云端 IP 被东财限流了 → 看 `$DATA_DIR/collect.err.log`；可把采集留在本地、每天推数据上去 |
| 页面很慢 | `/api/brief` 响应约 1.7MB，3M 带宽理论要 4~5 秒 → 升带宽，或把静态资源挪到 OSS+CDN |
| 端口不通 | 阿里云**安全组**要放行 7788（系统防火墙是另一层） |
| 想收回公开 | 改 `/etc/radar/radar.env` 的 `RADAR_HOST=127.0.0.1` 并重启，只留 nginx 反代并加鉴权 |

## 七、边界说明

- **Mini App（`kcb-intel`）不会跟着上云**：它是桌面端内嵌应用，运行时端口由宿主应用绑定在回环地址，
  局域网/公网都打不开。**云端跑的是网页版看板**，功能等价（含 CFO 问答）。
- **数据与采集都在云端**，本地机器与云端各自独立采集；两边数据会略有差异（采集时刻不同）。
