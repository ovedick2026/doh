import http from 'node:http';
import dnsPacket from 'dns-packet';

const PORT = process.env.PORT || 10000;

// 配置亚太优质多上游（并行竞速：谁快取谁）
const UPSTREAMS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.quad9.net/dns-query',
  'https://101.101.101.101/dns-query' // TWNIC Quad101 (亚太台湾节点，低延迟)
];

// 短期内存缓存配置
const MIN_TTL = 30;   // 最小缓存 30 秒
const MAX_TTL = 600;  // 最大缓存 10 分钟
const cache = new Map(); // 内存缓存

// 单个上游请求
async function queryUpstream(upstreamUrl, queryBuf) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500); // 3.5秒超时

  try {
    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message',
      },
      body: queryBuf,
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Upstream returned ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

// 向上游并发查询竞速
async function queryAllFastest(queryBuf) {
  const tasks = UPSTREAMS.map(url => queryUpstream(url, queryBuf));
  return await Promise.any(tasks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. 探针与保活（彻底解决 Render 和 UptimeRobot 的报错）
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // 2. 拦截 /dns-query
  if (url.pathname !== '/dns-query') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  try {
    let queryBuf = null;

    // 支持 DoH GET (RFC 8484)
    if (req.method === 'GET') {
      const dnsParam = url.searchParams.get('dns');
      if (!dnsParam) {
        res.writeHead(400);
        res.end('Missing dns parameter');
        return;
      }
      queryBuf = Buffer.from(dnsParam, 'base64url');
    }
    // 支持 DoH POST (RFC 8484)
    else if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      queryBuf = Buffer.concat(chunks);
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    if (!queryBuf || queryBuf.length < 12) {
      res.writeHead(400);
      res.end('Invalid DNS Packet');
      return;
    }

    const clientTxId = queryBuf.readUInt16BE(0);
    const decoded = dnsPacket.decode(queryBuf);
    const question = decoded.questions && decoded.questions[0];

    // 缓存 Key: 域名_查询类型
    const cacheKey = question ? `${question.name.toLowerCase()}_${question.type}` : null;

    // 命中缓存直接返回（1ms 极速响应）
    if (cacheKey && cache.has(cacheKey)) {
      const item = cache.get(cacheKey);
      if (item.expireAt > Date.now()) {
        const clientBuf = Buffer.from(item.rawBuf);
        clientBuf.writeUInt16BE(clientTxId, 0); // 替换客户端事务 ID

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

    // 未命中缓存：并发竞速查询最快上游
    const responseBuf = await queryAllFastest(queryBuf);

    // 计算 TTL 并写入缓存
    if (cacheKey) {
      try {
        const decodedRes = dnsPacket.decode(responseBuf);
        const answers = decodedRes.answers || [];
        let ttl = MIN_TTL;
        if (answers.length > 0) {
          const minAnswerTtl = Math.min(...answers.map(a => a.ttl || 60));
          ttl = Math.max(MIN_TTL, Math.min(minAnswerTtl, MAX_TTL));
        }

        // 控制缓存上限
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
    res.writeHead(502);
    res.end(`DNS Proxy Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`DoH Proxy successfully started on port ${PORT}`);
});
