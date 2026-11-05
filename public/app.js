import {filterTopics, leaderLabel, percentageLabel, normalizeMatricula} from './model.mjs';

const $ = selector => document.querySelector(selector);
const main = $('#main');
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const areaStyles = {'Administrativo':'green','Design':'coral','Marketing digital':'purple','Suporte técnico':'blue','Inovação':'yellow'};
const areaPaths = {
  'Administrativo':'M5 7h14v14H5z M9 7V4h6v3 M8 12h8 M8 16h5',
  'Design':'m5 18 2-6L17 2l5 5L12 17l-7 1z M7 12l5 5 M15 4l5 5 M4 22h16',
  'Marketing digital':'M4 10v7h4l9 4V6l-9 4H4z M8 17l2 5 M21 9v9',
  'Suporte técnico':'M3 4h18v13H3z M8 22h8 M12 17v5 M7 8l-2 3 2 2 M17 8l2 3-2 2',
  'Inovação':'M9 18h6 M9 21h6 M8 14a7 7 0 1 1 8 0l-1 3H9z',
};
function icon(category) { return `<svg viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${areaPaths[category] || areaPaths.Inovação}"/></svg>`; }

class ApiError extends Error { constructor(message, status, data) { super(message); this.status = status; this.data = data; } }
async function api(path, {method = 'GET', body} = {}) {
  let response;
  try { response = await fetch(path, {method, credentials:'same-origin', headers:body ? {'Content-Type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(12000)}); }
  catch { throw new Error('Não foi possível conectar. Confira sua conexão e tente novamente.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('O servidor enviou uma resposta inesperada. Tente novamente.'); }
  if (!response.ok) throw new ApiError(data.error || 'Não foi possível concluir. Tente novamente.', response.status, data);
  return data;
}

let topics = [], voter = null, selectedId = null, category = 'Todas', query = '', submitting = false;
let metricsTimer = null, refreshing = false, adminEpoch = 0, adminActive = false;
const isAdmin = location.pathname.replace(/\/$/, '') === '/metricas';
$(isAdmin ? '#metrics-link' : '#vote-link').setAttribute('aria-current','page');

function errorPage(error) {
  main.innerHTML = `<section class="page-error"><span class="eyebrow">OPA, ALGO NÃO CARREGOU</span><h1>Vamos tentar de novo?</h1><p>${escape(error.message)}</p><button class="button primary" id="retry">Tentar novamente <svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></button></section>`;
  $('#retry').addEventListener('click', init);
}

function hero() {
  return `<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><div class="eyebrow"><span class="status-dot"></span> VOTAÇÃO ABERTA <span class="eyebrow-divider">/</span> A SUA OPINIÃO CONTA</div><h1 id="hero-title">Sua próxima<br>descoberta começa<br>com <em>um voto.</em><span class="hero-star" aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span></h1><p>O que você quer aprender agora? Explore os temas,<br class="desktop-break"> encontre o que te move e ajude a escolher o próximo assunto.</p><a class="text-link" href="#topics-section">Encontre o seu tema <span aria-hidden="true">↓</span></a></div><div class="hero-art" aria-hidden="true"><div class="art-grid"></div><div class="art-top"><span>LABORATÓRIO DE<br>NOVAS POSSIBILIDADES</span><span>VOL. 01<br>2026</span></div><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-ticket"><span class="ticket-small">UMA ESCOLHA. MUITAS POSSIBILIDADES.</span><div>O FUTURO<br>TEM A<br><em>SUA VOZ.</em></div><span class="ticket-arrow"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span><span class="ticket-code">||||| || ||||| ||| || &nbsp; #SEUPRÓXIMOPASSO</span></div><div class="art-bottom"><span>ESCOLHA O QUE TE MOVE.</span><span>↓</span></div></div></section><div class="manifesto-strip"><span>${topics.length} TEMAS PARA EXPLORAR</span><span aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span><span>${new Set(topics.map(t=>t.category)).size} ÁREAS DO CONHECIMENTO</span><span aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span><span>01 VOTO. A SUA VOZ.</span><span aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span><span>INFINITAS POSSIBILIDADES</span></div>`;
}
function renderVoting() {
  main.innerHTML = `${hero()}<section class="topics-section" id="topics-section" aria-labelledby="topics-title"><div class="section-heading"><div><span class="eyebrow">01 / EXPLORE AS POSSIBILIDADES</span><h2 id="topics-title">Qual tema desperta <em>sua curiosidade?</em></h2></div><span class="section-side">ESCOLHA UM TEMA.<br>FAÇA PARTE DA DECISÃO.</span></div><div id="voter-status" aria-live="polite"></div><div class="explore-tools"><div class="search-window"><div class="search-titlebar"><span>EXPLORADOR DE IDEIAS</span><span aria-hidden="true">_ &nbsp; □ &nbsp; ×</span></div><label class="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><span class="sr-only">Buscar temas</span><input id="search" type="search" placeholder="Busque o que te interessa…" autocomplete="off"></label></div><div class="filters" role="group" aria-label="Filtrar por área">${['Todas',...new Set(topics.map(t=>t.category))].map(area=>`<button type="button" class="filter ${area==='Todas'?'active':''}" data-category="${escape(area)}" aria-pressed="${area==='Todas'}">${escape(area)}</button>`).join('')}</div></div><div class="results-heading"><span id="result-count" role="status"></span><button id="clear-filters" class="text-link" hidden>Limpar filtros ×</button></div><div id="topic-grid" class="topic-grid" role="group" aria-label="Tópicos disponíveis para votação"></div><div id="selection-bar" class="selection-bar"></div><p class="privacy-note">Um voto por matrícula de 5 dígitos. A matrícula não aparece nos resultados.</p></section>`;
  $('#search').value = query;
  $('#search').addEventListener('input', event => { query = event.target.value; renderCards(); });
  for (const button of document.querySelectorAll('.filter')) {
    button.classList.toggle('active',button.dataset.category===category);
    button.setAttribute('aria-pressed',String(button.dataset.category===category));
    button.addEventListener('click', () => { category=button.dataset.category; for (const item of document.querySelectorAll('.filter')) { item.classList.toggle('active',item===button); item.setAttribute('aria-pressed',String(item===button)); } renderCards(); });
  }
  $('#clear-filters').addEventListener('click', () => {query=''; category='Todas'; renderVoting(); $('#search').focus();});
  renderCards(); renderVoterStatus();
}
function renderCards() {
  const visible = filterTopics(topics,query,category);
  $('#result-count').textContent = `${String(visible.length).padStart(2,'0')} ${visible.length===1?'tema encontrado':'temas para descobrir'}`;
  $('#clear-filters').hidden = !query && category==='Todas';
  $('#topic-grid').innerHTML = visible.length ? visible.map(topic=>{
    const index = topics.findIndex(item=>item.id===topic.id)+1;
    const checked = voter.hasVoted ? voter.topicId===topic.id : selectedId===topic.id;
    return `<article class="topic-card ${areaStyles[topic.category] || 'green'} ${checked?'selected':''}"><label class="card-selection"><input type="radio" name="topic" value="${escape(topic.id)}" ${checked?'checked':''} ${voter.hasVoted?'disabled':''}><div class="card-meta"><span class="category-tag">${escape(topic.category)}</span><span class="topic-number">${String(index).padStart(2,'0')} /</span></div><div class="card-art">${icon(topic.category)}<span class="card-art-lines" aria-hidden="true"></span><span class="card-arrow" aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></div><h3>${escape(topic.title)}</h3><p>${escape(topic.description)}</p><div class="card-bottom"><span>${voter.topicId===topic.id?'Seu voto está aqui':checked?'Tema selecionado':'Quero explorar este tema'}</span><span class="radio-mark" aria-hidden="true">${checked?'✓':'+'}</span></div></label><details class="topic-details"><summary>O que vou aprender? <span aria-hidden="true">+</span></summary><ul>${topic.skills.map(skill=>`<li>${escape(skill)}</li>`).join('')}</ul></details></article>`;
  }).join('') : '<div class="empty-state"><span aria-hidden="true">⌕</span><h3>Nenhum tema por aqui.</h3><p>Tente outra palavra ou escolha uma área diferente.</p></div>';
  for (const input of document.querySelectorAll('input[name="topic"]')) input.addEventListener('change',()=>{selectedId=input.value; renderSelection(); for(const card of document.querySelectorAll('.topic-card')) {const selected=card.querySelector('input').checked; card.classList.toggle('selected',selected); card.querySelector('.card-bottom > span').textContent=selected?'Tema selecionado':'Quero explorar este tema'; card.querySelector('.radio-mark').textContent=selected?'✓':'+';}});
  renderSelection();
}
function renderSelection() {
  if (voter.hasVoted) { $('#selection-bar').hidden=true; return; }
  const topic = topics.find(topic=>topic.id===selectedId);
  $('#selection-bar').hidden=!topic;
  if (!topic) return;
  $('#selection-bar').innerHTML = `<div><span class="eyebrow">${topic?'SUA ESCOLHA':'PRONTO PARA DESCOBRIR?'}</span><strong>${topic?escape(topic.title):'Selecione o tema que mais combina com você.'}</strong></div><button id="open-confirm" class="button primary" ${topic?'':'disabled'}>Votar neste tema <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></button>`;
  $('#open-confirm').addEventListener('click',()=>{ if (!topic) return; $('#dialog-topic').textContent=topic.title; $('#dialog-error').textContent=''; $('#vote-dialog').showModal(); });
}
function renderVoterStatus() {
  if (!voter.hasVoted) return;
  const topic = topics.find(topic=>topic.id===voter.topicId);
  $('#voter-status').innerHTML = `<div class="success-banner" role="status"><span class="success-check" aria-hidden="true">✓</span><div><strong>Voto registrado. Sua voz faz a diferença!</strong><p>Você escolheu: ${escape(topic?.title || 'tema registrado')}. Obrigado por participar.</p></div><button class="button small secondary" id="new-student" type="button">Votar com outra matrícula</button></div>`;
  $('#new-student').addEventListener('click',()=>{voter={hasVoted:false,topicId:null}; selectedId=null; $('#vote-form').reset(); renderVoting(); $('#search').focus();});
}
$('#close-dialog').addEventListener('click',()=>!submitting && $('#vote-dialog').close());
$('#cancel-vote').addEventListener('click',()=>$('#vote-dialog').close());
$('#vote-dialog').addEventListener('cancel',event=>{if(submitting)event.preventDefault();});
$('#vote-dialog').addEventListener('close',()=>{ $('#vote-form').reset(); $('#matricula').setCustomValidity(''); $('#dialog-error').textContent=''; });
$('#matricula').addEventListener('input',event=>{event.target.value=event.target.value.trim(); event.target.setCustomValidity(''); $('#dialog-error').textContent='';});
$('#vote-form').addEventListener('submit', async event=>{
  event.preventDefault();
  if (submitting || !selectedId) return;
  const matricula = normalizeMatricula($('#matricula').value);
  if (!matricula) {$('#matricula').setCustomValidity('Informe uma matrícula com exatamente 5 dígitos.'); $('#matricula').reportValidity(); return;}
  submitting=true; $('#confirm-vote').disabled=true; $('#cancel-vote').disabled=true; $('#close-dialog').disabled=true;
  $('#confirm-vote').textContent='Registrando…'; $('#dialog-error').textContent='';
  try {
    const data = await api('/api/votes',{method:'POST',body:{topicId:selectedId,matricula}});
    voter={hasVoted:true,topicId:data.topicId};
    $('#vote-dialog').close(); renderVoting(); $('#voter-status').scrollIntoView({behavior:'smooth',block:'center'});
  } catch (error) {
    $('#dialog-error').textContent=error.message;
    if(error.status===400 || error.status===409) $('#matricula').focus();
  } finally {submitting=false; $('#confirm-vote').disabled=false; $('#cancel-vote').disabled=false; $('#close-dialog').disabled=false; $('#confirm-vote').innerHTML='Confirmar meu voto <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span>';}
});

function adminIntro() {return `<div class="admin-intro"><div><span class="eyebrow">PAINEL DE ACOMPANHAMENTO</span><h1>Da escolha<br>à <em>descoberta.</em></h1><p>Cada voto conta uma história. Acompanhe o que move a turma.</p></div><span class="admin-symbol" aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span></div>`;}
function renderLogin() {
  adminActive=false; adminEpoch++;
  clearInterval(metricsTimer);
  main.innerHTML = `<section class="admin-shell">${adminIntro()}<div class="login-layout"><div class="login-note"><span class="eyebrow">ACESSO RESTRITO</span><h2>Uma visão completa.<br>Para quem organiza.</h2><p>Confira os temas mais votados, entenda os interesses da turma e transforme as escolhas em próximos passos.</p><div class="login-note-bottom">RESULTADOS REAIS <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></div></div><form id="login-form" class="login-form"><div class="login-icon" aria-hidden="true">⌘</div><h2>Entrar nas métricas</h2><p>Use sua senha de administrador para continuar.</p><label for="password">Senha de administrador</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" placeholder="Digite sua senha"><p id="login-error" class="error-text" role="alert"></p><button id="login-submit" class="button primary" type="submit">Acessar painel <span aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></button><a class="text-link" href="/">← Voltar para a votação</a></form></div></section>`;
  $('#login-form').addEventListener('submit', async event=>{
    event.preventDefault(); const button=$('#login-submit'); button.disabled=true; $('#login-error').textContent='';
    try {await api('/api/admin/login',{method:'POST',body:{password:$('#password').value}}); $('#password').value=''; await loadDashboard();}
    catch(error) {if($('#login-error')) {$('#login-error').textContent=error.message; button.disabled=false;}}
  });
}
function renderDashboard(metrics) {
  const focusId = main.contains(document.activeElement) ? document.activeElement.id : null;
  const leader = leaderLabel(metrics);
  const topVotes = Math.max(1,...metrics.topics.map(topic=>topic.votes));
  const activeTopics = metrics.topics.filter(topic=>topic.votes>0).length;
  const dates = new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'short',timeZone:'America/Sao_Paulo'});
  main.innerHTML = `<section class="admin-shell">${adminIntro()}<div class="dashboard-toolbar"><div><span class="status-dot"></span><span id="updated-label" role="status">Atualizado às ${new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'America/Sao_Paulo'}).format(new Date(metrics.updatedAt))} · Brasília</span></div><div class="dashboard-actions"><button class="button small secondary" id="refresh">Atualizar ↻</button><a class="button small secondary" id="export-csv" href="/api/admin/export" download="votacao.csv">Exportar CSV ↓</a><button class="button small quiet" id="logout">Sair <svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></button></div></div><p id="metrics-error" class="error-text" role="alert"></p><div class="stat-grid"><article class="stat-card"><span class="eyebrow">PARTICIPAÇÃO TOTAL</span><strong id="total-votes">${metrics.totalVotes.toLocaleString('pt-BR')}</strong><span>votos registrados</span><span class="stat-decoration" aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></article><article class="stat-card leader-card"><span class="eyebrow">${metrics.leaders.length>1?'DISPUTA EQUILIBRADA':'NO TOPO DAS DESCOBERTAS'}</span><h2 id="leader-name">${escape(leader)}</h2><span>${metrics.totalVotes ? (metrics.leaders.length>1?'Os tópicos líderes têm o mesmo número de votos.':`${metrics.topics.find(t=>t.id===metrics.leaders[0])?.votes || 0} votos no tema mais escolhido`) : 'Os resultados aparecerão com a primeira participação.'}</span></article><article class="stat-card"><span class="eyebrow">INTERESSES EXPLORADOS</span><strong>${activeTopics}<small> / ${metrics.topics.length}</small></strong><span>temas receberam votos</span></article></div><div class="dashboard-grid"><section class="ranking-panel"><div class="panel-heading"><div><span class="eyebrow">01 / DO MAIS VOTADO AO PRÓXIMO</span><h2>Ranking de tópicos</h2></div><span class="panel-icon" aria-hidden="true"><svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg></span></div>${!metrics.totalVotes?'<p class="empty-note">Ainda não há votos. Compartilhe a página de votação para começar.</p>':''}<ol class="ranking-list">${metrics.topics.map((topic,index)=>`<li class="ranking-row ${areaStyles[topic.category]}"><span class="ranking-position">${String(index+1).padStart(2,'0')}</span><div class="ranking-info"><div class="ranking-title"><strong>${escape(topic.title)}</strong><span>${topic.votes} <span class="muted">${topic.votes===1?'voto':'votos'}</span></span></div><progress class="ranking-track" max="${topVotes}" value="${topic.votes}" aria-label="${escape(topic.title)}: ${topic.votes} votos"></progress><div class="ranking-caption"><span>${escape(topic.category)}</span><span>${percentageLabel(topic.percentage)}</span></div></div></li>`).join('')}</ol></section><aside class="dashboard-aside"><section class="area-panel"><span class="eyebrow">02 / OLHAR POR ÁREA</span><h2>O que conecta<br>a turma?</h2><div class="area-list">${metrics.categories.map(area=>`<div class="area-row ${areaStyles[area.name]}"><span class="area-dot"></span><div><strong>${escape(area.name)}</strong><span>${area.votes} votos</span></div><b>${percentageLabel(area.percentage)}</b></div>`).join('')}</div></section><section class="timeline-panel"><span class="eyebrow">03 / AO LONGO DO TEMPO</span><h2>O movimento<br>das escolhas.</h2>${metrics.timeline.length?`<ul class="timeline-list">${metrics.timeline.slice(-7).map(day=>`<li><time datetime="${escape(day.date)}">${dates.format(new Date(day.date+'T12:00:00Z'))}</time><progress class="timeline-bar" max="${Math.max(...metrics.timeline.map(item=>item.votes))}" value="${day.votes}" aria-label="${escape(day.date)}: ${day.votes} votos"></progress><strong>${day.votes}</strong></li>`).join('')}</ul><p class="muted">Últimos 7 dias com votos.</p>`:'<p class="muted">A história começa no primeiro voto.</p>'}</section><div class="insight-note"><span aria-hidden="true"><svg class="asterisk-icon" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M14 2v24M3.6 8l20.8 12M3.6 20 24.4 8"/></svg></span><p>Por trás de cada número,<br>uma nova possibilidade.</p></div></aside></div><p class="privacy-note">Atualização automática a cada 15 segundos. Percentuais calculados sobre o total de votos.</p></section>`;
  if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
  $('#refresh').addEventListener('click',async()=>{await refreshMetrics(); $('#refresh')?.focus();});
  $('#logout').addEventListener('click',async()=>{const button=$('#logout'); button.disabled=true; adminActive=false; adminEpoch++; clearInterval(metricsTimer); try {await api('/api/admin/logout',{method:'POST'}); renderLogin();}catch(error){adminActive=true; metricsTimer=setInterval(()=>{if(!document.hidden)refreshMetrics();},15000); $('#metrics-error').textContent=error.message;button.disabled=false;}});
}
async function refreshMetrics() {
  if(refreshing || !adminActive) return;
  const epoch = adminEpoch;
  refreshing=true; if($('#refresh')) $('#refresh').setAttribute('aria-busy','true');
  try {
    const metrics = await api('/api/admin/metrics');
    if (adminActive && epoch === adminEpoch) renderDashboard(metrics);
  } catch(error) {
    if (adminActive && epoch === adminEpoch) {
      if(error.status===401) renderLogin();
      else if($('#metrics-error')) $('#metrics-error').textContent=`${error.message} Os últimos resultados permanecem na tela.`;
    }
  } finally {refreshing=false;if($('#refresh')) $('#refresh').removeAttribute('aria-busy');}
}
async function loadDashboard() {
  const epoch = ++adminEpoch;
  const metrics = await api('/api/admin/metrics');
  if (epoch !== adminEpoch) return;
  adminActive=true; renderDashboard(metrics);
  clearInterval(metricsTimer); metricsTimer=setInterval(()=>{if(!document.hidden)refreshMetrics();},15000);
}
async function init() {
  main.innerHTML='<div class="initial-loading" role="status">Preparando suas próximas descobertas…</div>';
  try {
    if(isAdmin) {const session=await api('/api/admin/session'); if(session.authenticated)await loadDashboard();else renderLogin();}
    else {const [catalogue,status]=await Promise.all([api('/api/topics'),api('/api/voter')]);topics=catalogue.topics;voter=status;renderVoting();}
  } catch(error) {errorPage(error);}
}
init();
