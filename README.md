# Speed Test — Build 3

Browser speed test and concurrent VoIP traffic simulation for the existing Cloudflare Worker. No new database, bucket, API key, or binding required.

## Update your existing app

1. Extract this ZIP and upload **all of its files** to the root of the existing speed-test GitHub repository, replacing the old files. Include `client.js`, `voip.js`, and the entire `vendor` folder.
2. Keep your existing Cloudflare Worker and custom domain. Do not delete them.
3. Keep the deploy command `npx wrangler deploy`. No build command is required.
4. If your Worker is named differently, preserve that name in `wrangler.json`.
5. Commit the update and let the connected Cloudflare build deploy it. Refresh the page and check for **Build 3** in the header.

CLI alternative: `npm ci` then `npm run deploy`.

## Two independent speed tests

- **Cloudflare Test** uses the pinned official `@cloudflare/speedtest` 1.14.1 engine and its adaptive measurement sequence, excluding packet-loss and other non-throughput phases. The test runs directly in the browser against Cloudflare's public measurement endpoints.
- **Our Test** keeps the corrected parallel-stream custom test from Build 2.
- Each card retains its results when the other runs. One test at a time; the shared Stop button cancels the active test. The VoIP simulator is also mutually exclusive with both speed tests.
- Cloudflare's card includes idle RTT, RTT variation, and latency under download/upload load when available. Different measurement methods can legitimately produce different results; the cards do not claim identical methodology or certified ISP capacity.
- The official engine is bundled locally in `vendor/cloudflare-engine.js`, so it does not require a CDN script at runtime. No automatic test runs on page load. Optional result-logging endpoints are disabled; measurement traffic still goes to Cloudflare.
- The official adaptive sequence can transfer approximately 1.3 GB of payload, plus retries and protocol overhead. A three-minute watchdog stops a test that does not finish. The custom-test limits below apply only to Our Test.
- CTS/Clear Technology Solutions branding has been removed.

## Custom speed measurement fixes

- Counts bytes actually read from download responses.
- Upload counts only successful responses whose server-reported byte count exactly matches the sent chunk. Browser upload progress is not counted as delivery.
- Uses actual monotonic elapsed time. Delayed timers are never divided by a shorter nominal duration.
- Independent download deadline stops stalled streams. Upload allows up to ten extra seconds for outstanding chunks to finish; that time is included in the upload measurement. Failed, unconfirmed or timed-out uploads invalidate the result.
- Connection warmup precedes measurements. Download uses six concurrent requests; upload uses four, with adaptive chunk sizes targeting roughly half a second per chunk.
- Each direction targets 10 seconds with a 768 MiB payload cap. Capped results are identified, with an additional warning for samples shorter than five seconds.
- HTTP RTT uses ten samples after a warmup. RTT variation is the mean absolute difference between consecutive RTT samples; it is **not RTP jitter**.
- Stops on request or when the tab is hidden. Speed and call simulation cannot run together.
- Displays the Cloudflare edge code, rather than incorrectly presenting the visitor's city as the server location.

The number is application throughput to the serving Cloudflare edge. It includes connection/request/acknowledgement overhead and depends on the browser, device, Wi-Fi, VPN, route, server and competing traffic. It is not a certified ISP line-rate measurement. At very high speeds, the byte cap shortens the sample. Compare several tests using a wired connection, a visible tab and minimal background traffic. Avoid running another speed test simultaneously.

Data use: up to **1.5 GiB total measured payload** per speed run, plus a small warmup and transport overhead. Aborted requests can have data in flight. This is an application limit, not an account-wide billing cap. Existing per-IP rate limit bindings remain in place.

## Concurrent VoIP simulation

- Select **1–100 calls**, default **10**.
- 60-second aggregate two-way load at **100 kbps per call in each direction**.
- Ten calls target **1 Mbps upload plus 1 Mbps download**, approximately **15 MB total application payload** over 60 seconds.
- Independently paced server-to-browser and browser-to-server traffic uses one binary aggregate frame every 20 ms, sized at 250 bytes per call. This is a configurable call-bandwidth budget, not an exact codec/wire-overhead model.
- Live cards show median latency, RTT jitter (round-trip variation), longest received-frame gap, and an explicit **Packet loss: Not measurable** label. The report also includes server-confirmed upload, received download, loaded WebSocket median/p95 RTT, pacing skips and observed browser upload buffering.
- Flags delivered load below 95% of target. Pacing skips can originate in browser/server scheduling; they do not prove network packet loss.
- The Stop button cancels either test. No microphone, audio, SIP account or phone system is used.

**Limits:** One reliable WebSocket/TCP stream models aggregate call bandwidth, not separate RTP/UDP calls, codec behavior, QoS markings or a path to your phone provider. TCP can conceal packet loss through retransmission and delay later messages behind earlier ones. It does not measure real UDP packet loss, one-way jitter, MOS, or guarantee that calls will sound good. Results describe this simulation only.

## Verification

Run `npm test` for deterministic regression tests covering throughput timing, upload failures and byte acknowledgements, stalled downloads, and full client/server simulation at 1, 10 and 100 calls with cancellation, disconnect and buffering cases, plus official-engine UI integration checks. The desktop/mobile UI and the actual official library were also exercised in Chromium using small local test transfers; this does not validate results against a live ISP connection.

`npm run test:runtime` additionally checks the built Worker in the local Cloudflare runtime, including a real 60-second WebSocket exchange.

`npx wrangler deploy --dry-run` checks the deploy bundle without publishing. The prebuilt vendor bundle is included, so no new build command is required. `npm run build:engine` regenerates it from the locked dependency.

Browser JavaScript is kept as a literal source string so Wrangler does not inject Worker-only helper references into the page.

Technical references:
- https://developers.cloudflare.com/workers/runtime-apis/websockets/
- https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/upload
