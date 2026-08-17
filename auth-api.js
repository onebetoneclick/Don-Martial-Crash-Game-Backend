"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, "[]");
}
function read(file) { ensureStorage(); try { const x=JSON.parse(fs.readFileSync(file,"utf8")); return Array.isArray(x)?x:[]; } catch { return []; } }
function write(file, value) { ensureStorage(); const tmp=file+".tmp"; fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file); }
function email(x) { return String(x||"").trim().toLowerCase(); }
function hash(password, salt=crypto.randomBytes(16).toString("hex")) { return {salt,hash:crypto.scryptSync(String(password),salt,64).toString("hex")}; }
function verify(password,salt,expected) { try { const actual=crypto.scryptSync(String(password),salt,64).toString("hex"); return crypto.timingSafeEqual(Buffer.from(actual,"hex"),Buffer.from(expected,"hex")); } catch { return false; } }
function publicUser(u) { return {id:u.id,name:u.name,email:u.email,plan:u.plan||"starter",authProvider:u.authProvider||"password",createdAt:u.createdAt,lastLoginAt:u.lastLoginAt||null}; }
function tokenFor(userId) { const sessions=read(SESSIONS_FILE); const token="dm_session_"+crypto.randomBytes(32).toString("hex"); const now=Date.now(); sessions.push({token,userId,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+SESSION_TTL).toISOString()}); write(SESSIONS_FILE,sessions.slice(-5000)); return token; }
function bearer(req) { const h=String(req.headers.authorization||""); return h.startsWith("Bearer ")?h.slice(7).trim():String(req.headers["x-session-token"]||"").trim(); }
function currentUser(req) { const token=bearer(req); if(!token)return null; const now=Date.now(); const sessions=read(SESSIONS_FILE).filter(s=>new Date(s.expiresAt).getTime()>now); write(SESSIONS_FILE,sessions); const s=sessions.find(x=>x.token===token); return s?read(USERS_FILE).find(u=>u.id===s.userId)||null:null; }
function send(res,status,payload) { if(res.headersSent)return; res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}); res.end(JSON.stringify(payload)); }
function body(req) { return new Promise((resolve,reject)=>{let b="";req.on("data",c=>{b+=c.toString();if(b.length>1048576){req.destroy();reject(new Error("Request body too large"));}});req.on("end",()=>{try{resolve(b?JSON.parse(b):{});}catch{reject(new Error("Invalid JSON body"));}});req.on("error",reject);}); }
async function signup(req,res){let b;try{b=await body(req);}catch(e){send(res,400,{success:false,error:"INVALID_JSON",message:e.message});return;}const name=String(b.name||"").trim(),mail=email(b.email),password=String(b.password||"");if(name.length<2)return send(res,400,{success:false,error:"INVALID_NAME",message:"Name must contain at least 2 characters."});if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))return send(res,400,{success:false,error:"INVALID_EMAIL",message:"Enter a valid email address."});if(password.length<8)return send(res,400,{success:false,error:"WEAK_PASSWORD",message:"Password must contain at least 8 characters."});const users=read(USERS_FILE);if(users.some(u=>u.email===mail))return send(res,409,{success:false,error:"EMAIL_EXISTS",message:"An account with this email already exists."});const p=hash(password);const u={id:"dm_user_"+crypto.randomBytes(10).toString("hex"),name,email:mail,passwordHash:p.hash,passwordSalt:p.salt,authProvider:"password",plan:"starter",createdAt:new Date().toISOString(),lastLoginAt:null};users.push(u);write(USERS_FILE,users);send(res,201,{success:true,message:"Account created successfully.",token:tokenFor(u.id),user:publicUser(u)});}
async function login(req,res){let b;try{b=await body(req);}catch(e){send(res,400,{success:false,error:"INVALID_JSON",message:e.message});return;}const mail=email(b.email),password=String(b.password||""),users=read(USERS_FILE),u=users.find(x=>x.email===mail);if(!u||!u.passwordHash||!verify(password,u.passwordSalt,u.passwordHash))return send(res,401,{success:false,error:"INVALID_CREDENTIALS",message:"Email or password is incorrect."});u.lastLoginAt=new Date().toISOString();write(USERS_FILE,users);send(res,200,{success:true,message:"Login successful.",token:tokenFor(u.id),user:publicUser(u)});}
function me(req,res){const u=currentUser(req);if(!u)return send(res,401,{success:false,error:"UNAUTHORIZED",message:"A valid session is required."});send(res,200,{success:true,user:publicUser(u)});}
function logout(req,res){const t=bearer(req);write(SESSIONS_FILE,read(SESSIONS_FILE).filter(s=>s.token!==t));send(res,200,{success:true,message:"Logged out successfully."});}
function handleAuthRequest(req,res,pathname){if(!pathname.startsWith("/api/v1/auth/"))return false;if(req.method==="POST"&&pathname==="/api/v1/auth/signup"){signup(req,res).catch(e=>send(res,500,{success:false,error:"SIGNUP_ERROR",message:e.message}));return true;}if(req.method==="POST"&&pathname==="/api/v1/auth/login"){login(req,res).catch(e=>send(res,500,{success:false,error:"LOGIN_ERROR",message:e.message}));return true;}if(req.method==="GET"&&pathname==="/api/v1/auth/me"){me(req,res);return true;}if(req.method==="POST"&&pathname==="/api/v1/auth/logout"){logout(req,res);return true;}send(res,404,{success:false,error:"AUTH_ROUTE_NOT_FOUND"});return true;}
ensureStorage();
module.exports={handleAuthRequest,currentUser,publicUser};
