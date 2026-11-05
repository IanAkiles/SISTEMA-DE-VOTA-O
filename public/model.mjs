const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();

export function filterTopics(topics, query = '', category = 'Todas') {
  const search = normalize(query);
  return topics.filter(topic => (category === 'Todas' || topic.category === category) &&
    normalize([topic.title, topic.description, ...topic.skills].join(' ')).includes(search));
}

export function leaderLabel(metrics) {
  if (!metrics.totalVotes || !metrics.leaders.length) return 'Aguardando o primeiro voto';
  if (metrics.leaders.length > 1) return `Empate entre ${metrics.leaders.length} tópicos`;
  return metrics.topics.find(topic => topic.id === metrics.leaders[0])?.title || 'Resultado indisponível';
}

export function percentageLabel(value) {
  return `${new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 1}).format(value)}%`;
}

export function normalizeMatricula(value) {
  if (typeof value !== 'string') return null;
  const matricula = value.trim();
  return /^[0-9]{5}$/.test(matricula) ? matricula : null;
}
