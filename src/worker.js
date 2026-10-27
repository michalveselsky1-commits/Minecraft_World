const seed=[
["Najít Ancient City","Všichni",20,"diamond"],["Najít Sulfur City","Všichni",20,"diamond"],["Postavit farmu na písek","10miki10",10,"emerald"],["Postavit farmu na led","Ala",10,"emerald"],["Zajistit dostatek skla","Adas",5,"emerald"],["Získat packed ice","Všichni",5,"emerald"],["Postavit muzeum","Všichni",25,"diamond"],["Založit vesnici","Všichni",15,"diamond"],["Naplánovat město","Všichni",10,"diamond"]];
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
async function setup(db){
await db.prepare("CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,player TEXT NOT NULL,reward INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
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
if(url.pathname==="/api/admin/verify")return json({ok:await pinOK(request,env,body.pin)});
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
if(!await pinOK(request,env,body.pin))return json({error:"Nesprávný PIN nebo dočasné omezení pokusů"},403);
const status=url.pathname.endsWith("approve")?"approved":"open";
const result=await env.DB.prepare("UPDATE quests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(status,id).run();
return json({ok:result.meta.changes>0},result.meta.changes?200:409);
}
return json({error:"Nenalezeno"},404);
}catch(e){console.error("API error",e);return json({error:"Serverová chyba"},500)}
}};
