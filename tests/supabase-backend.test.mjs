import test from 'node:test';
import assert from 'node:assert/strict';

const config = {supabaseUrl:'https://project-a.supabase.co',supabasePublishableKey:'sb_publishable_fixture'};
const topic = {id:'redes',title:'Redes e servidores',category:'Suporte técnico',description:'Conectividade',skills:['Linux']};
const metrics = {totalVotes:2,topics:[{...topic,votes:2,percentage:100}],categories:[{name:topic.category,votes:2,percentage:100}],timeline:[{date:'2026-11-05',votes:2}],leaders:[topic.id],updatedAt:'2026-11-05T14:00:00Z'};

function memoryStorage() {
  const entries = new Map();
  return {entries,getItem:key=>entries.get(key) ?? null,setItem:(key,value)=>entries.set(key,String(value)),removeItem:key=>entries.delete(key)};
}

function token() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:'11111111-1111-4111-8111-111111111111',exp:Math.floor(Date.now()/1000)+3600})}.fixture`;
}

// Supabase's real SDK serializes requests and manages Auth. Only the remote HTTP
// service is replaced; assertions exercise the adapter's results and effects.
async function fixture(overrides = {}) {
  const {createClient} = await import('@supabase/supabase-js');
  const {createSupabaseBackend} = await import('../public/supabase-backend.mjs');
  const calls = [];
  const state = {admin:true,errors:{},...overrides};
  const fetch = async (input, init = {}) => {
    const request = new Request(input,init);
    const body = request.method === 'GET' ? null : await request.text();
    const call = {path:new URL(request.url).pathname,query:new URL(request.url).search,method:request.method,headers:request.headers,body:body ? JSON.parse(body) : null};
    calls.push(call);
    if (state.networkFailure) throw new TypeError('remote fixture unavailable');
    const reply = (data,status=200) => new Response(data === undefined ? null : JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    if (state.respond) {
      const response = await state.respond(call,reply);
      if (response) return response;
    }
    if (call.path === '/auth/v1/token') {
      if (state.invalidCredentials) return reply({code:'invalid_credentials',msg:'Invalid login credentials'},400);
      return reply({access_token:token(),refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user:{id:'11111111-1111-4111-8111-111111111111',email:'admin@example.test',aud:'authenticated',role:'authenticated'}});
    }
    if (call.path === '/auth/v1/logout') return reply(undefined,204);
    if (call.path === '/auth/v1/recover') return reply({});
    if (call.path === '/auth/v1/user' && call.method === 'PUT') return reply({id:'11111111-1111-4111-8111-111111111111',email:'admin@example.test',aud:'authenticated',role:'authenticated'});
    const name = call.path.split('/').at(-1);
    if (state.errors[name]) return reply(state.errors[name],state.errors[name].httpStatus || 400);
    if (name === 'get_voting_topics') return reply({topics:[topic]});
    if (name === 'cast_vote') return reply({topicId:call.body.p_topic_id});
    if (name === 'is_voting_admin') return reply(state.admin);
    if (name === 'get_voting_metrics') return reply(state.metrics || metrics);
    throw new Error(`Unimplemented fixture endpoint: ${call.path}`);
  };
  const client = createClient(config.supabaseUrl,config.supabasePublishableKey,{global:{fetch},auth:{storage:memoryStorage(),autoRefreshToken:false,persistSession:true,detectSessionInUrl:false}});
  const storage = memoryStorage();
  const backend = createSupabaseBackend(config,{client,storage,...(overrides.locationUrl ? {locationUrl:overrides.locationUrl} : {})});
  const login = () => backend.request('/api/admin/login',{method:'POST',body:{email:'admin@example.test',password:'fixture-password'}});
  return {backend,client,calls,state,storage,login,fetch,createSupabaseBackend};
}

async function statusOf(promise, expectedStatus, message) {
  let thrown;
  try { await promise; } catch(error) { thrown=error; }
  assert.ok(thrown instanceof Error,'esperava um Error em vez de sucesso');
  assert.equal(thrown.status,expectedStatus);
  if (message) assert.match(thrown.message,message);
  return thrown;
}

test('exporta o adapter Supabase com o contrato público', async () => {
  let adapter;
  try { adapter = await import('../public/supabase-backend.mjs'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof adapter?.createSupabaseBackend, 'function');
});

test('catálogo usa RPC real e o recibo começa vazio', async () => {
  const {backend,calls} = await fixture();
  assert.equal(backend.mode,'supabase');
  assert.equal(typeof backend.subscribeMetrics,'function');
  assert.equal(typeof backend.exportCsv,'function');
  assert.deepEqual(await backend.request('/api/topics'),{topics:[topic]});
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:false,topicId:null});
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/rest/v1/rpc/get_voting_topics');
  assert.equal(calls[0].method,'POST');
  assert.equal(calls[0].headers.get('apikey'),config.supabasePublishableKey);
});

test('voto preserva zeros, normaliza bordas e persiste somente tópico por projeto', async () => {
  const {backend,calls,storage,client,createSupabaseBackend} = await fixture();
  assert.deepEqual(await backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:' 00123 '}}),{topicId:topic.id});
  assert.deepEqual(calls[0].body,{p_topic_id:topic.id,p_matricula:'00123'});
  assert.equal(storage.entries.size,1);
  assert.deepEqual(JSON.parse([...storage.entries.values()][0]),{topicId:topic.id});
  assert.ok(!JSON.stringify([...storage.entries]).includes('00123'));
  assert.deepEqual(await createSupabaseBackend(config,{client,storage}).request('/api/voter'),{hasVoted:true,topicId:topic.id});
  const otherProject = {...config,supabaseUrl:'https://project-b.supabase.co'};
  assert.deepEqual(await createSupabaseBackend(otherProject,{client,storage}).request('/api/voter'),{hasVoted:false,topicId:null});
});

test('409 não expõe tópico nem altera recibo existente', async () => {
  const {backend,state,storage} = await fixture();
  await backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}});
  const before = [...storage.entries];
  state.errors.cast_vote={code:'P0001',message:'VOTE_ALREADY_RECORDED',details:'sensitive-topic',hint:'sensitive-id'};
  const error = await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:'outro',matricula:'00123'}}),409,/Esta matrícula já registrou um voto/);
  assert.equal(error.topicId,undefined);
  assert.equal(error.data,undefined);
  assert.ok(!JSON.stringify(error).includes('sensitive'));
  assert.deepEqual([...storage.entries],before);
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:true,topicId:topic.id});
});

test('voto duplicado sem recibo não cria sessão de votação', async () => {
  const {backend,state,storage} = await fixture();
  state.errors.cast_vote={code:'P0001',message:'VOTE_ALREADY_RECORDED'};
  await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}}),409);
  assert.equal(storage.entries.size,0);
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:false,topicId:null});
});

test('entrada inválida é 400 antes de enviar matrícula para a rede', async () => {
  const {backend,calls,storage} = await fixture();
  for (const matricula of [null,12345,'1234','123456','１２３４５','12 45','1234\n5']) {
    await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula}}),400,/5 dígitos/);
  }
  await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:null,matricula:'00123'}}),400);
  await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123',email:'extra'}}),400);
  assert.equal(calls.length,0);
  assert.equal(storage.entries.size,0);
});

test('erros RPC são mensagens portuguesas sem detalhes remotos', async () => {
  const {backend,state,storage} = await fixture();
  for (const [remote,status,message] of [
    [{code:'22023',message:'INVALID_MATRICULA'},400,/5 dígitos/],
    [{code:'22023',message:'INVALID_TOPIC'},400,/tópico válido/],
    [{code:'P0001',message:'unexpected sensitive backend failure'},503,/Não foi possível/],
    [{code:'XX000',message:'sensitive database failure'},503,/Não foi possível/],
  ]) {
    state.errors.cast_vote=remote;
    const error = await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}}),status,message);
    assert.ok(!error.message.includes('sensitive'));
    assert.equal(storage.entries.size,0);
  }
});

test('falha de rede é 503 e não marca voto como registrado', async () => {
  const {backend,state,storage} = await fixture();
  state.networkFailure=true;
  await statusOf(backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}}),503,/Não foi possível/);
  assert.equal(storage.entries.size,0);
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:false,topicId:null});
});

test('sessão ausente não pode ler métricas nem exportar CSV', async () => {
  const {backend,calls} = await fixture();
  assert.deepEqual(await backend.request('/api/admin/session'),{authenticated:false});
  await statusOf(backend.request('/api/admin/metrics'),401);
  await statusOf(backend.exportCsv(),401);
  assert.equal(calls.length,0);
});

test('login exige email/senha e verifica autorização com RPC além da sessão Auth', async () => {
  const {backend,calls,login} = await fixture();
  assert.deepEqual(await login(),{authenticated:true});
  assert.equal(calls[0].path,'/auth/v1/token');
  assert.equal(calls[0].query,'?grant_type=password');
  assert.deepEqual(calls[0].body,{email:'admin@example.test',password:'fixture-password',gotrue_meta_security:{}});
  assert.equal(calls[1].path,'/rest/v1/rpc/is_voting_admin');
  assert.deepEqual(await backend.request('/api/admin/session'),{authenticated:true});
  assert.equal(calls.at(-1).path,'/rest/v1/rpc/is_voting_admin');
  assert.deepEqual(await backend.request('/api/admin/metrics'),metrics);
  assert.equal(calls.at(-1).path,'/rest/v1/rpc/get_voting_metrics');
});

test('Auth sem permissão fecha a sessão e retorna 403', async () => {
  const {backend,client,calls,login} = await fixture({admin:false});
  await statusOf(login(),403,/permissão/);
  assert.equal(calls.at(-1).path,'/auth/v1/logout');
  assert.equal((await client.auth.getSession()).data.session,null);
  assert.deepEqual(await backend.request('/api/admin/session'),{authenticated:false});
});

test('sessão Auth restaurada deve passar por is_voting_admin e é encerrada se revogada', async () => {
  const {backend,client,state,calls,login} = await fixture();
  await login();
  state.admin=false;
  assert.deepEqual(await backend.request('/api/admin/session'),{authenticated:false});
  assert.ok(calls.some(call=>call.path==='/rest/v1/rpc/is_voting_admin'));
  assert.equal((await client.auth.getSession()).data.session,null);
  await statusOf(backend.request('/api/admin/metrics'),401);
});

test('credenciais incorretas são 401, indisponibilidade de Auth é 503', async () => {
  const {backend,state,login,calls} = await fixture({invalidCredentials:true});
  await statusOf(login(),401,/[Ee]-?mail|[Ss]enha|[Cc]redenciais/);
  assert.ok(!calls.some(call=>call.path==='/rest/v1/rpc/is_voting_admin'));
  state.invalidCredentials=false;
  state.respond=(call,reply)=>call.path==='/auth/v1/token' ? reply({msg:'fixture unavailable'},503) : undefined;
  await statusOf(login(),503);
  await statusOf(backend.request('/api/admin/login',{method:'POST',body:{password:'only-password'}}),400);
});

test('falha ao verificar admin não autoriza sessão nem assinatura', async () => {
  const f = await fixture();
  f.state.errors.is_voting_admin={code:'XX000',message:'sensitive'};
  await statusOf(f.login(),503);
  const wire = realtimeWire(f.client);
  const cleanup = f.backend.subscribeMetrics(()=>assert.fail('não deveria atualizar'));
  assert.equal(typeof cleanup,'function');
  assert.equal(wire.channels.length,0);
  cleanup();
});

test('CSV autorizado mantém ordem, BOM, colunas locais e escape de aspas/vírgula/quebra', async () => {
  const cloudMetrics = {...metrics,topics:[
    {...topic,title:'Rede, "Linux"\nBásico',category:'Suporte técnico',votes:1,percentage:33.3333,matricula:'never-export',email:'never-export@example.test'},
    {...topic,id:'design',title:'Design',category:'Design',votes:2,percentage:66.6667},
  ]};
  const {backend,login} = await fixture({metrics:cloudMetrics});
  await login();
  assert.equal(await backend.exportCsv(),'\uFEFFTópico,Área,Votos,Percentual\r\n"Rede, ""Linux""\nBásico",Suporte técnico,1,33.33\r\nDesign,Design,2,66.67\r\n');
});

function realtimeWire(client) {
  const channels = [], removed=[];
  client.channel = name => {
    const channel = {name,on(type,filter,callback){this.type=type;this.filter=filter;this.event=callback;return this;},subscribe(callback){this.status=callback;return this;}};
    channels.push(channel);
    return channel;
  };
  client.removeChannel = async channel => {removed.push(channel);return 'ok';};
  return {channels,removed};
}

test('Realtime exige admin verificado, reconcilia SUBSCRIBED e acompanha reconexão', async () => {
  const {backend,client,login} = await fixture();
  const wire=realtimeWire(client), statuses=[], changes=[];
  const noSession=backend.subscribeMetrics(()=>changes.push('unauthorized'),status=>statuses.push(status));
  assert.equal(wire.channels.length,0);
  noSession();
  await login();
  const stop=backend.subscribeMetrics(()=>changes.push('changed'),status=>statuses.push(status));
  assert.equal(wire.channels.length,1);
  const channel=wire.channels[0];
  assert.equal(channel.type,'postgres_changes');
  assert.deepEqual(channel.filter,{event:'*',schema:'public',table:'voting_totals'});
  assert.equal(statuses.at(-1),'reconnecting');
  channel.status('SUBSCRIBED');
  assert.equal(statuses.at(-1),'connected');
  assert.deepEqual(changes,['changed']);
  channel.event({new:{topic_id:'redes',votes:2}});
  assert.equal(changes.length,2);
  for (const status of ['CHANNEL_ERROR','TIMED_OUT','CLOSED']) {
    channel.status(status);
    assert.equal(statuses.at(-1),'reconnecting');
  }
  const statusCount=statuses.length;
  stop(); stop();
  channel.status('SUBSCRIBED'); channel.event({});
  assert.equal(changes.length,2);
  assert.equal(statuses.length,statusCount);
  assert.deepEqual(wire.removed,[channel]);
});

test('logout remove todas assinaturas e ignora eventos tardios', async () => {
  const {backend,client,login} = await fixture();
  await login();
  const wire=realtimeWire(client), changes=[];
  const stop=backend.subscribeMetrics(()=>changes.push(1));
  const stopOther=backend.subscribeMetrics(()=>changes.push(2));
  assert.deepEqual(await backend.request('/api/admin/logout',{method:'POST'}),{authenticated:false});
  assert.equal(wire.removed.length,2);
  for (const channel of wire.channels) {channel.event({});channel.status('SUBSCRIBED');}
  assert.deepEqual(changes,[]);
  stop(); stopOther();
  assert.equal(wire.removed.length,2);
  backend.subscribeMetrics(()=>changes.push(3))();
  assert.equal(wire.channels.length,2);
});

test('logout durante login pendente termina sem sessão tardia nem autorização restaurada', async () => {
  let releaseToken, tokenStarted;
  const tokenGate=new Promise(resolve=>{releaseToken=resolve;});
  const started=new Promise(resolve=>{tokenStarted=resolve;});
  const f=await fixture({respond:async call=>{if(call.path==='/auth/v1/token'){tokenStarted();await tokenGate;}}});
  const loginResult=f.login().then(value=>({value}),error=>({error}));
  await started;
  const logout=f.backend.request('/api/admin/logout',{method:'POST'});
  // Drain the already-started logout without requiring a timing delay; it must
  // remain safe whether the Auth response is still pending or has completed.
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await f.backend.request('/api/admin/session'),{authenticated:false});
  releaseToken();
  assert.deepEqual(await logout,{authenticated:false});
  assert.equal((await loginResult).error?.status,401);
  assert.equal((await f.client.auth.getSession()).data.session,null);
  assert.deepEqual(await f.backend.request('/api/admin/session'),{authenticated:false});
});

test('login novo após logout pendente permanece válido quando a operação anterior termina', async () => {
  let releaseToken, tokenStarted, first=true;
  const tokenGate=new Promise(resolve=>{releaseToken=resolve;});
  const started=new Promise(resolve=>{tokenStarted=resolve;});
  const f=await fixture({respond:async call=>{if(call.path==='/auth/v1/token' && first){first=false;tokenStarted();await tokenGate;}}});
  const oldLogin=f.login().then(value=>({value}),error=>({error}));
  await started;
  const logout=f.backend.request('/api/admin/logout',{method:'POST'});
  const newLogin=f.login();
  releaseToken();
  assert.equal((await oldLogin).error?.status,401);
  assert.deepEqual(await logout,{authenticated:false});
  assert.deepEqual(await newLogin,{authenticated:true});
  assert.ok((await f.client.auth.getSession()).data.session);
  assert.deepEqual(await f.backend.request('/api/admin/session'),{authenticated:true});
});

test('nãoadmin perde a sessão local mesmo se revogação remota falhar', async () => {
  const f=await fixture({admin:false,respond:(call,reply)=>call.path==='/auth/v1/logout' ? reply({msg:'offline'},503) : undefined});
  await statusOf(f.login(),403);
  assert.equal((await f.client.auth.getSession()).data.session,null);
});

test('falha de logout também encerra atualizações e invalida autorização em memória', async () => {
  const {backend,client,login,state} = await fixture();
  await login();
  const wire=realtimeWire(client), changes=[];
  backend.subscribeMetrics(()=>changes.push(1));
  state.respond=(call,reply)=>call.path==='/auth/v1/logout' ? reply({msg:'offline'},503) : undefined;
  await statusOf(backend.request('/api/admin/logout',{method:'POST'}),503);
  assert.equal(wire.removed.length,1);
  wire.channels[0].event({});
  assert.deepEqual(changes,[]);
  backend.subscribeMetrics(()=>changes.push(2))();
  assert.equal(wire.channels.length,1);
});

test('storage indisponível não transforma voto confirmado em falha nem armazena matrícula', async () => {
  const {client,createSupabaseBackend} = await fixture();
  const storage={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  const backend=createSupabaseBackend(config,{client,storage});
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:false,topicId:null});
  assert.deepEqual(await backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}}),{topicId:topic.id});
  assert.deepEqual(await backend.request('/api/voter'),{hasVoted:true,topicId:topic.id});
});

test('cliente padrão usa SDK oficial e sessionStorage somente para recibo', async t => {
  const f = await fixture();
  const originalFetch=globalThis.fetch;
  const originalStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const storage=memoryStorage();
  globalThis.fetch=f.fetch;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});
  t.after(()=>{globalThis.fetch=originalFetch;if(originalStorage)Object.defineProperty(globalThis,'sessionStorage',originalStorage);else delete globalThis.sessionStorage;});
  const backend=f.createSupabaseBackend(config);
  assert.deepEqual(await backend.request('/api/topics'),{topics:[topic]});
  await backend.request('/api/votes',{method:'POST',body:{topicId:topic.id,matricula:'00123'}});
  assert.deepEqual([...storage.entries.values()].map(JSON.parse),[{topicId:topic.id}]);
});


const recoveryUrl='https://example.github.io/SISTEMA-DE-VOTA-O/?old=private#metricas';
const sendRecovery=(backend,email='admin@example.test')=>backend.request('/api/admin/recover',{method:'POST',body:{email}});
const setPassword=(backend,password='new-fixture-password')=>backend.request('/api/admin/password',{method:'POST',body:{password}});
async function signInForRecovery(client) {
  const {error}=await client.auth.signInWithPassword({email:'admin@example.test',password:'fixture-password'});
  assert.equal(error,null);
}

test('recuperação usa SDK real, email normalizado e redirect na raiz Pages sem hash', async()=>{
  const f=await fixture({locationUrl:recoveryUrl});
  assert.deepEqual(await sendRecovery(f.backend,'  admin@example.test  '),{sent:true});
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].path,'/auth/v1/recover');
  assert.equal(f.calls[0].body.email,'admin@example.test');
  assert.equal(new URLSearchParams(f.calls[0].query).get('redirect_to'),'https://example.github.io/SISTEMA-DE-VOTA-O/?recovery=1');
  assert.ok(!JSON.stringify(f.calls[0].body).includes('private'));
  assert.deepEqual(await sendRecovery(f.backend,'unknown@example.test'),{sent:true});
});

test('recuperação consulta location global apenas no endpoint novo', async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://127.0.0.1:8000/#metricas'}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'location',original);else delete globalThis.location;});
  const f=await fixture();
  assert.deepEqual(await sendRecovery(f.backend),{sent:true});
  assert.equal(new URLSearchParams(f.calls[0].query).get('redirect_to'),'http://127.0.0.1:8000/?recovery=1');
});

test('email inválido falha antes da rede e erros Auth não expõem detalhes privados', async()=>{
  const f=await fixture({locationUrl:recoveryUrl});
  for(const email of [null,12345,'','   ','without-at','admin@','two@@example.test','has space@example.test']) {
    await statusOf(sendRecovery(f.backend,email),400,/email|e-mail/i);
  }
  assert.equal(f.calls.length,0);
  for(const [remoteStatus,expected] of [[400,400],[429,429],[503,503]]) {
    f.state.respond=(call,reply)=>call.path==='/auth/v1/recover' ? reply({code:'private-error',msg:'private-email-token'},remoteStatus) : undefined;
    const error=await statusOf(sendRecovery(f.backend),expected);
    assert.ok(!JSON.stringify(error).includes('private'));
    assert.ok(!error.message.includes('private'));
  }
});

test('falha de transporte em recuperação retorna 503 neutro', async()=>{
  const f=await fixture({locationUrl:recoveryUrl,respond:call=>{if(call.path==='/auth/v1/recover')throw new DOMException('private-token','AbortError');}});
  const error=await statusOf(sendRecovery(f.backend),503,/Não foi possível/);
  assert.ok(!error.message.includes('private'));
});

test('sessão de recuperação retorna somente booleano sem RPC de admin ou dados Auth', async()=>{
  const f=await fixture({admin:false});
  assert.deepEqual(await f.backend.request('/api/admin/recovery-session'),{authenticated:false});
  await signInForRecovery(f.client);
  f.calls.length=0;
  assert.deepEqual(await f.backend.request('/api/admin/recovery-session'),{authenticated:true});
  assert.equal(f.calls.length,0);
  assert.ok((await f.client.auth.getSession()).data.session);
});

test('alteração de senha exige sessão e valida 8 a 1024 caracteres sem enviar senha inválida', async()=>{
  const f=await fixture();
  await statusOf(setPassword(f.backend),401,/expir|link|sessão/i);
  await signInForRecovery(f.client);
  f.calls.length=0;
  for(const password of [null,12345,'','short7','x'.repeat(1025)]) await statusOf(setPassword(f.backend,password),400,/senha/i);
  assert.equal(f.calls.length,0);
  assert.deepEqual(await setPassword(f.backend,'x'.repeat(1024)),{updated:true});
  assert.equal(f.calls.find(call=>call.path==='/auth/v1/user').body.password.length,1024);
});

test('consulta de recuperação iniciada antes de logout não devolve sessão tardia', async()=>{
  const f=await fixture();
  await signInForRecovery(f.client);
  const session=f.backend.request('/api/admin/recovery-session');
  const logout=f.backend.request('/api/admin/logout',{method:'POST'});
  assert.deepEqual(await session,{authenticated:false});
  await logout;
});

test('usuário não admin pode definir própria senha e termina sem sessão ou permissão', async()=>{
  const f=await fixture({admin:false});
  await signInForRecovery(f.client);
  f.calls.length=0;
  assert.deepEqual(await setPassword(f.backend,'eight888'),{updated:true});
  assert.equal(f.calls[0].path,'/auth/v1/user');
  assert.equal(f.calls[0].method,'PUT');
  assert.equal(f.calls[0].body.password,'eight888');
  assert.equal(f.calls.at(-1).path,'/auth/v1/logout');
  assert.equal(new URLSearchParams(f.calls.at(-1).query).get('scope'),'local');
  assert.ok(!f.calls.some(call=>call.path.startsWith('/rest/')));
  assert.equal((await f.client.auth.getSession()).data.session,null);
  assert.deepEqual(await f.backend.request('/api/admin/recovery-session'),{authenticated:false});
  await statusOf(f.backend.request('/api/admin/metrics'),401);
});

test('sucesso na senha continua sucesso se revogação remota falhar após limpeza local', async()=>{
  const f=await fixture({respond:(call,reply)=>call.path==='/auth/v1/logout' ? reply({msg:'private-offline'},503) : undefined});
  await signInForRecovery(f.client);
  assert.deepEqual(await setPassword(f.backend),{updated:true});
  assert.equal((await f.client.auth.getSession()).data.session,null);
});

test('erros de updateUser são traduzidos sem senha ou payload remoto', async()=>{
  const f=await fixture();
  await signInForRecovery(f.client);
  for(const [remoteStatus,expected] of [[400,400],[401,401],[429,429],[503,503]]) {
    f.state.respond=(call,reply)=>call.path==='/auth/v1/user' ? reply({code:'private-error',msg:'private-password-token'},remoteStatus) : undefined;
    const error=await statusOf(setPassword(f.backend),expected);
    assert.ok(!error.message.includes('private'));
    assert.equal(error.data,undefined);
  }
});

test('troca de senha fecha assinaturas imediatamente e eventos tardios permanecem fechados', async()=>{
  let releaseUpdate, updateStarted;
  const gate=new Promise(resolve=>{releaseUpdate=resolve;});
  const started=new Promise(resolve=>{updateStarted=resolve;});
  const f=await fixture({respond:async call=>{if(call.path==='/auth/v1/user'){updateStarted();await gate;}}});
  await f.login();
  const wire=realtimeWire(f.client), changes=[];
  f.backend.subscribeMetrics(()=>changes.push('changed'));
  const password=setPassword(f.backend);
  assert.equal(wire.removed.length,1);
  await started;
  assert.deepEqual(await f.backend.request('/api/admin/session'),{authenticated:false});
  const logout=f.backend.request('/api/admin/logout',{method:'POST'});
  for(const channel of wire.channels){channel.event({});channel.status('SUBSCRIBED');}
  releaseUpdate();
  assert.deepEqual(await password,{updated:true});
  assert.deepEqual(await logout,{authenticated:false});
  assert.deepEqual(changes,[]);
  assert.equal((await f.client.auth.getSession()).data.session,null);
});

test('logout pendente impede updateUser posterior de reutilizar sessão antiga', async()=>{
  let releaseLogout, logoutStarted;
  const gate=new Promise(resolve=>{releaseLogout=resolve;});
  const started=new Promise(resolve=>{logoutStarted=resolve;});
  const f=await fixture({respond:async call=>{if(call.path==='/auth/v1/logout'){logoutStarted();await gate;}}});
  await signInForRecovery(f.client);
  const logout=f.backend.request('/api/admin/logout',{method:'POST'});
  await started;
  const passwordResult=setPassword(f.backend).then(value=>({value}),error=>({error}));
  releaseLogout();
  await logout;
  assert.equal((await passwordResult).error?.status,401);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user'));
  assert.deepEqual(await f.backend.request('/api/admin/recovery-session'),{authenticated:false});
});

async function failedCallbackFixture(t,status=401,callbackUrl='https://example.github.io/repo/?recovery=1#access_token=invalid-callback&refresh_token=invalid-refresh&expires_in=3600&token_type=bearer&type=recovery',authOptions={}) {
  const f=await fixture({respond:(call,reply)=>call.path==='/auth/v1/user' && call.method==='GET' ? reply({code:'bad_jwt',msg:'private-invalid-callback'},status) : undefined});
  await signInForRecovery(f.client);
  const previousSession=(await f.client.auth.getSession()).data.session;
  const {createClient}=await import('@supabase/supabase-js');
  const authStorage=memoryStorage();
  const storageKey=`recovery-callback-fixture-${Math.random().toString(36).slice(2)}`;
  authStorage.setItem(storageKey,JSON.stringify(previousSession));
  const saved=new Map(['window','document','BroadcastChannel'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const restore=()=>{for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}};
  let client;
  try {
    Object.defineProperty(globalThis,'window',{configurable:true,value:{location:new URL(callbackUrl)}});
    Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'hidden'}});
    Object.defineProperty(globalThis,'BroadcastChannel',{configurable:true,value:undefined});
    client=createClient(config.supabaseUrl,config.supabasePublishableKey,{global:{fetch:f.fetch},auth:{storage:authStorage,storageKey,autoRefreshToken:false,persistSession:true,detectSessionInUrl:true,...authOptions}});
    const initialized=await client.auth.initialize();
    assert.ok(initialized.error,'SDK deve detectar callback inválido de verdade');
  } finally {restore();}
  t.after(()=>client?.auth.dispose());
  assert.ok((await client.auth.getSession()).data.session,'SDK preserva a sessão anterior, reproduzindo o bug');
  return {...f,client,backend:f.createSupabaseBackend(config,{client,storage:memoryStorage()})};
}

test('callback inválido não aceita sessão anterior nem permite trocar senha dessa conta', async t=>{
  const f=await failedCallbackFixture(t);
  const sessionError=await statusOf(f.backend.request('/api/admin/recovery-session'),401,/link|recuperação|expir/i);
  assert.ok(!sessionError.message.includes('private'));
  await statusOf(setPassword(f.backend),401,/link|recuperação|expir/i);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user' && call.method==='PUT'));
  assert.ok(!f.calls.some(call=>call.path.startsWith('/rest/')));
});

test('endpoint de senha recusa callback inválido mesmo sem consulta prévia da sessão', async t=>{
  const f=await failedCallbackFixture(t);
  await statusOf(setPassword(f.backend),401,/link|recuperação|expir/i);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user' && call.method==='PUT'));
});

test('falha de rede ao inicializar callback retorna 503 sem usar sessão anterior', async t=>{
  const f=await failedCallbackFixture(t,503);
  await statusOf(f.backend.request('/api/admin/recovery-session'),503,/Não foi possível/);
  await statusOf(setPassword(f.backend),503,/Não foi possível/);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user' && call.method==='PUT'));
});


test('hash otp_expired usa erro de link 401 apesar do status 500 sintético do SDK', async t=>{
  const f=await failedCallbackFixture(t,401,'https://example.github.io/repo/?recovery=1#error=access_denied&error_code=otp_expired&error_description=private-expired-link');
  const initialized=await f.client.auth.initialize();
  assert.equal(initialized.error.name,'AuthImplicitGrantRedirectError');
  assert.equal(initialized.error.status,500);
  await statusOf(f.backend.request('/api/admin/recovery-session'),401,/link|expir/i);
  await statusOf(setPassword(f.backend),401,/link|expir/i);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user' && call.method==='PUT'));
});

test('callback incompatível com PKCE também é link inválido e não erro de rede', async t=>{
  const f=await failedCallbackFixture(t,401,undefined,{flowType:'pkce'});
  const initialized=await f.client.auth.initialize();
  assert.equal(initialized.error.name,'AuthPKCEGrantCodeExchangeError');
  assert.equal(initialized.error.status,500);
  await statusOf(f.backend.request('/api/admin/recovery-session'),401,/link|expir/i);
  await statusOf(setPassword(f.backend),401,/link|expir/i);
  assert.ok(!f.calls.some(call=>call.path==='/auth/v1/user' && call.method==='PUT'));
});
