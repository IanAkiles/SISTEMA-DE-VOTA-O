# Corrigir recuperação de acesso

Causa confirmada pelo usuário: e-mail do Supabase redireciona para localhost, endereço padrão do projeto. O site publicado também não possui interface para receber recuperação e definir nova senha. Corrigir ambos, sem ver/salvar senha em chat ou repositório e sem usar chave privilegiada.

- [x] Adapter: resetPasswordForEmail com redirect para a mesma raiz pública e `?recovery=1`; estado de sessão para recuperação; updateUser password min8/max1024 e logout local. Mensagem de envio neutra, erros de limite/expiração claros, sem acesso administrativo concedido pela recuperação.
- [x] Helpers de URL preservam subdiretório Pages e reconhecem retorno recovery/erro sem exibir tokens.
- [x] Login cloud recebe Esqueci minha senha; formulário de envio e formulário de nova senha/confirmar; dados limpos após salvar; link expirado permite novo envio; rotas protegidas contra resposta velha.
- [x] Testes SDK reais/fixtures e browser: envio, redirect correto, sessão recebida por link, troca, confirmação, erros e login após troca; regressão local mantida.
- [x] Docs: Site URL raiz Pages, Redirect URL raiz `?recovery=1`, solicitar e-mail novo após alteração; callback deve vir do Supabase. Não pedir links completos, tokens, senhas ou service_role.
- [ ] Revisão, suíte Node/build/browser, push e acompanhamento Actions. Configuração do projeto Supabase depende do painel do usuário; chave pública não autoriza mudar Site URL.

## Evidência

- Testes de regressão reproduziram a resposta de login atrasada sobrescrevendo a tela e o SDK mantendo uma sessão anterior após callback inválido; ambos passaram após as correções.
- Revisão independente concluída sem bloqueadores.
- `npm test`: 56 testes aprovados, incluindo SDK Auth real com respostas controladas e callbacks inválidos, expirados e falha de transporte.
- `python3 -m unittest discover -s tests -v`: 38 testes aprovados, incluindo PostgreSQL isolado; smoke do navegador no modo Python aprovado.
- Build estático com a configuração pública do projeto aprovado. Teste de navegador Pages usa SDK real e serviços controlados; não confirma envio de e-mail nem configuração do Supabase remoto.
- Alterar Site URL e Redirect URLs no Supabase continua dependendo do painel do usuário; não foi executado com a chave pública.
