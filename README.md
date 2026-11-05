# VOTA — Sistema de votação

Painel público para escolher um dos **15 tópicos de cursos** da imagem de referência e painel administrativo com métricas reais. Interface em português, responsiva, com busca sem acentos, filtros por área, detalhes, confirmação e recibo do voto.

## Site no GitHub Pages e painel ao vivo

A versão pública usa GitHub Pages para as telas e Supabase para os votos, login por e-mail/senha e atualização por Realtime. O projeto Supabase já está configurado com os dados **públicos** em `pages.public.json`; nenhuma senha ou chave privilegiada pertence ao site.

**Siga [Colocar a votação no ar](docs/PUBLICAR.md)** para aplicar o SQL, autorizar seu usuário e ativar GitHub Pages. A rota do painel publicado é `#metricas`. O site só estará disponível após o workflow terminar e o banco ser preparado.

No modo Supabase, a senha é a do usuário autorizado em Authentication; `data/admin-password` vale somente para a execução local Python abaixo. Os bancos SQLite local e Supabase são independentes: votos anteriores do ambiente local não são enviados automaticamente para a nuvem.

## Executar localmente

Requisito da aplicação: **Python 3.12 ou superior**, com SQLite (biblioteca padrão). Não há pacotes Python/npm para instalar nem etapa de build.

```bash
cd /workspace/SISTEMA-DE-VOTA-O
python3 server.py --init
python3 server.py --host 0.0.0.0 --port 8000
```

A página de votação fica em `/`; o painel de métricas fica em `/metricas`, no mesmo servidor. A primeira execução cria a pasta local `data/`. A inicialização é idempotente: não apaga votos nem troca a senha existente. Use Ctrl+C para parar o processo executado no terminal.

### Senha administrativa

