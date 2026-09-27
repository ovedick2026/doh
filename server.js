import http from 'node:http';

const PORT = process.env.PORT || 10000;

// 上游 DoH 配置（并行竞速，取最快响应）
const UPSTREAMS = [
  { name: "cf", url: "https://cloudflare-dns.com/dns-query", timeout: 2500 },
  { name: "google", url: "https://dns.google/dns-query", timeout: 2500 }
];

const PINNED = {
  "linux.do": {
    A: ["104.20.16.234", "172.66.166.61"],
    AAAA: ["2606:4700:20::6812:10ea", "2606:4700:20::ac42:a63d"],
  },
  "connect.linux.do": {
    A: ["104.20.16.234", "172.66.166.61"],
    AAAA: ["2606:4700:20::6812:10ea", "2606:4700:20::ac42:a63d"],
  },
};

const PINNED_TTL = 120;
const MIN_TTL = 60;
const MAX_TTL = 86400;
const NEGATIVE_TTL = 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Accept",
  "Access-Control-Max-Age": "86400",
  "Timing-Allow-Origin": "*",
};

// 内存级语义化缓存字典
const memoryCache = new Map();

// ==================== 基础工具 ====================
function randId() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(t) {
  return Math.max(MIN_TTL, Math.min(Number(t || MIN_TTL), MAX_TTL));
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function typeNumToName(n) {
  switch (n) {
    case 1: return "A";
    case 28: return "AAAA";
    case 65: return "HTTPS";
    case 5: return "CNAME";
    case 15: return "MX";
    case 16: return "TXT";
    case 2: return "NS";
    default: return String(n || "");
  }
}

function typeNameToNum(t) {
  t = String(t || "A").toUpperCase();
  switch (t) {
    case "A": return 1;
    case "AAAA": return 28;
    case "HTTPS": return 65;
    case "CNAME": return 5;
    case "MX": return 15;
    case "TXT": return 16;
    case "NS": return 2;
    default: return 1;
  }
}

function concatBuf(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function b64e(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64d(s) {
  return Buffer.from(s, 'base64url');
}

// ==================== DNS Wire 解析 ====================
function parseWireQuery(buf) {
  try {
    const a = new Uint8Array(buf);
    const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
    if (a.length < 17) return null;

    const qd = v.getUint16(4);
    if (qd !== 1) return null;

    let o = 12;
    const labels = [];

    while (o < a.length) {
      const len = a[o];
      if (len === 0) {
        o += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) return null;
      if (o + 1 + len > a.length) return null;
      labels.push(new TextDecoder().decode(a.slice(o + 1, o + 1 + len)));
      o += 1 + len;
    }

    if (o + 4 > a.length) return null;

    const qtype = v.getUint16(o);
    const qclass = v.getUint16(o + 2);
    const rd = (a[2] & 0x01) === 0x01;

    return {
      name: labels.join(".").toLowerCase(),
      qtype,
      qclass,
      rd,
      questionEnd: o + 4,
    };
  } catch {
    return null;
  }
}

function extractTtl(buf) {
  try {
    const a = new Uint8Array(buf);
    const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const qd = v.getUint16(4), an = v.getUint16(6);
    let o = 12;

    for (let i = 0; i < qd; i++) {
      o = skipN(v, o);
      o += 4;
    }

    if (an === 0) return NEGATIVE_TTL;

    let min = 0xffffffff;
    for (let i = 0; i < an; i++) {
      o = skipN(v, o);
      const t = v.getUint32(o + 4);
      if (t < min) min = t;
      o += 10 + v.getUint16(o + 8);
    }

    return min === 0xffffffff ? MIN_TTL : min;
  } catch {
    return MIN_TTL;
  }
}

function skipN(v, o) {
  while (o < v.byteLength) {
    const l = v.getUint8(o);
    if (l === 0) return o + 1;
    if ((l & 0xc0) === 0xc0) return o + 2;
    o += 1 + l;
  }
  return o;
}

// ==================== Pinned 直返构造 ====================
function getPinnedAnswers(name, qtypeName) {
  const item = PINNED[name];
  if (!item) return null;
  const arr = item[qtypeName];
  return Array.isArray(arr) && arr.length ? arr : null;
}

function ipv6ToBytes(ip) {
  try {
    let left = [];
    let right = [];
    if (ip.includes("::")) {
      const parts = ip.split("::");
      left = parts[0] ? parts[0].split(":") : [];
      right = parts[1] ? parts[1].split(":") : [];
    } else {
      left = ip.split(":");
    }
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const full = [...left, ...Array(missing).fill("0"), ...right];
    if (full.length !== 8) return null;

    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      const n = parseInt(full[i] || "0", 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      view.setUint16(i * 2, n);
    }
    return out;
  } catch {
    return null;
  }
}

function buildPinnedWireResponse(queryBuf, parsed, answers, ttl = PINNED_TTL) {
  const query = new Uint8Array(queryBuf);
  const rrList = [];

  for (const ans of answers) {
    if (parsed.qtype === 1) {
      const parts = ans.split(".").map(Number);
      if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) continue;
      rrList.push(new Uint8Array([
        0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
        (ttl >>> 24) & 255, (ttl >>> 16) & 255, (ttl >>> 8) & 255, ttl & 255,
        0x00, 0x04,
        parts[0], parts[1], parts[2], parts[3],
      ]));
    } else if (parsed.qtype === 28) {
      const ip6 = ipv6ToBytes(ans);
      if (!ip6) continue;
      const head = new Uint8Array([
        0xc0, 0x0c, 0x00, 0x1c, 0x00, 0x01,
        (ttl >>> 24) & 255, (ttl >>> 16) & 255, (ttl >>> 8) & 255, ttl & 255,
        0x00, 0x10,
      ]);
      rrList.push(concatBuf([head, ip6]));
    }
  }

  if (!rrList.length) return null;

  const header = new Uint8Array([
    query[0], query[1],
    0x80 | (parsed.rd ? 0x01 : 0x00),
    0x80,
    0x00, 0x01,
    0x00, rrList.length,
    0x00, 0x00,
    0x00, 0x00,
  ]);

  const question = query.slice(12, parsed.questionEnd);
  return Buffer.from(concatBuf([header, question, ...rrList]).buffer);
}

function buildPinnedJson(name, type, answers, ttl = PINNED_TTL) {
  return JSON.stringify({
    Status: 0,
    TC: false,
    RD: true,
    RA: true,
    AD: false,
    CD: false,
    Question: [{ name: `${name}.`, type: typeNameToNum(type) }],
    Answer: answers.map(data => ({
      name: `${name}.`,
      type: typeNameToNum(type),
      TTL: ttl,
      data,
    })),
  });
}

// ==================== 上游竞速请求 ====================
async function fetchOneUpstream(u, queryBuf, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), u.timeout);

  try {
    const res = await fetch(u.url, {
      method: "POST",
      headers: {
        "Accept": accept,
        "Content-Type": "application/dns-message",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: queryBuf,
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`${u.name} status ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    return { buf: Buffer.from(arrayBuf), upstream: u.name };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamRacing(queryBuf) {
  const tasks = UPSTREAMS.map(u => fetchOneUpstream(u, queryBuf, "application/dns-message"));
  return await Promise.any(tasks);
}

// ==================== HTTP 服务入口 ====================
const server = http.createServer(async (req, res) => {
  // 处理 OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // 稳健提取路径和查询参数
  const [urlPath, queryString] = (req.url || '/').split('?');
  const searchParams = new URLSearchParams(queryString || '');
  const pathname = urlPath.replace(/\/+$/, '') || '/';

  // 1. 首页测试探针 UI
  if (pathname === '/' && !searchParams.has('dns') && !searchParams.has('name')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
    res.end(renderHomePage(`https://${req.headers.host}`));
    return;
  }

  // 2. 探针存活路由
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // 3. 严格放行 DoH 路径（兼容 /dns-query 和 / 带有 dns 查询参数）
  if (pathname !== '/dns-query' && pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end(`Not Found: ${pathname}`);
    return;
  }

  const trace = {
    id: randId(),
    start: performance.now(),
    method: req.method,
    path: pathname,
    source: "",
    cache: "",
    upstream: "",
  };

  try {
    // A. JSON 格式查询 (name & type)
    if (searchParams.has("name")) {
      const name = String(searchParams.get("name") || "").trim().toLowerCase();
      const type = String(searchParams.get("type") || "A").toUpperCase();

      if (type === "A" || type === "AAAA") {
        const answers = getPinnedAnswers(name, type);
        if (answers) {
          const body = buildPinnedJson(name, type, answers, PINNED_TTL);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "X-Source": "PINNED",
            "X-Cache": "PINNED",
            ...CORS_HEADERS
          });
          res.end(body);
          return;
        }
      }

      // JSON 转发给 Cloudflare DoH
      const fetchRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, {
        headers: { "Accept": "application/dns-json" }
      });
      const data = await fetchRes.text();

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Source": "UPSTREAM",
        "X-Upstream": "cf-json",
        ...CORS_HEADERS
      });
      res.end(data);
      return;
    }

    // B. 获取 Wire 二进制查询数据包
    let queryBuf = null;

    if (req.method === 'GET' && searchParams.has('dns')) {
      queryBuf = b64d(searchParams.get('dns'));
    } else if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      queryBuf = Buffer.concat(chunks);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: "Bad Request" }));
      return;
    }

    if (!queryBuf || queryBuf.length < 12) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end("Invalid DNS Packet");
      return;
    }

    const clientTxId = queryBuf.readUInt16BE(0);
    const parsed = parseWireQuery(queryBuf);

    // C. Pinned 域名命中（针对 linux.do 直返）
    if (parsed && (parsed.qtype === 1 || parsed.qtype === 28)) {
      const qtypeName = typeNumToName(parsed.qtype);
      const answers = getPinnedAnswers(parsed.name, qtypeName);
      if (answers) {
        const pinnedBuf = buildPinnedWireResponse(queryBuf, parsed, answers, PINNED_TTL);
        if (pinnedBuf) {
          res.writeHead(200, {
            "Content-Type": "application/dns-message",
            "X-Source": "PINNED",
            "X-Cache": "PINNED",
            "X-Upstream": "pinned",
            ...CORS_HEADERS
          });
          res.end(pinnedBuf);
          return;
        }
      }
    }

    // D. 语义化缓存查询 (Key: domain_type_class)
    const cacheKey = parsed ? `${parsed.name}_${parsed.qtype}_${parsed.qclass}` : null;
    const now = Date.now();

    if (cacheKey && memoryCache.has(cacheKey)) {
      const item = memoryCache.get(cacheKey);
      if (item.expireAt > now) {
        // 缓存命中：复写当前查询的事务 ID
        const returnBuf = Buffer.from(item.rawBuf);
        returnBuf.writeUInt16BE(clientTxId, 0);

        res.writeHead(200, {
          "Content-Type": "application/dns-message",
          "X-Source": "CACHE",
          "X-Cache": "HIT",
          "X-Upstream": item.upstream,
          "Cache-Control": `max-age=${Math.floor((item.expireAt - now) / 1000)}`,
          ...CORS_HEADERS
        });
        res.end(returnBuf);
        return;
      } else {
        memoryCache.delete(cacheKey);
      }
    }

    // E. 向上游发起多路并发竞速
    const { buf: responseBuf, upstream } = await fetchUpstreamRacing(queryBuf);

    // 计算 TTL 并写入缓存
    if (cacheKey) {
      const ttl = clamp(extractTtl(responseBuf));
      if (memoryCache.size > 5000) memoryCache.clear();
      memoryCache.set(cacheKey, {
        rawBuf: responseBuf,
        upstream: upstream,
        expireAt: now + (ttl * 1000)
      });
    }

    res.writeHead(200, {
      "Content-Type": "application/dns-message",
      "X-Source": "UPSTREAM",
      "X-Cache": "MISS",
      "X-Upstream": upstream,
      ...CORS_HEADERS
    });
    res.end(responseBuf);

  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: err.message, trace: trace.id }));
  }
});

