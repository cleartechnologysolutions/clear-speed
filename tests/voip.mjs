import vm from 'node:vm';
import assert from 'node:assert/strict';
import {CLIENT} from '../client.js';
const browserApp={toString:()=>CLIENT};
import {voipResponse} from '../voip.js';
async function simulate(calls,mode='normal') {
 let now=100,id=0;const timers=new Map(),els=new Map(),listeners={};let lastServer,activeSockets=0;
 const schedule=(fn,ms,repeat=false)=>{const k=++id;timers.set(k,{fn,ms,at:now+ms,repeat});return k;};const clear=k=>timers.delete(k);
 class Socket {
  constructor(){this.listeners={};this.readyState=1;this.bufferedAmount=0;this.binaryType="blob";}
  accept(){}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  emit(type,event={}){this['on'+type]?.(event);for(const fn of this.listeners[type]||[])fn(event);}
  send(data){if(this.readyState!==1)throw Error('closed');const copy=typeof data==='string'?data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);schedule(()=>{if(this.other.readyState===1)this.other.emit('message',{data:typeof copy==='string'||this.other.binaryType==='arraybuffer'?copy:new Blob([copy])});},0);}
  close(){if(this.closing||this.readyState===3)return;this.closing=true;schedule(()=>{this.readyState=3;this.emit('close');if(this.other.readyState!==3){this.other.readyState=3;this.other.emit('close');}},0);}
 }
 const context=vm.createContext({Request,URL,ArrayBuffer,Uint8Array,Blob,AbortController,AbortSignal,Error,Number,Math,Map,Set,crypto:globalThis.crypto,
  Date:class extends Date {static now(){return now;}},performance:{now:()=>now},
  setTimeout:(fn,ms)=>schedule(fn,ms),clearTimeout:clear,setInterval:(fn,ms)=>schedule(fn,ms,true),clearInterval:clear,
  Response:class {constructor(body,opts){Object.assign(this,opts);}},
  WebSocketPair:class {constructor(){const a=new Socket(),b=new Socket();a.other=b;b.other=a;this[0]=a;this[1]=b;lastServer=b;}},
  document:{getElementById(id){if(!els.has(id))els.set(id,{textContent:'',value:String(calls),style:{}});return els.get(id);},addEventListener(type,fn){listeners[type]=fn;}},navigator:{},location:{protocol:'https:',host:'test.example'},
  fetch:async()=>({ok:true,json:async()=>({token:'abc',ip:'192.0.2.1'})})});
 vm.runInContext('globalThis.voipResponse='+voipResponse.toString(),context);
 context.WebSocket=class {
  static OPEN=1;
  constructor(url){assert.ok(url.startsWith('wss://test.example/voip?'));
   const response=context.voipResponse(new Request(url.replace('wss:','https:'),{headers:{upgrade:'websocket',origin:'https://test.example'}}));
   assert.equal(response.status,101);const socket=response.webSocket;activeSockets++;schedule(()=>socket.emit('open'),0);
   if(mode==='disconnect')schedule(()=>socket.close(),1000);
   if(mode==='queue')socket.bufferedAmount=1e6;
   return socket;
  }
 };
 vm.runInContext('('+browserApp.toString()+')()',context);
 let done=false;const operation=els.get('voip-start').onclick().then(()=>done=true);
 if(mode==='cancel')schedule(()=>els.get('stop').onclick(),1000);
 for(let n=0;n<30000&&!done;n++){
  for(let j=0;j<30;j++)await Promise.resolve();if(done)break;
  const next=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];assert.ok(next);const[k,t]=next;now=t.at;if(t.repeat)t.at+=t.ms;else timers.delete(k);t.fn();
 }
 await operation; for(const[k,t] of [...timers]) if(!t.repeat&&t.at===now){timers.delete(k);t.fn();} assert.ok(done);if(activeSockets)assert.equal(els.get('start').disabled,false);if(activeSockets)assert.equal(els.get('stop').disabled,true);
 if(activeSockets)assert.equal(lastServer.readyState,3);
 assert.equal(timers.size,0,'All pacing/watchdog timers must be cleaned up');
 return Object.fromEntries([...els].map(([k,v])=>[k,v.textContent]));
}
for(const calls of [1,10,100]) {
 const r=await simulate(calls);assert.match(r['voip-status'],/Simulation complete/);assert.ok(r['voip-output'].includes('Target: '+(calls*.1).toFixed(2)+' Mbps EACH'));
 const match=r['voip-output'].match(/Delivered upload: ([\d.]+) Mbps.*download: ([\d.]+) Mbps/);assert.ok(match);assert.ok(Math.abs(Number(match[1])-calls*.1)<.02);assert.ok(Math.abs(Number(match[2])-calls*.1)<.02);console.log('PASS '+calls+' call-equivalent pacing, acknowledged duplex rates, completed report, timer cleanup');
}
for(const mode of ['disconnect','cancel']) {const r=await simulate(10,mode);assert.ok(!r['voip-status'].includes('complete —'));assert.equal(r.report,undefined);console.log('PASS '+mode+' leaves no completed simulation');}
const queued=await simulate(10,'queue');assert.match(queued['voip-output'],/below 95%/);console.log('PASS excessive browser queue suppresses sends and flags under-delivered load');
const invalid=await simulate(101);assert.match(invalid['voip-status'],/1 to 100/);console.log('PASS invalid call count rejected before connecting');
