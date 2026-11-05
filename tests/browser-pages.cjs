// Frontend integration at a GitHub-Pages-like subdirectory. The real bundled
// Supabase SDK talks to controlled Auth/RPC/Realtime fixtures, not a cloud project.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {execFileSync}=require('node:child_process');
const {readFileSync,mkdtempSync,rmSync,existsSync}=require('node:fs');
const {join,resolve,extname}=require('node:path');
const {tmpdir}=require('node:os');
const root=resolve(__dirname,'..');
const output=mkdtempSync(join(tmpdir(),'vota-pages-browser-'));
const cloud='https://fixture.supabase.co';
const prefix='/SISTEMA-DE-VOTA-O/';
const topics=JSON.parse(execFileSync('python3',['-c','import json;from voting.catalog import TOPICS;print(json.dumps(TOPICS))'],{cwd:root,encoding:'utf8'}));
const votes=new Map();
const connections=new Set();
const errors=[];
let browser,server;
const user={id:'11111111-1111-4111-8111-111111111111',email:'admin@example.test',aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),app_metadata:{provider:'email'},user_metadata:{}};
const token=[{alg:'HS256',typ:'JWT'},{sub:user.id,role:'authenticated',aud:'authenticated',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')+'.Zml4dHVyZS1vbmx5';
function metrics(){
  const rows=topics.map(topic=>({...topic,votes:[...votes.values()].filter(id=>id===topic.id).length})).sort((a,b)=>b.votes-a.votes);
  for(const topic of rows)topic.percentage=votes.size?100*topic.votes/votes.size:0;
  return {totalVotes:votes.size,topics:rows,categories:[...new Set(topics.map(t=>t.category))].map(name=>({name,votes:rows.filter(t=>t.category===name).reduce((sum,t)=>sum+t.votes,0),percentage:votes.size?rows.filter(t=>t.category===name).reduce((sum,t)=>sum+t.percentage,0):0})),timeline:votes.size?[{date:'2026-11-05',votes:votes.size}]:[],leaders:votes.size?rows.filter(t=>t.votes===rows[0].votes).map(t=>t.id):[],updatedAt:new Date().toISOString()};
}
function eventFor(info,event,payload,ref=null){
  return info.array?JSON.stringify([info.joinRef,ref,info.topic,event,payload]):JSON.stringify({topic:info.topic,event,payload,ref});
}
function broadcast(topicId){
  for(const info of connections)info.ws.send(eventFor(info,'postgres_changes',{ids:[1],data:{schema:'public',table:'voting_totals',commit_timestamp:new Date().toISOString(),type:'UPDATE',columns:[{name:'topic_id',type:'text'},{name:'votes',type:'int8'},{name:'updated_at',type:'timestamptz'}],record:{topic_id:topicId,votes:[...votes.values()].filter(id=>id===topicId).length,updated_at:new Date().toISOString()},old_record:{},errors:null}}));
}
async function fixture(context){
  await context.route(cloud+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json'};
    const reply=(status,data)=>route.fulfill({status,headers,body:data===undefined?'':JSON.stringify(data)});
    if(request.method()==='OPTIONS')return reply(204);
    const body=request.postDataJSON()||{};
    const authorized=request.headers().authorization==='Bearer '+token;
    if(url.pathname==='/auth/v1/token') {
      if(body.email!==user.email || body.password!=='fixture-password')return reply(400,{code:'invalid_credentials',msg:'Invalid login credentials',error_description:'Invalid login credentials'});
      return reply(200,{access_token:token,refresh_token:'fixture-refresh-token',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user});
    }
    if(url.pathname==='/auth/v1/user')return reply(authorized?200:401,authorized?user:{message:'Not authenticated'});
    if(url.pathname==='/auth/v1/logout')return reply(204);
    if(url.pathname==='/rest/v1/rpc/get_voting_topics')return reply(200,{topics});
    if(url.pathname==='/rest/v1/rpc/is_voting_admin')return reply(200,authorized);
    if(url.pathname==='/rest/v1/rpc/get_voting_metrics')return authorized?reply(200,metrics()):reply(403,{code:'42501',message:'FORBIDDEN'});
    if(url.pathname==='/rest/v1/rpc/cast_vote'){
      if(typeof body.p_matricula!=='string'||!/^\d{5}$/.test(body.p_matricula))return reply(400,{code:'22023',message:'INVALID_MATRICULA'});
      if(votes.has(body.p_matricula))return reply(400,{code:'P0001',message:'VOTE_ALREADY_RECORDED'});
      if(!topics.some(t=>t.id===body.p_topic_id))return reply(400,{code:'22023',message:'INVALID_TOPIC'});
      votes.set(body.p_matricula,body.p_topic_id);
      await reply(200,{topicId:body.p_topic_id});broadcast(body.p_topic_id);return;
    }
    return reply(404,{message:'Fixture route not found'});
  });
  await context.routeWebSocket('wss://fixture.supabase.co/**',ws=>{
    let info;
    ws.onMessage(raw=>{
      const value=JSON.parse(String(raw));
      const message=Array.isArray(value)?{joinRef:value[0],ref:value[1],topic:value[2],event:value[3],payload:value[4]}:value;
      if(message.event==='phx_join'){
        info={ws,array:Array.isArray(value),topic:message.topic,joinRef:message.joinRef};connections.add(info);
        ws.send(eventFor(info,'phx_reply',{status:'ok',response:{postgres_changes:[{id:1,event:'*',schema:'public',table:'voting_totals'}]}},message.ref));
      } else if(message.event==='phx_leave'){
        if(info){connections.delete(info);ws.send(eventFor(info,'phx_reply',{status:'ok',response:{}},message.ref));}
      } else if(message.event==='heartbeat'){
        ws.send(JSON.stringify({topic:'phoenix',event:'phx_reply',payload:{status:'ok',response:{}},ref:message.ref}));
      }
    });
    ws.onClose(()=>{if(info)connections.delete(info);});
  });
}
function watch(page){
  page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));
}
async function cast(page,title,matricula){
  await page.getByRole('radio',{name:new RegExp(title)}).check();
  await page.getByRole('button',{name:'Votar neste tema'}).click();
  await page.getByLabel('Matrícula do aluno').fill(matricula);
  await page.getByRole('button',{name:'Confirmar meu voto'}).click();
}
(async()=>{
  execFileSync(process.execPath,['scripts/build-pages.mjs','--out-dir',output],{cwd:root,env:{...process.env,SUPABASE_URL:cloud,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture_public_key'},stdio:'pipe'});
  server=createServer((request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname;
    if(!path.startsWith(prefix)){response.writeHead(404);response.end();return;}
    const relative=decodeURIComponent(path.slice(prefix.length))||'index.html';
    if(relative.includes('..')){response.writeHead(404);response.end();return;}
    try{
      const bytes=readFileSync(join(output,relative));
      response.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(relative)]||'application/octet-stream'});response.end(bytes);
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}${prefix}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)});
  const racingContext=await browser.newContext();await fixture(racingContext);
  let releaseCatalogue, catalogueStarted;
  const catalogueGate=new Promise(resolve=>{releaseCatalogue=resolve;});
  const capturedCatalogue=new Promise(resolve=>{catalogueStarted=resolve;});
  await racingContext.route(cloud+'/rest/v1/rpc/get_voting_topics',async route=>{
    catalogueStarted();await catalogueGate;
    await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*','Content-Type':'application/json'},body:JSON.stringify({topics})});
  });
  const racingPage=await racingContext.newPage();watch(racingPage);
  await racingPage.goto(base);await capturedCatalogue;
  await racingPage.getByRole('link',{name:'Métricas',exact:true}).click();
  await racingPage.getByRole('heading',{name:'Entrar nas métricas'}).waitFor();
  const lateCatalogue=racingPage.waitForResponse(response=>response.url().endsWith('/get_voting_topics'));
  releaseCatalogue();await (await lateCatalogue).finished();
  await racingPage.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await racingPage.getByRole('heading',{name:'Entrar nas métricas'}).isVisible(),true,'A stale voting response must not replace the selected admin route');
  await racingContext.close();
  const studentContext=await browser.newContext({viewport:{width:390,height:844}});await fixture(studentContext);
  const student=await studentContext.newPage();watch(student);
  await student.goto(base);await student.getByRole('radio').first().waitFor();
  assert.equal(await student.getByRole('radio').count(),15);
  assert.equal(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const adminContext=await browser.newContext({viewport:{width:1440,height:1000}});await fixture(adminContext);
  const admin=await adminContext.newPage();watch(admin);
  await admin.goto(base+'#metricas');await admin.getByLabel('E-mail de administrador').fill(user.email);
  await admin.getByLabel('Senha de administrador').fill('fixture-password');await admin.getByRole('button',{name:'Acessar painel'}).click();
  await admin.locator('#total-votes').filter({hasText:'0'}).waitFor();
  await admin.locator('#live-connection').filter({hasText:'Ao vivo'}).waitFor();
  await admin.getByRole('link',{name:'Exportar CSV'}).focus();
  await cast(student,'Robótica','27250');await student.getByText('Voto registrado. Sua voz faz a diferença!').waitFor();
  await admin.waitForFunction(()=>document.querySelector('#total-votes')?.textContent==='1',null,{timeout:6000});
  assert.equal(await admin.locator('#leader-name').innerText(),'Robótica');
  assert.equal(await admin.evaluate(()=>document.activeElement.id),'export-csv','Realtime must retain focused controls');
  await student.reload();await student.getByText('Voto registrado. Sua voz faz a diferença!').waitFor();
  await student.getByRole('button',{name:'Votar com outra matrícula'}).click();
  await cast(student,'Desenvolvimento de games','27250');await student.getByRole('alert').filter({hasText:/matrícula/}).waitFor();
  assert.equal(votes.size,1);assert.equal(await student.getByRole('dialog').isVisible(),true);
  await student.getByLabel('Matrícula do aluno').fill('00123');await student.getByRole('button',{name:'Confirmar meu voto'}).click();
  await student.getByText('Voto registrado. Sua voz faz a diferença!').waitFor();
  await admin.waitForFunction(()=>document.querySelector('#total-votes')?.textContent==='2',null,{timeout:6000});
  assert.equal(await admin.locator('#leader-name').innerText(),'Empate entre 2 tópicos');
  const downloaded=admin.waitForEvent('download');await admin.getByRole('link',{name:'Exportar CSV'}).click();const download=await downloaded;
  assert.equal(download.suggestedFilename(),'votacao.csv');const content=readFileSync(await download.path(),'utf8');
  assert.match(content,/Robótica/);assert.doesNotMatch(content,/27250|00123|fixture-password/);
  await admin.getByRole('button',{name:'Sair'}).click();await admin.getByRole('heading',{name:'Entrar nas métricas'}).waitFor();
  await admin.waitForFunction(()=>!document.querySelector('#total-votes'));
  // A later event must not restore the private dashboard.
  broadcast('design-web');await admin.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await admin.getByRole('heading',{name:'Entrar nas métricas'}).isVisible(),true);
  await admin.getByRole('link',{name:'Votação',exact:true}).click();await admin.getByRole('radio').first().waitFor();
  assert.equal(new URL(admin.url()).pathname,prefix);assert.equal(new URL(admin.url()).hash,'');
  assert.equal(connections.size,0,'Logout must remove the Realtime channel');
  assert.deepEqual(errors,[]);
  console.log('PASS Pages fixture: subdirectory/assets/hash navigation, cloud Auth, 15 topics, matricula/duplicate, session receipt, actual SDK Realtime updates under6s, focus, CSV and logout. Not a live Supabase deployment.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(output,{recursive:true,force:true});
});
