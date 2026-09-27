#!/bin/bash

# 默认兜底 3000
LISTEN_PORT=${PORT:-3000}

echo "Starting dnsproxy on 0.0.0.0:${LISTEN_PORT}..."

# 参数说明：
# --https-port: 监听转发的端口
# --insecure-https: 因为边缘节点自带 SSL 证书并作为反向代理，容器内部直接监听 plain-HTTP DoH
# --all-servers: 并发竞速（同时向上游所有 DNS 发起请求，谁快取谁）
# --cache: 开启缓存
# --cache-min-ttl / --cache-max-ttl: 强制 TTL 范围（秒）
# --cache-optimistic: 乐观缓存（过期了也先返回旧缓存，后台默默刷新，速度最快）
# -u: 配置多个优质海外/亚太上游 DoH

exec /usr/local/bin/dnsproxy \
  -l 0.0.0.0 \
  --https-port=${LISTEN_PORT} \
  --insecure-https \
  --all-servers \
  --cache \
  --cache-size=10000 \
  --cache-min-ttl=30 \
  --cache-max-ttl=600 \
  --cache-optimistic \
  -u https://cloudflare-dns.com/dns-query \
  -u https://dns.google/dns-query \
  -u https://dns.quad9.net/dns-query \
  -u https://101.101.101.101/dns-query
