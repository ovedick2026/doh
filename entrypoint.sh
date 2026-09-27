#!/bin/bash

# 外部 HTTP 端口，默认为 10000
LISTEN_PORT=${PORT:-10000}
INTERNAL_DOH_PORT=10443

# 1. 生成内部专用的自签证书
CERT_DIR="/tmp/ssl"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/server.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -days 3650 -subj "/CN=127.0.0.1"
fi

# 2. 生成 Caddy 配置文件 (作为 HTTP -> HTTPS 反代并提供健康检查)
cat <<EOF > /tmp/Caddyfile
{
    admin off
    auto_https off
}

:$LISTEN_PORT {
    # 根路径与探针响应，健康检查与浏览器访问不会报错
    handle / {
        respond "DoH Proxy is Healthy and Running!" 200
    }
    handle /health {
        respond "OK" 200
    }

    # DoH 请求反代给内部 dnsproxy
    handle /dns-query* {
        reverse_proxy https://127.0.0.1:${INTERNAL_DOH_PORT} {
            transport http {
                tls_insecure_skip_verify
            }
        }
    }
}
EOF

# 3. 启动后台 dnsproxy（监听 127.0.0.1:10443）
/usr/local/bin/dnsproxy \
  -l 127.0.0.1 \
  -p 0 \
  --https-port=${INTERNAL_DOH_PORT} \
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
  -u https://101.101.101.101/dns-query &

# 4. 前台启动 Caddy 处理外部 HTTP 流量
exec caddy run --config /tmp/Caddyfile --adapter caddyfile