server.listen(PORT, () => {
  console.log(`DoH Server is running on port ${PORT}`);
});

// ==================== 首页探针 HTML ====================
function renderHomePage(origin) {
  const ep = `${origin}/dns-query`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DoH Probe (Render)</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:20px}
.c{max-width:860px;margin:0 auto}
.card{background:#111827;border:1px solid #334155;border-radius:14px;padding:18px;margin-bottom:16px}
h1{font-size:28px;margin-bottom:8px}
h2{font-size:18px;margin-bottom:10px;color:#60a5fa}
.sub{color:#94a3b8;margin-bottom:10px}
.ep{background:#020617;border:1px solid #334155;border-radius:10px;padding:12px;font-family:monospace;word-break:break-all;cursor:pointer}
.row{display:flex;gap:8px;flex-wrap:wrap}
input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#020617;color:#fff}
button{cursor:pointer;background:#2563eb}
pre{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:10px;padding:12px;min-height:160px;margin-top:12px}
.small{font-size:13px;color:#94a3b8;line-height:1.7}
</style>
</head>
<body>
<div class="c">
  <div class="card">
    <h1>🔒 Render DoH Node</h1>
    <div class="sub">linux.do / connect.linux.do 的 A / AAAA 直返 | 多上游竞速 | 内存缓存</div>
    <h2>端点</h2>
    <div class="ep" id="ep">${ep}</div>
    <div class="small" style="margin-top:8px">点击复制端点 URL。</div>
  </div>

  <div class="card">
    <h2>在线测速</h2>
    <div class="row">
      <input id="dm" value="linux.do" placeholder="域名">
      <select id="qt">
        <option>A</option>
        <option>AAAA</option>
      </select>
      <button id="b1">测1次</button>
      <button id="b2">测2次 (测缓存)</button>
    </div>
    <pre id="out"></pre>
  </div>
</div>

<script>
const E='${ep}';
document.getElementById('ep').onclick=()=>navigator.clipboard.writeText(E);
async function doFetch(name,type){
  const url=E+'?name='+encodeURIComponent(name)+'&type='+encodeURIComponent(type)+'&_='+Date.now();
  const t0=performance.now();
  const resp=await fetch(url);
  const t1=performance.now();
  const txt=await resp.text();
  let j=null; try{j=JSON.parse(txt)}catch{}
  return {resp,j,total:t1-t0};
}
function render(tag,r){
  const {resp,j,total}=r;
  const out=['['+tag+']','HTTP: '+resp.status,'耗时: '+total.toFixed(1)+'ms',
  'X-Source: '+(resp.headers.get('X-Source')||'-'),
  'X-Cache: '+(resp.headers.get('X-Cache')||'-'),
  'X-Upstream: '+(resp.headers.get('X-Upstream')||'-')];
  if(j&&j.Answer){
    out.push('解析结果:');
    j.Answer.forEach(a=>out.push('  '+a.data+' (TTL: '+a.TTL+')'));
  }
  return out.join('\\n');
}
document.getElementById('b1').onclick=async()=>{
  const d=document.getElementById('dm').value.trim();
  const t=document.getElementById('qt').value;
  document.getElementById('out').textContent='查询中...';
  const r=await doFetch(d,t);
  document.getElementById('out').textContent=render('第1次',r);
};
document.getElementById('b2').onclick=async()=>{
  const d=document.getElementById('dm').value.trim();
  const t=document.getElementById('qt').value;
  document.getElementById('out').textContent='查询中...';
  const r1=await doFetch(d,t);
  const r2=await doFetch(d,t);
  document.getElementById('out').textContent=render('第1次',r1)+'\\n\\n'+render('第2次(命中缓存)',r2);
};
</script>
</body>
</html>`;
}
