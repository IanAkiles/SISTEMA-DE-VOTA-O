import {cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

class BuildError extends Error {}

function readConfig(env) {
  const value = env.SUPABASE_URL?.trim();
  // Accept an HTTPS origin only; URL parsing alone normalizes paths and credentials.
  const originPattern = /^https:\/\/([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+)(?::443)?\/?$/i;
  if (!value || !originPattern.test(value)) {
    throw new BuildError('SUPABASE_URL deve conter somente a origem HTTPS pública do projeto.');
  }
  const url = new URL(value);
  if (isIP(url.hostname)) {
    throw new BuildError('SUPABASE_URL deve conter somente a origem HTTPS pública do projeto.');
  }

  const key = (env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY)?.trim();
  let isPublic = /^sb_publishable_[a-z\d_-]{8,}$/i.test(key || '');
  if (!isPublic && key) {
    const parts = key.split('.');
    if (parts.length === 3 && parts.every(part => /^[a-z\d_-]+$/i.test(part))) {
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        isPublic = header.alg === 'HS256' && claims.role === 'anon' &&
          Buffer.from(parts[2], 'base64url').length === 32;
      } catch {
        // Never include the supplied key or parser error in build logs.
      }
    }
  }
  if (!isPublic) {
    throw new BuildError('SUPABASE_PUBLISHABLE_KEY (ou SUPABASE_ANON_KEY) deve ser uma chave publishable ou JWT anon; chaves secretas e privilegiadas são proibidas.');
  }
  return {provider:'supabase',supabaseUrl:url.origin,supabasePublishableKey:key};
}

function outputPath(args) {
  if (args.length === 0) return join(root, 'dist');
  if (args.length === 2 && args[0] === '--out-dir' && args[1]) return resolve(args[1]);
  throw new BuildError('Uso: npm run build -- [--out-dir pasta-de-saída-vazia] [--config arquivo-público.json]');
}

async function assertEmptyOutput(outDir) {
  try {
    const status = await lstat(outDir);
    if (!status.isDirectory() || (await readdir(outDir)).length > 0) {
      throw new BuildError('A pasta de saída já existe e não está vazia. Escolha uma pasta nova ou vazia.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const args=process.argv.slice(2);
  let fileConfig={};
  const index=args.indexOf('--config');
  if(index>=0) {
    const path=args[index+1];
    if(!path || path.startsWith('--')) throw new BuildError('Informe o arquivo público de configuração.');
    try {fileConfig=JSON.parse(await readFile(resolve(path),'utf8'));}
    catch {throw new BuildError('Não foi possível ler o arquivo público de configuração.');}
    if(!fileConfig || typeof fileConfig!=='object' || Array.isArray(fileConfig)) throw new BuildError('Arquivo público de configuração inválido.');
    args.splice(index,2);
  }
  const config = readConfig({
    SUPABASE_URL:process.env.SUPABASE_URL || fileConfig.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY:process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || fileConfig.supabasePublishableKey,
  });
  const outDir = outputPath(args);
  await assertEmptyOutput(outDir);
  await mkdir(dirname(outDir), {recursive:true});
  const staging = await mkdtemp(join(dirname(outDir), '.vota-pages-build-'));
  try {
    await cp(join(root,'public'), staging, {recursive:true});
    await build({
      entryPoints:[join(root,'public/supabase-backend.mjs')],
      outfile:join(staging,'supabase-backend.mjs'),
      bundle:true,
      format:'esm',
      platform:'browser',
      target:'es2022',
      minify:true,
      logLevel:'silent',
    });
    await writeFile(join(staging,'config.js'),`export const config = ${JSON.stringify(config,null,2)};\n`);
    await writeFile(join(staging,'.nojekyll'),'');
    // rmdir only removes an empty destination. Never recursively delete caller paths.
    await rmdir(outDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rename(staging,outDir);
    process.stdout.write('Build do GitHub Pages concluído.\n');
  } finally {
    await rm(staging,{recursive:true,force:true});
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof BuildError ? error.message : 'Não foi possível gerar o site estático. Verifique a pasta de saída e execute npm ci.'}\n`);
  process.exitCode = 1;
});
