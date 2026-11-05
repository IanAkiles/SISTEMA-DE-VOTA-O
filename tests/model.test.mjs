import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTopics, leaderLabel, percentageLabel, normalizeMatricula} from '../public/model.mjs';

const topics = [
  {id:'a',title:'Robótica',category:'Inovação',description:'Sensores e automação',skills:['Arduino']},
  {id:'b',title:'Redes e servidores',category:'Suporte técnico',description:'Conectividade',skills:['Linux']},
  {id:'c',title:'Edição de vídeos',category:'Inovação',description:'Histórias em movimento',skills:['Roteiro']},
];
test('busca ignora acentos e combina filtro sem perder termos das habilidades',()=>{
  assert.deepEqual(filterTopics(topics,' robotica ','Todas').map(t=>t.id),['a']);
  assert.deepEqual(filterTopics(topics,'LINUX','Suporte técnico').map(t=>t.id),['b']);
  assert.deepEqual(filterTopics(topics,'Linux','Inovação'),[]);
  assert.deepEqual(filterTopics(topics,'','Inovação').map(t=>t.id),['a','c']);
});
test('sem votos não inventa um líder e empate não é apresentado como vencedor único',()=>{
  assert.equal(leaderLabel({totalVotes:0,leaders:[],topics:[]}), 'Aguardando o primeiro voto');
  assert.equal(leaderLabel({totalVotes:3,leaders:['b'],topics}), 'Redes e servidores');
  assert.equal(leaderLabel({totalVotes:4,leaders:['a','c'],topics}), 'Empate entre 2 tópicos');
});
test('percentuais têm formato português e zero não vira NaN',()=>{
  assert.equal(percentageLabel(0),'0%');
  assert.equal(percentageLabel(33.333),'33,3%');
  assert.equal(percentageLabel(100),'100%');
});

test('matrícula exige cinco dígitos ASCII e preserva zeros iniciais',()=>{
  assert.equal(normalizeMatricula('27250'),'27250');
  assert.equal(normalizeMatricula(' 00123 '),'00123');
  for (const value of ['', '1234', '123456', '27-250', '27 250', 'abcde', '２７２５０', '٢٧٢٥٠', '1234\n5', 27250, null]) {
    assert.equal(normalizeMatricula(value),null,`Deve rejeitar ${JSON.stringify(value)}`);
  }
});
