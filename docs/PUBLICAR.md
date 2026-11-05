# Colocar a votação no ar

O site está preparado para **GitHub Pages + Supabase**. O arquivo `pages.public.json` já contém o endereço e a chave pública fornecidos pelo dono do projeto. A chave publishable é própria para uso no navegador; a segurança dos resultados depende das regras do banco e do login administrativo. Não coloque service_role, sb_secret ou senha nesse arquivo.

## 1. Preparar o banco Supabase

Abra o projeto `gqemwlmusvnueosgjzki` no painel do Supabase.

1. Entre em **SQL Editor → New query**.
2. Cole todo o conteúdo de [`supabase/schema.sql`](../supabase/schema.sql) e clique **Run**.
3. O resultado deve ser sucesso. Isso cria os 15 temas, as regras de voto único e a assinatura Realtime dos totais. Não cria votos de demonstração.

O script pode ser executado novamente: preserva os votos, administradores e a chave que identifica as matrículas. Não apague nem troque essa chave.

Também existe a migração inicial `supabase/migrations/20261105000000_voting.sql`, com o mesmo instalador, para a integração GitHub/CLI do Supabase. Conectar o repositório não comprova que a migração foi aplicada ao banco de produção: confirme o sucesso no painel ou execute `schema.sql` no SQL Editor. Não execute reset de banco. Alterações futuras devem usar novas migrações, mantendo os votos existentes.

## 2. Criar seu acesso administrativo

1. Em **Authentication → Users → Add user**, crie seu usuário com **seu e-mail e uma senha forte**. Confirme o e-mail conforme as opções do painel. Não envie a senha pelo chat nem a coloque no GitHub.
2. Abra [`supabase/admin.example.sql`](../supabase/admin.example.sql).
3. Troque somente `admin@example.invalid` pelo e-mail que você acabou de cadastrar.
4. Execute esse script no **SQL Editor**. Ele concede acesso ao usuário existente, sem publicar a senha.
5. Se não for usar outros cadastros, desative o cadastro público em **Authentication → Sign In / Providers**.

Uma conta do Supabase Auth sem essa autorização não vê o painel nem os totais. Os alunos não precisam de conta ou e-mail: informam apenas a matrícula de cinco dígitos.

## 3. Ativar GitHub Pages

No repositório `IanAkiles/SISTEMA-DE-VOTA-O`:

1. Vá em **Settings → Pages → Build and deployment**.
2. Em **Source**, selecione **GitHub Actions**.
3. Abra **Actions → GitHub Pages → Run workflow** e execute na branch `main`, caso a execução após o push ainda não tenha concluído.
4. Aguarde o trabalho `deploy` ficar verde e use o endereço mostrado pelo GitHub. O caminho padrão esperado é `https://ianakiles.github.io/SISTEMA-DE-VOTA-O/`.

Após o deploy confirmado:

- **Alunos:** endereço principal do site.
- **Seu painel:** o mesmo endereço seguido de `#metricas`.

Exemplo de painel: `https://ianakiles.github.io/SISTEMA-DE-VOTA-O/#metricas`.

Não é necessário criar variáveis do repositório para o projeto atual: o workflow lê `pages.public.json`. Opcionalmente, `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` em **Settings → Secrets and variables → Actions → Variables** substituem os valores públicos do arquivo. O build recusa chaves secretas/privilegiadas.

## Conferir antes de compartilhar

1. Abra a página pública em uma aba e o painel com seu login em outra.
2. Faça uma participação com uma matrícula autorizada para a sua votação. Isso é um voto real e ficará no banco.
3. Confirme que total e ranking mudam sem clicar em Atualizar.
4. Tentar a mesma matrícula em outro navegador deve ser recusado, sem mostrar a escolha anterior.

No desenvolvimento os testes usam dados temporários. A implantação de produção não recebe votos de teste automaticamente. A matrícula é autodeclarada: o sistema impede repetir o mesmo número, mas não consulta um cadastro oficial da escola.

## Se aparecer erro

- **Página 404:** confira Source GitHub Actions e o resultado de `deploy` no GitHub.
- **Catálogo não carrega / função não encontrada:** execute `schema.sql` no projeto correto e confira o Project URL em `pages.public.json`.
- **Sem permissão no painel:** crie o usuário em Authentication e aplique `admin.example.sql` com o e-mail correto.
- **Painel mostra Reconectando:** confira Realtime, a publicação `supabase_realtime` e a conexão. O sistema mantém uma verificação a cada 15 segundos como recuperação; não desative as políticas RLS para contornar falhas.
- **Serviço pausado:** reative o projeto no painel Supabase conforme as condições do plano escolhido.

## Verificação técnica

```bash
npm ci
npm test
npm run build -- --config pages.public.json
python3 -m unittest discover -s tests -v
node tests/browser-smoke.cjs
node tests/browser-pages.cjs
```

`dist/` deve ser nova ou vazia. Para repetir um build sem apagar saídas anteriores, use `--out-dir /tmp/vota-pages-nova-pasta`.

O teste SQL usa PostgreSQL 16 temporário em Docker; se Docker estiver indisponível, é marcado como skipped. O teste Pages usa o SDK oficial com fixtures locais de Auth/RPC/Realtime e subdiretório equivalente ao GitHub Pages. Esses testes não provam que o seu projeto Supabase remoto já recebeu o SQL nem que o deploy no GitHub terminou. A validação real depende dos passos acima e do acesso aos serviços.
