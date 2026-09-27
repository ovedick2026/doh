FROM alpine:latest

# 安装 curl, bash, openssl, caddy
RUN apk add --no-cache curl bash openssl caddy ca-certificates

# 自动拉取官方最新的 dnsproxy
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  ASSET_ARCH="amd64" ;; \
      aarch64) ASSET_ARCH="arm64" ;; \
      *) echo "Unsupported architecture" && exit 1 ;; \
    esac && \
    LATEST_TAG=$(curl -s https://api.github.com/repos/AdguardTeam/dnsproxy/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/') && \
    curl -L -o dnsproxy.tar.gz "https://github.com/AdguardTeam/dnsproxy/releases/download/${LATEST_TAG}/dnsproxy-linux-${ASSET_ARCH}-${LATEST_TAG}.tar.gz" && \
    tar -zxvf dnsproxy.tar.gz && \
    mv linux-${ASSET_ARCH}/dnsproxy /usr/local/bin/dnsproxy && \
    chmod +x /usr/local/bin/dnsproxy && \
    rm -rf dnsproxy.tar.gz linux-${ASSET_ARCH}

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
