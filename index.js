import { CF_ENGINE } from "./vendor/cloudflare-engine.js";
import { CLIENT } from "./client.js";
import { voipResponse } from "./voip.js";
const SESSION_SECRET = "f9d2e7b437ec4d63a8e142769df03cb7735cc8e268d84a3d906516d6264ae117";
const SESSION_SECONDS = 90;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function signature(value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

async function createToken(request) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const nonce = crypto.randomUUID();
  const payload = `${expires}.${nonce}`;
  const signed = await signature(`${clientIp(request)}.${payload}`);
  return `${payload}.${base64Url(signed)}`;
}

async function tokenIsValid(request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const [expiresText, nonce, suppliedSignature] = token.split(".");
  const expires = Number(expiresText);
  if (!expires || !nonce || !suppliedSignature || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = base64Url(await signature(`${clientIp(request)}.${expiresText}.${nonce}`));
  return expected === suppliedSignature;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function rateLimit(binding, key) {
  if (!binding) return true;
  const result = await binding.limit({ key });
  return result.success;
}

function downloadResponse(bytes) {
  const seed = crypto.getRandomValues(new Uint8Array(64 * 1024));
  const chunk = new Uint8Array(1024 * 1024);
  for (let offset = 0; offset < chunk.length; offset += seed.length) chunk.set(seed, offset);
  let remaining = bytes;

  const body = new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const length = Math.min(remaining, chunk.length);
      controller.enqueue(length === chunk.length ? chunk : chunk.subarray(0, length));
      remaining -= length;
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      "content-encoding": "identity",
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
    },
  });
}

async function consumeUpload(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES) return json({ error: "Upload chunk is too large." }, 413);
  if (!request.body) return json({ error: "No upload body received." }, 400);

  const reader = request.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      return json({ error: "Upload chunk is too large." }, 413);
    }
  }
  return json({ received });
}