No site publicado, use o e-mail/senha do usuário autorizado no Supabase. Se o e-mail de recuperação abrir localhost, configure **Authentication → URL Configuration** com o endereço público do site e solicite um novo link pelo botão **Esqueci minha senha**. O [guia de publicação](docs/PUBLICAR.md#recuperação-de-senha-e-links-que-abrem-localhost) informa os endereços e o procedimento completo.

As instruções abaixo sobre arquivo de senha se aplicam ao modo Python local.

Uma senha aleatória é criada em **`data/admin-password`**, com permissão de leitura apenas para o proprietário. Consulte esse arquivo localmente para entrar no painel. O arquivo, o banco e os cookies nunca são enviados ao Git. Não compartilhe a senha com os participantes.

Também é possível fornecer `ADMIN_PASSWORD` pelo gerenciador seguro de variáveis da hospedagem. Quando presente, ela substitui a senha do arquivo. Para trocar a senha local, pare o servidor, edite `data/admin-password` sem espaços nas extremidades e reinicie; as sessões existentes são invalidadas. Se estiver usando `ADMIN_PASSWORD`, altere essa variável. Sessões administrativas duram até 8 horas, têm cookies HttpOnly/SameSite e são revogadas ao sair. Tentativas incorretas de login são limitadas.

## O que é contabilizado

- **Um voto por matrícula do aluno.** São obrigatórios exatamente cinco algarismos de 0 a 9, como `27250` ou `00123`. Letras, separadores e outros comprimentos são recusados. Zeros iniciais são preservados e espaços nas extremidades são ignorados pelo servidor.
- A matrícula é solicitada na confirmação. O banco garante unicidade de forma transacional, inclusive em celulares diferentes, janelas privadas e envios simultâneos. Limpar cookies não permite repetir a mesma matrícula.
- Para outro aluno votar no mesmo computador, use **Votar com outra matrícula** no recibo. O cookie lembra apenas o último voto daquele navegador; ele não é mais a regra que limita os votos.
- A matrícula não é armazenada em texto nem enviada em métricas/CSV. A base guarda um HMAC SHA-256, calculado com uma chave aleatória privada persistida na própria base. O campo é limpo após sucesso, cancelamento e troca de participante; não é guardado no localStorage.
- Uma tentativa repetida informa que a matrícula já participou, sem revelar o tema escolhido por ela. Não há função de apagar/reiniciar a votação nesta versão.
- **Não há lista oficial de alunos ou autenticação escolar integrada.** A matrícula é informada pelo participante: a regra impede repetição do mesmo número, mas não comprova que ele existe na escola ou que pertence à pessoa.
- Não há votos de exemplo no banco da aplicação.

### Atualização da versão por navegador

A primeira inicialização com esta versão migra o banco automaticamente, em transação, sem apagar votos, timestamps ou credenciais. Votos anteriores à regra por matrícula continuam nas métricas e ficam sem matrícula associada, pois essa informação não foi coletada antes. Esses votos não podem ser associados retroativamente a alunos nem bloquear uma matrícula correspondente. A migração pode ser repetida com segurança.

O painel mostra total, líder (ou empate), temas com votos, ranking completo, percentual do total, distribuição por área e últimos 7 dias que tiveram votos. Os dias e horários seguem Brasília (America/Sao_Paulo); timestamps são armazenados em UTC. No modo local, atualização automática a cada 15 segundos enquanto a aba está visível. No GitHub Pages/Supabase, o painel recebe eventos Realtime e mantém a consulta periódica como recuperação. O CSV protegido exporta os 15 temas, área, total e percentual.

## Persistência e hospedagem

`data/voting.sqlite3` guarda os votos, identificadores opacos, a chave HMAC privada e sessões. Preserve essa chave junto com a base: recriar/trocar apenas a chave quebra a identificação das matrículas já usadas. Mantenha essa pasta em um **volume persistente**, numa única instância do servidor; múltiplas réplicas com bancos independentes não compartilham os votos. A variável opcional `VOTING_DATA_DIR` altera a pasta dos dados.

Para disponibilizar na internet, use um proxy reverso com **HTTPS** e inicie com `--secure-cookies`. Preserve o cabeçalho Host público e encaminhe as requisições na mesma origem; POST de origens diferentes são recusados. O servidor Python é adequado ao desenvolvimento e a uma votação pequena controlada; operação pública exige supervisão do processo e limites de tráfego na hospedagem. Publicar o código no GitHub não inicia o servidor web na internet; a aplicação deve ser executada ou hospedada conforme estas instruções.

Faça backup consistente usando a API de backup do SQLite (não copie apenas o arquivo principal durante gravações WAL):

```bash
python3 - <<'PY'
import os
import sqlite3
from pathlib import Path
source = Path(os.environ.get('VOTING_DATA_DIR', 'data')) / 'voting.sqlite3'
# Crie o backup fora da pasta pública e proteja-o como os dados originais.
destination = Path('/tmp/votacao-backup.sqlite3')
if destination.exists():
    raise SystemExit('Destino já existe; escolha outro para preservar o backup anterior.')
with sqlite3.connect(source) as db, sqlite3.connect(destination) as backup:
    db.backup(backup)
destination.chmod(0o600)
PY
```

## Testes

Testes automatizados usam bancos e credenciais temporários, separados de `data/`.

```bash
python3 -m unittest discover -s tests -v
node --test --test-isolation=none tests/model.test.mjs
```

Use Node.js 24+ para os testes JavaScript e o build do GitHub Pages; a versão está indicada em `.nvmrc` e é lida pelo workflow. O modo Python local não precisa de Node para executar a aplicação. `--test-isolation=none` exige a versão atual do runtime.

Teste completo de navegador (opcional; Playwright e Chromium já disponíveis neste ambiente):

```bash
node tests/browser-smoke.cjs
```

Fora deste ambiente, instale Playwright/Chromium nas ferramentas de teste. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` seleciona um Chromium existente. O teste inicia servidor e banco descartáveis, verifica matrícula de cinco dígitos, duplicidade entre dispositivos, alunos distintos no mesmo navegador, falha de rede, recarga, login, ranking, empate, exportação, logout, CSP e viewport de celular. Capturas ficam em `test-results/`, ignorado pelo Git. O sandbox pode exigir execução com permissão de abrir sockets locais.

## Organização

- `server.py`: servidor, validação de requisições, cookies, autenticação e arquivos públicos permitidos.
- `voting/catalog.py`: catálogo dos 15 cursos em cinco áreas; edite em uma tarefa de conteúdo para alterar os temas.
- `voting/store.py`: persistência SQLite, credenciais, sessões e agregação.
- `public/`: interface e apresentação de resultados; nenhum segredo deve ser colocado aqui.
- `tests/`: integração HTTP/SQLite, helpers da interface e fluxo do navegador.
- `docs/`: decisões, plano e referências.

O arquivo vazio `PAINEL VOTAÇÃO`, já existente no repositório, foi preservado. Os dados, credenciais e capturas são locais e ignorados.
