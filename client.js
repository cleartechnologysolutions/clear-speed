// Keep browser source literal so Worker bundling cannot inject unavailable helpers.
export const CLIENT = String.raw`function browserApp() {
  const $ = id => document.getElementById(id);
  const MiB = 1024 * 1024, LIMIT = 768 * MiB, SAMPLE = 10000;
  const shown = n => Number.isFinite(n) ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : '—';
  const mib = n => (n / MiB).toFixed(1) + ' MiB';
  const rate = (bytes, ms) => bytes * 8 / ms / 1000;
  const median = a => { const s = [...a].sort((a,b) => a-b), n = s.length; return n ? (s[Math.floor((n-1)/2)] + s[Math.floor(n/2)]) / 2 : NaN; };
  const variation = a => a.length > 1 ? a.slice(1).reduce((s,x,i) => s + Math.abs(x-a[i]), 0) / (a.length-1) : NaN;
  let active = null, report = '';
  const reports = {};
  let cfLoading = null;
  function lock(controller) {
    active = controller; $('cf-start').disabled = $('start').disabled = $('voip-start').disabled = $('calls').disabled = !!controller;
    $('stop').disabled = !controller;
  }
  function check(signal) { signal.throwIfAborted(); }
  function url(path, token, query = '') { return path + '?token=' + encodeURIComponent(token) + '&r=' + crypto.randomUUID() + query; }
  async function request(path, options = {}, signal = active?.signal, timeout = 15000) {
    const response = await fetch(path, {cache:'no-store', ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)});
    if (!response.ok) {
      let message = 'Request failed (HTTP ' + response.status + ').';
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    return response;
  }
  async function session() { return (await (await request('/session', {method:'POST'})).json()).token; }
  $('stop').onclick = () => active?.abort(new Error('Stopped. Partial results are not a completed test.'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) active?.abort(new Error('Test stopped because this tab was hidden. Keep it visible for accurate timing.'));
  });
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(report); $('copy').textContent = 'Copied'; }
    catch { $('status').textContent = 'Clipboard unavailable. Select and copy the report below.'; }
  };
  function publish(text) { $('report-details').open = true; reports[text.startsWith('VoIP') ? 'voip' : text.startsWith('Cloudflare') ? 'cloudflare' : 'custom'] = text; report = Object.values(reports).join('\n\n────────────────────\n\n'); $('report').textContent = report; $('copy').disabled = false; $('copy').textContent = 'Copy results'; }
  for (const [id, endpoint] of [['ipv4','https://api.ipify.org?format=json'],['ipv6','https://api6.ipify.org?format=json']]) {
    fetch(endpoint,{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(d=>$(id).textContent=d.ip || 'Not available').catch(()=> { if ($(id).textContent === 'Checking...') $(id).textContent='Not available'; });
  }
  async function latency(token, signal) {
    $('status').textContent = 'Warming connection and measuring HTTP round-trip time…';
    const samples=[];
    for (let i=0;i<11;i++) {
      const start=performance.now();
      await request(url('/ping',token),{},signal,5000);
      if(i) samples.push(performance.now()-start);
    }
    $('latency').textContent=shown(median(samples)); $('jitter').textContent=shown(variation(samples));
    return {latency:median(samples),variation:variation(samples)};
  }
  async function download(token, outer) {
    $('status').textContent='Measuring download — up to 10 seconds…';
    // Complete a small warmup before starting the measured interval.
    await (await request(url('/download',token,'&bytes=262144'),{},outer)).arrayBuffer();
    const controller=new AbortController(), signal=AbortSignal.any([outer,controller.signal]);
    const start=performance.now(); let stopped=0, bytes=0, reserved=0, failure=null;
    const stop=()=>{ if(!stopped) stopped=performance.now(); controller.abort(); };
    const timer=setTimeout(stop,SAMPLE);
    const display=setInterval(()=>{
      $('download').textContent=shown(rate(bytes,performance.now()-start));
      $('usage').textContent=mib(bytes)+' received'; $('bar').style.width=(10+Math.min(1,(performance.now()-start)/SAMPLE)*40)+'%';
    },100);
    async function stream() {
      try {
        while(!signal.aborted && reserved<LIMIT) {
          const size=Math.min(32*MiB,LIMIT-reserved); reserved+=size;
          const response=await request(url('/download',token,'&bytes='+size),{},signal);
          const reader=response.body.getReader(); let received=0;
          while(!signal.aborted) {
            const part=await reader.read();
            if (signal.aborted) break;
            if(part.done) { if(received!==size) throw new Error('Incomplete download response; result discarded.'); break; }
            bytes+=part.value.byteLength; received+=part.value.byteLength;
          }
        }
      } catch(e) { if(!signal.aborted) { failure=e; stop(); } }
    }
    try { await Promise.allSettled(Array.from({length:6},stream)); }
    finally { stop(); clearTimeout(timer); clearInterval(display); }
    check(outer); if(failure) throw failure;
    const ms=stopped-start;
    if(!bytes) throw new Error('No download data received.');
    return {bytes,ms,speed:rate(bytes,ms),capped:bytes>=LIMIT};
  }
  async function upload(token, outer) {
    $('status').textContent='Warming upload…';
    const raw=new Uint8Array(8*MiB);
    for(let i=0;i<raw.length;i+=65536) crypto.getRandomValues(raw.subarray(i,i+65536));
    const payload=new Blob([raw],{type:'application/octet-stream'});
    async function send(size, signal) {
      const result=await (await request(url('/upload',token),{method:'POST',body:payload.slice(0,size)},signal,20000)).json();
      if(result.received!==size) throw new Error('Upload acknowledgement did not match the sent data.');
    }
    const probeStart=performance.now(); await send(32768,outer);
    let chunk=Math.max(32768,Math.min(8*MiB,Math.round(32768*500/Math.max(1,performance.now()-probeStart)/4)));
    $('status').textContent='Measuring upload — counting only server-confirmed data…';
    const controller=new AbortController(), signal=AbortSignal.any([outer,controller.signal]);
    const start=performance.now(); let bytes=0,reserved=0,failure=null;
    // Allow bounded time for in-flight chunks to finish; include that time in the denominator.
    const timer=setTimeout(()=>controller.abort(new Error('Upload did not finish within its drain timeout. Result discarded.')),SAMPLE+10000);
    const display=setInterval(()=>{
      $('upload').textContent=shown(rate(bytes,performance.now()-start)); $('usage').textContent=mib(bytes)+' confirmed uploaded';
      $('bar').style.width=(55+Math.min(1,(performance.now()-start)/SAMPLE)*43)+'%';
      if(performance.now()-start>=SAMPLE) $('status').textContent='Finishing and confirming in-flight uploads…';
    },100);
    async function stream() {
      try {
        while(!signal.aborted && performance.now()-start<SAMPLE && reserved<LIMIT) {
          const size=Math.min(chunk,LIMIT-reserved); reserved+=size;
          const then=performance.now(); await send(size,signal); bytes+=size;
          // Target ~0.5 seconds per stream, with a floor to avoid tiny request floods.
          chunk=Math.max(32768,Math.min(8*MiB,Math.round(size*500/Math.max(1,performance.now()-then))));
        }
      } catch(e) { if(!signal.aborted) { failure=e; controller.abort(e); } }
    }
    try { await Promise.allSettled(Array.from({length:4},stream)); }
    finally { clearTimeout(timer); clearInterval(display); }
    check(outer); if(failure) throw failure; check(signal);
    const ms=performance.now()-start;
    if(!bytes) throw new Error('No upload data confirmed by server.');
    return {bytes,ms,speed:rate(bytes,ms),capped:reserved>=LIMIT};
  }
  $('start').onclick=async()=>{
    if(active) return;
    const controller=new AbortController(); lock(controller); $('copy').disabled=true; $('report').textContent='';
    for(const id of ['download','upload','latency','jitter','down-data','up-data']) $(id).textContent='—';
    try {
      const token=await session(), q=await latency(token,controller.signal), down=await download(token,controller.signal);
      $('download').textContent=shown(down.speed); $('down-data').textContent=mib(down.bytes)+' / '+(down.ms/1000).toFixed(2)+' s';
      const up=await upload(token,controller.signal);
      $('upload').textContent=shown(up.speed); $('up-data').textContent=mib(up.bytes)+' / '+(up.ms/1000).toFixed(2)+' s';
      const notes=[];
      for(const [name,r] of [['Download',down],['Upload',up]]) {
        if(r.capped) notes.push(name+': data cap reached.');
        if(r.ms<5000) notes.push(name+': short sample (under 5 seconds); repeat to assess consistency.');
      }
      $('status').textContent=notes.length?'Complete — see measurement notes below.':'Speed test complete'; $('bar').style.width='100%';
      $('usage').textContent=mib(down.bytes+up.bytes)+' measured payload';
      publish(['Our speed test • Build 3 • '+new Date().toISOString(),'Cloudflare edge: '+$('server').textContent,
        'Download: '+shown(down.speed)+' Mbps; '+$('down-data').textContent,
        'Upload: '+shown(up.speed)+' Mbps; '+$('up-data').textContent,
        'HTTP RTT median: '+shown(q.latency)+' ms; RTT variation: '+shown(q.variation)+' ms',
        ...notes,'Application throughput, including request/acknowledgement overhead. Not a guaranteed ISP line-rate measurement.'].join('\n'));
    } catch(e) { $('status').textContent=e.message; $('download').textContent=$('upload').textContent='—'; $('bar').style.width='0%'; }
    finally { lock(null); }
  };

  function loadCloudflare() {
    if(window.CFEngine?.default) return Promise.resolve(window.CFEngine.default);
    if(cfLoading) return cfLoading;
    cfLoading=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/cf-engine.js';
      script.onload=()=>window.CFEngine?.default ? resolve(window.CFEngine.default) : reject(new Error('Cloudflare engine did not initialize.'));
      script.onerror=()=>{script.remove();cfLoading=null;reject(new Error('Could not load the Cloudflare engine. Reload and retry.'));};
      document.head.appendChild(script);
    });
    return cfLoading;
  }
  function showCloudflare(summary) {
    for(const [id,key,divisor] of [['cf-download','download',1e6],['cf-upload','upload',1e6],['cf-latency','latency',1],['cf-jitter','jitter',1],['cf-loaded-down','downLoadedLatency',1],['cf-loaded-up','upLoadedLatency',1]]) {
      $(id).textContent=Number.isFinite(summary[key]) ? shown(summary[key]/divisor) : '—';
    }
  }
  $('cf-start').onclick=async()=>{
    if(active) return;
    const controller=new AbortController();lock(controller);
    $('cf-status').textContent='Loading official engine…';$('cf-bar').classList.add('running');$('cf-bar').style.width='35%';
    let engine, timeout, elapsedTimer;
    try {
      const summary=await new Promise((resolve,reject)=>{
        let finished=false;
        const finish=(error,result)=>{if(finished)return;finished=true;error?reject(error):resolve(result);};
        controller.signal.addEventListener('abort',()=>{engine?.pause();finish(controller.signal.reason);},{once:true});
        timeout=setTimeout(()=>controller.abort(new Error('Cloudflare test timed out. No completed result was recorded.')),180000);
        loadCloudflare().then(Engine=>{
          if(controller.signal.aborted) return;
          engine=new Engine({autoStart:false,logAimApiUrl:null,logMeasurementApiUrl:null});
          // Retain the pinned official ramp-up sequence, excluding tests needing other infrastructure.
          engine.config.measurements=engine.config.measurements.filter(m=>['latency','download','upload'].includes(m.type));
          engine.onResultsChange=({type})=>{if(!finished){showCloudflare(engine.results.getSummary());$('cf-status').textContent='Measuring '+(type==='latency'?'latency':type)+'…';}};
          engine.onError=error=>{engine.pause();finish(new Error('Cloudflare test failed: '+String(error)));};
          engine.onFinish=results=>{
            const s=results.getSummary();
            if(!Number.isFinite(s.download)||s.download<=0||!Number.isFinite(s.upload)||s.upload<=0||!Number.isFinite(s.latency)) {
              finish(new Error('Cloudflare returned incomplete measurements. Please retry.'));return;
            }
            finish(null,s);
          };
          const start=performance.now();
          elapsedTimer=setInterval(()=>$('cf-elapsed').textContent=((performance.now()-start)/1000).toFixed(0)+' s elapsed',250);
          $('cf-status').textContent='Measuring latency…';engine.play();
        }).catch(error=>finish(error));
      });
      showCloudflare(summary);$('cf-status').textContent='Cloudflare test complete';$('cf-bar').style.width='100%';
      const duration=Number.isFinite(summary.totalDurationMs)?'Duration: '+(summary.totalDurationMs/1000).toFixed(1)+' s':'';
      publish(['Cloudflare official engine 1.14.1 • '+new Date().toISOString(),
        'Download: '+shown(summary.download/1e6)+' Mbps; upload: '+shown(summary.upload/1e6)+' Mbps',
        'Unloaded latency: '+shown(summary.latency)+' ms; RTT variation: '+shown(summary.jitter)+' ms',
        'Loaded latency: download '+shown(summary.downLoadedLatency)+' ms; upload '+shown(summary.upLoadedLatency)+' ms',duration,
        'Official adaptive request method, not the custom parallel-stream average. Packet loss not tested.'].filter(Boolean).join('\n'));
    } catch(error) {showCloudflare({});$('cf-status').textContent=error.message;$('cf-bar').style.width='0%';}
    finally {clearTimeout(timeout);clearInterval(elapsedTimer);engine?.pause();$('cf-bar').classList.remove('running');lock(null);}
  };
  $('voip-start').onclick=async()=>{
    if(active) return;
    const calls=Number($('calls').value);
    if(!Number.isInteger(calls)||calls<1||calls>100) { $('voip-status').textContent='Choose a whole number from 1 to 100 calls.'; return; }
    const controller=new AbortController(); lock(controller); $('copy').disabled=true;
    $('voip-bar').style.width='0%'; $('voip-time').textContent='60 seconds remaining';
    for(const id of ['voip-latency','voip-jitter','voip-gap']) $(id).textContent='—';
    $('voip-status').textContent='Connecting…'; $('voip-output').textContent='';
    let socket, pacing, probes, watchdog;
    try {
      const token=await session(); check(controller.signal);
      const target=calls*.1, size=calls*250; // 100 kbps/call/direction; one aggregate frame every 20 ms.
      const result=await new Promise((resolve,reject)=>{
        socket=new WebSocket(url('/voip',token,'&calls='+calls).replace(/^\//,(location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/'));
        socket.binaryType='arraybuffer';
        let start=0, down=0, sent=0, skipped=0, maxQueue=0, last=0, maxGap=0, ticks=0, finished=false;
        const rtts=[], pending=new Map(); let probeId=0, probesSent=0;
        const fail=e=>{ if(!finished) { finished=true; reject(e); } };
        controller.signal.addEventListener('abort',()=>fail(controller.signal.reason),{once:true});
        watchdog=setTimeout(()=>fail(new Error('Simulation timed out before server confirmation.')),70000);
        socket.onerror=()=>fail(new Error('WebSocket connection failed.'));
        socket.onclose=()=>fail(new Error('Simulation connection closed before completion.'));
        socket.onopen=()=>{ socket.send(JSON.stringify({type:'start'})); };
        socket.onmessage=event=>{
          if(event.data instanceof ArrayBuffer) {
            if(!start) return;
            if(event.data.byteLength!==size) { fail(new Error('Unexpected simulation frame size.')); return; }
            const now=performance.now(); down+=event.data.byteLength;
            if(last) maxGap=Math.max(maxGap,now-last); last=now; return;
          }
          let data; try {data=JSON.parse(event.data);} catch {fail(new Error('Invalid simulation response.'));return;}
          if(data.type==='ready') {
            if(start) return; start=performance.now();
            const frame=new Uint8Array(size); crypto.getRandomValues(frame);
            $('voip-status').textContent='Running '+calls+' call equivalents for 60 seconds…';
            pacing=setInterval(()=>{
              const elapsed=performance.now()-start;
              if(elapsed>=60000||socket.readyState!==WebSocket.OPEN) return;
              $('voip-time').textContent=Math.max(0,Math.ceil((60000-elapsed)/1000))+' seconds remaining';
              $('voip-bar').style.width=Math.min(100,elapsed/600)+'%';
              $('voip-gap').textContent=shown(maxGap);
              const due=Math.floor(elapsed/20); if(due<=ticks) return;
              skipped+=Math.max(0,due-ticks-1); ticks=due;
              maxQueue=Math.max(maxQueue,socket.bufferedAmount);
              if(socket.bufferedAmount>size*25) skipped++; else {socket.send(frame);sent+=size;}
              $('voip-output').textContent='Target: '+target.toFixed(2)+' Mbps each direction\nElapsed: '+(elapsed/1000).toFixed(1)+' / 60 s\nReceived: '+mib(down)+'\nLocal pacing/queue skips: '+skipped;
            },20);
            probes=setInterval(()=>{
              if(socket.readyState!==WebSocket.OPEN) return;
              const id=++probeId; pending.set(id,performance.now()); probesSent++;
              socket.send(JSON.stringify({type:'probe',id}));
            },1000);
          } else if(data.type==='pong' && pending.has(data.id)) {
            rtts.push(performance.now()-pending.get(data.id)); pending.delete(data.id);
            $('voip-latency').textContent=shown(median(rtts)); $('voip-jitter').textContent=shown(variation(rtts));
          } else if(data.type==='summary') {
            const ms=performance.now()-start;
            if(!start || !Number.isFinite(data.received) || data.received<0 || data.received>sent || !Number.isFinite(data.sent) || data.sent!==down || !Number.isFinite(data.duration) || data.duration<59000) {
              fail(new Error('Incomplete simulation acknowledgement.'));return;
            }
            finished=true; resolve({calls,target,down,up:data.received,ms,serverMs:data.duration,rtts,skipped,maxQueue,maxGap,serverSkips:data.skipped,probesSent});
          } else if(data.type==='error') fail(new Error(data.error));
        };
      });
      const r=result, sorted=[...r.rtts].sort((a,b)=>a-b), p95=sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)];
      const upRate=rate(r.up,r.serverMs),downRate=rate(r.down,r.ms);
      const notes=[];
      if(upRate<r.target*.95||downRate<r.target*.95) notes.push('Delivered load was below 95% of the target. Inspect pacing, buffering and connection performance.');
      if(r.skipped||r.serverSkips) notes.push('Pacing misses occurred; browser/server scheduling can contribute.');
      const text=['VoIP load simulation • '+r.calls+' call equivalents • 60 seconds',
        'Target: '+r.target.toFixed(2)+' Mbps EACH direction (100 kbps per call)',
        'Delivered upload: '+shown(upRate)+' Mbps (server-confirmed); download: '+shown(downRate)+' Mbps',
        'Loaded WebSocket RTT: median '+shown(median(r.rtts))+' ms; p95 '+shown(p95)+' ms',
        'RTT jitter (round-trip variation): '+shown(variation(r.rtts))+' ms; replies: '+r.rtts.length+'/'+r.probesSent,
        'Longest received-frame gap: '+shown(r.maxGap)+' ms',
        'Pacing skips: browser '+r.skipped+', server '+r.serverSkips+'; maximum observed upload queue: '+r.maxQueue+' bytes',
        'Packet loss: not measurable with this TCP test; retransmissions can conceal lost packets.',
        ...notes,'Aggregated synthetic traffic over one reliable WebSocket (TCP), not separate SIP/RTP calls. No audio, UDP packet-loss, one-way jitter or MOS measurement. Late delivery may be masked by TCP retransmission.'].join('\n');
      $('voip-output').textContent=text; $('voip-status').textContent=notes.length?'Simulation complete — delivery/pacing notes below.':'Simulation complete — review results below.';
      $('voip-bar').style.width='100%'; $('voip-time').textContent='60-second simulation complete'; $('voip-gap').textContent=shown(r.maxGap); publish(text);
    } catch(e) { $('voip-status').textContent=e.message; }
    finally { clearInterval(pacing);clearInterval(probes);clearTimeout(watchdog);if(socket) socket.close();lock(null); }
  };
}`;
