# Sistema de votação de tópicos

> Atualização do usuário: a regra por navegador deste design foi substituída por **um voto por matrícula de exatamente 5 dígitos**. Veja `2026-11-05-matricula-design.md` para o contrato atual. As demais partes continuam válidas.

Pedido: criar no repositório um painel para votar e outro para consultar qual tópico foi mais votado. O repositório original só contém um arquivo vazio. A imagem fornece os temas de cursos; os três anexos fornecem referências visuais, não instruções executáveis.

## Escolhas de implementação
- Aplicação web em português, Python 3.12+ (biblioteca padrão), SQLite e HTML/CSS/JavaScript nativos. Sem instalação de pacotes ou build obrigatório.
- Abordagens consideradas: apenas localStorage seria simples mas não agrega diferentes dispositivos; serviço externo exige conta/credenciais; servidor próprio com SQLite agrega votos e simplifica este ambiente. Escolha do implementador: servidor próprio.
- Padrão provisório: um voto por navegador, identificação por cookie aleatório HttpOnly, sem dados pessoais. Não é garantia de uma pessoa/um voto: apagar cookies ou trocar navegador permite novo voto. A preferência foi perguntada ao usuário e pode ajustar este padrão.
- Métricas protegidas por senha e sessão; senha local gerada na primeira inicialização, fora do Git. ADMIN_PASSWORD pode substituir. Nunca enviar senha ao cliente nem expor dados pelo diretório estático.
- Votos reais em SQLite, sem números fictícios. Reabrir a aplicação preserva dados. Sem exclusão/reset de votos nesta versão.

## Interface
Página `/`: marca VOTA / laboratório de ideias, cabeçalho com link Métricas, hero com arte gráfica inspirada na impressão do anexo, busca com moldura retro inspirada em input.md, filtros por área, cartões escuros inspirados em cards.md, detalhes acessíveis, seleção, confirmação e recibo de voto. Layout responsivo, foco visível, estados de carregamento/erro/vazio e suporte a movimento reduzido.
Página `/metricas`: login, total de votos, líder ou empate, participação por área, ranking por tópico com barras/percentuais, evolução diária, CSV, atualização periódica e logout. Sem resultados antes do login.

## Tópicos da imagem
Administrativo: Sistemas, práticas e mercado de trabalho; Produção de documentos profissionais; Planilhas e gestão financeira.
Design: Design gráfico e ilustração; Edição e tratamento de imagens; Desenvolvimento de sites e landing pages.
Marketing digital: Apresentações multimídia; Gestão de redes sociais; Gestão de tráfego pago.
Suporte técnico: Sistemas operacionais modernos e acesso remoto; Manutenção e configuração de hardwares e softwares; Redes e servidores.
Inovação: Desenvolvimento de games; Robótica; Edição de vídeos.
Benefícios não são temas de votação.

## Contrato HTTP
`GET /api/topics` → `{topics:[{id,title,category,description,skills:[]}]}`.
`GET /api/voter` → `{hasVoted,topicId:null|string}`; emite cookie identificador quando ausente.
`POST /api/votes` recebe `{topicId}`; exige identificador emitido, retorna 201 `{topicId}`; duplicado 409 `{error,topicId}`; inválido 400.
`GET /api/admin/session` → `{authenticated}`.
`POST /api/admin/login` recebe `{password}` e cria cookie de sessão; senha incorreta 401, limite de tentativas 429.
`POST /api/admin/logout` encerra sessão.
`GET /api/admin/metrics` autenticado → `{totalVotes,topics:[...topic,votes,percentage],categories:[{name,votes,percentage}],timeline:[{date,votes}],leaders:[id],updatedAt}`. Ranking decrescente, empate preservado, líderes vazios se zero votos.
`GET /api/admin/export` autenticado → CSV UTF-8 com título, área, votos e percentual. Percentuais do total.
Erros `{error}`. POST aceita JSON limitado e rejeita origem externa. Sessões aleatórias expiram e são guardadas como hashes. Diretório estático é somente public; sem CORS aberto.

## Validação e limites
Testes reais de HTTP/SQLite para voto, duplicidade concorrente, persistência, entrada inválida, acesso administrativo, expiração/logout, métricas e CSV. Testes JavaScript para filtragem/agregação de apresentação, além de fluxo real no navegador desktop e mobile. Deploy público, TLS e backups de produção ficam a cargo da hospedagem; HTTPS e volume persistente são necessários para uso público. Não publicar nem fazer push automaticamente.
