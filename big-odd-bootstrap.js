"use strict";
const http = require("http");
const bigOddApi = require("./big-odd-api");
const apiKeyManager = require("./api-key-manager");
const planManager = require("./api-plan-manager");
const bigOddWebSocketBridge = require("./big-odd-websocket-bridge");
const bigOddScheduler = require("./big-odd-scheduler");
const opayApi = require("./opay-api");
const authApi = require("./auth-api");
const otpApi = require("./otp-api");
const originalCreateServer = http.createServer;
function setCorsHeaders(res){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization, X-API-Key, X-Admin-Key, X-Session-Token");res.setHeader("Access-Control-Max-Age","86400");}
function sendJson(res,statusCode,payload){if(res.headersSent)return;setCorsHeaders(res);res.writeHead(statusCode,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(payload));}
function getRequestKeyRecord(req){return apiKeyManager.getRequestKeyRecord(req);}
function getPlanUpgradeResponse(res,plan){sendJson(res,403,{success:false,error:"PLAN_UPGRADE_REQUIRED",message:"Scheduler status is available from the Premium plan.",plan:plan.id,requiredPlan:"premium",upgrade:true,availableEndpoints:{current:"/api/v1/big-odd/current",history:"/api/v1/big-odd/history",today:"/api/v1/big-odd/today"}});}
function getCustomerSchedulerStatus(plan){const scheduler=bigOddScheduler.getStatus();const nowMs=Date.now();const limit=Math.max(1,Number(plan.upcomingLimit||0));const upcoming=scheduler.plan.filter(item=>{const t=new Date(item.scheduledAt).getTime();return !item.published&&Number.isFinite(t)&&t>nowMs;}).sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt)).slice(0,limit);return {...scheduler,plan:upcoming,dailyCount:upcoming.length};}
http.createServer=function patchedCreateServer(...args){const listenerIndex=typeof args[0]==="function"?0:1;const originalListener=args[listenerIndex];if(typeof originalListener==="function"){args[listenerIndex]=function patchedRequestHandler(req,res){let pathname=req.url||"/";try{pathname=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`).pathname;}catch{}if(req.method==="OPTIONS"&&pathname.startsWith("/api/v1/")){setCorsHeaders(res);res.writeHead(204);res.end();return;}if(pathname.startsWith("/api/v1/auth/otp/")){setCorsHeaders(res);if(otpApi.handleOtpRequest(req,res,pathname))return;}if(pathname.startsWith("/api/v1/auth/")){setCorsHeaders(res);if(authApi.handleAuthRequest(req,res,pathname))return;}if(pathname==="/api/v1/api-key/plans"){if(req.method!=="GET")return sendJson(res,405,{success:false,error:"METHOD_NOT_ALLOWED"});return sendJson(res,200,{success:true,type:"api-plans",serverTime:new Date().toISOString(),data:planManager.listPlans().map(plan=>planManager.getPlanResponse(plan.id))});}if(pathname==="/api/v1/big-odd/bridge-status")return sendJson(res,200,{success:true,type:"bridge-status",serverTime:new Date().toISOString(),bridge:bigOddWebSocketBridge.getStatus()});if(pathname==="/api/v1/big-odd/scheduler-status"){if(req.method!=="GET")return sendJson(res,405,{success:false,error:"METHOD_NOT_ALLOWED"});const keyRecord=getRequestKeyRecord(req);if(!keyRecord)return sendJson(res,401,{success:false,error:"INVALID_API_KEY",message:"A valid Big Odd API key is required."});const plan=planManager.getPlan(keyRecord.plan);if(!plan.upcomingBigOdd){getPlanUpgradeResponse(res,plan);return;}return sendJson(res,200,{success:true,type:"scheduler-status",plan:planManager.getPlanResponse(plan.id),serverTime:new Date().toISOString(),scheduler:getCustomerSchedulerStatus(plan)});}if(pathname==="/api/v1/api-key"||pathname==="/api/v1/api-key/generate"){if(apiKeyManager.handleApiKeyRequest(req,res,pathname))return;}if(pathname.startsWith("/api/v1/payments/opay")){opayApi.handleOpayRequest(req,res,pathname).catch(error=>{console.error("[OPAY ROUTE]",error);if(!res.headersSent)sendJson(res,500,{success:false,error:"OPAY_ROUTE_ERROR",message:error.message});});return;}if(pathname.startsWith("/api/v1/big-odd/")){if(bigOddApi.handleBigOddRequest(req,res,pathname))return;}return originalListener(req,res);};}return originalCreateServer.apply(http,args);};
bigOddWebSocketBridge.install();
bigOddScheduler.install();
console.log("[BIG ODD] Bootstrap loaded");
console.log("[AUTH] Authentication API routes loaded");
console.log("[OTP] Email OTP routes loaded");
console.log("[OPAY] Payment API routes loaded");
