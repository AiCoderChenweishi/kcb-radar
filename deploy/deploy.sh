#!/usr/bin/env bash
# ==============================================================================
#  科创板每日情报雷达 · 云端一键部署（Linux / 阿里云轻量应用服务器 或 ECS）
#
#  用法（在云端执行，或从本地 ssh 过去执行）：
#    bash deploy.sh
#
#  它做什么：
#    1. 检查/安装 Node.js 20
#    2. 建专用用户 radar（不以 root 跑服务）
#    3. 释放到 /opt/radar，同步数据目录
#    4. 建 systemd 服务（看板，端口 7788，监听 0.0.0.0）
#    5. 建 systemd timer（每天 07:30 自动采集）
#    6. 可选：nginx 反代 + 证书（给了域名才做）
#
#  密钥：**不进发布包**。本脚本会生成 /etc/radar/radar.env 模板并提示你填。
#        填好后重启服务生效（systemd 只在启动时读这个文件）。
#
#  ⚠ 采集依赖：主口径全部走东方财富 HTTP（无需凭证）；
#     iFinD 补充口径在云端没有 mcode-tools，会自动降级并写进 degraded 披露（不影响主口径）。
# ==============================================================================
set -euo pipefail

APP_DIR=/opt/radar
DATA_DIR=/var/lib/radar
ENV_DIR=/etc/radar
SERVICE=radar
NODE_MAJOR=20

log()  { echo -e "\033[1;36m[deploy]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn ]\033[0m $*"; }
die()  { echo -e "\033[1;31m[fail ]\033[0m $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo bash deploy.sh"

# ---------------------------------------------------------------- 1. Node
log "检查 Node.js…"
need_node() {
  command -v node >/dev/null 2>&1 || return 0        # 没有 → 需要装
  local v; v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  [ -n "$v" ] && [ "$v" -ge 18 ] && return 1          # 已有 ≥18 → 不用装
  return 0
}
install_node_official() {
  # **官方二进制包（发行版无关）**。
  # 为什么不用 apt/NodeSource：新发行版（如 Ubuntu 26.04）的 apt 源里 nodejs
  # 可能太老，而 NodeSource 的仓库未必有对应 codename —— 两者都会失败。
  # nodejs.org 的 tar.gz 对任何 glibc 发行版都通用。
  local arch; arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) warn "不认识的架构 $arch，跳过 Node 安装"; return 1 ;;
  esac
  local ver
  ver=$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null \
        | grep -o '"version":"v20\.[0-9.]*"' | head -1 | cut -d'"' -f4)
  [ -z "$ver" ] && ver=$(curl -fsSL --max-time 30 https://nodejs.org/dist/index.json 2>/dev/null \
        | grep -o '"version":"v2[2-9]\.[0-9.]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$ver" ]; then
    warn "拿不到 nodejs.org 版本列表，尝试 apt 源"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq nodejs >/dev/null || return 1
      return 0
    fi
    return 1
  fi
  log "安装官方 Node.js ${ver} (${NODE_ARCH})…"
  curl -fsSL --max-time 180 "https://nodejs.org/dist/${ver}/node-${ver}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.gz
  return 0
}

if need_node; then
  install_node_official || warn "Node 安装失败，继续尝试（后面会提示手工处理）"
fi
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -v)
  log "Node.js = $NODE_V"
  case "$NODE_V" in
    v1[0-7].*) die "Node 版本过旧（$NODE_V），需要 ≥18" ;;
  esac
else
  die "Node.js 没装上。请在服务器上手工安装 Node 20+ 后重跑本脚本"
fi

# ---------------------------------------------------------------- 2. 用户与目录
log "建用户与目录…"
id -u radar >/dev/null 2>&1 || useradd -r -m -d /home/radar -s /bin/bash radar
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"

# ---------------------------------------------------------------- 3. 释放代码
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log "释放代码：$SRC_DIR → $APP_DIR"
# 先清掉旧的（保留 data/ 和 .env）
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name '.env' -exec rm -rf {} + 2>/dev/null || true
cp -a "$SRC_DIR/." "$APP_DIR/"
mkdir -p "$APP_DIR/data"
[ -f "$APP_DIR/data/star_market_list.csv" ] || die "包里缺 data/star_market_list.csv（采集必需）"
chown -R radar:radar "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# 软链 data 目录到统一位置（采集与服务都写这里）
if [ ! -L "$APP_DIR/data" ]; then
  rm -rf "$APP_DIR/data"
  ln -s "$DATA_DIR" "$APP_DIR/data"
  chown -h radar:radar "$APP_DIR/data"
fi
# 名单/行业映射放进数据目录（如果包里带了）
for f in star_market_list.csv industries.json; do
  if [ -f "$SRC_DIR/data/$f" ] && [ ! -f "$DATA_DIR/$f" ]; then
    cp "$SRC_DIR/data/$f" "$DATA_DIR/$f"
    chown radar:radar "$DATA_DIR/$f"
  fi
done

# ---------------------------------------------------------------- 4. 密钥
ENV_FILE="$ENV_DIR/radar.env"
if [ ! -f "$ENV_FILE" ]; then
  log "生成密钥模板：$ENV_FILE"
  cat > "$ENV_FILE" <<'EOF'
