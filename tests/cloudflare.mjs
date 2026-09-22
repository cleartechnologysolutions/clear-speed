import vm from 'node:vm';
import assert from 'node:assert/strict';
import {CLIENT} from '../client.js';
const summary={download:800e6,upload:120e6,latency:12,jitter:2,downLoadedLatency:30,upLoadedLatency:40,totalDurationMs:20000};
function setup(){
 const els=new Map();let instance;
 const el=id=>{if(!els.has(id))els.set(id,{style:{},textContent:'',value:'10',classList:{add(){},remove(){}}});return els.get(id);};
 class Engine {
  constructor(config){assert.equal(config.autoStart,false);assert.equal(config.logAimApiUrl,null);this.config={...config,measurements:[{type:'latency'},{type:'download'},{type:'upload'},{type:'packetLoss'},{type:'reachability'}]};this.results={getSummary:()=>summary};instance=this;}
  play(){this.played=true;}
  pause(){this.paused=true;}
 }
 const context=vm.createContext({window:{CFEngine:{default:Engine}},document:{getElementById:el,addEventListener(){}},navigator:{},fetch:async()=>({json:async()=>({ip:'192.0.2.1'})}),AbortController,AbortSignal,performance,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,Blob,Uint8Array,Date});
 vm.runInContext('('+CLIENT+')()',context);
 return{el,instance:()=>instance,async start(){const promise=el('cf-start').onclick();for(let n=0;n<10;n++)await Promise.resolve();return {promise};}};
}
{
 const h=setup();h.el('download').textContent='900';h.el('upload').textContent='150';const{promise}=await h.start();
 assert.equal(h.el('start').disabled,true);assert.equal(h.el('voip-start').disabled,true);
 assert.deepEqual(Array.from(h.instance().config.measurements,m=>m.type),['latency','download','upload']);
 await h.el('start').onclick();assert.equal(h.el('download').textContent,'900','other test cannot start while running');
 h.instance().onResultsChange({type:'download'});assert.equal(h.el('cf-download').textContent,'800');
 h.instance().onFinish(h.instance().results);await promise;
 assert.equal(h.el('start').disabled,false);assert.equal(h.el('download').textContent,'900');assert.equal(h.el('upload').textContent,'150');
 assert.equal(h.el('cf-loaded-down').textContent,'30.0');assert.match(h.el('report').textContent,/Cloudflare official/);
 console.log('PASS official config, Mbps conversion, loaded latency, independent results, exclusive run lock');
}
for(const mode of ['cancel','error','incomplete']) {
 const h=setup(),{promise}=await h.start();
 if(mode==='cancel')h.el('stop').onclick();
 if(mode==='error')h.instance().onError('network error');
 if(mode==='incomplete')h.instance().onFinish({getSummary:()=>({latency:5})});
 await promise;assert.ok(h.instance().paused);assert.equal(h.el('cf-download').textContent,'—');assert.equal(h.el('report').textContent,'');assert.equal(h.el('voip-start').disabled,false);
 // Late results from a canceled instance must not update cards.
 h.instance().onResultsChange({type:'download'});assert.equal(h.el('cf-download').textContent,'—');
 console.log('PASS Cloudflare '+mode+' aborts and does not publish a completed result');
}
