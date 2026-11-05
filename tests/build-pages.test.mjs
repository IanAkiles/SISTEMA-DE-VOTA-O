import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, openSync, readFileSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm, mkdir, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicConfig = {
  SUPABASE_URL: 'https://example-project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_public_key_123456789',
};
const jwt = role => [
  Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({iss:'supabase',role})).toString('base64url'),
  Buffer.alloc(32, 1).toString('base64url'),
].join('.');

async function withOutput(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'vota-pages-test-'));
  try { await run(join(temporary, 'site'), temporary); }
  finally { await rm(temporary, {recursive:true,force:true}); }
}

function build(outDir, overrides = {}, extraArgs = []) {
  const env = {...process.env};
  delete env.SUPABASE_URL;
  delete env.SUPABASE_PUBLISHABLE_KEY;
  delete env.SUPABASE_ANON_KEY;
  // Regular files avoid pipe capture returning EPERM in restricted Linux runners.
  const stdoutPath = join(dirname(outDir),'build.stdout.log');
  const stderrPath = join(dirname(outDir),'build.stderr.log');
  const stdoutFd = openSync(stdoutPath,'w');
  const stderrFd = openSync(stderrPath,'w');
  let result;
  try {
    result = spawnSync(process.execPath, ['scripts/build-pages.mjs', '--out-dir', outDir, ...extraArgs], {
      cwd:root,
      env:{...env,...overrides},
      stdio:['ignore',stdoutFd,stderrFd],
      timeout:30000,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return {...result,stdout:readFileSync(stdoutPath,'utf8'),stderr:readFileSync(stderrPath,'utf8')};
}

async function loadConfig(path) {
  const source = await readFile(path, 'utf8');
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).config;
}

test('build preserva public e empacota o SDK para um site estático autônomo', async () => {
  await withOutput(async outDir => {
    const before = await readFile(join(root,'public/config.js'), 'utf8').catch(() => null);
    const result = build(outDir, publicConfig);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await loadConfig(join(outDir,'config.js')), {
      provider:'supabase',
      supabaseUrl:'https://example-project.supabase.co',
      supabasePublishableKey:publicConfig.SUPABASE_PUBLISHABLE_KEY,
    });
    assert.deepEqual(await loadConfig(join(root,'public/config.js')), {
      provider:'local',supabaseUrl:'',supabasePublishableKey:'',
    });
    assert.equal(await readFile(join(root,'public/config.js'),'utf8'),before);
    for (const file of ['index.html','app.js','model.mjs','styles.css','favicon.svg']) {
      assert.deepEqual(await readFile(join(outDir,file)),await readFile(join(root,'public',file)));
    }
    assert.equal(await readFile(join(outDir,'.nojekyll'),'utf8'),'');
    const bundle = await readFile(join(outDir,'supabase-backend.mjs'),'utf8');
    assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()\s*["'](?:@supabase\/|https?:\/\/)/);
    const adapter = await import(`file://${join(outDir,'supabase-backend.mjs')}`);
    assert.equal(typeof adapter.createSupabaseBackend,'function');
    assert.ok(!(await readdir(outDir)).includes('node_modules'));
  });
});

test('build aceita domínio personalizado HTTPS e chave anon legada', async () => {
  await withOutput(async outDir => {
    const result = build(outDir, {SUPABASE_URL:'https://database.example.edu/',SUPABASE_ANON_KEY:jwt('anon')});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(await loadConfig(join(outDir,'config.js')), {
      provider:'supabase',supabaseUrl:'https://database.example.edu',supabasePublishableKey:jwt('anon'),
    });
  });
});

test('chave publishable explícita tem preferência sobre fallback anon', async () => {
  await withOutput(async outDir => {
    const result = build(outDir, {...publicConfig,SUPABASE_ANON_KEY:jwt('service_role')});
    assert.equal(result.status,0,result.stderr);
    assert.equal((await loadConfig(join(outDir,'config.js'))).supabasePublishableKey,publicConfig.SUPABASE_PUBLISHABLE_KEY);
  });
});

test('build rejeita configuração ausente antes de criar artefato', async () => {
  for (const configuration of [{}, {SUPABASE_URL:publicConfig.SUPABASE_URL}, {SUPABASE_PUBLISHABLE_KEY:publicConfig.SUPABASE_PUBLISHABLE_KEY}]) {
    await withOutput(async outDir => {
      const result = build(outDir,configuration);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY/);
      await assert.rejects(readdir(outDir),{code:'ENOENT'});
    });
  }
});

test('build rejeita origens inválidas sem imprimir valores fornecidos', async () => {
  for (const url of [
    'http://example-project.supabase.co',
    'https://username:password@example-project.supabase.co',
    'https://example-project.supabase.co/rest/v1',
    'https://example-project.supabase.co?secret=private',
    'https://example-project.supabase.co#private',
    'https://example-project.supabase.co:8443',
    'https://localhost',
    'https://127.0.0.1',
    'definitely-private-invalid-url',
  ]) {
    await withOutput(async outDir => {
      const result = build(outDir,{...publicConfig,SUPABASE_URL:url});
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/SUPABASE_URL/);
      assert.ok(!(result.stdout+result.stderr).includes(url));
      await assert.rejects(readdir(outDir),{code:'ENOENT'});
    });
  }
});

test('build rejeita chaves secretas, papéis privilegiados e tokens malformados sem vazá-los', async () => {
  for (const key of [
    'sb_secret_do_not_publish_this_value',
    jwt('service_role'),
    jwt('authenticated'),
    'eyJhbGciOiJIUzI1NiJ9.not-json.signature',
    'not-a-supabase-key',
    'sb_publishable_',
  ]) {
    await withOutput(async outDir => {
      const result = build(outDir,{...publicConfig,SUPABASE_PUBLISHABLE_KEY:key});
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/SUPABASE_PUBLISHABLE_KEY/);
      assert.ok(!(result.stdout+result.stderr).includes(key));
      await assert.rejects(readdir(outDir),{code:'ENOENT'});
    });
  }
});

test('build nunca limpa uma pasta customizada que já contém arquivos', async () => {
  await withOutput(async outDir => {
    await mkdir(outDir);
    await writeFile(join(outDir,'keep.txt'),'arquivo que deve continuar intacto');
    const result = build(outDir,publicConfig);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/saída/);
    assert.equal(await readFile(join(outDir,'keep.txt'),'utf8'),'arquivo que deve continuar intacto');
    assert.deepEqual(await readdir(outDir),['keep.txt']);
  });
});

test('build usa arquivo público de projeto e recusa segredo mesmo quando há fallback válido', async () => {
  await withOutput(async (outDir,temporary) => {
    const path=join(temporary,'pages.public.json');
    await writeFile(path,JSON.stringify({supabaseUrl:publicConfig.SUPABASE_URL,supabasePublishableKey:publicConfig.SUPABASE_PUBLISHABLE_KEY}));
    const result=build(outDir,{},['--config',path]);
    assert.equal(result.status,0,result.stderr);
    assert.equal((await loadConfig(join(outDir,'config.js'))).supabasePublishableKey,publicConfig.SUPABASE_PUBLISHABLE_KEY);
    const bad=build(join(temporary,'rejected'),{SUPABASE_PUBLISHABLE_KEY:'sb_secret_never_expose'},['--config',path]);
    assert.notEqual(bad.status,0);
    assert.ok(!bad.stderr.includes('sb_secret_never_expose'));
  });
});
