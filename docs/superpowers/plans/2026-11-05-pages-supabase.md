# GitHub Pages + Supabase — Implementation Plan

**Goal:** votação por link estático, armazenamento compartilhado e painel administrativo ao vivo.
**Architecture:** manter app existente com adapter opcional Supabase; schema privado/RLS/RPC; build estático GitHub Actions.
**Tech Stack:** Python/SQLite local; JavaScript, Supabase JS, PostgreSQL, esbuild, GitHub Pages.
**Spec:** docs/superpowers/specs/2026-11-05-pages-supabase-design.md

## Global Constraints
Preservar banco/credenciais/repositório e modo local. Matrícula string com cinco ASCII dígitos. Nunca expor service_role/sb_secret/senha; só URL e chave pública na build. Não criar worktree nem publicar ambiente.

## Review Focus
- Anônimo não lê votos/HMAC/métricas nem se torna admin.
- Unicidade e incremento atômicos entre dispositivos/concorrência; setup repetível.
- Pages funciona em subdiretório e rota hash sem backend Python.
- Sessão/assinatura/fetch antigos não restauram painel após logout.
- Build falha antes de publicar se config ausente/insegura; não promete cloud validada sem acesso.

## Task 1 — Banco (agente)
Files supabase/schema.sql, supabase/admin.example.sql, tests/test_supabase_sql.py.
- [x] Testes SQL reais antes implementação; observar falhas e depois aprovação.
- [x] Esquema, catálogo, HMAC, roles/RLS/grants/RPCs, publication e admin conforme spec.
- [x] Testar concorrência/idempotência/permissões/metrics em Postgres temporário.

## Task 2 — Adapter (agente)
Files public/supabase-backend.mjs, tests/supabase-backend.test.mjs.
- [x] Testar contratos SQL/Auth/erros/recibo e assinatura antes implementar.
- [x] Implementar request, subscribeMetrics e exportCsv conforme spec.
- [x] Rodar testes Node e revisar logs/armazenamento sem matrícula.

## Task 3 — Build e publicação (agente)
Files package.json/lock, scripts/build-pages.mjs, public/config.js, .github/workflows/pages.yml, tests/build-pages.test.mjs.
- [x] Testar build, subdiretório/config/segredos sem tocar src nem credenciais.
- [x] Instalar SDK/esbuild com lock e build offline de assets.
- [x] Workflow Pages com variáveis públicas, sem deploy efetivo antes de configuração real.

## Task 4 — Integração visual e entrega (principal)
Files public/app.js/index.html/styles.css, server.py allowlist, tests/browser-smoke.cjs + novo browser-pages, README/docsDEPLOY.
- [x] Adaptar navegação hash/relativa, email cloud e adapter mantendo local.
- [x] Adicionar realtime lifecycle, CSV cloud, guardas sessão e regressão browser.
- [x] Testar suítes completas/build/Postgres/browser e revisão independente.
- [x] Commit/push autorizado para o mesmo GitHub; configurar Pages/SQL só se credenciais necessárias disponíveis. Se bloqueado, entregar passos mínimos e pendências exatas.

## Resultado verificado
- PostgreSQL16 real em Docker: 13 testes de catálogo, RLS, grants, HMAC, tipos, concorrência, atomicidade, idempotência, admin e métricas aprovados.
- SQLite/HTTP existente: 25 testes aprovados (38 no total Python).
- Node: 35 testes de model/build/adapter aprovados; SDK real em boundary HTTP e lifecycle Realtime com fixture.
- Build com pages.public.json gerado em pasta temporária e não incluiu segredos administrativos.
- Chromium local e Pages em subdiretório: voto, duplicate entre dispositivos, login, CSV, foco, logout e atualização ao vivo por SDK/fixture aprovados; resposta atrasada de catálogo não altera rota escolhida.
- Correções RED/GREEN concluídas para corridas de login/logout e navegação hash.
- Atualização do draft de ambiente salvou npmci/instruções e domínios de rede, sem publicar ambiente.
- Link público e schema remoto não são considerados validados: chamadas ao domínio Supabase e à API GitHub foram bloqueadas pela política atual. Última etapa externa em docs/PUBLICAR.md.
