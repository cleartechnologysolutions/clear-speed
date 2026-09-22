// One short-lived aggregate two-way call-equivalent load; no storage or Durable Object.
export function voipResponse(request) {
  if(request.headers.get('upgrade')?.toLowerCase()!=='websocket') return new Response('WebSocket required',{status:426});
  const origin=request.headers.get('origin');
  if(origin!==new URL(request.url).origin) return new Response('Origin not allowed',{status:403});
  const calls=Number(new URL(request.url).searchParams.get('calls'));
  if(!Number.isInteger(calls)||calls<1||calls>100) return new Response('Call count must be 1–100',{status:400});
  const pair=new WebSocketPair(), client=pair[0], server=pair[1]; server.binaryType="arraybuffer"; server.accept();
  const size=calls*250, frame=crypto.getRandomValues(new Uint8Array(size));
  let started=0, received=0, sent=0, ticks=0, skipped=0, timer, end, probes=0, closed=false;
  function clean() { closed=true;clearInterval(timer);clearTimeout(end);clearTimeout(watchdog); }
  function close(code=1000,reason='Complete') {clean();try{server.close(code,reason);}catch{}}
  const watchdog=setTimeout(()=>close(1008,'Session time limit'),65000);
  server.addEventListener('close',clean); server.addEventListener('error',clean);
  server.addEventListener('message',event=>{
    if(closed) return;
    try {
      if(typeof event.data==='string') {
        if(event.data.length>160) return close(1008,'Invalid control message');
        const data=JSON.parse(event.data);
        if(data.type==='start'&&!started) {
          started=Date.now(); server.send(JSON.stringify({type:'ready'}));
          timer=setInterval(()=>{
            try {
              const due=Math.floor((Date.now()-started)/20);
              if(due<=ticks||due>3000) return;
              skipped+=Math.max(0,due-ticks-1);ticks=due;server.send(frame);sent+=size;
            } catch {close(1011,'Send failed');}
          },20);
          end=setTimeout(()=>{
            clearInterval(timer);
            try {server.send(JSON.stringify({type:'summary',received,sent,duration:Date.now()-started,skipped}));}catch{}
            close();
          },60000);
        } else if(data.type==='probe'&&started&&Number.isInteger(data.id)&&++probes<=70) server.send(JSON.stringify({type:'pong',id:data.id}));
        else close(1008,'Invalid control message');
      } else {
        if(!started||event.data.byteLength!==size||received+size>size*3050) return close(1008,'Simulation traffic limit');
        received+=size;
      }
    } catch {close(1008,'Invalid message');}
  });
  return new Response(null,{status:101,webSocket:client});
}