function page(request) {
  const cf = request.cf || {};
  const seenIp = clientIp(request);
  const isp = cf.asOrganization || "Unknown";
  const asn = cf.asn ? `AS${cf.asn}` : "Unknown";
  const server = cf.colo ? `Cloudflare edge ${cf.colo}` : "Cloudflare edge";
  const escape = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Speed Test</title>
  <meta name="description" content="Internet speed and network quality test.">
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #07111d; color: #f8fafc; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #07111d; }
    button { font: inherit; }
    main { width: min(1120px, calc(100% - 28px)); margin: 0 auto; padding: 18px 0 42px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border: 1px solid #284157; border-radius: 8px; background: #0d1a29; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .mark { display: grid; place-items: center; width: 46px; height: 46px; border: 1px solid #8eeafa; border-radius: 8px; background: #12384b; font-weight: 900; letter-spacing: .08em; }
    .brand strong { display: block; font-size: 17px; }
    .brand span { display: block; margin-top: 2px; color: #94c8eb; font-size: 13px; }
    .layout { display: grid; grid-template-columns: 280px 1fr; gap: 18px; margin-top: 18px; }
    aside, .workspace { border: 1px solid #24384b; border-radius: 8px; background: #101c2a; }
    aside { padding: 20px; }
    h1 { margin: 0; font-size: 30px; }
    aside p { color: #b8cee2; font-size: 14px; line-height: 1.6; }
    .network { margin-top: 22px; padding-top: 18px; border-top: 1px solid #263a4d; }
    .network div { margin-bottom: 14px; }
    .network span { display: block; color: #79dff4; font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .network strong { display: block; margin-top: 4px; overflow-wrap: anywhere; font-size: 14px; }
    .workspace { padding: 22px; }
    .results { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #2a4054; border-radius: 8px; overflow: hidden; }
    .result { min-width: 0; padding: 20px 16px; background: #0a1523; border-right: 1px solid #2a4054; }
    .result:last-child { border-right: 0; }
    .result span { color: #8dbbd8; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .result strong { display: block; margin-top: 9px; font-size: clamp(25px, 4vw, 42px); line-height: 1; }
    .result small { color: #8dbbd8; font-size: 12px; }
    .meter { margin-top: 24px; }
    .meter-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 13px; }
    .meter-head span:last-child { color: #8dbbd8; }
    .track { height: 10px; overflow: hidden; border-radius: 5px; background: #07111d; border: 1px solid #284157; }
    .bar { width: 0; height: 100%; background: #11c5e7; transition: width .15s linear; }
    .controls { display: flex; gap: 10px; margin-top: 24px; }
    .primary, .secondary { min-height: 44px; padding: 0 20px; border-radius: 7px; border: 1px solid #47dff6; cursor: pointer; font-weight: 800; }
    .primary { color: #04131d; background: #13c6e8; }
    .secondary { color: #f8fafc; background: transparent; border-color: #38536a; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .details { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 24px; }
    .detail { padding: 13px 14px; border: 1px solid #263b4e; border-radius: 7px; background: #0b1624; }
    .detail span { display: block; color: #87b8d8; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .detail strong { display: block; margin-top: 5px; overflow-wrap: anywhere; font-size: 14px; }
    .note { margin: 18px 0 0; color: #8faec5; font-size: 12px; line-height: 1.5; }
    .voip { margin-top:28px; border-top:1px solid #38536a; padding-top:18px; } h2 {font-size:20px;} input {font:inherit; color:inherit; background:#07111d; border:1px solid #38536a; border-radius:5px; padding:10px; width:90px;} .controls {flex-wrap:wrap;align-items:center;} pre {white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;} details {margin-top:20px;} #status, #voip-status {line-height:1.5;}
    main {width:min(1460px,calc(100% - 28px));} .layout {grid-template-columns:230px minmax(0,1fr);} .workspace {min-width:0;} .test-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;} .test-card {min-width:0;padding:16px;border:1px solid #2a4054;border-radius:8px;background:#0d1826;} .test-card h2 {margin:0;} .test-card .meter {min-height:104px;} .test-card>.note {margin:10px 0 16px;} .test-card .results {grid-template-columns:repeat(2,minmax(0,1fr));} .test-card .result {padding:15px 10px;} .test-card .result:nth-child(2) {border-right:0;} .test-card .result:nth-child(-n+2) {border-bottom:1px solid #2a4054;} .test-card .details {grid-template-columns:repeat(2,minmax(0,1fr));} .test-card .result strong {font-size:32px;} .detail strong span {display:inline;font:inherit;color:inherit;letter-spacing:normal;} .running {animation:scan 1.4s ease-in-out infinite alternate;} @keyframes scan {from {transform:translateX(0);}to {transform:translateX(180%);}} @media(prefers-reduced-motion:reduce){.running{animation:none;}} @media(max-width:1100px){.layout{grid-template-columns:1fr;}.network{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}} @media(max-width:720px){.test-grid{grid-template-columns:1fr;}}
    @media (max-width: 850px) { .layout { grid-template-columns: 1fr; } .results { grid-template-columns: repeat(2, 1fr); } .result:nth-child(2) { border-right: 0; } .result:nth-child(-n+2) { border-bottom: 1px solid #2a4054; } .details { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 520px) { main { width: min(100% - 18px, 1120px); } header, .workspace, aside { padding: 14px; } .brand strong { font-size: 14px; } .results, .details { grid-template-columns: 1fr; } .result { border-right: 0; border-bottom: 1px solid #2a4054; } .result:last-child { border-bottom: 0; } .controls { flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><div class="mark" aria-hidden="true">↕</div><div><strong>Speed Test</strong><span>Network speed test · Build 3</span></div></div>
    </header>
    <section class="layout">
      <aside>
        <h1>Your connection</h1>
        <p>Measure your connection to the Cloudflare edge serving you. The test runs only when you press Start.</p>
        <div class="network">
          <div><span>IPv4</span><strong id="ipv4">${seenIp.includes(":") ? "Checking..." : escape(seenIp)}</strong></div>
          <div><span>IPv6</span><strong id="ipv6">${seenIp.includes(":") ? escape(seenIp) : "Checking..."}</strong></div>
          <div><span>ISP / Network</span><strong>${escape(isp)}</strong></div>
          <div><span>ASN</span><strong>${escape(asn)}</strong></div>
        </div>
      </aside>
      <section class="workspace">
        <div class="test-grid">
        <section class="test-card">
          <h2><span aria-hidden="true">☁</span> Cloudflare Test</h2>
          <p class="note">Official engine · adaptive requests</p>
          <div class="results">
            <div class="result"><span>Download</span><strong id="cf-download">—</strong><small>Mbps</small></div>
            <div class="result"><span>Upload</span><strong id="cf-upload">—</strong><small>Mbps</small></div>
            <div class="result"><span>Latency</span><strong id="cf-latency">—</strong><small>ms</small></div>
            <div class="result"><span>RTT variation</span><strong id="cf-jitter">—</strong><small>ms</small></div>
          </div>
          <div class="meter"><p id="cf-status" role="status">Ready</p><div class="track"><div class="bar" id="cf-bar"></div></div><p class="note" id="cf-elapsed">Runs only when you click Run.</p></div>
          <div class="controls"><button class="primary" id="cf-start">Run Cloudflare Test</button></div>
          <div class="details"><div class="detail"><span>Loaded latency ↓</span><strong><span id="cf-loaded-down">—</span> ms</strong></div><div class="detail"><span>Loaded latency ↑</span><strong><span id="cf-loaded-up">—</span> ms</strong></div></div>
          <p class="note">Tests your browser directly against speed.cloudflare.com. The adaptive sequence can use about 1.3 GB of payload, plus retries and overhead. Packet-loss testing is not enabled.</p>
        </section>
        <section class="test-card">
        <h2><span aria-hidden="true">↕</span> Our Test</h2>
        <p class="note">Parallel streams · measured average</p>
        <div class="results">
          <div class="result"><span>Download</span><strong id="download">-</strong><small>Mbps</small></div>
          <div class="result"><span>Upload</span><strong id="upload">-</strong><small>Mbps</small></div>
          <div class="result"><span>HTTP RTT</span><strong id="latency">-</strong><small>ms</small></div>
          <div class="result"><span>RTT variation</span><strong id="jitter">-</strong><small>ms</small></div>
        </div>
        <div class="meter">
          <div class="meter-head"><span id="status" role="status">Ready</span><span id="usage">0 MB transferred</span></div>
          <div class="track"><div class="bar" id="bar"></div></div>
        </div>
        <div class="controls">
          <button class="primary" id="start">Run Our Test</button>

        </div>
        <div class="details">
          <div class="detail"><span>Test server</span><strong id="server">${escape(server)}</strong></div>
          <div class="detail"><span>Download data</span><strong id="down-data">-</strong></div>
          <div class="detail"><span>Upload data</span><strong id="up-data">-</strong></div>
        </div>
        <p class="note">Up to 10 seconds per direction, with a 768 MiB payload cap per direction (up to 1.5 GiB total, plus warmup and protocol overhead). Keep this tab visible. Upload is counted only after server acknowledgement. Very fast links may reach the cap early.</p>
        </section>
        </div>
        <div class="controls"><button class="secondary" id="stop" disabled>Stop current test</button><button class="secondary" id="copy" disabled>Copy results</button></div>
        <p class="note">Run either speed test. Its results stay visible while you run the other. Only one test runs at a time to prevent competing traffic.</p>
        <section class="voip">
          <h2>Concurrent VoIP simulation</h2>
          <p class="note">Generate 100 kbps per call in each direction for 60 seconds. Ten calls target 1 Mbps each way and approximately 15 MB total payload. Synthetic traffic only; no microphone or telephone service needed.</p>
          <div class="controls"><label for="calls">Concurrent calls <input id="calls" type="number" min="1" max="100" step="1" value="10"></label><button class="primary" id="voip-start">Run 60-second simulation</button></div>
          <p id="voip-status" role="status">Ready — default: 10 calls</p>
          <div class="results voip-results">
            <div class="result"><span>Latency</span><strong id="voip-latency">—</strong><small>median round trip · ms</small></div>
            <div class="result"><span>RTT jitter</span><strong id="voip-jitter">—</strong><small>round-trip variation · ms</small></div>
            <div class="result"><span>Longest gap</span><strong id="voip-gap">—</strong><small>between received frames · ms</small></div>
            <div class="result"><span>Packet loss</span><strong style="font-size:18px;line-height:1.4">Not measurable</strong><small>TCP retransmits lost data</small></div>
          </div>
          <p class="note" id="voip-time">60-second test</p><div class="track"><div class="bar" id="voip-bar"></div></div>
          <pre id="voip-output" aria-live="off"></pre>
          <p class="note">Models aggregate bandwidth and delay over a WebSocket, not actual RTP/UDP calls. It cannot measure real VoIP packet loss, one-way jitter or MOS.</p>
        </section>
        <details id="report-details"><summary>Last completed report</summary><pre id="report"></pre></details>
        <p class="note">Results measure performance to Cloudflare, not every destination on the internet. VPNs, Wi-Fi, browser load, and device performance can affect the result.</p>
      </section>
    </section>
  </main>
  <script>
    (${CLIENT})();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/cf-engine.js") return new Response(CF_ENGINE, {headers:{"content-type":"application/javascript; charset=utf-8","cache-control":"no-cache","x-content-type-options":"nosniff"}});
    if (url.pathname === "/") {
      return new Response(page(request), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (url.pathname === "/session" && request.method === "POST") {
      const allowed = await rateLimit(env.SESSION_LIMITER, clientIp(request));
      if (!allowed) return json({ error: "Too many tests. Please wait a minute and try again." }, 429);
      return json({ token: await createToken(request), expiresIn: SESSION_SECONDS });
    }

    if (!["/ping", "/download", "/upload", "/voip"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (!(await tokenIsValid(request))) return json({ error: "Invalid or expired test session." }, 403);

    if (url.pathname === "/ping") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    const allowed = await rateLimit(env.TRANSFER_LIMITER, `${clientIp(request)}:${url.pathname}`);
    if (!allowed) return json({ error: "Speed test rate limit reached." }, 429);

    if (url.pathname === "/voip") return voipResponse(request);

    if (url.pathname === "/download" && request.method === "GET") {
      const requested = Number(url.searchParams.get("bytes") || MAX_DOWNLOAD_BYTES);
      const bytes = Math.max(1024, Math.min(MAX_DOWNLOAD_BYTES, Number.isFinite(requested) ? requested : MAX_DOWNLOAD_BYTES));
      return downloadResponse(bytes);
    }

    if (url.pathname === "/upload" && request.method === "POST") return consumeUpload(request);
    return new Response("Method not allowed", { status: 405 });
  },
};
