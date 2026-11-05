# GitHub Pages + Supabase

O usuário aprovou hospedar as interfaces no GitHub Pages e usar Supabase para banco, login administrativo e atualização ao vivo. O fluxo continua: matrícula de cinco dígitos ASCII, um voto por matrícula, 15 temas, painel privado e CSV. O modo local Python/SQLite existente deve continuar funcionando.

## Fronteiras e configuração
- Fonte HTML/CSS/JS atual preservada. Links/assets relativos; painel na rota hash `#metricas`, que funciona em `/SISTEMA-DE-VOTA-O/` sem rewrites de servidor. Rota local antiga `/metricas` permanece aceita.
- `public/config.js` exporta `config={provider:'local',supabaseUrl:'',supabasePublishableKey:''}`. Build Pages sobrescreve somente cópia em dist/ com provider supabase e valores públicos de SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY (ou fallback SUPABASE_ANON_KEY). Nunca usar service_role, sb_secret ou senha de administrador no build/cliente. Build rejeita esses tipos de chave, ausência de configuração e URL inválida, sem imprimir valores.
- SDK oficial @supabase/supabase-js instalado por npm com lockfile e empacotado localmente por esbuild (sem CDN/runtime remoto de scripts). App importa o adapter cloud dinamicamente só quando provider=supabase. Build preserva restante de public/ e fornece .nojekyll. Python precisa permitir config.js e adapter JS, mas não servir node_modules.
- npm scripts: build → scripts/build-pages.mjs; test → testes Node com --test-isolation=none; dependências runtime @supabase/supabase-js, dev esbuild. dist/ ignorado. Workflow Pages em main usa Node22, npm ci, npm test/build, configure-pages/upload-pages-artifact/deploy-pages e variáveis públicas do repositório. Ativação do Pages/configuração depende do acesso disponível, sem fabricar URL pronta.

## Contrato Supabase SQL
`supabase/schema.sql` transacional/idempotente. pgcrypto em schema extensions. Catálogo público `public.voting_topics` com 15 cursos/ordem; `public.voting_totals(topic_id text PRIMARY KEY,votes bigint,updated_at timestamptz)` com zero inicial, RLS SELECT apenas administrador e incluído na publication supabase_realtime (se existe). Sem writes diretos anon/authenticated.
Dados privados em schema `voting_private` sem grants anon/authenticated: configuração com chave HMAC aleatória persistente, votos com matrícula somente HMAC SHA256 UNIQUE, administradores com user_id UUID referenciando auth.users. Nenhum nome/matrícula original em tabelas, retorno ou logs.
Funções públicas SECURITY DEFINER com search_path vazio, grants mínimos e validação explícita:
- `get_voting_topics()` → JSON `{topics:[{id,title,category,description,skills}]}`; anon/authenticated.
- `cast_vote(p_topic_id text,p_matricula jsonb)` → JSON `{topicId}`; anon/authenticated. p_matricula deve ser JSON string de exatamente 5 dígitos após trim externo; preservar zeros. Insere voto e incrementa totals na mesma transação. Duplicado lança P0001 com mensagem VOTE_ALREADY_RECORDED (não revela tópico anterior); formato inválido 22023/INVALID_MATRICULA; tema inválido 22023/INVALID_TOPIC. Realtime vê apenas totais após commit. Sem recibo/consulta pública por matrícula.
- `is_voting_admin()` → boolean somente UID atual autorizado na tabela privada; anon/authenticated (anon false).
- `get_voting_metrics()` → JSON no contrato local `{totalVotes,topics:[...topic,votes,percentage],categories:[{name,votes,percentage}],timeline:[{date,votes}],leaders:[id],updatedAt}`. Validar admin; erro42501 caso contrário. Dia America/Sao_Paulo, zero sem líderes, empate preservado. Só authenticated pode executar.
Registrar admin é ação explícita do dono do projeto via SQL seguro que resolve um usuário de auth.users pelo email; não permitir autocadastro de permissões pelo cliente. Instruções: criar usuário em Authentication/Users e autorizar UUID; desativar signup público se não necessário. Nenhum código admin/credencial no browser.

## Adapter cloud
`public/supabase-backend.mjs`: exporta `createSupabaseBackend(config, options={})`; options.client e options.storage opcionais para testar contratos com SDK real/injeção controlada. Retorno `{request(path,{method,body}={}),subscribeMetrics(onChange,onStatus),exportCsv(),mode:'supabase'}`. Import SDK official createClient; cliente normal com sessão Auth padrão. Se storage não fornecido usar sessionStorage só para recibo `{topicId}` em chave com escopo por projeto; nunca matrícula.
request traduz os endpoints existentes:
GET /api/topics → get_voting_topics; GET /api/voter → recibo da aba; POST /api/votes {topicId,matricula} → cast_vote; GET /api/admin/session → Auth getSession + is_voting_admin; POST /api/admin/login {email,password} → signInWithPassword e is_voting_admin (não admin: signOut + erro403); logout → signOut; GET /api/admin/metrics → get_voting_metrics. Erros têm Error.message em português, .status 400/401/403/409/503; não retornar tópico em409 nem alterar recibo.
subscribeMetrics cria channel postgres_changes event* schema public table voting_totals, somente após autenticação; callbacks onChange a cada evento e na primeira SUBSCRIBED para fechar janela de concorrência, onStatus connected/reconnecting. Retorna função unsubscribe/cleanup, idempotente, que remove channel; não vazar eventos após remoção.
exportCsv busca métricas autorizadas e retorna string UTF8 com BOM, mesma ordem/colunas de CSV local, escape correto. Nunca matrícula/email/tokens.

## Interface cloud
- Form de login inclui email somente em modo Supabase; local continua senha apenas.
- API atual passa pelo adapter em modo cloud; no local mantém fetch atual.
- App abre assinatura após login/sessão verificada; evento dispara fetch das métricas com guard adminEpoch. Revalidação15s e botão Atualizar mantidos. Fechar assinatura antes de logout e em mudança de rota; eventos tardios não reabrem painel. Preservar foco e resultados em falha de rede; mostrar status de conexão honesto.
- CSV cloud gera download Blob do adapter; local mantém endpoint de download.
- Matrícula é autodeclarada, sem cadastro oficial de alunos. Não confundir unicidade com identidade verificada.

## Verificação e limites
Testes SQL reais em PostgreSQL com schema auth mínimo simulando papéis anon/authenticated e JWT UID, inclusive RLS, grants, erros, concorrência, HMAC/chave, credenciais, métricas e rerun sem perder votos. Não são validação de um projeto Supabase remoto nem do serviço Realtime hospedado.
Testes adapter pelo boundary SDK/HTTP, testes build em pasta temporária com config pública de exemplo e rejeição de segredos, browser Pages em subdiretório com hash/links/assets, login/voto/duplicado/atualização ao vivo por fixture local e regressão Python existente. Não fingir que fixture valida cloud real.
O usuário forneceu Project URL e chave publishable pública, configurados em pages.public.json e lidos pelo workflow com --config. Não há credencial administrativa/Management API ou acesso à configuração Pages. A política de rede bloqueou o domínio remoto e api.github.com; SQL remoto/Pages ainda exigem confirmação ou ação do usuário. Código e configuração revisável devem ficar completos antes de pedir essa ação final. Não publicar versão do ambiente Codex.
