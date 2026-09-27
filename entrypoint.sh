#!/bin/bash

LISTEN_PORT=${PORT:-10000}

# 1. 生成本地自签名证书（让 dnsproxy 能够启动 HTTPS 监听）
CERT_DIR="/tmp/ssl"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  echo "Generating self-signed certificate for internal HTTPS listener..."
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" -days 3650 -subj "/CN=localhost"
fi

echo "Starting dnsproxy on port ${LISTEN_PORT}..."

# 2. 启动 dnsproxy（适配最新命令行参数）
# -p 0: 禁用 53 端口的监听
# --https-port: 监听 Render 分配的端口
# --upstream-mode=parallel: 并发向上游所有 DNS 发起请求，取最快响应
# --cache-optimistic: 开启乐观缓存
exec /usr/local/bin/dnsproxy \
  -l 0.0.0.0 \
  -p 0 \
  --https-port=${LISTEN_PORT} \
  --tls-crt="$CERT_DIR/server.crt" \
  --tls-key="$CERT_DIR/server.key" \
  --upstream-mode=parallel \
  --cache \
  --cache-size=10485760 \
  --cache-min-ttl=30 \
  --cache-max-ttl=600 \
  --cache-optimistic \
  -u https://cloudflare-dns.com/dns-query \
  -u https://dns.google/dns-query \
  -u https://dns.quad9.net/dns-query \
  -u https://101.101.101.101/dns-query
