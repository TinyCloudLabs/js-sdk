/** Explicit virtual executable identities for offline shell/normalisation tests. Real-filesystem identity tests use realEnv. */
const names = new Set(`gh git npm npx pnpm pnpx yarn bun bunx corepack changeset wrangler phala tc tinycloud courier lerna semantic-release turbo nx make gmake just paseo claude codex omp opencode gemini sudo doas su ssh tmux screen crontab curl wget node nodejs python python3 perl ruby php deno lua tsx sh bash dash zsh fish env timeout nohup nice find xargs parallel rg grep cat ls head tail wc tee sort echo printf pwd date sleep cp mv ln install hardlink tsc`.split(' '));
const aliases = new Map([
  ['/usr/bin/gh', 'gh'], ['./node_modules/.bin/gh', 'gh'], ['GH', 'gh'],
  ['/opt/courier/dist/cli.js', 'courier'],
]);
export const trustedProgram = word => aliases.get(word) ?? (names.has(word) ? word : undefined);
