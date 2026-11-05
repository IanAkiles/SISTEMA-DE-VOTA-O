export function buildRecoveryRedirect(url) {
  const target=new URL('./',url);
  target.hash='';
  target.search='?recovery=1';
  return target.href;
}

export function isRecoveryLocation(url) {
  try {
    const location=new URL(url);
    const fragment=new URLSearchParams(location.hash.slice(1));
    return location.searchParams.get('recovery') === '1' || fragment.get('type') === 'recovery' || fragment.has('error') || fragment.has('error_code');
  } catch {return false;}
}