# 科创板雷达 · 云端配置（真实值只留在这台机器，别回传）
RADAR_HOST=0.0.0.0
PORT=7788
RADAR_WRITE_TOKEN=
RADAR_LLM_BASE_URL=https://api.deepseek.com/v1
RADAR_LLM_API_KEY=
RADAR_LLM_MODEL=deepseek-flash
RADAR_LLM_TIMEOUT_MS=180000
RADAR_LLM_TEMPERATURE=0.2
RADAR_LLM_MAX_TOKENS=8000
RADAR_LLM_THINKING=off
RADAR_SEARCH_PROVIDER=duckduckgo
RADAR_SEARCH_API_KEY=
RADAR_SEARCH_MODE=auto
RADAR_SEARCH_MAX_RESULTS=6
RADAR_ASK_RPM=8
RADAR_ASK_SEARCH_RPM=3
RADAR_ASK_DAILY_CAP=300
EOF
  chmod 600 "$ENV_FILE"
  chown radar:radar "$ENV_FILE"
  warn "已生成 $ENV_FILE —— 请填 RADAR_LLM_API_KEY（必填）与 RADAR_SEARCH_API_KEY（可留空）后重启服务"
fi

# ---------------------------------------------------------------- 5. systemd：看板
log "配置 systemd 服务…"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=科创板每日情报雷达 · Web 看板
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=radar
Group=radar
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node src/server.js
Restart=always
RestartSec=5
StandardOutput=append:$DATA_DIR/server.log
StandardError=append:$DATA_DIR/server.err.log
# 看板要读 57MB 数据集，给足内存
Environment=NODE_OPTIONS=--max-old-space-size=1024

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null 2>&1 || true
systemctl restart ${SERVICE}
sleep 3
if systemctl is-active --quiet ${SERVICE}; then
  log "看板服务已启动（systemd）"
else
  warn "服务没起来，看日志：journalctl -u ${SERVICE} -n 50 --no-pager"
fi

# ---------------------------------------------------------------- 6. systemd timer：每日采集
log "配置每日采集定时器（07:30）…"
cat > /etc/systemd/system/${SERVICE}-collect.service <<EOF
[Unit]
Description=科创板每日情报雷达 · 每日采集
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=radar
Group=radar
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node scripts/run_collect.cjs
StandardOutput=append:$DATA_DIR/collect.log
StandardError=append:$DATA_DIR/collect.err.log
EOF
cat > /etc/systemd/system/${SERVICE}-collect.timer <<EOF
[Unit]
Description=科创板每日情报雷达 · 每日采集定时器

[Timer]
OnCalendar=*-*-* 07:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE}-collect.timer >/dev/null 2>&1 || true
systemctl start ${SERVICE}-collect.timer
log "定时器已启用：systemctl list-timers | grep radar"

# ---------------------------------------------------------------- 7. 健康自愈（可选但建议）
log "配置健康自愈（每 15 分钟探活，异常则重启）…"
cat > /etc/systemd/system/${SERVICE}-health.service <<EOF
[Unit]
Description=科创板每日情报雷达 · 健康探活
After=network.target

[Service]
Type=oneshot
User=radar
Group=radar
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node scripts/healthcheck.cjs --repair
EOF
cat > /etc/systemd/system/${SERVICE}-health.timer <<EOF
[Unit]
Description=科创板每日情报雷达 · 健康探活定时器

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable ${SERVICE}-health.timer >/dev/null 2>&1 || true
systemctl start ${SERVICE}-health.timer

# ---------------------------------------------------------------- 8. nginx（可选）
if [ -n "${RADAR_DOMAIN:-}" ]; then
  log "配置 nginx 反代：$RADAR_DOMAIN"
  command -v apt-get >/dev/null 2>&1 && { apt-get update -qq; apt-get install -y -qq nginx >/dev/null; }
  cat > /etc/nginx/sites-available/radar <<EOF
server {
    listen 80;
    server_name $RADAR_DOMAIN;
    client_max_body_size 4m;
    location / {
        proxy_pass http://127.0.0.1:7788;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 180s;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/radar /etc/nginx/sites-enabled/radar
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  log "已配好 http 反代；需要 HTTPS 就再跑：certbot --nginx -d $RADAR_DOMAIN"
else
  log "未给域名（RADAR_DOMAIN），跳过 nginx；直接用 http://<公网IP>:7788 访问"
  warn "若要 HTTPS/域名：重跑时带 RADAR_DOMAIN=你的域名 bash deploy.sh"
fi

# ---------------------------------------------------------------- 9. 收尾
IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
log "=============================================="
log " 部署完成"
log "   看板地址（公网）：http://${IP:-<本机IP>}:7788"
log "   本机自测：      http://127.0.0.1:7788/api/ping"
log "   配置密钥：      $ENV_FILE"
log "   数据目录：      $DATA_DIR"
log "   服务日志：      journalctl -u ${SERVICE} -f / tail -f $DATA_DIR/server.log"
log "   采集定时器：    systemctl list-timers | grep radar"
log "=============================================="
warn "下一步：填 $ENV_FILE 里的 RADAR_LLM_API_KEY，然后 systemctl restart ${SERVICE}"
