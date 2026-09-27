FROM alpine:latest

RUN apk add --no-cache curl ca-certificates bash

# 自动获取 GitHub 官方最新的 doh-server release
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  ASSET_ARCH="x86_64" ;; \
      aarch64) ASSET_ARCH="arm64" ;; \
      *) echo "Unsupported architecture" && exit 1 ;; \
    esac && \
    LATEST_TAG=$(curl -s https://api.github.com/repos/DNSCrypt/doh-server/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/') && \
    curl -L -o doh-server.tar.gz "https://github.com/DNSCrypt/doh-server/releases/download/${LATEST_TAG}/doh-server_${LATEST_TAG}_linux_${ASSET_ARCH}.tar.gz" && \
    tar -zxvf doh-server.tar.gz && \
    mv doh-server /usr/local/bin/doh-server && \
    chmod +x /usr/local/bin/doh-server && \
    rm -rf doh-server*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
