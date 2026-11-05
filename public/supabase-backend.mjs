import {createClient} from '@supabase/supabase-js';
import {normalizeMatricula} from './model.mjs';

const unavailable = 'Não foi possível acessar os dados. Confira sua conexão e tente novamente.';
const failure = (message,status) => Object.assign(new Error(message),{status});

function translatedError(error, context) {
  if (error.code === 'P0001' && error.message === 'VOTE_ALREADY_RECORDED') {
    return failure('Esta matrícula já registrou um voto.',409);
  }
  if (error.code === '22023') {
    return failure(error.message === 'INVALID_MATRICULA' ? 'Informe uma matrícula com exatamente 5 dígitos.' : 'Escolha um tópico válido.',400);
  }
  if (error.code === '42501') return failure('Você não tem permissão para acessar este painel.',403);
  if (error.status === 401 || error.code === 'PGRST301' || error.name === 'AuthSessionMissingError') {
    return failure('Sua sessão expirou. Entre novamente para continuar.',401);
  }
  if (context === 'login' && [400,403].includes(error.status)) return failure('Email ou senha incorretos.',401);
  return failure(unavailable,503);
}

function tabStorage() {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

const csvCell = value => {
  const text=String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text;
};

export function createSupabaseBackend(config, options = {}) {
  const client = options.client ?? createClient(config.supabaseUrl,config.supabasePublishableKey);
  const storage = options.storage ?? tabStorage();
  const receiptKey = `voting-receipt:${new URL(config.supabaseUrl).origin}`;
  let receipt = null, adminAuthorized = false, authEpoch = 0, channelSequence = 0;
  const subscriptions = new Set();
  let authQueue=Promise.resolve(), pendingAuth=0;
  function queueAuth(operation) {
    pendingAuth++;
    const task=authQueue.then(operation);
    authQueue=task.catch(()=>{});
    return task.finally(()=>{pendingAuth--;});
  }

  try {
    const stored = JSON.parse(storage?.getItem(receiptKey) ?? 'null');
    if (stored && typeof stored.topicId === 'string' && stored.topicId) receipt={topicId:stored.topicId};
  } catch { /* A blocked or invalid receipt must not prevent voting. */ }

  async function sdk(operation, context = 'rpc') {
    let result;
    try { result = await operation(); }
    catch { throw failure(unavailable,503); }
    if (result.error) throw translatedError(result.error,context);
    return result.data;
  }

  function invalidateAdmin() {
    adminAuthorized=false;
    for (const stop of [...subscriptions]) stop();
  }

  async function discardSession() {
    invalidateAdmin();
    try { await client.auth.signOut({scope:'local'}); } catch { /* Authorization still stays closed. */ }
  }

  async function verifyAdmin(epoch = authEpoch, duringLogin = false) {
    if(epoch!==authEpoch) throw failure('Sua sessão expirou. Entre novamente para continuar.',401);
    if(pendingAuth && !duringLogin) return false;
    let session, authorized;
    try {
      ({session} = await sdk(()=>client.auth.getSession()));
      if (!session) {invalidateAdmin();return false;}
      authorized = await sdk(()=>client.rpc('is_voting_admin'));
    } catch(error) {invalidateAdmin();throw error;}
    if (epoch !== authEpoch) throw failure('Sua sessão expirou. Entre novamente para continuar.',401);
    if (authorized !== true) {await discardSession();return false;}
    adminAuthorized=true;
    return true;
  }

  async function getMetrics() {
    if (!await verifyAdmin()) throw failure('Entre como administrador para acessar os resultados.',401);
    try { return await sdk(()=>client.rpc('get_voting_metrics')); }
    catch(error) {
      if ([401,403].includes(error.status)) invalidateAdmin();
      throw error;
    }
  }

  async function request(path, {method = 'GET', body} = {}) {
    method=method.toUpperCase();
    if (method === 'GET' && path === '/api/topics') return sdk(()=>client.rpc('get_voting_topics'));
    if (method === 'GET' && path === '/api/voter') return {hasVoted:receipt !== null,topicId:receipt?.topicId ?? null};
    if (method === 'POST' && path === '/api/votes') {
      if (!body || typeof body !== 'object' || Object.keys(body).length !== 2 || !Object.hasOwn(body,'topicId') || !Object.hasOwn(body,'matricula')) {
        throw failure('Solicitação de votação inválida.',400);
      }
      if (typeof body.topicId !== 'string' || !body.topicId) throw failure('Escolha um tópico válido.',400);
      const matricula=normalizeMatricula(body.matricula);
      if (matricula === null) throw failure('Informe uma matrícula com exatamente 5 dígitos.',400);
      const data=await sdk(()=>client.rpc('cast_vote',{p_topic_id:body.topicId,p_matricula:matricula}));
      if (!data || typeof data.topicId !== 'string' || !data.topicId) throw failure(unavailable,503);
      receipt={topicId:data.topicId};
      try { storage?.setItem(receiptKey,JSON.stringify(receipt)); } catch { /* Keep the confirmed receipt in memory when storage is blocked. */ }
      return {...receipt};
    }
    if (method === 'GET' && path === '/api/admin/session') return {authenticated:await verifyAdmin()};
    if (method === 'POST' && path === '/api/admin/login') {
      if (!body || typeof body.email !== 'string' || !body.email.trim() || typeof body.password !== 'string' || !body.password || body.password.length > 1024) {
        throw failure('Informe um email e uma senha válidos.',400);
      }
      const epoch=++authEpoch;
      invalidateAdmin();
      return queueAuth(async()=>{
        await sdk(()=>client.auth.signInWithPassword({email:body.email.trim(),password:body.password}),'login');
        if(epoch!==authEpoch) {
          await discardSession();
          throw failure('Sua sessão expirou. Entre novamente para continuar.',401);
        }
        if (!await verifyAdmin(epoch,true)) throw failure('Você não tem permissão para acessar este painel.',403);
        return {authenticated:true};
      });
    }
    if (method === 'POST' && path === '/api/admin/logout') {
      authEpoch++;
      invalidateAdmin();
      return queueAuth(async()=>{
        await sdk(()=>client.auth.signOut({scope:'local'}));
        return {authenticated:false};
      });
    }
    if (method === 'GET' && path === '/api/admin/metrics') return getMetrics();
    throw failure('Solicitação inválida.',400);
  }

  function subscribeMetrics(onChange, onStatus = () => {}) {
    if (!adminAuthorized) return () => {};
    let stopped=false, channel;
    const stop = () => {
      if (stopped) return;
      stopped=true;
      subscriptions.delete(stop);
      if (channel) {
        try { Promise.resolve(client.removeChannel(channel)).catch(()=>{}); } catch { /* Local callbacks are already disabled. */ }
      }
    };
    onStatus('reconnecting');
    try {
      channel=client.channel(`voting-metrics-${++channelSequence}`)
        .on('postgres_changes',{event:'*',schema:'public',table:'voting_totals'},()=>{if(!stopped)onChange();});
      subscriptions.add(stop);
      channel.subscribe(status=>{
        if (stopped) return;
        if (status === 'SUBSCRIBED') {onStatus('connected');onChange();}
        else if (['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status)) onStatus('reconnecting');
      });
    } catch {stop();onStatus('reconnecting');}
    return stop;
  }

  async function exportCsv() {
    const metrics=await getMetrics();
    const rows=[['Tópico','Área','Votos','Percentual'],...metrics.topics.map(topic=>[topic.title,topic.category,topic.votes,Number(topic.percentage).toFixed(2)])];
    return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  }

  return {request,subscribeMetrics,exportCsv,mode:'supabase'};
}
