FROM alpine:latest

# 安装 curl 和 ca-certificates 用于拉取和验证证书
RUN apk add --no-cache curl ca-certificates bash

# 自动获取 GitHub 官方最新的 dnsproxy release 二进制文件
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

# 复制启动脚本
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 暴露端口由环境变量动态传入（默认为 10000/3000）
ENTRYPOINT ["/entrypoint.sh"]
