const seed=[
["Najít Ancient City","Všichni",20,"diamond"],["Najít Sulfur City","Všichni",20,"diamond"],["Postavit farmu na písek","10miki10",10,"emerald"],["Postavit farmu na led","Ala",10,"emerald"],["Zajistit dostatek skla","Adas",5,"emerald"],["Získat packed ice","Všichni",5,"emerald"],["Postavit muzeum","Všichni",25,"diamond"],["Založit vesnici","Všichni",15,"diamond"],["Naplánovat město","Všichni",10,"diamond"]];
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
async function setup(db){
await db.prepare("CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,player TEXT NOT NULL,reward INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
await db.prepare("CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)").run();
await db.prepare("CREATE TABLE IF NOT EXISTS approval_attempts (ip TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,blocked_until INTEGER NOT NULL DEFAULT 0)").run();
const row=await db.prepare("SELECT COUNT(*) AS n FROM quests").first();
if(!row.n){for(const t of seed)await db.prepare("INSERT INTO quests (name,player,reward,currency,status) VALUES (?,?,?,?,'open')").bind(...t).run()}
}
async function pinOK(request,env,pin){
if(!env.ADMIN_PIN||typeof pin!=="string")return false;
const ip=request.headers.get("CF-Connecting-IP")||"unknown";
const attempt=await env.DB.prepare("SELECT failures,blocked_until FROM approval_attempts WHERE ip=?").bind(ip).first();
if(attempt?.blocked_until>Date.now())return false;
const enc=new TextEncoder();
const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",enc.encode(pin)),crypto.subtle.digest("SHA-256",enc.encode(env.ADMIN_PIN))]);
const aa=new Uint8Array(a),bb=new Uint8Array(b);let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];
if(diff===0){await env.DB.prepare("DELETE FROM approval_attempts WHERE ip=?").bind(ip).run();return true}
const failures=(attempt?.failures||0)+1;
await env.DB.prepare("INSERT INTO approval_attempts(ip,failures,blocked_until) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until").bind(ip,failures,failures>=5?Date.now()+15*60*1000:0).run();return false;
}
async function tokenHash(token){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("")}
async function sessionOK(env,token){if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))return false;const row=await env.DB.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash=?").bind(await tokenHash(token)).first();return !!row&&row.expires_at>Date.now()}
export default {async fetch(request,env){
const url=new URL(request.url);
if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(request);
if(!env.DB)return json({error:"Databáze není připojena"},503);
try{
await setup(env.DB);
if(url.pathname==="/api/quests"&&request.method==="GET"){const {results}=await env.DB.prepare("SELECT id,name,player,reward,currency,status FROM quests ORDER BY id").all();return json({tasks:results})}
if(request.method!=="POST")return json({error:"Nepodporovaná metoda"},405);
if(Number(request.headers.get("content-length")||0)>8192)return json({error:"Příliš velký požadavek"},413);
let body;try{body=await request.json()}catch{return json({error:"Neplatný JSON"},400)}
if(url.pathname==="/api/admin/verify"){
if(!await pinOK(request,env,body.pin))return json({ok:false},403);
const token=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,"0")).join("");
const expires_at=Date.now()+2*60*60*1000;
await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<?").bind(Date.now()).run();
await env.DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)").bind(await tokenHash(token),expires_at).run();
return json({ok:true,token,expires_at});
}
if(url.pathname==="/api/admin/session")return json({ok:await sessionOK(env,body.token)});
if(url.pathname==="/api/admin/logout"){if(typeof body.token==="string")await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await tokenHash(body.token)).run();return json({ok:true})}

if(url.pathname==="/api/admin/deploy"){
if(!await sessionOK(env,body.token))return json({error:"Přihlášení správce vypršelo. Přihlas se znovu."},403);
if(!env.CLOUDFLARE_BUILD_TOKEN)return json({error:"Chybí CLOUDFLARE_BUILD_TOKEN v Runtime Secrets tohoto Workeru."},503);
const account="02d3eed9f53a8cd69f94bc83f1698b71",base="https://api.cloudflare.com/client/v4/accounts/"+account;
async function cf(path){
const response=await fetch(base+path,{headers:{Authorization:"Bearer "+env.CLOUDFLARE_BUILD_TOKEN,Accept:"application/json"}});
const data=await response.json().catch(()=>({success:false,errors:[{message:"Neplatná odpověď Cloudflare"}]}));
if(!response.ok||data.success===false)throw Error("Cloudflare API: "+(data.errors||[]).map(e=>e.message).join("; ").slice(0,220));
return data.result;
}
try{
const scripts=await cf("/workers/scripts"),list=Array.isArray(scripts)?scripts:(scripts?.scripts||[]);
const script=list.find(x=>x.id==="minecraft-world");
if(!script?.tag)return json({error:"Worker minecraft-world nebyl nalezen. Ověř oprávnění tokenu."},502);
const result=await cf("/builds/workers/"+encodeURIComponent(script.tag)+"/builds?per_page=1");
const builds=Array.isArray(result)?result:(result?.builds||[]);
const b=builds[0];
return json({checked_at:new Date().toISOString(),build:b?{status:b.status||null,outcome:b.build_outcome||null,created_at:b.created_on||null,completed_at:b.completed_on||null,branch:b.build_trigger_metadata?.branch||null,commit:b.build_trigger_metadata?.commit_hash||null,message:b.build_trigger_metadata?.commit_message||null}:null});
}catch(e){return json({error:e.message},502)}
}

if(url.pathname==="/api/quests/add"){
const name=String(body.name||"").trim().slice(0,120),player=body.player;
if(!name||!["10miki10","Ala","Adas","Všichni"].includes(player))return json({error:"Neplatný úkol"},400);
await env.DB.prepare("INSERT INTO quests(name,player,reward,currency,status) VALUES(?,?,5,'emerald','open')").bind(name,player).run();return json({ok:true});
}
const id=Number(body.id);
if(!Number.isSafeInteger(id)||id<=0)return json({error:"Neplatné ID"},400);
if(url.pathname==="/api/quests/request"){
const result=await env.DB.prepare("UPDATE quests SET status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").bind(id).run();return json({ok:result.meta.changes>0},result.meta.changes?200:409);
}
if(url.pathname==="/api/quests/retract"){
const result=await env.DB.prepare("UPDATE quests SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id).run();return json({ok:result.meta.changes>0},result.meta.changes?200:409);
}
if(url.pathname==="/api/quests/approve"||url.pathname==="/api/quests/reject"){
if(!await sessionOK(env,body.token))return json({error:"Přihlášení správce vypršelo"},403);
const status=url.pathname.endsWith("approve")?"approved":"open";
const result=await env.DB.prepare("UPDATE quests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,id).run();
return json({ok:result.meta.changes>0},result.meta.changes?200:409);
}
return json({error:"Nenalezeno"},404);
}catch(e){console.error("API error",e);return json({error:"Serverová chyba"},500)}
}};
