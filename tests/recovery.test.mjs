import test from 'node:test';
import assert from 'node:assert/strict';

async function helpers() {
  let module;
  try {module = await import('../public/recovery.mjs');}
  catch(error) {if(error.code !== 'ERR_MODULE_NOT_FOUND') throw error;}
  assert.equal(typeof module?.buildRecoveryRedirect,'function','helper de redirect precisa existir');
  assert.equal(typeof module?.isRecoveryLocation,'function','helper de detecção precisa existir');
  return module;
}

test('redirect retorna raiz do projeto Pages com recovery=1 e sem fragmento ou token', async () => {
  const {buildRecoveryRedirect}=await helpers();
  for(const source of [
    'https://example.github.io/SISTEMA-DE-VOTA-O/',
    'https://example.github.io/SISTEMA-DE-VOTA-O/index.html?old=secret#metricas',
    'https://example.github.io/SISTEMA-DE-VOTA-O/?old=secret#access_token=private&type=recovery',
  ]) assert.equal(buildRecoveryRedirect(source),'https://example.github.io/SISTEMA-DE-VOTA-O/?recovery=1');
});

test('redirect aceita raiz de domínio e loopback de desenvolvimento', async () => {
  const {buildRecoveryRedirect}=await helpers();
  assert.equal(buildRecoveryRedirect('https://vote.example.test/#metricas'),'https://vote.example.test/?recovery=1');
  assert.equal(buildRecoveryRedirect('http://127.0.0.1:8000/metricas?old=secret#anything'),'http://127.0.0.1:8000/?recovery=1');
  assert.throws(()=>buildRecoveryRedirect('not a URL'),TypeError);
});

test('detecta query recovery, fragmento Auth e fragmento de erro sem retornar detalhes', async () => {
  const {isRecoveryLocation}=await helpers();
  for(const suffix of [
    '?recovery=1',
    '#access_token=private&refresh_token=private&type=recovery',
    '#error=access_denied&error_code=otp_expired&error_description=private',
    '#error_code=otp_expired',
    '#error=',
  ]) assert.equal(isRecoveryLocation('https://example.github.io/repo/'+suffix),true);
});

test('navegação normal e outras ações Auth não abrem recuperação', async () => {
  const {isRecoveryLocation}=await helpers();
  for(const suffix of ['', '#metricas', '?recovery=0', '#type=signup', '#error_description=private', '?error=access_denied']) {
    assert.equal(isRecoveryLocation('https://example.github.io/repo/'+suffix),false);
  }
  assert.equal(isRecoveryLocation('invalid URL'),false);
});
