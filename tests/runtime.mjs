import {Miniflare} from 'miniflare';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.argv[2]||'.test-build/index.js','utf8');
const bundled=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const html=await(await bundled.default.fetch(new Request('https://example.test/'),{})).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];assert.ok(!script.includes('__name'));new vm.Script(script);
console.log('PASS deployment bundle browser script');
const mf=new Miniflare({modules:true,script:source,compatibilityDate:'2026-05-15'});let timer;
try{
 assert.equal((await mf.dispatchFetch('http://localhost/')).status,200);
 const{token}=await(await mf.dispatchFetch('http://localhost/session',{method:'POST'})).json();
 const ack=await(await mf.dispatchFetch('http://localhost/upload?token='+token,{method:'POST',body:new Uint8Array(12345)})).json();assert.equal(ack.received,12345);
 console.log('PASS Worker runtime homepage and upload acknowledgement');
 const response=await mf.dispatchFetch('http://localhost/voip?calls=10&token='+token,{headers:{Upgrade:'websocket',Origin:'http://localhost'}});
 assert.equal(response.status,101);const ws=response.webSocket;ws.binaryType='arraybuffer';ws.accept();let bytes=0;
 const summary=await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('timeout')),70000);
  ws.addEventListener('close',e=>{if(e.code!==1000)reject(Error('Closed: '+e.code+' '+e.reason));});
  ws.addEventListener('message',e=>{
   if(typeof e.data!=='string'){bytes+=e.data.byteLength;ws.send(e.data);return;}
   const d=JSON.parse(e.data);if(d.type==='summary')resolve(d);
  });ws.send(JSON.stringify({type:'start'}));
 });
 assert.ok(bytes>6e6&&bytes<8e6);assert.equal(summary.sent,bytes);assert.ok(summary.received>6e6);
 console.log('PASS Worker runtime 60-second duplex simulation',JSON.stringify(summary));
}finally{clearTimeout(timer);await mf.dispose();}
