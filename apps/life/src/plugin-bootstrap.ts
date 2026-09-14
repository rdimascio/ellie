const CHILD_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";

/** Builds the opaque child document. This bootstrap always precedes untrusted plugin markup. */
export function pluginChildDocument(pluginId: string, pluginHtml: string): string {
  const bootstrap = `(() => {
const pluginId=${JSON.stringify(pluginId)},upstream=new MessageChannel(),pending=new Map(),sendWindow=window.postMessage.bind(window);
let hostPort=upstream.port2,sequence=0,closed=false;
parent.postMessage({type:'ellie:child-port',pluginId},'*',[upstream.port1]);
const fail=(entry,message)=>{clearTimeout(entry.timer);entry.reject(new Error(message))};
const canonical=value=>{const seen=new WeakSet(),visit=item=>{if(item===null||typeof item==='string'||typeof item==='boolean')return;if(typeof item==='number'){if(Number.isFinite(item))return;throw 0}if(typeof item!=='object')throw 0;if(seen.has(item)||Object.prototype.hasOwnProperty.call(item,'toJSON'))throw 0;const prototype=Object.getPrototypeOf(item);if(prototype!==Object.prototype&&prototype!==null&&prototype!==Array.prototype)throw 0;seen.add(item);if(Array.isArray(item)){for(const child of item)visit(child)}else for(const key of Object.keys(item))visit(item[key]);seen.delete(item)};visit(value);const json=JSON.stringify(value);if(json===undefined||new TextEncoder().encode(json).byteLength>16384)throw 0;return JSON.parse(json)};
const stop=()=>{if(closed)return;closed=true;for(const entry of pending.values())fail(entry,'Plugin page closed.');pending.clear();try{hostPort.close()}catch{}try{legacyLocal.close()}catch{}};
const send=(method,key,value)=>new Promise((resolve,reject)=>{
  if(closed){reject(new Error('Plugin page closed.'));return}
  if(method!=='storage.get'&&method!=='storage.set'&&method!=='mlb.snapshot'){reject(new Error('Invalid plugin request.'));return}
  if(method!=='mlb.snapshot'&&(typeof key!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,511}$/.test(key))){reject(new Error('Invalid storage key.'));return}
  if(pending.size>=32){reject(new Error('Too many pending storage requests.'));return}
  if(method==='storage.set')try{value=canonical(value)}catch{reject(new Error('Storage value must be JSON and no larger than 16 KiB.'));return}
  const id='sdk-'+(++sequence),entry={resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Storage request timed out.'))},5000)};
  if(method==='mlb.snapshot'){clearTimeout(entry.timer);entry.timer=setTimeout(()=>{pending.delete(id);reject(new Error('Plugin request timed out.'))},15000)}
  pending.set(id,entry);const message={id,method};if(key!==undefined)message.key=key;if(method==='storage.set')message.value=value;
  try{hostPort.postMessage(message)}catch{pending.delete(id);fail(entry,'Plugin page closed.')}
});
hostPort.onmessage=event=>{const data=event.data;if(!data||typeof data.id!=='string')return;const entry=pending.get(data.id);if(!entry)return;pending.delete(data.id);clearTimeout(entry.timer);if(data.ok===true)entry.resolve(data.result);else entry.reject(new Error(typeof data.error==='string'?data.error:'Storage request failed.'))};
hostPort.start();
const storage=Object.freeze({get:key=>send('storage.get',key),set:(key,value)=>send('storage.set',key,value).then(()=>undefined)}),sdk=Object.freeze({version:1,storage});
Object.defineProperty(window,'ellie',{value:sdk,writable:false,configurable:false,enumerable:true});
const legacy=new MessageChannel(),legacyLocal=legacy.port1;
legacyLocal.onmessage=event=>{const request=event.data;if(!request||typeof request.id!=='string'||request.id.length<1||request.id.length>120||typeof request.method!=='string'){return}send(request.method,request.key,request.value).then(result=>legacyLocal.postMessage({id:request.id,ok:true,result}),error=>legacyLocal.postMessage({id:request.id,ok:false,error:error instanceof Error?error.message:'Request failed.'}))};
legacyLocal.start();
addEventListener('DOMContentLoaded',()=>{if(!closed)sendWindow({type:'ellie:connect',pluginId},'*',[legacy.port2])},{once:true});
addEventListener('pagehide',stop,{once:true});
})()`;
  return `<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(CHILD_POLICY)}><script>${bootstrap}</script>${pluginHtml}`;
}
