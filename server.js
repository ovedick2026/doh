import http from 'node:http';
import dnsPacket from 'dns-packet';

const PORT = process.env.PORT || 10000;

// 配置亚太优质多上游（并行竞速）
const UPSTREAMS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query'
];

// 短期内存缓存配置
const MIN_TTL = 30;
const MAX_TTL = 600;
const cache = new Map();

// 向单个上游发起请求
async function queryUpstream(upstreamUrl, queryBuf) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: queryBuf,
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Upstream ${upstreamUrl} returned status ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

// 向上游并发竞速
async function queryAllFastest(queryBuf) {
  const tasks = UPSTREAMS.map(url => queryUpstream(url, queryBuf));
  return await Promise.any(tasks);
}

const server = http.createServer(async (req, res) => {
  // 1. 更加健壮的路径提取逻辑（避免反代与 URL 对象解析异常）
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0].replace(/\/+$/, ''); // 去除尾部斜杠

  // 健康检查与探针路由（浏览器访问或 UptimeRobot 保活用）
  if (pathname === '' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DoH Proxy is Healthy!');
    return;
  }

  // 严格匹配 DoH 路径（兼容 /dns-query 与 /dns-query/）
  if (pathname !== '/dns-query') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not Found: ${pathname}`);
    return;
  }

  try {
    let queryBuf = null;

    // 支持 GET (base64url)
    if (req.method === 'GET') {
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const dnsParam = parsedUrl.searchParams.get('dns');
      if (!dnsParam) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing ?dns= parameter');
        return;
      }
      queryBuf = Buffer.from(dnsParam, 'base64url');
    }
    // 支持 POST (binary payload，dnslookup 默认采用此方式)
    else if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      queryBuf = Buffer.concat(chunks);
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (!queryBuf || queryBuf.length < 12) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid DNS Packet');
      return;
    }

    const clientTxId = queryBuf.readUInt16BE(0);
    const decoded = dnsPacket.decode(queryBuf);
    const question = decoded.questions && decoded.questions[0];

    // 缓存 Key 生成
    const cacheKey = question ? `${question.name.toLowerCase()}_${question.type}` : null;

    // 命中短期内存缓存
    if (cacheKey && cache.has(cacheKey)) {
      const item = cache.get(cacheKey);
      if (item.expireAt > Date.now()) {
        const clientBuf = Buffer.from(item.rawBuf);
        clientBuf.writeUInt16BE(clientTxId, 0); // 覆写客户端的事务 ID

        res.writeHead(200, {
          'Content-Type': 'application/dns-message',
          'Cache-Control': `max-age=${Math.floor((item.expireAt - Date.now()) / 1000)}`,
          'X-Cache': 'HIT'
        });
        res.end(clientBuf);
        return;
      } else {
        cache.delete(cacheKey);
      }
    }

    // 缓存未命中：向上游并发竞速
    const responseBuf = await queryAllFastest(queryBuf);

    // 解析结果并放入缓存
    if (cacheKey) {
      try {
        const decodedRes = dnsPacket.decode(responseBuf);
        const answers = decodedRes.answers || [];
        let ttl = MIN_TTL;
        if (answers.length > 0) {
          const minAnswerTtl = Math.min(...answers.map(a => a.ttl || 60));
          ttl = Math.max(MIN_TTL, Math.min(minAnswerTtl, MAX_TTL));
        }

        if (cache.size > 5000) cache.clear();

        cache.set(cacheKey, {
          rawBuf: responseBuf,
          expireAt: Date.now() + (ttl * 1000)
        });
      } catch (e) {}
    }

    res.writeHead(200, {
      'Content-Type': 'application/dns-message',
      'X-Cache': 'MISS'
    });
    res.end(responseBuf);

  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`DNS Proxy Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`DoH Proxy successfully started on port ${PORT}`);
});
