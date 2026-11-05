# Um voto por matrícula

O usuário respondeu à preferência pendente: **um voto por matrícula do aluno**. Este documento substitui o padrão por navegador do design original.

- O usuário especificou formato exato: **5 dígitos**, exemplo `27250`. Campo obrigatório Matrícula do aluno no diálogo de confirmação, inputmode numeric. Backend e frontend aceitam somente string com cinco algarismos ASCII 0–9 após remover espaços apenas das extremidades; sem letras nem separadores internos. Zeros à esquerda preservados: `00123` é matrícula válida; o número JSON 123 é inválido. O servidor não trunca nem completa entradas.
- Backend exige `{topicId,matricula}` no POST /api/votes. Cookie emitido continua necessário, mas não define mais unicidade. Matrícula ausente/inválida: 400; repetida: 409 com apenas `{error}`, sem revelar tópico anterior. Banco garante matrícula única inclusive concorrência entre cookies/dispositivos. Matrículas distintas podem votar no mesmo cookie.
- Não guardar matrícula original em texto, cookies, métricas ou CSV. Usar HMAC SHA-256 da forma canônica com chave aleatória persistente e privada no SQLite (tabela de configuração local). Banco mantém permissões privadas. A chave sobrevive a reinícios e não depende de senha administrativa.
- Migração transacional/idempotente mantém todos os votos anteriores e seus timestamps; unicidade por cookie é removida. Votos antigos ficam sem matrícula (NULL) e continuam nas métricas. Não é possível associá-los retroativamente; comunicar esse limite. Não zerar base.
- GET /api/voter continua lembrando o último voto do navegador (não identifica aluno). Após recibo há botão Votar com outra matrícula que limpa a escolha e dados da matrícula para uso compartilhado. O input nunca é persistido em armazenamento do navegador. Repetição em outro dispositivo é recusada sem exibir a escolha original; no diálogo erro é claro e permite corrigir matrícula.
- Mantêm-se painel privado, métricas, testes de foco/logout, classes de layout e os 15 cursos.
- Sem lista de matrículas válidas nem integração escolar, a matrícula é autodeclarada. A unicidade não autentica a identidade ou vínculo do aluno. Não inventar cadastro/SSO nem bloquear entrega por essa ausência.

## Verificação
Testes reais: repetição em cookies diferentes e após reinício, cinco dígitos exatos, espaços externos, zeros à esquerda, entradas inválidas, concorrência com cookies distintos, duas matrículas mesmo cookie, migração legada com votos, privacidade de respostas/banco/CSV e compatibilidade de métricas. Navegador: campo obrigatório, confirmação, duplicate sem sucesso falso, novo aluno no mesmo computador, reload e preservação do painel. Toda validação com dados temporários.
