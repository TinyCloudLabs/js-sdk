// Module-loader hook for pair-as-unpatched-06.mjs: loads dist/pairing.js with the first-pairing issue lifetime a
// pre-TC-3173 0.6.x build had (30 days), so the real pair commands sign what such an issuer signs.
const PATCHED = "PEER_DELEGATION_ISSUE = '7d'";

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith('/dist/pairing.js')) return loaded;
  const source = String(loaded.source);
  if (!source.includes(PATCHED)) throw new Error(`unpatched-06: ${PATCHED} not found in ${url}; this helper is out of date`);
  return { ...loaded, source: source.replace(PATCHED, "PEER_DELEGATION_ISSUE = '30d'") };
}
