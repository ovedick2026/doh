#!/bin/bash

LISTEN_PORT=${PORT:-10000}

cat <<EOF > /tmp/doh-server.conf
# 监听分配的 HTTP 端口（无需 TLS，由边缘反代提供 TLS）
listen_addresses = ["0.0.0.0:${LISTEN_PORT}"]

# DoH 路径
path = "/dns-query"

# 上游 DNS 列表（可配置多个，内置智能轮询和故障转移）
# 包含 Cloudflare, Google, Quad9, TWNIC
upstream = [
  "1.1.1.1:53",
  "1.0.0.1:53",
  "8.8.8.8:53",
  "9.9.9.9:53",
  "101.101.101.101:53"
]

# 短期内存缓存配置
cache_size = 10000
cache_min_ttl = 30
cache_max_ttl = 600
cache_neg_min_ttl = 10
cache_neg_max_ttl = 60

# 超时设置
timeout = 5
EOF

echo "Starting doh-server on port ${LISTEN_PORT}..."
exec /usr/local/bin/doh-server -conf /tmp/doh-server.conf
