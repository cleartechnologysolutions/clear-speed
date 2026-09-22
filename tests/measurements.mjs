import assert from 'node:assert/strict';
import vm from 'node:vm';
import {CLIENT} from '../client.js';
const browserApp={toString:()=>CLIENT};
import worker from '../index.js';
function harness(mode='normal') {
  let now=100, id=0, uploadCount=0;const timers=new Map(), elements=new Map();
  const schedule=(fn,ms,repeat=false)=>{const key=++id;timers.set(key,{fn,ms,at:now+ms,repeat});return key;};
  const clear=key=>timers.delete(key);
  const wait=(ms,signal)=>new Promise((resolve,reject)=>{
    const key=schedule(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    function abort(){clear(key);reject(signal.reason);} if(signal?.aborted) abort();else signal?.addEventListener('abort',abort,{once:true});
  });
  const element=id=>{if(!elements.has(id))elements.set(id,{style:{},textContent:'',value:'10'});return elements.get(id);};
  const fetch=async(path,options={})=>{
    const u=new URL(path,'https://test.example');
    if(u.host.includes('ipify'))return {json:async()=>({ip:'192.0.2.1'})};
    if(u.pathname==='/upload'){
      uploadCount++; await wait(uploadCount===1?50:500,options.signal);
      if(mode==='upload-fail'&&uploadCount>1)return {ok:false,status:429,json:async()=>({error:'Rate limit reached'})};
      return {ok:true,json:async()=>({received:options.body.size+(mode==='bad-ack'?1:0)})};
    }
    if(u.pathname==='/download'){
      const size=Number(u.searchParams.get('bytes'));let received=0;
      return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0),body:{getReader:()=>({read:async()=>{
        if(received===size)return{done:true};
        await wait(mode==='stall'?50000:100,options.signal);
        const n=Math.min(size-received,125000);received+=n;return{done:false,value:{byteLength:n}};
      }})}};
    }
    return {ok:true,json:async()=>({token:'t'})};
  };
  const context=vm.createContext({document:{getElementById:element,addEventListener(){}},navigator:{},location:{protocol:'https:',host:'test.example'},fetch,performance:{now:()=>now},
    crypto:globalThis.crypto,Uint8Array,Blob,AbortController,AbortSignal,Error,Number,Math,Date,Map,Set,
    setTimeout:(fn,ms)=>schedule(fn,mode==='late-timer'&&ms===10000?12000:ms),clearTimeout:clear,
    setInterval:(fn,ms)=>schedule(fn,ms,true),clearInterval:clear});
  const source=browserApp.toString().replace(/}\s*$/,'globalThis.api={download,upload,rate,median};}');vm.runInContext('('+source+')()',context);
  async function run(promise){let done=false,value,error;promise.then(x=>{done=true;value=x},e=>{done=true;error=e});
    for(let n=0;n<10000&&!done;n++){
      for(let k=0;k<30;k++)await Promise.resolve();if(done)break;
      const next=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];assert.ok(next,'No timer while promise pending');
      const [key,t]=next;now=t.at;if(t.repeat)t.at+=t.ms;else timers.delete(key);t.fn();
    }
    assert.ok(done,'Simulation did not finish');if(error)throw error;return value;
  }
  return {api:context.api,run};
}
const signal=()=>new AbortController().signal;
{
  const h=harness();assert.equal(h.api.rate(125000000,1000),1000);assert.equal(h.api.median([10,20]),15);
  const d=await h.run(h.api.download('t',signal()));assert.equal(d.ms,10000);assert.ok(d.speed>59&&d.speed<=60);console.log('PASS known 60 Mbps aggregate download, real 10 s denominator');
}
{
 const h=harness('late-timer'),d=await h.run(h.api.download('t',signal()));assert.equal(d.ms,12000);assert.ok(d.speed<=60);console.log('PASS delayed deadline uses 12 s, never clamps to 10 s');
}
{
 const h=harness('stall');await assert.rejects(h.run(h.api.download('t',signal())),/No download data/);console.log('PASS stalled downloads stop on independent deadline');
}
{
 const h=harness(),u=await h.run(h.api.upload('t',signal()));assert.ok(u.bytes>0);assert.ok(u.ms>=10000&&u.ms<=10500);assert.equal(u.speed,u.bytes*8/u.ms/1000);console.log('PASS upload waits for confirmations and measures full elapsed time');
}
for(const [mode,message] of [['upload-fail',/Rate limit/],['bad-ack',/acknowledgement/]]) {
 const h=harness(mode);await assert.rejects(h.run(h.api.upload('t',signal())),message);console.log('PASS rejects '+mode);
}
{
 const request=new Request('https://test.example/');request.cf={colo:'DFW',city:'Client City',region:'Client Region',asOrganization:'<img src=x>'};
 const html=await (await worker.fetch(request,{})).text();assert.ok(html.includes('Cloudflare edge DFW'));assert.ok(!html.includes('Client City'));assert.ok(html.includes('&lt;img src=x&gt;'));assert.ok(html.includes('value="10"'));new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
 const session=await(await worker.fetch(new Request('https://test.example/session',{method:'POST'}),{})).json();
 const upload=await worker.fetch(new Request('https://test.example/upload?token='+session.token,{method:'POST',body:new Uint8Array(4321)}),{});assert.deepEqual(await upload.json(),{received:4321});
 assert.equal((await worker.fetch(new Request('https://test.example/download?token=bad'),{})).status,403);
 console.log('PASS rendered script, escaping, edge label, token gating, actual server upload byte count');
}
