(function(){
'use strict';
const VERSION='1.2';
const ICON='icon-192.png';
const $app=document.getElementById('app');
const $tabs=document.getElementById('tabs');
const $file=document.getElementById('filePick');
const $json=document.getElementById('jsonPick');
const S={settings:{},invoices:[],nights:[],units:{}};
let view={name:'boot'};
let draft=null;          // invoice / night being edited
let pasteQueue=[];       // more sheets from one Claude paste, opened one by one
let pasteText='',pasteErr='';
let readyBackup=null;    // prepared backup file waiting to be saved
let IDB=null;

// ---------- helpers ----------
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>(n<0?'−':'')+'S$'+Math.abs(Number(n)||0).toLocaleString('en-SG',{minimumFractionDigits:2,maximumFractionDigits:2});
const signed=n=>(n>0?'+':'')+money(n);
const num=v=>{const x=parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,''));return isFinite(x)?x:0;};
const r2=n=>Math.round((Number(n)||0)*100)/100;
const fmtQ=n=>{n=Number(n)||0;return Number.isInteger(n)?String(n):String(r2(n));};
function ymd(d){d=d||new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function parseYmd(s){const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);}
function addDays(s,n){const d=parseYmd(s);d.setDate(d.getDate()+n);return ymd(d);}
const WD=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
function niceDate(s){const d=parseYmd(s);return (d.getMonth()+1)+'月'+d.getDate()+'日 '+WD[d.getDay()];}
function newId(p){return p+Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
function keyOf(name,unit){return String(name||'').trim()+'|'+String(unit||'').trim();}
function hashId(s){let h=2166136261;for(const c of s){h^=c.codePointAt(0);h=Math.imul(h,16777619)>>>0;}return 'u'+h.toString(36);}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2800);}
function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
async function sha(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('fruit-ledger:'+s));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');}
const isStandalone=()=>window.navigator.standalone===true||(window.matchMedia&&matchMedia('(display-mode: standalone)').matches);
function daysSince(iso){if(!iso)return Infinity;return Math.floor((Date.now()-new Date(iso).getTime())/864e5);}

// ---------- storage: everything lives on this phone (IndexedDB) ----------
const STORES=['invoices','nights','units','settings','photos'];
function openDb(){return new Promise((res,rej)=>{const r=indexedDB.open('fruit-ledger',1);r.onupgradeneeded=()=>{STORES.forEach(s=>{if(!r.result.objectStoreNames.contains(s))r.result.createObjectStore(s);});};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
function tx(stores,mode,fn){return new Promise((res,rej)=>{const t=IDB.transaction(stores,mode);let out;const r=fn(t);if(r&&'onsuccess' in r)r.onsuccess=()=>{out=r.result;};t.oncomplete=()=>res(out);t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error||new Error('abort'));});}
const put=(st,k,v)=>tx([st],'readwrite',t=>t.objectStore(st).put(v,k));
const del=(st,k)=>tx([st],'readwrite',t=>t.objectStore(st).delete(k));
const getv=(st,k)=>tx([st],'readonly',t=>t.objectStore(st).get(k));
function entries(st){return new Promise((res,rej)=>{const out=[];const c=IDB.transaction(st).objectStore(st).openCursor();c.onsuccess=()=>{const cur=c.result;if(cur){out.push([cur.key,cur.value]);cur.continue();}else res(out);};c.onerror=()=>rej(c.error);});}
const DEFAULTS={fixedFee:1000,pinHash:'',apiKey:'',model:'gemini-3.8-flash',lastBackup:''};
async function loadAll(){
  S.settings=Object.assign({},DEFAULTS,(await getv('settings','main'))||{});
  S.invoices=(await entries('invoices')).map(([k,v])=>Object.assign({},v,{id:k}));
  S.nights=(await entries('nights')).map(([k,v])=>Object.assign({},v,{id:k}));
  const u={};(await entries('units')).forEach(([k,v])=>{u[v.supplier+'|'+v.name]=v.unit;});S.units=u;
}
async function saveSettings(patch){S.settings=Object.assign({},S.settings,patch);await put('settings','main',S.settings);}
function strip(o){const c=Object.assign({},o);delete c.id;return c;}
async function putDoc(coll,id,doc){await put(coll,id,doc);const arr=S[coll];const v=Object.assign({},doc,{id});const i=arr.findIndex(x=>x.id===id);if(i>=0)arr[i]=v;else arr.push(v);}
async function delDoc(coll,id){await del(coll,id);S[coll]=S[coll].filter(x=>x.id!==id);}
async function savePhoto(blob){if(!blob)return '';const id=newId('p');try{await put('photos',id,blob);return id;}catch(e){console.warn(e);return '';}}
async function photoUrl(id){if(!id)return '';try{const b=await getv('photos',id);return b?URL.createObjectURL(b):'';}catch(e){return '';}}
const hasData=()=>S.invoices.length||S.nights.length;

// ---------- data ----------
function invoicesOn(date){return S.invoices.filter(x=>x.date===date);}
function nightOn(date){return S.nights.find(x=>x.date===date)||null;}
function prevNight(date){return S.nights.filter(x=>x.date<date).sort((a,b)=>a.date<b.date?1:-1)[0]||null;}
function purchaseOn(date){return r2(invoicesOn(date).reduce((a,x)=>a+num(x.total),0));}
function openingFor(date){
  const m=new Map();const pn=prevNight(date);
  if(pn)(pn.rows||[]).forEach(r=>{if(num(r.left)>0){const k=keyOf(r.name,r.unit);m.set(k,{name:r.name,unit:r.unit,qty:(m.get(k)?.qty||0)+num(r.left)});}});
  invoicesOn(date).forEach(iv=>(iv.items||[]).forEach(it=>{const k=keyOf(it.name,it.unit);m.set(k,{name:it.name,unit:it.unit,qty:(m.get(k)?.qty||0)+num(it.qty)});}));
  return m;
}
function unlocked(){const v=lsGet('fl_unlock');if(!v)return false;const [t,h]=v.split(':');return h===S.settings.pinHash.slice(0,16)&&Date.now()-Number(t)<30*864e5;}
function decideStart(){
  if(!S.settings.pinHash&&!hasData())go({name:'welcome'});
  else if(!S.settings.pinHash)go({name:'setpin'});
  else if(!unlocked())go({name:'login'});
  else go({name:'home'});
}

// ---------- photos ----------
function pickFile(input){return new Promise(res=>{input.value='';input.onchange=()=>res(input.files&&input.files[0]||null);input.click();});}
async function shrink(file){
  try{
    const bmp=await createImageBitmap(file);
    const max=1600,sc=Math.min(1,max/Math.max(bmp.width,bmp.height));
    const c=document.createElement('canvas');c.width=Math.round(bmp.width*sc);c.height=Math.round(bmp.height*sc);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(b=>r(b||file),'image/jpeg',0.85));
  }catch(e){return file;}
}
function blobToB64(blob){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result).split(',')[1]||'');fr.onerror=()=>rej(fr.error);fr.readAsDataURL(blob);});}
async function b64ToBlob(b64,type){const r=await fetch('data:'+(type||'image/jpeg')+';base64,'+b64);return await r.blob();}

