# Matrícula — Implementation Plan

**Goal:** garantir um voto por matrícula, inclusive entre dispositivos, com uso compartilhado do computador.
**Architecture:** ampliar identidade do voto em SQLite com HMAC canônico e UNIQUE; formulário exige matrícula; preservar cookies apenas como recibo/anti-forgery.
**Tech Stack:** Python 3.12+, SQLite, JavaScript nativo.
**Spec:** docs/superpowers/specs/2026-11-05-matricula-design.md

## Global Constraints
Preservar votos/credenciais e checkout existente; sem novo worktree; não expor matrícula; sem dependências externas; não validar vínculo escolar inexistente.

## Review Focus
- Validação exige cinco algarismos ASCII, mantém zeros à esquerda e aceita somente espaços nas extremidades.
- Duas matrículas no mesmo computador funcionam; uma matrícula em computadores distintos é recusada atomicamente.
- Respostas 409 não revelam escolha de outra pessoa e não exibem confirmação falsa.
- Migração mantém votos antigos e a chave HMAC; trocar senha não permite votar novamente.
- Campo obrigatório e erros acessíveis; matrícula limpa no sucesso/novo aluno e não persiste no browser.

## Task 1 — Backend e migração (agente)
Files: voting/store.py, server.py, tests/test_server.py.
Interface: POST /api/votes recebe topicId + matricula, sucesso 201 topicId, duplicado 409 error sem topicId. GET /api/voter lembra último voto do cookie. Schemas anteriores preservados com migração.
- [x] Escrever testes HTTP/SQLite novos e adaptar fixtures para matrícula; observar falhas antes implementar.
- [x] Implementar canonicalização/HMAC, UNIQUE e migração idempotente sem perda.
- [x] Executar toda suíte unittest e conferir privacidade/concorrência/persistência.

## Task 2 — Interface e regressão (principal)
Files: public/model.mjs, tests/model.test.mjs, public/index.html, public/app.js, public/styles.css, tests/browser-smoke.cjs.
- [x] Testar canonicalização válida/inválida e preservar zeros antes implementar helper.
- [x] Campo matrícula obrigatório no diálogo; limpar no sucesso, cancelamento e novo participante.
- [x] Atualizar cópia e erro 409, botão de outro aluno; testes navegador entre dispositivos e mesmo computador.
- [x] Executar testes Node e Chromium com base temporária.

## Task 3 — Revisão, documentação, runtime
Files: README.md, docs e draft start_skill do ambiente.
- [x] Revisão independente do resultado, corrigir bugs relevantes com regressão.
- [x] Atualizar regra, limitações, migração, backups e instruções salvas sem perder requisitos existentes.
- [x] Reiniciar somente servidor iniciado por esta sessão; validar instância e estado Git sem credenciais/votos de teste.

## Evidências
- TDD: backend registrou 10 falhas antes da mudança, depois 25/25 testes aprovados; helper de matrícula falhou antes da implementação e passou com os 4 testes Node.
- Chromium: teste inicialmente falhou por campo de matrícula ausente; depois aprovou matrícula obrigatória de cinco dígitos, 00123, bloqueio entre dispositivos, 409 privado sem confirmação falsa, campo limpo e alunos distintos no mesmo navegador. Fluxos administrativos anteriores também aprovados.
- Revisão independente sem bloqueadores; confirmou preservação de credenciais/sessões em migração legada completa.
- Backup consistente da instância feito antes da migração; inicialização repetida, serviço anterior encerrado e nova versão iniciada na porta 8000. Requisições reais recusaram matrículas inválidas, métricas continuaram privadas e banco permaneceu sem votos de teste.
- start_skill atualizado no draft preservando demais configurações; install_script anterior continua válido e foi executado. Publicação do ambiente continua separada.
