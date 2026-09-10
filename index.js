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
  const server = [cf.colo, cf.city, cf.region].filter(Boolean).join(" / ") || "Cloudflare edge";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clear Speed | Clear Technology Solutions</title>
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
    @media (max-width: 850px) { .layout { grid-template-columns: 1fr; } .results { grid-template-columns: repeat(2, 1fr); } .result:nth-child(2) { border-right: 0; } .result:nth-child(-n+2) { border-bottom: 1px solid #2a4054; } .details { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 520px) { main { width: min(100% - 18px, 1120px); } header, .workspace, aside { padding: 14px; } .brand strong { font-size: 14px; } .results, .details { grid-template-columns: 1fr; } .result { border-right: 0; border-bottom: 1px solid #2a4054; } .result:last-child { border-bottom: 0; } .controls { flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand"><div class="mark">CTS</div><div><strong>Clear Technology Solutions</strong><span>Network speed test</span></div></div>
    </header>
    <section class="layout">
      <aside>
        <h1>Clear Speed</h1>
        <p>Measure your connection to the nearest Cloudflare edge. The test runs only when you press Start.</p>
        <div class="network">
          <div><span>IPv4</span><strong id="ipv4">${seenIp.includes(":") ? "Checking..." : seenIp}</strong></div>
          <div><span>IPv6</span><strong id="ipv6">${seenIp.includes(":") ? seenIp : "Checking..."}</strong></div>
          <div><span>ISP / Network</span><strong>${isp}</strong></div>
          <div><span>ASN</span><strong>${asn}</strong></div>
        </div>
      </aside>
      <section class="workspace">
        <div class="results">
          <div class="result"><span>Download</span><strong id="download">-</strong><small>Mbps</small></div>
          <div class="result"><span>Upload</span><strong id="upload">-</strong><small>Mbps</small></div>
          <div class="result"><span>Latency</span><strong id="latency">-</strong><small>ms</small></div>
          <div class="result"><span>Jitter</span><strong id="jitter">-</strong><small>ms</small></div>
        </div>
        <div class="meter">
          <div class="meter-head"><span id="status">Ready</span><span id="usage">0 MB transferred</span></div>
          <div class="track"><div class="bar" id="bar"></div></div>
        </div>
        <div class="controls">
          <button class="primary" id="start">Start speed test</button>
          <button class="secondary" id="copy" disabled>Copy results</button>
        </div>
        <div class="details">
          <div class="detail"><span>Test server</span><strong>${server}</strong></div>
          <div class="detail"><span>Download data</span><strong id="down-data">-</strong></div>
          <div class="detail"><span>Upload data</span><strong id="up-data">-</strong></div>
        </div>
        <p class="note">Results measure performance to Cloudflare, not every destination on the internet. VPNs, Wi-Fi, browser load, and device performance can affect the result.</p>
      </section>
    </section>
  </main>
  <script>
    const elements = Object.fromEntries(["start", "copy", "status", "usage", "bar", "download", "upload", "latency", "jitter", "down-data", "up-data", "ipv4", "ipv6"].map(id => [id, document.getElementById(id)]));
    const DOWNLOAD_SECONDS = 5;
    const UPLOAD_SECONDS = 5;
    const DOWNLOAD_LIMIT = 768 * 1024 * 1024;
    const UPLOAD_LIMIT = 384 * 1024 * 1024;
    const DOWNLOAD_CHUNK = 32 * 1024 * 1024;
    const UPLOAD_CHUNK = 32 * 1024 * 1024;
    let results = null;

    const mb = bytes => (bytes / 1024 / 1024).toFixed(0) + " MB";
    const mbps = (bytes, milliseconds) => bytes * 8 / milliseconds / 1000;
    const shown = value => value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

    async function detectIp(version, endpoint) {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        const data = await response.json();
        elements[version].textContent = data.ip || "Not available";
      } catch { elements[version].textContent = "Not available"; }
    }

    detectIp("ipv4", "https://api.ipify.org?format=json");
    detectIp("ipv6", "https://api6.ipify.org?format=json");

    async function getSession() {
      const response = await fetch("/session", { method: "POST", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start test.");
      return data.token;
    }

    async function testLatency(token) {
      elements.status.textContent = "Testing latency";
      elements.bar.style.width = "10%";
      const samples = [];
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const response = await fetch("/ping?token=" + encodeURIComponent(token) + "&n=" + i, { cache: "no-store" });
        if (!response.ok) throw new Error("Latency test failed.");
        samples.push(performance.now() - started);
      }
      const latency = median(samples);
      const deltas = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
      const jitter = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
      elements.latency.textContent = shown(latency);
      elements.jitter.textContent = shown(jitter);
      return { latency, jitter };
    }

    async function testDownload(token) {
      elements.status.textContent = "Testing download";
      const controller = new AbortController();
      const started = performance.now();
      const deadline = started + DOWNLOAD_SECONDS * 1000;
      let bytes = 0;

      async function stream() {
        while (performance.now() < deadline && bytes < DOWNLOAD_LIMIT) {
          try {
            const response = await fetch("/download?bytes=" + DOWNLOAD_CHUNK + "&token=" + encodeURIComponent(token) + "&r=" + crypto.randomUUID(), { cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error("Download test was limited.");
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              const elapsed = performance.now() - started;
              elements.download.textContent = shown(mbps(bytes, elapsed));
              elements.usage.textContent = mb(bytes) + " transferred";
              elements.bar.style.width = Math.min(55, 15 + elapsed / (DOWNLOAD_SECONDS * 1000) * 40) + "%";
              if (performance.now() >= deadline || bytes >= DOWNLOAD_LIMIT) { controller.abort(); break; }
            }
          } catch (error) { if (error.name !== "AbortError") throw error; }
        }
      }

      try {
        await Promise.all(Array.from({ length: 6 }, stream));
      } finally {
        controller.abort();
      }
      const duration = Math.min(performance.now() - started, DOWNLOAD_SECONDS * 1000);
      const speed = mbps(bytes, duration);
      elements.download.textContent = shown(speed);
      elements["down-data"].textContent = mb(bytes);
      return { speed, bytes };
    }

    function makeUploadData() {
      const seed = crypto.getRandomValues(new Uint8Array(64 * 1024));
      const data = new Uint8Array(UPLOAD_CHUNK);
      for (let offset = 0; offset < data.length; offset += seed.length) data.set(seed, offset);
      return new Blob([data], { type: "application/octet-stream" });
    }

    async function testUpload(token) {
      elements.status.textContent = "Testing upload";
      const payload = makeUploadData();
      const started = performance.now();
      const deadline = started + UPLOAD_SECONDS * 1000;
      let completedBytes = 0;
      const active = new Set();

      async function send() {
        while (performance.now() < deadline && completedBytes < UPLOAD_LIMIT) {
          await new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            active.add(xhr);
            let lastLoaded = 0;
            xhr.open("POST", "/upload?token=" + encodeURIComponent(token) + "&r=" + crypto.randomUUID());
            xhr.upload.onprogress = event => {
              const delta = Math.max(0, event.loaded - lastLoaded);
              lastLoaded = event.loaded;
              completedBytes += delta;
              const elapsed = performance.now() - started;
              elements.upload.textContent = shown(mbps(completedBytes, elapsed));
              elements.usage.textContent = mb(completedBytes) + " uploaded";
              elements.bar.style.width = Math.min(98, 60 + elapsed / (UPLOAD_SECONDS * 1000) * 38) + "%";
              if (performance.now() >= deadline || completedBytes >= UPLOAD_LIMIT) xhr.abort();
            };
            const finish = () => { active.delete(xhr); resolve(); };
            xhr.onload = finish;
            xhr.onerror = finish;
            xhr.onabort = finish;
            xhr.send(payload);
          });
        }
      }

      const timer = window.setTimeout(() => active.forEach(xhr => xhr.abort()), UPLOAD_SECONDS * 1000);
      await Promise.all(Array.from({ length: 4 }, send));
      window.clearTimeout(timer);
      active.forEach(xhr => xhr.abort());
      const duration = Math.min(performance.now() - started, UPLOAD_SECONDS * 1000);
      const speed = mbps(completedBytes, duration);
      elements.upload.textContent = shown(speed);
      elements["up-data"].textContent = mb(completedBytes);
      return { speed, bytes: completedBytes };
    }

    async function runTest() {
      elements.start.disabled = true;
      elements.copy.disabled = true;
      elements.start.textContent = "Testing...";
      elements.download.textContent = elements.upload.textContent = elements.latency.textContent = elements.jitter.textContent = "-";
      elements.bar.style.width = "2%";
      try {
        const token = await getSession();
        const quality = await testLatency(token);
        const download = await testDownload(token);
        const upload = await testUpload(token);
        results = { ...quality, download, upload };
        elements.status.textContent = "Test complete";
        elements.usage.textContent = mb(download.bytes + upload.bytes) + " total";
        elements.bar.style.width = "100%";
        elements.copy.disabled = false;
      } catch (error) {
        elements.status.textContent = error.message || "Test failed";
        elements.bar.style.width = "0";
      } finally {
        elements.start.disabled = false;
        elements.start.textContent = "Retest";
      }
    }

    elements.start.addEventListener("click", runTest);
    elements.copy.addEventListener("click", async () => {
      if (!results) return;
      const text = [
        "Clear Speed results",
        "Download: " + shown(results.download.speed) + " Mbps",
        "Upload: " + shown(results.upload.speed) + " Mbps",
        "Latency: " + shown(results.latency) + " ms",
        "Jitter: " + shown(results.jitter) + " ms",
        "IPv4: " + elements.ipv4.textContent,
        "IPv6: " + elements.ipv6.textContent,
        "Server: " + ${JSON.stringify(server)},
      ].join("\\n");
      await navigator.clipboard.writeText(text);
      elements.copy.textContent = "Copied";
      window.setTimeout(() => elements.copy.textContent = "Copy results", 1400);
    });
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    if (!["/ping", "/download", "/upload"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    if (!(await tokenIsValid(request))) return json({ error: "Invalid or expired test session." }, 403);

    if (url.pathname === "/ping") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    const allowed = await rateLimit(env.TRANSFER_LIMITER, `${clientIp(request)}:${url.pathname}`);
    if (!allowed) return json({ error: "Speed test rate limit reached." }, 429);

    if (url.pathname === "/download" && request.method === "GET") {
      const requested = Number(url.searchParams.get("bytes") || MAX_DOWNLOAD_BYTES);
      const bytes = Math.max(1024, Math.min(MAX_DOWNLOAD_BYTES, Number.isFinite(requested) ? requested : MAX_DOWNLOAD_BYTES));
      return downloadResponse(bytes);
    }

    if (url.pathname === "/upload" && request.method === "POST") return consumeUpload(request);
    return new Response("Method not allowed", { status: 405 });
  },
};
