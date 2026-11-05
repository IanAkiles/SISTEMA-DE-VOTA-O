"""The fifteen course topics transcribed from the supplied course image."""

TOPICS = [
    {"id": "admin-sistemas", "title": "Sistemas, práticas e mercado de trabalho", "category": "Administrativo", "description": "Conheça rotinas administrativas e ferramentas para atuar no mercado de trabalho.", "skills": ["Rotinas administrativas", "Organização", "Mercado de trabalho"]},
    {"id": "admin-documentos", "title": "Produção de documentos profissionais", "category": "Administrativo", "description": "Crie e organize documentos claros para o dia a dia profissional.", "skills": ["Edição de textos", "Documentos profissionais", "Comunicação"]},
    {"id": "admin-planilhas", "title": "Planilhas e gestão financeira", "category": "Administrativo", "description": "Use planilhas para acompanhar informações e organizar as finanças.", "skills": ["Planilhas", "Fórmulas", "Gestão financeira"]},
    {"id": "design-grafico", "title": "Design gráfico e ilustração", "category": "Design", "description": "Explore composição visual, identidade e criação de ilustrações.", "skills": ["Composição", "Identidade visual", "Ilustração"]},
    {"id": "design-imagens", "title": "Edição e tratamento de imagens", "category": "Design", "description": "Aprenda a ajustar, compor e tratar imagens para diferentes projetos.", "skills": ["Edição de imagens", "Cor", "Composição digital"]},
    {"id": "design-web", "title": "Desenvolvimento de sites e landing pages", "category": "Design", "description": "Construa páginas para apresentar ideias, projetos e negócios na web.", "skills": ["Sites", "Landing pages", "Design responsivo"]},
    {"id": "marketing-apresentacoes", "title": "Apresentações multimídia", "category": "Marketing digital", "description": "Combine texto, imagem e mídia para comunicar ideias em apresentações.", "skills": ["Apresentações", "Narrativa", "Multimídia"]},
    {"id": "marketing-redes", "title": "Gestão de redes sociais", "category": "Marketing digital", "description": "Planeje conteúdos e organize a presença de marcas nas redes sociais.", "skills": ["Redes sociais", "Planejamento de conteúdo", "Comunicação digital"]},
    {"id": "marketing-trafego", "title": "Gestão de tráfego pago", "category": "Marketing digital", "description": "Conheça campanhas de anúncios e o acompanhamento de seus resultados.", "skills": ["Anúncios", "Campanhas", "Métricas"]},
    {"id": "suporte-sistemas", "title": "Sistemas operacionais modernos e acesso remoto", "category": "Suporte técnico", "description": "Explore configuração de sistemas e ferramentas de atendimento remoto.", "skills": ["Sistemas operacionais", "Acesso remoto", "Suporte"]},
    {"id": "suporte-manutencao", "title": "Manutenção e configuração de hardwares e softwares", "category": "Suporte técnico", "description": "Conheça os cuidados e ajustes necessários para manter computadores funcionando.", "skills": ["Hardware", "Software", "Manutenção"]},
    {"id": "suporte-redes", "title": "Redes e servidores", "category": "Suporte técnico", "description": "Entenda conexões, infraestrutura de redes e o papel dos servidores.", "skills": ["Redes", "Servidores", "Conectividade"]},
    {"id": "inovacao-games", "title": "Desenvolvimento de games", "category": "Inovação", "description": "Explore a criação de jogos, suas regras e experiências interativas.", "skills": ["Games", "Lógica", "Interatividade"]},
    {"id": "inovacao-robotica", "title": "Robótica", "category": "Inovação", "description": "Descubra como programação, eletrônica e mecanismos dão vida a projetos.", "skills": ["Robótica", "Programação", "Eletrônica"]},
    {"id": "inovacao-videos", "title": "Edição de vídeos", "category": "Inovação", "description": "Organize imagens, cortes e som para contar histórias em vídeo.", "skills": ["Edição", "Narrativa audiovisual", "Som"]},
]
TOPIC_IDS = frozenset(topic["id"] for topic in TOPICS)