// ---------- AI (Google Gemini, called straight from this phone) ----------
const API='https://generativelanguage.googleapis.com/v1beta/models/';
function aiErr(code,detail){const e=new Error(code);e.code=code;e.detail=detail||'';return e;}
async function callGemini(body,model){
  const key=(S.settings.apiKey||'').trim();if(!key)throw aiErr('no_key');
  let r;
  try{r=await fetch(API+encodeURIComponent(model)+':generateContent',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body)});}
  catch(e){throw aiErr('offline');}
  if(r.ok)return await r.json();
  let msg='';try{const j=await r.json();msg=(j.error&&j.error.message)||'';}catch(e){}
  if(r.status===400&&/thinking/i.test(msg))throw aiErr('bad_thinking',msg);
  if(r.status===400&&/api key/i.test(msg))throw aiErr('bad_key',msg);
  if(r.status===401||r.status===403)throw aiErr('bad_key',msg);
  if(r.status===404)throw aiErr('bad_model',msg);
  if(r.status===429)throw aiErr('rate_limited',msg);
  if(r.status>=500)throw aiErr('busy',msg);
  throw aiErr('http_'+r.status,msg);
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function aiProgress(t){const el=document.getElementById('aiStatus');if(el)el.textContent=t;}
let backupModels=null; // other Flash models this key can use, found once per session
async function findBackupModels(main){
  if(backupModels)return backupModels;
  try{
    const r=await fetch(API.replace(/\/$/,'')+'?pageSize=200',{headers:{'x-goog-api-key':S.settings.apiKey.trim()}});
    const j=await r.json();
    const ver=n=>{const m=n.match(/(\d+(?:\.\d+)?)/);return m?parseFloat(m[1]):0;};
    backupModels=(j.models||[])
      .filter(m=>(m.supportedGenerationMethods||[]).includes('generateContent'))
      .map(m=>String(m.name||'').replace(/^models\//,''))
      .filter(n=>/^gemini-[\d.]+-flash/.test(n)&&!/tts|image|audio|live|cyber|computer|embed|exp|thinking|preview-\d\d-\d\d/.test(n)&&n!==main)
      .sort((a,b)=>ver(b)-ver(a)||(a.includes('lite')?1:0)-(b.includes('lite')?1:0)||a.length-b.length)
      .slice(0,3);
  }catch(e){backupModels=[];}
  return backupModels;
}
async function callOnce(body,model){
  try{return await callGemini(body,model);}
  catch(e){if(e.code==='bad_thinking'&&body.generationConfig.thinkingConfig){delete body.generationConfig.thinkingConfig;return await callGemini(body,model);}throw e;}
}
async function callWithRetry(body){
  const main=(S.settings.model||DEFAULTS.model).trim();
  let last;
  // 1) main model, up to 3 tries with short waits
  for(const wait of [0,3000,8000]){
    if(wait){aiProgress('Google 的 AI 有点忙，'+(wait/1000)+' 秒后自动再试…');await sleep(wait);}
    try{return await callOnce(JSON.parse(JSON.stringify(body)),main);}
    catch(e){last=e;if(!['busy','rate_limited','bad_model'].includes(e.code))throw e;if(e.code==='bad_model')break;}
  }
  // 2) another Flash model
  for(const m of await findBackupModels(main)){
    aiProgress('换另一个 AI 型号（'+m+'）来读…');
    try{const j=await callOnce(JSON.parse(JSON.stringify(body)),m);return j;}
    catch(e){last=e;if(!['busy','rate_limited','bad_model'].includes(e.code))throw e;}
  }
  throw last;
}
async function aiJson(prompt,blob){
  const b64=await blobToB64(blob);
  const body={contents:[{role:'user',parts:[{inline_data:{mime_type:blob.type||'image/jpeg',data:b64}},{text:prompt}]}],
    generationConfig:{responseMimeType:'application/json',temperature:0.2,thinkingConfig:{thinkingLevel:'low'}}};
  const j=await callWithRetry(body);
  const cand=j.candidates&&j.candidates[0];
  if(!cand){throw aiErr(j.promptFeedback&&j.promptFeedback.blockReason?'blocked':'empty');}
  const text=((cand.content&&cand.content.parts)||[]).filter(p=>!p.thought&&p.text).map(p=>p.text).join('').trim();
  const clean=text.replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
  try{return JSON.parse(clean);}catch(e){throw aiErr('invalid_json');}
}
async function testKey(key,model){
  try{
    const r=await fetch(API+encodeURIComponent(model),{headers:{'x-goog-api-key':key}});
    if(r.ok)return {ok:true};
    let msg='';try{msg=(await r.json()).error.message||'';}catch(e){}
    if(r.status===404)return {ok:false,why:'找不到「'+model+'」这个 AI 型号。'};
    if(r.status===400||r.status===401||r.status===403)return {ok:false,why:'这把钥匙用不了，请检查有没有复制完整。'};
    if(r.status===429)return {ok:true,note:'钥匙可以用，但现在 AI 太忙，稍后再拍单。'};
    return {ok:false,why:'Google 回复了错误（'+r.status+'）'+(msg?'：'+msg:'')};
  }catch(e){return {ok:false,why:'连不上 Google，请检查网络。'};}
}
function errText(e){
  const c=e&&e.code;
  if(c==='no_key')return '还没有设定 AI 钥匙。请到「设置」填好 Gemini 钥匙，现在可以先在下面手动输入。';
  if(c==='bad_key')return 'AI 钥匙用不了。请到「设置」重新贴上钥匙，现在可以先手动输入。';
  if(c==='bad_model')return '设置里的 AI 型号名称不对，请到「设置」检查。';
  if(c==='rate_limited')return 'AI 免费额度暂时用完或太频繁，请过一两分钟再试，或手动输入。';
  if(c==='busy')return 'Google 的 AI 现在太忙，已经自动试了几次和换了型号都不行。请过几分钟再拍一次，或先手动输入。';
  if(c==='offline')return '连不上网络，请检查后再试，或手动输入。';
  if(c==='invalid_json'||c==='empty')return 'AI 没读懂这张照片，请拍清楚一点再试，或手动输入。';
  if(c==='blocked')return 'AI 拒绝读这张照片，请换一张再试。';
  return 'AI 读单失败（'+(c||'未知原因')+'），请再试一次或手动输入。';
}
function aiInvoice(blob){
  const known=Object.entries(S.units).slice(0,150).map(([k,u])=>k.replace('|',' 的 ')+'：'+u).join('\n');
  const prompt=`你在帮一位新加坡水果批发/零售商读供应商的进货单照片。单据大多是华文，少数是马来文，货币是新币（S$）。
请把照片里的内容整理成 JSON，只回 JSON，格式：
{"supplier":"供应商名称（照单上写的）","invoiceNo":"单号","date":"YYYY-MM-DD（看不到就留空）","items":[{"name":"水果名称","qty":数字,"unit":"单位","price":单价数字,"subtotal":小计数字,"unsure":false,"question":""}],"total":单上的合计数字,"note":""}
规则：
- 水果名称统一写简体中文常用名（例如 pisang→香蕉、epal→苹果、oren→橙、tembikai→西瓜、nanas→菠萝、anggur→葡萄、mangga→芒果），品种可以放在括号里。
- 单位用简体中文：箱、公斤、粒、盒、串、篮、包、斤 等。马来文 kotak=箱、kg=公斤、biji=粒。
- 单上印的货币就算是 RM，也当作新币数字照抄，不要换算。
- 单位看不清楚时，先参考下面这位老板之前确认过的单位；还是不确定，就按水果批发常识填一个最可能的，并把 unsure 设为 true，在 question 里用一句简体中文问老板（例如「西瓜是按粒还是按箱？」）。
- 数字看不清楚也设 unsure 为 true 并写 question。
- 小计 = 数量 × 单价；如果单上写的小计和算出来不同，用单上的，并在 question 说明。
- 不是水果的费用（运费、箱子押金等）也列成一项，name 写清楚。
之前确认过的单位（供应商 的 水果：单位）：
${known||'（还没有）'}`;
  return aiJson(prompt,blob);
}
function aiLeftover(blob,opening){
  const list=Array.from(opening.values()).map(o=>o.name+'（'+o.unit+'）').join('、');
  const prompt=`这是一位水果店老板晚上手写的「剩货单」照片，写的是今晚每样水果还剩多少。只回 JSON：
{"items":[{"name":"水果名称","qty":数字,"unit":"单位","unsure":false,"question":""}]}
规则：
- 尽量把名称对应到今天店里有的水果：${list||'（没有资料）'}。对应到了就用完全一样的名称和单位。
- 如果手写的单位和上面不同（例如写公斤但店里是按箱），照手写的填，并设 unsure 为 true，在 question 用一句简体中文说明。
- 字看不清楚也设 unsure 为 true 并写 question。
- 名称用简体中文。`;
  return aiJson(prompt,blob);
}

// ---------- navigation ----------
function go(v){view=v;render();window.scrollTo(0,0);}
$tabs.addEventListener('click',e=>{const b=e.target.closest('button[data-tab]');if(b){if(b.dataset.tab==='home')homeDate=null;go({name:b.dataset.tab});}});
function setTabs(active){
  const show=['home','records','suggest','settings','day'].includes(view.name);
  $tabs.hidden=!show;
  $tabs.querySelectorAll('button').forEach(b=>{if(b.dataset.tab===active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
}
function render(){
  const fn={welcome:vWelcome,setpin:vSetPin,login:vLogin,home:vHome,records:vRecords,day:vDay,suggest:vSuggest,settings:vSettings,invoice:vInvoice,night:vNight,paste:vPaste}[view.name];
  if(fn)fn();
  setTabs(view.name==='day'?'records':view.name);
}
const back=label=>`<div class="back"><button type="button" data-act="back" aria-label="返回"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button><h1>${label}</h1></div>`;

// ---------- screens: welcome / password ----------
function vWelcome(){
  $app.innerHTML=`<div class="wrap"><div class="welcome"><img src="${ICON}" alt="水果账本图示"><div><h1>水果账本</h1><p class="sub">欢迎！你之前有用过旧账本吗？</p></div>
  <div class="btns"><button type="button" class="btn primary" data-act="importStart">导入旧资料（用备份文件）</button>
  <button type="button" class="btn" data-act="freshStart">第一次用，从新开始</button></div>
  <p class="sub" style="max-width:340px">导入后，旧账本的密码照样可以用。</p></div></div>`;
}
function vSetPin(){
  $app.innerHTML=`<div class="wrap"><div class="login"><img src="${ICON}" alt="水果账本图示"><div><h1>水果账本</h1><p class="sub">请设一个密码</p></div>
  <form id="f"><label class="f" for="p1">新密码（至少 4 位）<input class="in" id="p1" type="password" autocomplete="new-password" required minlength="4"></label>
  <label class="f" for="p2">再输入一次<input class="in" id="p2" type="password" autocomplete="new-password" required minlength="4"></label>
  <p class="sub" id="msg" role="alert"></p><button class="btn primary" type="submit">设好了，进入账本</button></form></div></div>`;
  document.getElementById('f').onsubmit=async e=>{e.preventDefault();const a=p1.value,b=p2.value;const m=document.getElementById('msg');
    if(a.length<4){m.textContent='密码至少 4 位';return;}if(a!==b){m.textContent='两次输入的不一样，请再输入一次';return;}
    const h=await sha(a);await saveSettings({pinHash:h});lsSet('fl_unlock',Date.now()+':'+h.slice(0,16));go({name:'home'});};
}
function vLogin(){
  $app.innerHTML=`<div class="wrap"><div class="login"><img src="${ICON}" alt="水果账本图示"><div><h1>水果账本</h1><p class="sub">只有你能进入</p></div>
  <form id="f"><label class="f" for="pw">密码<input class="in" id="pw" type="password" autocomplete="current-password" required></label>
  <p class="sub" id="msg" role="alert"></p><button class="btn primary" type="submit">登录</button><p class="sub" style="text-align:center">登录后 30 天内这台手机不用再输入密码</p></form></div></div>`;
  document.getElementById('f').onsubmit=async e=>{e.preventDefault();const h=await sha(pw.value);
    if(h===S.settings.pinHash){lsSet('fl_unlock',Date.now()+':'+h.slice(0,16));go({name:'home'});}else{document.getElementById('msg').textContent='密码不对，请再试一次';pw.value='';}};
}

// ---------- screens: home ----------
function daySummary(date){
  const pur=purchaseOn(date),n=nightOn(date),fee=num(S.settings.fixedFee);
  const has=n&&n.revenue!=null&&n.revenue!=='';
  return {pur,fee,rev:has?num(n.revenue):null,profit:has?r2(num(n.revenue)-pur-fee):null,n};
}
let homeDate=null;
function setHomeDate(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))return;const t=ymd();if(v>t)v=t;homeDate=(v===t)?null:v;render();}
function notices(){
  const out=[];
  if(!isStandalone()&&lsGet('fl_hideA2HS')!=='1'){
    out.push(`<div class="warn"><div class="cardhead"><strong>先把账本放到手机桌面</strong><button type="button" class="linkbtn" data-act="hideA2HS">知道了</button></div>
    <ol class="steps"><li>用 Safari 打开这个网址</li><li>按下方的「分享」按钮（方框加向上箭头）</li><li>选「加入主画面」，再按「加入」</li></ol>
    以后从桌面的图标打开。只在 Safari 里用的话，太久没开，iPhone 可能会清掉资料。</div>`);
  }
  if(!S.settings.apiKey){
    out.push(`<div class="warn">还没设定 AI 钥匙，拍单后 AI 没办法帮你读。<button type="button" class="linkbtn" data-act="goSettings">去设置</button></div>`);
  }
  const d=daysSince(S.settings.lastBackup);
  if(hasData()&&d>=7){
    out.push(`<div class="warn">资料只存在这台手机里。${d===Infinity?'你还没有备份过':'已经 '+d+' 天没备份了'}，换手机或手机坏了资料就会不见。<button type="button" class="linkbtn" data-act="goSettings">现在备份</button></div>`);
  }
  return out.join('');
}
function vHome(){
  const today=ymd(),t=homeDate||today,isToday=t===today;
  const s=daySummary(t),y=daySummary(addDays(t,-1));
  const ivs=invoicesOn(t);
  const D=isToday?'今天':'这天';
  $app.innerHTML=`<div class="wrap">
  <div class="head" style="align-items:center">
    <div class="datebar">
      <button type="button" class="dnav" data-act="dayPrev" aria-label="前一天"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <label class="datepick" for="pickDay"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg><span>${niceDate(t)}</span><input type="date" id="pickDay" aria-label="选择日期" value="${t}" max="${today}"></label>
      <button type="button" class="dnav" data-act="dayNext" aria-label="后一天" ${isToday?'disabled':''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>
    <img class="logo" src="${ICON}" alt="">
  </div>
  ${isToday?notices():''}
  <div class="row" style="align-items:center"><h1>${isToday?'今天':niceDate(t).split(' ')[0]}</h1>${isToday?'':'<button type="button" class="btn small" data-act="dayToday">回到今天</button>'}</div>
  <div class="card">
    <div class="row"><span class="dim">进货</span><span class="num">${money(s.pur)}</span></div>
    <div class="row"><span class="dim">固定费用</span><span class="num">${money(s.fee)}</span></div>
    <div class="row"><span class="dim">收入</span>${s.rev==null?`<span class="dim">${isToday?'晚上填写':'未填'}</span>`:`<span class="num">${money(s.rev)}</span>`}</div>
    <div class="sep"></div>
    <div class="row"><span class="dim">${D}盈亏</span>${s.profit==null?'<span class="big dim">—</span>':`<span class="big num ${s.profit>=0?'pos':'neg'}">${signed(s.profit)}</span>`}</div>
    ${y.profit!=null?`<div class="sub">${isToday?'昨天':'前一天'}${y.profit>=0?'盈利':'亏损'} <span class="num ${y.profit>=0?'pos':'neg'}" style="font-weight:500">${signed(y.profit)}</span></div>`:''}
  </div>
  <div class="bigbtns">
    <button type="button" class="btn primary bigbtn" data-act="newInvoice"><svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>${isToday?'拍进货单':'补拍这天的单'}</button>
    <button type="button" class="btn bigbtn" data-act="night" data-date="${t}"><svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>${s.n?(isToday?'改今晚结算':'改这天结算'):(isToday?'晚上报剩货':'结算这天')}</button>
  </div>
  <button type="button" class="btn pastebtn" data-act="paste"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3"/></svg>贴上 Claude 读好的单</button>
  <button type="button" class="btn small" data-act="manualInvoice" style="align-self:flex-start">没有照片，手动输入一张单</button>
  <div class="list"><h2>${D}的进货单</h2>
  ${ivs.length?ivs.map(invItem).join(''):`<div class="empty">${D}没有进货单。${isToday?'按上面「拍进货单」拍第一张。':''}</div>`}
  </div>
  ${s.n&&(s.n.rows||[]).length?soldTable(s.n,D+'卖出'):''}
  </div>`;
  const pk=document.getElementById('pickDay');
  pk.addEventListener('change',e=>setHomeDate(e.target.value));
  pk.addEventListener('click',()=>{try{pk.showPicker&&pk.showPicker();}catch(e){}});
}
const soldTable=(n,title)=>`<div class="list"><h2>${title}</h2><div class="tbl ngt"><div class="tr h"><span>水果</span><span>早上有</span><span>卖出</span><span class="r">剩</span></div>${n.rows.map(r=>`<div class="tr"><span>${esc(r.name)}</span><span class="num">${r.opening==null?'—':fmtQ(r.opening)+' '+esc(r.unit)}</span><span class="num">${r.sold==null?'—':fmtQ(r.sold)+' '+esc(r.unit)}</span><span class="r num">${fmtQ(r.left)} ${esc(r.unit)}</span></div>`).join('')}</div></div>`;
const invItem=iv=>`<button type="button" class="item" data-act="openInv" data-id="${esc(iv.id)}"><div><div class="t">${esc(iv.supplier||'（没写供应商）')}</div><div class="s">${iv.invoiceNo?'单号 '+esc(iv.invoiceNo)+' · ':''}${(iv.items||[]).length} 项</div></div><span class="num" style="font-weight:500">${money(iv.total)}</span></button>`;

// ---------- screens: invoice ----------
const blankItem=()=>({name:'',qty:0,unit:'',price:0,subtotal:0,unsure:false,question:''});
async function startInvoice(manual){
  let blob=null;
  if(!manual){const f=await pickFile($file);if(!f)return;blob=await shrink(f);}
  draft={id:newId('inv'),date:homeDate||ymd(),supplier:'',invoiceNo:'',items:[],readTotal:null,photoBlob:blob,photoUrl:blob?URL.createObjectURL(blob):'',loading:!manual,error:'',isNew:true};
  if(manual){draft.items=[blankItem()];go({name:'invoice'});return;}
  go({name:'invoice'});
  const mine=draft;
  try{
    const r=await aiInvoice(blob);
    if(draft!==mine||!mine.loading)return; // user moved on / chose manual
    mine.supplier=String(r.supplier||'');mine.invoiceNo=String(r.invoiceNo||'');
    if(/^\d{4}-\d{2}-\d{2}$/.test(r.date||''))mine.date=r.date;
    mine.items=(Array.isArray(r.items)?r.items:[]).map(it=>({name:String(it.name||''),qty:num(it.qty),unit:String(it.unit||''),price:num(it.price),subtotal:num(it.subtotal)||r2(num(it.qty)*num(it.price)),unsure:!!it.unsure,question:String(it.question||'')}));
    mine.items.forEach(it=>{const u=S.units[mine.supplier+'|'+it.name];if(u&&!it.unit)it.unit=u;});
    mine.readTotal=r.total!=null&&r.total!==''?num(r.total):null;mine.note=String(r.note||'');
    if(!mine.items.length)mine.items=[blankItem()];
  }catch(e){if(draft!==mine||!mine.loading)return;mine.error=errText(e);mine.items=[blankItem()];}
  mine.loading=false;if(view.name==='invoice'&&draft===mine)render();
}
async function editInvoice(iv,from){
  draft=JSON.parse(JSON.stringify(iv));draft.isNew=false;draft.loading=false;draft.error='';draft.photoUrl=await photoUrl(iv.photoId);
  go({name:'invoice',from});
}
function invTotal(){return r2(draft.items.reduce((a,x)=>a+num(x.subtotal),0));}
function vInvoice(){
  const d=draft;
  if(d.loading){$app.innerHTML=`<div class="wrap">${back('读单中')}<div style="display:flex;gap:14px;align-items:center">${d.photoUrl?`<img class="thumb" src="${d.photoUrl}" alt="进货单照片">`:''}<div><span class="spin"></span><span id="aiStatus">AI 正在读这张单，大约 10–30 秒…</span></div></div><button type="button" class="btn" data-act="manual">不等了，手动输入</button></div>`;return;}
  const tot=invTotal();
  const mismatch=d.readTotal!=null&&Math.abs(d.readTotal-tot)>0.009;
  $app.innerHTML=`<div class="wrap">${back(d.isNew?'请确认这张单':'修改进货单')}
  ${d.error?`<div class="warn">${esc(d.error)}</div>`:''}
  <div style="display:flex;gap:14px;align-items:flex-start">
    ${d.photoUrl?`<a href="${d.photoUrl}" target="_blank" rel="noopener"><img class="thumb" src="${d.photoUrl}" alt="进货单照片，点一下放大"></a>`:''}
    <div style="display:flex;flex-direction:column;gap:8px;flex:1;min-width:0">
      <label class="f" for="sup">供应商<input class="in" id="sup" value="${esc(d.supplier)}"></label>
      <div class="grid2"><label class="f" for="ino">单号<input class="in" id="ino" value="${esc(d.invoiceNo)}"></label>
      <label class="f" for="idt">日期<input class="in" id="idt" type="date" value="${esc(d.date)}"></label></div>
    </div>
  </div>
  <div class="tbl inv" id="items">
    <div class="tr h"><span>水果</span><span>数量</span><span>单位</span><span>单价</span><span class="r">小计</span><span></span></div>
    ${d.items.map((it,i)=>`<div class="tr${it.unsure?' flag':''}" data-i="${i}">
      <input aria-label="水果" data-k="name" value="${esc(it.name)}">
      <input aria-label="数量" data-k="qty" inputmode="decimal" value="${fmtQ(it.qty)}">
      <input aria-label="单位" data-k="unit" value="${esc(it.unit)}">
      <input aria-label="单价" data-k="price" inputmode="decimal" value="${fmtQ(it.price)}">
      <input aria-label="小计" data-k="subtotal" inputmode="decimal" class="r" value="${fmtQ(it.subtotal)}">
      <button type="button" class="x" data-act="delRow" data-i="${i}" aria-label="删除这一项">×</button>
      ${it.unsure&&it.question?`<div class="q">${esc(it.question)}（改好后这行会变回白色）</div>`:''}
    </div>`).join('')}
  </div>
  <button type="button" class="btn small" data-act="addRow" style="align-self:flex-start">＋ 加一项</button>
  <div class="row"><span class="dim">合计</span><span class="big num" id="tot">${money(tot)}</span></div>
  ${mismatch?`<div class="warn">单上写的合计是 ${money(d.readTotal)}，和各项加起来不一样，请检查一下。</div>`:''}
  ${d.note?`<div class="sub">AI 备注：${esc(d.note)}</div>`:''}
  <p class="sub">点任何格子都可以直接修改。单位确认后，下次同一家供应商会自动记得。</p>
  <div class="actions"><button type="button" class="btn" data-act="back">取消</button><button type="button" class="btn primary" data-act="saveInv">确认，保存</button></div>
  ${!d.isNew?`<button type="button" class="btn danger" data-act="delInv">删除这张单</button>`:''}
  </div>`;
  document.getElementById('items').addEventListener('input',e=>{
    const inp=e.target;const row=inp.closest('.tr');if(!row||row.dataset.i==null)return;
    const it=d.items[+row.dataset.i];const k=inp.dataset.k;
    it[k]=(k==='name'||k==='unit')?inp.value:num(inp.value);
    if(k==='qty'||k==='price'){it.subtotal=r2(num(it.qty)*num(it.price));row.querySelector('[data-k="subtotal"]').value=fmtQ(it.subtotal);}
    if(it.unsure){it.unsure=false;row.classList.remove('flag');const q=row.querySelector('.q');if(q)q.remove();}
    document.getElementById('tot').textContent=money(invTotal());
  });
  ['sup','ino','idt'].forEach(id=>document.getElementById(id).addEventListener('input',e=>{d[{sup:'supplier',ino:'invoiceNo',idt:'date'}[id]]=e.target.value;}));
}
async function saveInvoice(btn){
  const d=draft;
  d.items=d.items.filter(it=>String(it.name).trim()||num(it.subtotal));
  if(!d.items.length){d.items=[blankItem()];toast('至少要有一项');return;}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.date)){toast('请填日期');return;}
  btn.disabled=true;btn.textContent='保存中…';
  try{
    let photoId=d.photoId||'';
    if(d.photoBlob&&!photoId)photoId=await savePhoto(d.photoBlob);
    const doc={date:d.date,supplier:String(d.supplier).trim(),invoiceNo:String(d.invoiceNo).trim(),items:d.items.map(it=>({name:String(it.name).trim(),qty:num(it.qty),unit:String(it.unit).trim(),price:num(it.price),subtotal:r2(num(it.subtotal))})),total:invTotal(),photoId,createdAt:d.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    await putDoc('invoices',d.id,doc);
    if(doc.supplier){for(const it of doc.items){if(it.name&&it.unit){const k=doc.supplier+'|'+it.name;if(S.units[k]!==it.unit){await put('units',hashId(k),{supplier:doc.supplier,name:it.name,unit:it.unit});S.units[k]=it.unit;}}}}
    const to=view.from||'home';toast('已保存');draft=null;if(pasteQueue.length){nextPaste();return;}go({name:to,date:doc.date});
  }catch(e){console.warn(e);btn.disabled=false;btn.textContent='确认，保存';toast('保存失败：手机空间可能不够，请再试一次');}
}

// ---------- screens: night ----------
async function startNight(date,from){
  const n=nightOn(date),open=openingFor(date);
  const rows=Array.from(open.values()).map(o=>({name:o.name,unit:o.unit,opening:r2(o.qty),left:'',unsure:false,question:''}));
  if(n){(n.rows||[]).forEach(r=>{const x=rows.find(y=>keyOf(y.name,y.unit)===keyOf(r.name,r.unit));if(x)x.left=r.left;else rows.push({name:r.name,unit:r.unit,opening:null,left:r.left,unsure:false,question:''});});}
  draft={date,revenue:n&&n.revenue!=null?String(n.revenue):'',rows,photoId:n?n.photoId||'':'',photoBlob:null,photoUrl:await photoUrl(n&&n.photoId),loading:false,error:''};
  go({name:'night',from});
}
async function readLeftover(){
  const f=await pickFile($file);if(!f)return;
  const blob=await shrink(f);draft.photoBlob=blob;draft.photoUrl=URL.createObjectURL(blob);draft.photoId='';draft.error='';
  draft.loading=true;render();
  const mine=draft;
  try{
    const open=new Map(mine.rows.filter(r=>r.opening!=null).map(r=>[keyOf(r.name,r.unit),{name:r.name,unit:r.unit,qty:r.opening}]));
    const res=await aiLeftover(blob,open);
    applyLeftover(mine,res.items);
  }catch(e){mine.error=errText(e);}
  mine.loading=false;if(view.name==='night'&&draft===mine)render();
}
const baseName=s=>String(s||'').replace(/[（(][^）)]*[）)]/g,'').replace(/\s+/g,'').trim();
function findRow(rows,name,unit){
  let x=rows.find(r=>keyOf(r.name,r.unit)===keyOf(name,unit))||rows.find(r=>r.name===name);if(x)return x;
  const b=baseName(name);if(!b)return null;
  let c=rows.filter(r=>baseName(r.name)===b);if(c.length===1)return c[0];
  c=rows.filter(r=>{const rb=baseName(r.name);return rb&&(rb.includes(b)||b.includes(rb));});
  if(unit&&c.length>1){const cu=c.filter(r=>r.unit===unit);if(cu.length)c=cu;}
  return c.length===1?c[0]:null;
}
function applyLeftover(d,items){
  (Array.isArray(items)?items:[]).forEach(it=>{
    const name=String(it.name||'').trim(),unit=String(it.unit||'').trim();if(!name)return;
    const x=findRow(d.rows,name,unit);
    if(x){x.left=num(it.qty);if(x.unit!==unit&&unit){x.unsure=true;x.question=it.question||('单上的单位是「'+unit+'」，店里是按「'+x.unit+'」，请改成同一个单位的数量');}else if(it.unsure){x.unsure=true;x.question=String(it.question||'');}}
    else d.rows.push({name,unit,opening:null,left:num(it.qty),unsure:true,question:String(it.question||'找不到「'+name+'」的进货记录，请确认名称')});
  });
}
function nightCalc(){const d=draft,pur=purchaseOn(d.date),fee=num(S.settings.fixedFee),rev=num(d.revenue);return {pur,fee,rev,profit:r2(rev-pur-fee)};}
function vNight(){
  const d=draft,c=nightCalc();
  $app.innerHTML=`<div class="wrap">${back(d.date===ymd()?'今晚结算':niceDate(d.date)+' 结算')}
  <label class="f" for="rev">收入（S$，还不知道可以先空着）<input class="in lg num" id="rev" inputmode="decimal" placeholder="例如 3308.70" value="${esc(d.revenue)}"></label>
  <div class="row" style="align-items:center"><h2>剩货</h2><button type="button" class="btn small" data-act="readLeft">${d.photoUrl?'重拍剩货单':'拍手写剩货单'}</button></div>
  ${d.loading?'<div><span class="spin"></span><span id="aiStatus">AI 正在读你的手写单…</span></div>':''}
  ${d.error?`<div class="warn">${esc(d.error)}</div>`:''}
  ${d.rows.length?`<div class="tbl ngt" id="rows"><div class="tr h"><span>水果</span><span>早上有</span><span>卖出</span><span class="r">今晚剩</span></div>
  ${d.rows.map((r,i)=>{const sold=r.opening!=null&&r.left!==''?r2(r.opening-num(r.left)):null;return `<div class="tr${r.unsure?' flag':''}" data-i="${i}">
    <span>${esc(r.name)}</span><span class="num">${r.opening!=null?fmtQ(r.opening)+' '+esc(r.unit):'—'}</span>
    <span class="num" data-sold>${sold==null?'—':fmtQ(sold)+' '+esc(r.unit)}</span>
    <input aria-label="${esc(r.name)} 今晚剩" data-k="left" inputmode="decimal" value="${r.left===''?'':fmtQ(r.left)}" placeholder="${esc(r.unit)}">
    ${r.unsure&&r.question?`<div class="q">${esc(r.question)}</div>`:''}</div>`;}).join('')}</div>
  <p class="sub">早上有 = 上次结算剩下的 + 这天的进货。没剩的水果填 0。</p>`
  :'<div class="empty">这天还没有进货单，也没有上次剩货的记录。先拍进货单，或直接拍剩货单。</div>'}
  <div class="ok">
    <div class="row num"><span class="dim">收入 − 进货 − 固定费用</span><span id="eq">${fmtQ(c.rev)} − ${fmtQ(c.pur)} − ${fmtQ(c.fee)}</span></div>
    <div class="row"><span style="font-weight:500">${d.date===ymd()?'今天':'这天'}盈亏</span><span class="big num ${c.profit>=0?'pos':'neg'}" id="pf">${signed(c.profit)}</span></div>
  </div>
  <button type="button" class="btn primary" data-act="saveNight">确认，保存</button>
  </div>`;
  document.getElementById('rev').addEventListener('input',e=>{d.revenue=e.target.value;const c=nightCalc();document.getElementById('eq').textContent=fmtQ(c.rev)+' − '+fmtQ(c.pur)+' − '+fmtQ(c.fee);const pf=document.getElementById('pf');pf.textContent=signed(c.profit);pf.className='big num '+(c.profit>=0?'pos':'neg');});
  const rows=document.getElementById('rows');
  if(rows)rows.addEventListener('input',e=>{const row=e.target.closest('.tr');if(!row)return;const r=d.rows[+row.dataset.i];r.left=e.target.value===''?'':num(e.target.value);
    if(r.unsure){r.unsure=false;row.classList.remove('flag');const q=row.querySelector('.q');if(q)q.remove();}
    const sold=r.opening!=null&&r.left!==''?r2(r.opening-num(r.left)):null;row.querySelector('[data-sold]').textContent=sold==null?'—':fmtQ(sold)+' '+r.unit;});
}
async function saveNight(btn){
  const d=draft;
  const noRev=String(d.revenue).trim()==='';
  const missing=d.rows.filter(r=>r.left==='');
  if(missing.length){toast('还有 '+missing.length+' 样没填剩多少（没剩填 0）');return;}
  btn.disabled=true;btn.textContent='保存中…';
  try{
    let photoId=d.photoId;if(d.photoBlob&&!photoId)photoId=await savePhoto(d.photoBlob);
    const c=nightCalc();
    const rows=d.rows.map(r=>({name:r.name,unit:r.unit,opening:r.opening,left:num(r.left),sold:r.opening!=null?r2(r.opening-num(r.left)):null}));
    await putDoc('nights','d'+d.date.replace(/-/g,''),{date:d.date,revenue:noRev?null:c.rev,purchase:c.pur,fee:c.fee,profit:noRev?null:c.profit,rows,photoId:photoId||'',savedAt:new Date().toISOString()});
    toast(noRev?'剩货已保存，收入之后再补':'已保存：'+(c.profit>=0?'盈利 ':'亏损 ')+money(Math.abs(c.profit)));
    const to=view.from||'home';draft=null;if(pasteQueue.length){nextPaste();return;}go({name:to,date:d.date});
  }catch(e){console.warn(e);btn.disabled=false;btn.textContent='确认，保存';toast('保存失败，请再按一次');}
}

// ---------- screens: paste from Claude ----------
function vPaste(){
  $app.innerHTML=`<div class="wrap">${back('贴上 Claude 读好的单')}
  <p class="sub" style="line-height:1.7;margin:0">在 Claude 那边，按资料框右上角的「复制」，再回到这里按下面的绿色按钮。进货单、剩货单都可以，一次几张也行。</p>
  <button type="button" class="btn primary" data-act="pasteClip">从剪贴板贴上</button>
  <label class="f" for="pasteBox">如果上面的按钮没反应，在这个框里长按 → 贴上
  <textarea class="in paste" id="pasteBox" placeholder="Claude 给你的资料会出现在这里">${esc(pasteText)}</textarea></label>
  ${pasteErr?`<div class="warn">${esc(pasteErr)}</div>`:''}
  <button type="button" class="btn" data-act="pasteGo">读取框里的资料</button>
  </div>`;
  document.getElementById('pasteBox').addEventListener('input',e=>{pasteText=e.target.value;});
}
function parseClaude(text){
  let t=String(text||'').replace(/[“”]/g,'"');
  const i=t.search(/[\[{]/),j=Math.max(t.lastIndexOf('}'),t.lastIndexOf(']'));
  if(i<0||j<i)return null;
  let data;try{data=JSON.parse(t.slice(i,j+1));}catch(e){return null;}
  const list=(Array.isArray(data)?data:(Array.isArray(data.sheets)?data.sheets:[data])).filter(x=>x&&typeof x==='object');
  const kind=x=>{const k=String(x.type||'');if(/进货|invoice/i.test(k))return 'inv';if(/剩货|leftover|night/i.test(k))return 'left';return x.supplier!=null||x.invoiceNo!=null?'inv':'left';};
  const out=list.map(x=>Object.assign({},x,{kind:kind(x)})).filter(x=>Array.isArray(x.items)||x.revenue!=null);
  return out.length?out:null;
}
async function usePaste(text){
  const list=parseClaude(text);
  if(!list){pasteText=text||pasteText;pasteErr='读不懂这段资料。请在 Claude 那边按「复制」把整个资料框复制过来，再试一次。';render();return;}
  pasteText='';pasteErr='';
  // invoices first, then leftovers (so the night opening includes the new invoices)
  pasteQueue=list.filter(x=>x.kind==='inv').concat(list.filter(x=>x.kind==='left'));
  if(pasteQueue.length>1)toast('一共 '+pasteQueue.length+' 张，一张一张确认');
  nextPaste();
}
async function nextPaste(){
  const x=pasteQueue.shift();if(!x){go({name:'home'});return;}
  const left=pasteQueue.length?'（后面还有 '+pasteQueue.length+' 张）':'';
  const date=/^\d{4}-\d{2}-\d{2}$/.test(x.date||'')?x.date:(homeDate||ymd());
  if(x.kind==='inv'){
    const supplier=String(x.supplier||'').trim(),invoiceNo=String(x.invoiceNo||'').trim();
    const items=(x.items||[]).map(it=>{const q=String(it.question||'');return {name:String(it.name||''),qty:num(it.qty),unit:String(it.unit||''),price:num(it.price),subtotal:num(it.subtotal)||r2(num(it.qty)*num(it.price)),unsure:!!(it.unsure||q),question:q};});
    items.forEach(it=>{const u=S.units[supplier+'|'+it.name];if(u&&!it.unit)it.unit=u;});
    const dup=invoiceNo&&S.invoices.find(v=>v.supplier===supplier&&v.invoiceNo===invoiceNo);
    draft={id:newId('inv'),date,supplier,invoiceNo,items:items.length?items:[blankItem()],readTotal:x.total!=null&&x.total!==''?num(x.total):null,photoBlob:null,photoUrl:'',loading:false,isNew:true,note:String(x.note||''),
      error:(dup?'这张单好像已经记过了（'+niceDate(dup.date)+'，同一家、同一个单号）。如果是重复的，按「取消」。':'')};
    go({name:'invoice',from:'home'});
    if(left)toast('Claude 读好的进货单'+left);
  }else{
    await startNight(date,'home');
    const d=draft;
    applyLeftover(d,x.items);
    if(x.others===0||x.restZero===true)d.rows.forEach(r=>{if(r.left==='')r.left=0;});
    if(x.revenue!=null&&x.revenue!=='')d.revenue=String(num(x.revenue));
    render();
    if(left)toast('Claude 读好的剩货单'+left);
  }
}

// ---------- screens: records ----------
function vRecords(){
  const dates=new Set([...S.invoices.map(x=>x.date),...S.nights.map(x=>x.date)]);
  const list=Array.from(dates).filter(Boolean).sort().reverse();
  let sum=0,cnt=0;list.slice(0,30).forEach(dt=>{const s=daySummary(dt);if(s.profit!=null){sum+=s.profit;cnt++;}});
  $app.innerHTML=`<div class="wrap"><h1>记录</h1>
  ${cnt?`<div class="card"><div class="row"><span class="dim">最近 ${cnt} 个结算日合计</span><span class="big num ${sum>=0?'pos':'neg'}">${signed(r2(sum))}</span></div></div>`:''}
  <div class="list">${list.length?list.map(dt=>{const s=daySummary(dt);return `<button type="button" class="item" data-act="openDay" data-date="${dt}"><div><div class="t">${niceDate(dt)}</div><div class="s">进货 ${money(s.pur)} · ${invoicesOn(dt).length} 张单${s.profit!=null?'':(s.n?' · 收入未填':' · 未结算')}</div></div>${s.profit==null?'<span class="dim">—</span>':`<span class="num ${s.profit>=0?'pos':'neg'}" style="font-weight:500">${signed(s.profit)}</span>`}</button>`;}).join(''):'<div class="empty">还没有任何记录。回到「今天」拍第一张进货单。</div>'}</div></div>`;
}
function vDay(){
  const dt=view.date,s=daySummary(dt),n=s.n;
  $app.innerHTML=`<div class="wrap">${back(niceDate(dt))}
  <div class="card"><div class="row"><span class="dim">进货</span><span class="num">${money(s.pur)}</span></div>
  <div class="row"><span class="dim">固定费用</span><span class="num">${money(s.fee)}</span></div>
  <div class="row"><span class="dim">收入</span><span class="num">${s.rev==null?'—':money(s.rev)}</span></div><div class="sep"></div>
  <div class="row"><span class="dim">盈亏</span>${s.profit==null?'<span class="big dim">—</span>':`<span class="big num ${s.profit>=0?'pos':'neg'}">${signed(s.profit)}</span>`}</div></div>
  <div class="list"><h2>进货单</h2>${invoicesOn(dt).map(invItem).join('')||'<div class="empty">这天没有进货单。</div>'}</div>
  ${n&&(n.rows||[]).length?soldTable(n,'卖出'):''}
  <button type="button" class="btn ${n?'':'primary'}" data-act="night" data-date="${dt}">${n?'修改这天的结算':'结算这天'}</button>
  </div>`;
}

// ---------- screens: suggest ----------
function vSuggest(){
  const tomorrow=addDays(ymd(),1),wd=parseYmd(tomorrow).getDay();
  const settled=S.nights.slice().sort((a,b)=>a.date<b.date?1:-1);
  const last=settled[0]||null;
  if(settled.length<3){
    $app.innerHTML=`<div class="wrap"><div><div class="sub">明天 ${niceDate(tomorrow)}</div><h1>建议进货</h1></div><div class="empty">需要至少 3 个晚上的结算才能开始建议，现在有 ${settled.length} 个。<br>每晚报剩货，资料越多建议越准（满 2 周最好）。</div></div>`;return;
  }
  const same=settled.filter(n=>parseYmd(n.date).getDay()===wd).slice(0,4);
  const base=same.length>=2?same:settled.slice(0,7);
  const basis=same.length>=2?`过去 ${same.length} 个${WD[wd]}`:`最近 ${base.length} 天`;
  const soldMap=new Map();
  base.forEach(n=>(n.rows||[]).forEach(r=>{if(r.sold==null)return;const k=keyOf(r.name,r.unit);const o=soldMap.get(k)||{name:r.name,unit:r.unit,vals:[]};o.vals.push(Math.max(0,num(r.sold)));soldMap.set(k,o);}));
  const leftMap=new Map();if(last)(last.rows||[]).forEach(r=>leftMap.set(keyOf(r.name,r.unit),num(r.left)));
  const items=Array.from(soldMap.entries()).map(([k,o])=>{const avg=o.vals.reduce((a,b)=>a+b,0)/base.length;const left=leftMap.get(k)||0;return {name:o.name,unit:o.unit,avg,left,sug:Math.max(0,Math.ceil(avg-left))};}).sort((a,b)=>b.sug-a.sug);
  $app.innerHTML=`<div class="wrap"><div><div class="sub">明天 ${niceDate(tomorrow)}</div><h1>建议进货</h1></div>
  <p class="sub" style="line-height:1.6;margin:0">按${basis}平均卖了多少，减去${last?(last.date===ymd()?'今晚':niceDate(last.date))+'的':''}剩货算出。只是参考，你可以自己调。${same.length<2?'同一个星期几的资料还不够，先用最近几天。':''}</p>
  <div class="list">${items.map(x=>`<div class="item"><div><div class="t">${esc(x.name)}</div><div class="s">平均卖 ${fmtQ(r2(x.avg))} ${esc(x.unit)} · 剩 ${fmtQ(x.left)} ${esc(x.unit)}</div></div><span class="big num" style="font-size:22px">${x.sug} <span class="sub" style="font-weight:400">${esc(x.unit)}</span></span></div>`).join('')||'<div class="empty">结算记录里还没有卖出数量。</div>'}</div></div>`;
}

// ---------- screens: settings ----------
function vSettings(){
  const st=S.settings,bd=daysSince(st.lastBackup);
  $app.innerHTML=`<div class="wrap"><h1>设置</h1>
  <form class="card" id="keyF"><h2>AI 读单钥匙（Google Gemini）</h2>
    <p class="sub" style="margin:0;line-height:1.7">${st.apiKey?'✅ 已经设定好。要换钥匙才需要再贴。':'拍单要用 AI 读，需要一把免费的钥匙：'}</p>
    ${st.apiKey?'':`<ol class="steps"><li>打开 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>，用 Google 帐号登录</li><li>按「Create API key」（建立钥匙）</li><li>按复制，回来贴在下面</li></ol>`}
    <label class="f" for="key">钥匙<input class="in" id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${st.apiKey?'••••••••'+esc(st.apiKey.slice(-4)):'贴上钥匙'}"></label>
    <details><summary class="sub">进阶：AI 型号</summary><label class="f" for="mdl" style="margin-top:8px">型号名称<input class="in" id="mdl" autocapitalize="off" spellcheck="false" value="${esc(st.model)}"></label></details>
    <p class="sub" id="keyMsg" role="status" style="margin:0"></p>
    <button class="btn primary" type="submit">测试并保存</button>
    <p class="sub" style="margin:0;line-height:1.6">免费版不用付钱，但 Google 可能会用上传的单据照片改善他们的服务。要收费前我们会先通知你。</p>
  </form>
  <form class="card" id="feeF"><label class="f" for="fee">每天固定费用（S$）<input class="in num" id="fee" inputmode="decimal" value="${fmtQ(st.fixedFee)}"></label><button class="btn primary" type="submit">保存费用</button><p class="sub" style="margin:0">改了以后，所有日子的盈亏都会用新的数字计算。</p></form>
  <div class="card"><h2>备份</h2>
    <p class="sub" style="margin:0;line-height:1.6">资料只存在这台手机里。${bd===Infinity?'你还没有备份过。':'上次备份：'+(bd===0?'今天':bd+' 天前')+'。'}建议每个星期备份一次，存到「文件」App 的 iCloud Drive。</p>
    ${readyBackup?`<button type="button" class="btn primary" data-act="saveBackup">保存备份文件（${esc(readyBackup.size)}）</button>`:`<button type="button" class="btn primary" data-act="makeBackup">备份全部资料</button>`}
    <button type="button" class="btn" data-act="exportCsv">下载 Excel 表格（CSV）</button>
    <button type="button" class="btn" data-act="restore">从备份文件还原</button>
  </div>
  <form class="card" id="pinF"><h2>改密码</h2><label class="f" for="np">新密码（至少 4 位）<input class="in" id="np" type="password" autocomplete="new-password" minlength="4" required></label><button class="btn" type="submit">改密码</button></form>
  <div class="card"><h2>单位记忆</h2><p class="sub" style="margin:0">已经记住 ${Object.keys(S.units).length} 个「供应商 + 水果」的单位。</p></div>
  <button type="button" class="btn" data-act="logout">在这台手机登出</button>
  <p class="sub">水果账本 ${VERSION} · 读单由 Google Gemini 完成，资料存在这台手机里。</p></div>`;
  document.getElementById('keyF').onsubmit=async e=>{e.preventDefault();
    const k=key.value.trim()||st.apiKey,m=(mdl.value.trim()||DEFAULTS.model),msg=document.getElementById('keyMsg');
    if(!k){msg.textContent='请先贴上钥匙';return;}
    msg.innerHTML='<span class="spin"></span>测试中…';
    const r=await testKey(k,m);
    if(r.ok){await saveSettings({apiKey:k,model:m});toast(r.note||'钥匙可以用，已保存');render();}
    else msg.textContent=r.why;};
  document.getElementById('feeF').onsubmit=async e=>{e.preventDefault();const v=num(fee.value);await saveSettings({fixedFee:v});toast('费用已改为每天 '+money(v));};
  document.getElementById('pinF').onsubmit=async e=>{e.preventDefault();if(np.value.length<4){toast('密码至少 4 位');return;}const h=await sha(np.value);await saveSettings({pinHash:h});lsSet('fl_unlock',Date.now()+':'+h.slice(0,16));np.value='';toast('密码已更改');};
}

// ---------- backup / restore / export ----------
function giveFile(name,blob){
  const f=new File([blob],name,{type:blob.type});
  if(navigator.canShare&&navigator.share){try{if(navigator.canShare({files:[f]}))return navigator.share({files:[f],title:name}).then(()=>true,e=>{if(e&&e.name==='AbortError')return false;dl(name,blob);return true;});}catch(e){}}
  dl(name,blob);return Promise.resolve(true);
}
function dl(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},5000);}
function sizeText(n){return n>1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB';}
async function makeBackup(btn){
  btn.disabled=true;btn.innerHTML='<span class="spin"></span>准备中…';
  try{
    const photos={};
    for(const [k,b] of await entries('photos')){if(b)photos[k]={type:b.type||'image/jpeg',data:await blobToB64(b)};}
    const units=(await entries('units')).map(([,v])=>v);
    const settings=Object.assign({},S.settings);delete settings.apiKey;delete settings.lastBackup;
    const data={app:'fruit-ledger',version:1,exportedAt:new Date().toISOString(),settings,invoices:S.invoices,nights:S.nights,units,photos};
    const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
    readyBackup={name:'水果账本备份-'+ymd()+'.json',blob,size:sizeText(blob.size)};
    render();
  }catch(e){console.warn(e);toast('备份准备失败，请再试一次');render();}
}
async function saveBackup(){
  if(!readyBackup)return;
  const ok=await giveFile(readyBackup.name,readyBackup.blob);
  if(ok){await saveSettings({lastBackup:new Date().toISOString()});readyBackup=null;toast('备份好了，记得存在 iCloud Drive');render();}
}
async function restoreFrom(file){
  let data;
  try{data=JSON.parse(await file.text());}catch(e){toast('这个文件打不开，不是账本备份');return false;}
  if(!data||!Array.isArray(data.invoices)||!Array.isArray(data.nights)){toast('这个文件不是账本备份');return false;}
  const keepKey=S.settings.apiKey,keepModel=S.settings.model;
  const photos=[];for(const [k,p] of Object.entries(data.photos||{})){try{photos.push([k,await b64ToBlob(p.data,p.type)]);}catch(e){}}
  await tx(STORES,'readwrite',t=>{
    STORES.forEach(s=>t.objectStore(s).clear());
    data.invoices.forEach(x=>{if(x&&x.id)t.objectStore('invoices').put(strip(x),x.id);});
    data.nights.forEach(x=>{if(x&&x.id)t.objectStore('nights').put(strip(x),x.id);});
    (data.units||[]).forEach(u=>{if(u&&u.supplier&&u.name)t.objectStore('units').put({supplier:u.supplier,name:u.name,unit:u.unit},hashId(u.supplier+'|'+u.name));});
    photos.forEach(([k,b])=>t.objectStore('photos').put(b,k));
    const st=Object.assign({},DEFAULTS,data.settings||{},{apiKey:keepKey||'',model:(data.settings&&data.settings.model)||keepModel||DEFAULTS.model,lastBackup:new Date().toISOString()});
    t.objectStore('settings').put(st,'main');
  });
  await loadAll();
  toast('已导入：'+S.invoices.length+' 张进货单、'+S.nights.length+' 晚结算');
  return true;
}
async function exportCsv(){
  const q=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
  const lines=[['类型','日期','供应商','单号','水果','数量','单位','单价','小计','收入','进货','费用','盈亏'].map(q).join(',')];
  S.invoices.slice().sort((a,b)=>a.date<b.date?-1:1).forEach(iv=>(iv.items||[]).forEach(it=>lines.push(['进货',iv.date,iv.supplier,iv.invoiceNo,it.name,it.qty,it.unit,it.price,it.subtotal,'','','',''].map(q).join(','))));
  S.nights.slice().sort((a,b)=>a.date<b.date?-1:1).forEach(n=>{const s=daySummary(n.date);lines.push(['结算',n.date,'','','','','','','',s.rev,s.pur,s.fee,s.profit].map(q).join(','));(n.rows||[]).forEach(r=>lines.push(['卖出',n.date,'','',r.name,r.sold,r.unit,'','','','','',''].map(q).join(',')));});
  await giveFile('水果账本-'+ymd()+'.csv',new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv'}));
}

// ---------- actions ----------
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  const a=b.dataset.act;
  if(a==='back'&&pasteQueue.length){const n=pasteQueue.length;pasteQueue=[];toast('已取消，后面 '+n+' 张没有记');}
  if(a==='back'&&view.name==='paste'){go({name:'home'});return;}
  if(a==='back'){const from=view.from;draft=null;if(view.name==='invoice'||view.name==='night')go(from==='day'?{name:'day',date:view.dayDate}:{name:from||'home'});else go({name:'records'});}
  else if(a==='newInvoice')startInvoice(false);
  else if(a==='manualInvoice')startInvoice(true);
  else if(a==='manual'){draft.loading=false;draft.items=[blankItem()];render();}
  else if(a==='addRow'){draft.items.push(blankItem());render();}
  else if(a==='delRow'){draft.items.splice(+b.dataset.i,1);if(!draft.items.length)draft.items.push(blankItem());render();}
  else if(a==='saveInv')saveInvoice(b);
  else if(a==='delInv'){if(b.dataset.sure){await delDoc('invoices',draft.id);if(draft.photoId)del('photos',draft.photoId).catch(()=>{});toast('已删除');const from=view.from,dd=view.dayDate;draft=null;go(from==='day'?{name:'day',date:dd}:{name:'home'});}else{b.dataset.sure='1';b.textContent='再按一次确定删除';}}
  else if(a==='openInv'){const iv=S.invoices.find(x=>x.id===b.dataset.id);if(iv){const from=view.name==='day'?'day':'home',dd=view.date;await editInvoice(iv,from);view.dayDate=dd;}}
  else if(a==='night'){const from=view.name==='day'?'day':'home',dd=view.date;await startNight(b.dataset.date,from);view.dayDate=dd;}
  else if(a==='readLeft')readLeftover();
  else if(a==='paste'){pasteErr='';go({name:'paste'});}
  else if(a==='pasteGo')usePaste(pasteText);
  else if(a==='pasteClip'){
    let t='';try{t=await navigator.clipboard.readText();}catch(e){}
    if(t)usePaste(t);else{pasteErr='手机没让 App 读剪贴板。请在下面的框里长按 → 贴上，再按「读取框里的资料」。';render();const bx=document.getElementById('pasteBox');if(bx)bx.focus();}
  }
  else if(a==='saveNight')saveNight(b);
  else if(a==='openDay')go({name:'day',date:b.dataset.date});
  else if(a==='exportCsv')exportCsv();
  else if(a==='makeBackup')makeBackup(b);
  else if(a==='saveBackup')saveBackup();
  else if(a==='restore'){
    if(!b.dataset.sure&&hasData()){b.dataset.sure='1';b.textContent='还原会取代手机上现在的资料，再按一次继续';return;}
    const f=await pickFile($json);if(!f){render();return;}
    if(await restoreFrom(f)){if(!unlocked())go({name:S.settings.pinHash?'login':'setpin'});else render();}
  }
  else if(a==='importStart'){const f=await pickFile($json);if(!f)return;if(await restoreFrom(f))go({name:S.settings.pinHash?'login':'setpin'});}
  else if(a==='freshStart')go({name:'setpin'});
  else if(a==='hideA2HS'){lsSet('fl_hideA2HS','1');render();}
  else if(a==='goSettings')go({name:'settings'});
  else if(a==='dayPrev')setHomeDate(addDays(homeDate||ymd(),-1));
  else if(a==='dayNext')setHomeDate(addDays(homeDate||ymd(),1));
  else if(a==='dayToday')setHomeDate(ymd());
  else if(a==='logout'){lsSet('fl_unlock','');go({name:'login'});}
});

// ---------- boot ----------
(async function boot(){
  try{
    if(!('indexedDB' in window))throw new Error('no idb');
    IDB=await openDb();
    await loadAll();
  }catch(e){
    console.warn(e);
    $app.innerHTML='<div class="wrap"><div class="empty">这个浏览器存不了资料。请用 iPhone 的 Safari 打开，并且不要用「无痕浏览」。</div></div>';return;
  }
  try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist();}catch(e){}
  if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{});}
  decideStart();
})();
})();
