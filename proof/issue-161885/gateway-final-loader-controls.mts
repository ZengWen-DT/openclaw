import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const evidence = path.resolve(root, '../issue161885-evidence');
const source = (file: string) => import(pathToFileURL(path.join(root, file)).href);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'issue161885-'));
const state = path.join(home, 'state'), temp = path.join(home, 'tmp'), bin = path.join(home, 'bin'), plugin = path.join(home, 'voice-fixture');
for (const dir of [state,temp,bin,plugin]) await fs.mkdir(dir, {recursive:true, mode:0o700});
// This fixture receives no real account data. Only the selected Node/pnpm toolchain survives.
const toolchain = { PATH: process.env.PATH, COREPACK_HOME: process.env.COREPACK_HOME };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, toolchain, {
 PATH: `${bin}:${toolchain.PATH}`, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
 OPENCLAW_CONFIG_PATH: path.join(state,'openclaw.json'), CLAUDE_CONFIG_DIR: path.join(home,'claude'),
 XDG_CACHE_HOME:temp, TMPDIR:temp, TMP:temp, TEMP:temp, LANG:'C.UTF-8',
 OPENCLAW_NO_AUTO_UPDATE:'1', DO_NOT_TRACK:'1', CLAWHUB_DISABLE_TELEMETRY:'1',
 OPENCLAW_DISABLE_BONJOUR:'1', OPENCLAW_SKIP_CHANNELS:'1', OPENCLAW_SKIP_CRON:'1',
 OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:'1', OPENCLAW_SKIP_CANVAS_HOST:'1', OPENCLAW_SKIP_GMAIL_WATCHER:'1',
 CI:'1', FORCE_COLOR:'0', NO_COLOR:'1', GOMEMLIMIT:'2GiB',
});
const cliLog=path.join(home,'cli.log');
await fs.writeFile(path.join(bin,'claude'), `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'); const readline=require('node:readline');
const log=(x)=>fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(x)+'\n');
if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:false}));process.exit(0)}
if(process.argv.includes('--version')){console.log('2.1.274 (Claude Code)');process.exit(0)}
log({kind:'launch',pid:process.pid,argv:process.argv.slice(2)});
if(!process.argv.includes('--input-format')){console.log(JSON.stringify({type:'result',subtype:'success',result:'Synthetic title',session_id:'22222222-2222-4333-8444-555555555555'}));process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.type==='control_request'&&m.request.subtype==='initialize') send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[]}}});
 if(m.type==='user') {
  if(JSON.stringify(m).includes('CLI_HOLD')){log({kind:'hold',pid:process.pid});continue;}
  if(JSON.stringify(m).includes('FAIL_CLI')){send({type:'result',subtype:'error_during_execution',is_error:true,result:'429 rate limit exceeded',session_id:'11111111-2222-4333-8444-555555555555'});continue;}
  log({kind:'user',text:m.message.content,pid:process.pid});
  const answer='CLI_FIXTURE_ANSWER';
  send({type:'assistant',message:{role:'assistant',content:[{type:'text',text:answer}]}});
  send({type:'result',subtype:'success',is_error:false,result:answer,session_id:'11111111-2222-4333-8444-555555555555',usage:{input_tokens:1,output_tokens:1}});
 }
}
`.replace('const fs=require', "const fs=require").replace('for await (const line', '(async()=>{for await (const line') + '\n})();\n', {mode:0o755});
await fs.writeFile(path.join(plugin,'package.json'),JSON.stringify({name:'voice-fixture',type:'commonjs',main:'index.js',openclaw:{extensions:['./index.js'],runtimeExtensions:['./index.js']},peerDependencies:{openclaw:'>=2026.1.1'}}));
await fs.writeFile(path.join(plugin,'openclaw.plugin.json'),JSON.stringify({id:'voice-fixture',activation:{onStartup:true},configSchema:{type:'object',additionalProperties:false,properties:{}}}));
await fs.writeFile(path.join(plugin,'index.js'),`module.exports={id:'voice-fixture',register(api){
 api.registerRealtimeVoiceProvider({id:'voice-fixture',label:'Synthetic Talk transport',defaultModel:'fixture',
 capabilities:{transports:['webrtc'],inputAudioFormats:['pcm16'],outputAudioFormats:['pcm16'],supportsBrowserSession:true},
 isConfigured:()=>true,createBridge(){throw new Error('No media fixture');},
 async createBrowserSession(req){globalThis[Symbol.for('issue161885.voice-requests')]??=[];globalThis[Symbol.for('issue161885.voice-requests')].push(req);return {provider:'voice-fixture',transport:'webrtc',model:'fixture',clientSecret:'synthetic-no-media',offerUrl:'http://127.0.0.1/unused'};}
 });
}};`);
const requests: Array<any>=[];
let cancelRequestArrived: (()=>void)|undefined;
let closedCancelResponse: (()=>void)|undefined;
const provider=http.createServer(async(req,res)=>{
 let body='';for await(const part of req)body+=part;
 const input=JSON.parse(body);requests.push({url:req.url,input});
 console.log('LOOPBACK_REQUEST',req.url,input.model);
 if(JSON.stringify(input).includes('CANCEL_PROBE')){res.on('close',()=>closedCancelResponse?.()); cancelRequestArrived?.(); return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const send=(x:any)=>res.write(`data: ${JSON.stringify(x)}\n\n`);
 send({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'LOOPBACK_FIXTURE_ANSWER'},finish_reason:null}]});
 send({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
 res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
const port=(provider.address() as any).port;
const primary='anthropic/claude-opus-5-5',fallback='loopback/fixture';
const config={
 gateway:{mode:'local',bind:'loopback',auth:{mode:'token',token:'synthetic-issue161885-token'},controlUi:{enabled:false}},
 plugins:{allow:['voice-fixture','anthropic','openai'],load:{paths:[plugin]},entries:{'voice-fixture':{enabled:true},anthropic:{enabled:true},openai:{enabled:true}}},
 agents:{ownership:'explicit',defaults:{workspace:path.join(home,'workspace'),heartbeat:{every:'0m'},model:{primary,fallbacks:[]},models:{[primary]:{agentRuntime:{id:'claude-cli'}},[fallback]:{agentRuntime:{id:'openclaw'}}}},entries:{main:{model:{primary,fallbacks:[]}},withfallback:{model:{primary,fallbacks:[fallback]}},direct:{model:{primary:fallback,fallbacks:[]}}}},
 models:{catalogRefresh:{enabled:false},providers:{loopback:{baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'synthetic-loopback-only',api:'openai-completions',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}}},
 talk:{realtime:{provider:'voice-fixture',model:'fixture',providers:{'voice-fixture':{}}}},
 cron:{enabled:false},browser:{enabled:false},update:{checkOnStart:false},telemetry:{enabled:false},logging:{file:path.join(home,'gateway.log')},
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!,JSON.stringify(config));
const {acquireTestPortBlock}=await source('src/test-utils/port-claims.ts');
const claim=await acquireTestPortBlock({offsets:[0,1,2,3]});
const {startGatewayServer}=await source('src/gateway/server.ts');
const {GatewayClient}=await source('src/gateway/client.ts');
const {onAgentEvent}=await source('src/infra/agent-events.ts');
let server:any,client:any;
const results:any[]=[];
const events:any[]=[];
const cliRows=async()=>{try{return (await fs.readFile(cliLog,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return [];}};
try{
 await claim.release();
 server=await startGatewayServer(claim.port,{bind:'loopback',auth:{mode:'token',token:'synthetic-issue161885-token'},controlUiEnabled:false});
 client=await new Promise((resolve,reject)=>{const c=new GatewayClient({url:`ws://127.0.0.1:${claim.port}`,token:'synthetic-issue161885-token',clientName:'test',mode:'test',clientVersion:'repro',platform:'linux',role:'operator',scopes:['operator.admin','operator.read','operator.write','operator.talk'],onHelloOk:()=>resolve(c),onConnectError:reject,onEvent:(e:any)=>events.push(e)});c.start();});
 console.log('GATEWAY_READY');
 for(const agent of ['main','withfallback','direct']) {
  const sessionKey=`agent:${agent}:controls-proof`;
  const created=await client.request('talk.client.create',{sessionKey,provider:'voice-fixture',model:'fixture',transport:'webrtc',capabilities:['voice-transcript']});
  const req=(globalThis as any)[Symbol.for('issue161885.voice-requests')].at(-1);
  assert.equal(typeof req.runAgentConsult.adoptCompletionClaims,'function');
  req.runAgentConsult.adoptCompletionClaims();
  await client.request('talk.client.transcript',{sessionKey,voiceSessionId:created.voiceSessionId,entryId:'prior-user',role:'user',text:'HISTORY_SENTINEL: Remember the copper telescope.'});
  const beforeHistory=await client.request('chat.history',{sessionKey,limit:40});
  results.push({kind:'before-history',agent,history:beforeHistory});
  for(let turn=0;turn<2;turn++) {
    const result=await req.runAgentConsult({prompt:agent==='withfallback'?`FAIL_CLI: Answer turn ${turn}.`:`Answer turn ${turn}.`,signal:AbortSignal.timeout(45000)});
    const claimed=req.runAgentConsult.claimAppend();
    results.push({kind:'claimed-consult',agent,turn,result,claimed});
    console.log('CLAIMED_RESULT',agent,turn,JSON.stringify({result,claimed}));
    assert.equal(claimed,true,'current native consult completion must be accepted once');
    assert.equal(req.runAgentConsult.claimAppend(),false,'duplicate append must be refused');
  }
  const history=await client.request('chat.history',{sessionKey,limit:40});
  results.push({kind:'after-history',agent,history});
  if(agent==='main') {
    const controller=new AbortController();
    const held=req.runAgentConsult({prompt:'CLI_HOLD',signal:controller.signal}).then((result:any)=>({result}),(error:any)=>({error:{name:error.name,message:error.message}}));
    const deadline=Date.now()+45000;
    while(!(await cliRows()).some(row=>row.kind==='hold')) {
      assert.ok(Date.now()<deadline,'CLI hold must reach real fixture');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    let steeringError:any;
    try { await req.runAgentConsult.steer({prompt:'Use my correction instead.'}); } catch(error:any) { steeringError={name:error.name,message:error.message}; }
    assert.equal(steeringError?.name,'NotSupportedError');
    assert.equal(controller.signal.aborted,false);
    controller.abort(new DOMException('Replace non-steerable CLI','AbortError'));
    const cancelled=await held;
    assert.equal((cancelled as any).error?.name,'AbortError');
    assert.equal(req.runAgentConsult.claimFailureAppend(),false);
    const replacement=await req.runAgentConsult({prompt:'Answer the latest replacement request.',signal:AbortSignal.timeout(45000)});
    assert.equal(req.runAgentConsult.claimAppend(),true);
    assert.deepEqual(replacement,{text:'CLI_FIXTURE_ANSWER'});
    results.push({kind:'cli-steering-replacement',steeringError,cancelled,replacement});
    console.log('CLI_STEERING_REPLACEMENT',JSON.stringify(results.at(-1)));
  }
  if(agent==='withfallback') {
    const controller=new AbortController();
    const before=requests.length;
    let transitionObserved=false;
    const stop=onAgentEvent((event:any)=>{
      if(event.sessionKey===sessionKey && event.data?.phase==='fallback_step' && event.data?.fallbackStepFinalOutcome==='next_fallback') {
        transitionObserved=true;
        controller.abort(new DOMException('Cancel candidate transition','AbortError'));
      }
    });
    let cancelled:any;
    try { cancelled=await req.runAgentConsult({prompt:'FAIL_CLI: Cancel at the candidate transition.',signal:controller.signal}).then((result:any)=>({result}),(error:any)=>({error:{name:error.name,message:error.message}})); } finally { stop(); }
    assert.equal(transitionObserved,true);
    assert.equal(cancelled.error?.name,'AbortError');
    assert.equal(requests.length,before,'cancelled transition must not launch the next provider');
    assert.equal(req.runAgentConsult.claimFailureAppend(),false);
    results.push({kind:'transition-cancellation',cancelled,transitionObserved,successorRequests:requests.length-before});
    console.log('TRANSITION_CANCELLED',JSON.stringify(results.at(-1)));
  }
  if(agent==='direct') {
    const controller=new AbortController();
    const arrived=new Promise<void>(resolve=>{cancelRequestArrived=resolve;});
    const closed=new Promise<void>(resolve=>{closedCancelResponse=resolve;});
    const cancelling=req.runAgentConsult({prompt:'CANCEL_PROBE',signal:controller.signal}).then((result:any)=>({result}), (error:any)=>({error:{name:error.name,message:error.message}}));
    await Promise.race([arrived,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Cancellation did not reach upstream')),45000);timer.unref();})]);
    controller.abort(new DOMException('Fixture cancellation','AbortError'));
    const cancelled=await cancelling; await closed;
    const failureClaim=req.runAgentConsult.claimFailureAppend();
    results.push({kind:'cancellation',agent,cancelled,failureClaim,history:await client.request('chat.history',{sessionKey,limit:40})});
    console.log('CANCELLED',JSON.stringify(cancelled));
    assert.equal((cancelled as any).error?.name,'AbortError');
    assert.equal(failureClaim,false);
  }
  await client.request('talk.client.close',{sessionKey,voiceSessionId:created.voiceSessionId});
 }
 await client.stopAndWait({timeoutMs:1000});
 client=await new Promise((resolve,reject)=>{const c=new GatewayClient({url:`ws://127.0.0.1:${claim.port}`,token:'synthetic-issue161885-token',clientName:'test',mode:'test',clientVersion:'repro',platform:'linux',role:'operator',scopes:['operator.admin','operator.read','operator.write','operator.talk'],onHelloOk:()=>resolve(c),onConnectError:reject,onEvent:(e:any)=>events.push(e)});c.start();});
}finally{
 await fs.writeFile(path.join(evidence,'final-loader-controls-results.json'),JSON.stringify({home,head:'de14009aa2226f27188fd599472fbec7014847b3',results,cli:await cliRows(),requests,events},null,2));
 await client?.stopAndWait({timeoutMs:1000});if(server)await server.close({reason:'isolated fixture finished',restartExpectedMs:null});
 await new Promise<void>(resolve=>provider.close(()=>resolve()));
 await fs.copyFile(path.join(home,'gateway.log'),path.join(evidence,'final-loader-controls-gateway.log')).catch(()=>{});
 await fs.writeFile(path.join(evidence,'final-loader-controls-home.txt'),home+'\n');
 const stillAlive=[];
 for(const row of await cliRows()) if(row.kind==='launch') {
   try{const cmd=await fs.readFile(`/proc/${row.pid}/cmdline`,'utf8');if(cmd.includes(path.join(bin,'claude'))){process.kill(row.pid,'SIGTERM');stillAlive.push(row.pid);}}catch{}
 }
 console.log('FIXTURE_CLOSED',home,'remainingFixtureChildrenTerminated',JSON.stringify(stillAlive));
}
