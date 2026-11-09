# Hosted MCP client compatibility draft

Details: TC-2393

This is an engineering requirements and evidence draft, not an installation-success,
directory-approval or publication claim. Checked 9 November 2026. No owner sign-in,
client registration, token exchange, personal-data access or submission was performed.

## Surfaces and source

- Custom remote connections use `https://mcp.tinycloud.xyz/mcp` with OpenKey OAuth.
- The restricted public ChatGPT candidate uses
  `https://mcp.tinycloud.xyz/chatgpt/mcp`. Its configuration is
  [`package/mcp.json`](package/mcp.json); existing release prerequisites and historical
  evidence are in [`review-evidence.json`](review-evidence.json). Do not replace the
  broad custom endpoint with the public candidate for other clients without checking
  the required tool set and OAuth audience.
- Both HTTP surfaces are implemented in [`../src/http.ts`](../src/http.ts) in
  `TinyCloudLabs/js-sdk`, not TinyChat. TinyChat is a consumer; its
  [TC-2196 PR #609](https://github.com/TinyCloudLabs/tinychat/pull/609) is separate.
- Local `tinycloud-mcp` stdio runs in the client's process environment and uses a
  local CLI profile. The TinyCloud CLI itself is a separate direct-data route, not
  a hosted MCP client. A setup prompt link does not install a connector.
- The public [server card](https://mcp.tinycloud.xyz/.well-known/mcp/server-card.json)
  advertises `streamable-http`, `/mcp`, and this repository's `packages/mcp` source.
  A server card does not establish a client's official-directory listing.

## Shared server requirements and current evidence

Source baseline: `e86376ede`, package `@tinycloud/mcp@0.10.0-beta.16`. The live card
reported `0.10.0-beta.6`; do not equate the checked source with the deployed version.

| Requirement | Observed support or remaining boundary |
| --- | --- |
| Protected-resource discovery | Both [root metadata](https://mcp.tinycloud.xyz/.well-known/oauth-protected-resource) and [path metadata](https://mcp.tinycloud.xyz/.well-known/oauth-protected-resource/mcp) returned HTTP 200 with resource `https://mcp.tinycloud.xyz/mcp`, issuer `https://api.openkey.so/api/auth`, scope `tinycloud:mcp`, and header bearer transport. |
| Authentication challenge | Unauthenticated `GET /mcp` returned HTTP 401 with `WWW-Authenticate: Bearer`, scope `tinycloud:mcp`, and the path-specific `resource_metadata` URL. No authenticated behavior was exercised. |
| Separate public audience | Unauthenticated `GET /chatgpt/mcp` returned HTTP 401 pointing to [its own metadata](https://mcp.tinycloud.xyz/.well-known/oauth-protected-resource/chatgpt/mcp), which returned HTTP 200 and the distinct `/chatgpt/mcp` resource. |
| Authorization discovery | [RFC 8414 issuer-path metadata](https://api.openkey.so/.well-known/oauth-authorization-server/api/auth) returned HTTP 200. The append-path URL `/api/auth/.well-known/oauth-authorization-server` returned 404; use the advertised issuer and standards-based discovery rather than inventing that URL. [OIDC discovery](https://api.openkey.so/api/auth/.well-known/openid-configuration) also returned HTTP 200. |
| DCR, PKCE and refresh | Authorization metadata advertises `registration_endpoint`, `authorization_code`, `refresh_token`, `S256`, `offline_access`, and token auth methods `none`, `client_secret_basic`, `client_secret_post`. These declarations are not a successful registration, code exchange or refresh. CIMD support is not advertised in the checked metadata. |
| Resource-bound tokens | [`../src/oauth.ts`](../src/oauth.ts) verifies issuer, audience, expiry and required scope; the HTTP surface selects the corresponding resource. Live claim binding, revocation and refresh remain untested here. Do not add a token proxy, static bearer fallback or auth bypass. |
| Browser transport | A live `OPTIONS /mcp` with Origin `https://gemini.google.com` returned 204, wildcard origin, GET/POST/DELETE/OPTIONS, and a fixed allowed-header list including authorization and MCP protocol/session headers. It exposed only `WWW-Authenticate`. |
| Browser response headers | Checked source additionally exposes `Mcp-Session-Id` and `Mcp-Protocol-Version`. That change is already merged in [#857 / TC-2461](https://github.com/TinyCloudLabs/js-sdk/pull/857); the observed live difference needs release/deployment evidence, not duplicate implementation. Any-Origin bearer CORS is already merged in [#833 / TC-2394](https://github.com/TinyCloudLabs/js-sdk/pull/833). |
| Tool titles and annotations | [`../src/tools.ts`](../src/tools.ts) already projects a title and explicit boolean `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` for each binding. `tinycloud_connect` supplies the same fields in `http.ts`. Context/query are intentionally mutating; do not relabel them read-only to pass review. Actual authenticated tool discovery was not run. |
| Owner authority | OAuth is followed by existing account/per-task delegation approval. Native TinyChat service authentication is a separate signed-grant path, not credentials for general clients or reviewers. |

Clients that can configure scopes should request `tinycloud:mcp offline_access`
with resource `https://mcp.tinycloud.xyz/mcp` on the first authorization when
refresh is desired, following the [TinyCloud connection guide](https://agents.tinycloud.xyz/connect.md).
The public ChatGPT candidate instead uses its own resource. An advertised refresh
grant does not prove the client requested the needed scope or retained a refresh token.
Do not expand protected-resource scopes or alter token lifetimes speculatively.

## Ten target clients

Each row distinguishes a custom connection from official distribution. None of
these clients was signed in or exercised by this draft's checks.

| Client | Custom/local connection requirements | Official distribution or remaining work |
| --- | --- | --- |
| ChatGPT | Custom remote `/mcp`, OAuth discovery, resource-bound authorization code + S256; [OpenAI authentication contract](https://developers.openai.com/plugins/build/auth). | Stage only the restricted `/chatgpt/mcp` package. [Submission](https://developers.openai.com/plugins/deploy/submission) requires domain verification, authenticated hosted-tool scan, populated dedicated review account, five positive and three negative cases, and walkthrough. [Annotations](https://developers.openai.com/plugins/plugin-guidelines) already have a source implementation; portal acceptance is unverified. |
| Claude | Public HTTPS remote MCP, OAuth, titles and effect annotations; [custom connection](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp). The [auth contract](https://claude.com/docs/connectors/building/authentication) requires a 401 challenge, exact resource path, primary issuer first, S256, form-urlencoded token exchange and public-client refresh rotation; Claude appends `offline_access` when authorization metadata advertises it. Discovery is observed; exchange/rotation are untested here. | [Directory submission](https://claude.com/docs/connectors/building/submission) additionally needs listing/privacy/support material, populated reviewer account and real tool checks. Directory policy review below remains unresolved; custom compatibility is not directory approval. Claude Code is the CLI-capable route, not the Claude app connector. |
| Cursor | [MCP contract](https://cursor.com/docs/mcp): Streamable HTTP URL, PKCE, RFC 9728 discovery, RFC 8707 resource, public DCR without a secret. Refresh requires a returned refresh token; `offline_access` can be necessary. CLI-capable Cursor may use TinyCloud CLI instead. | Custom `mcp.json` is not a Cursor Marketplace listing. No marketplace entry, client registration or authenticated check is supplied here. |
| Gemini | [Custom app](https://support.google.com/gemini/answer/17209137) adds an MCP URL; DCR avoids manually supplied OAuth credentials. Its account/region restrictions are client-side availability, not server-protocol failures. | [Google Connected Apps](https://developers.google.com/connected-apps/gpc/perform-the-steps) uses user-delegated authorization code, CIMD-first/DCR fallback, app-specific callbacks, domain verification, authenticated tool sync and a seeded review account with 2FA disabled. No console access or challenge token is available in this draft. |
| Grok | [Custom MCP connector](https://docs.x.ai/grok/connectors) accepts a public server URL and required authentication, then discovers tools. Business/Enterprise provisioning is admin-controlled. | Built-in connectors and the connector catalog are different routes; custom MCP support is not TinyCloud catalog inclusion. No Grok login or official catalog submission was performed. |
| Muse | [Meta connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/) allows user-created custom connectors and a secure credentials store. TinyCloud's [Muse guide](https://agents.tinycloud.xyz/connect.md#meta-muse) specifies Streamable HTTP, resource `/mcp`, and both scopes on first OAuth sign-in. | Custom connectors are not reviewed by Meta. The separate [Muse Connector Platform](https://platform.muse.ai/) provides a login-gated submission route with functional, security and legal review plus end-to-end testing before directory inclusion. No submission, native tool discovery, record round-trip or token refresh was run here; do not store tokens in connector source or prompts. |
| Perplexity | [Custom remote connector](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors): HTTPS MCP URL, OAuth, Streamable HTTP, discovery/DCR or configured client credentials. Direct help fetch was Cloudflare-blocked; the primary page's indexed content supplied these requirements. | A custom connector is not a built-in listing. If a real connection demands confidential credentials, reuse TC-2165 rather than inventing a secret or changing public DCR. No authenticated check was run. |
| OpenClaw | Prefer TinyCloud CLI when the runtime can run it. Its native [remote transport](https://docs.openclaw.ai/cli/mcp/transports) requires explicit `transport: "streamable-http"` (otherwise SSE), `auth: "oauth"`, and `oauth.scope: "tinycloud:mcp offline_access"` for refresh-capable authorization, followed by owner login. Shared-operator versus per-requester identity belongs to OpenClaw configuration. | [Managed company MCP publication](https://docs.openclaw.ai/clawhub/managed-mcp) is a distinct admin/organization-authorized route, not skill publication. It requires DCR absent explicit supported CIMD, an HTTPS endpoint, transport/auth definition and verified icon-rights metadata. Consumers need the [remote loader fix #162376](https://github.com/openclaw/openclaw/pull/162376). No config, login, publication or consumer-release verification was performed. |
| Hermes | Prefer TinyCloud CLI when available. [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/) supports remote HTTP with `auth: oauth`, discovery/PKCE/DCR and `hermes mcp login`. | Nous-approved catalog entries are separate reviewed `optional-mcps/` manifests. No catalog PR, token-store change or authenticated Hermes run is included. |
| TinyCloud CLI | [CLI onboarding](https://agents.tinycloud.xyz/onboarding) installs/signs in the direct CLI route; it does not connect the CLI to hosted MCP. Local stdio uses `@tinycloud/mcp` plus a local CLI profile as described in [the package README](../README.md#local-stdio). | First-party CLI availability is not an MCP-directory listing. Hosted connector work does not require changing the local stdio server. No installer, sign-in or profile mutation was run. |

## Public candidate tool boundary

The checked source's `/chatgpt/mcp` surface registers only `tinycloud_connect`,
`tinycloud_apps_context`, `tinycloud_apps_read`, `tinycloud_apps_write` and
`tinycloud_apps_query`. It excludes named-secrets retrieval, generic KV/SQL,
account discovery, permission requests and reusable read-scope tools. The
private `/mcp` service still offers its broader authorized tool set. This
existing isolation is not a claim that either surface passed directory review.
No tool was removed or relabeled by this draft.

## Review-sensitive requirements, not speculative auth changes

- **Reviewer access:** OpenAI requires a populated dedicated account that works
  without MFA approval, email/SMS codes, magic links or private networking. Google
  requires seeded credentials with 2FA disabled; Claude requires a standard
  populated test account. Bobbie must assess an authorized OpenKey reviewer-login
  path. This draft supplies no credentials, adds no bypass and does not weaken
  normal sign-in. A developer's working passkey is not independent reviewer access.
- **Domain verification:** OpenAI's `/.well-known/openai-apps-challenge` returns
  the portal's exact token as plain text. Google's
  `/.well-known/google-connected-apps` returns direct HTTP 200 JSON with a
  `verification_tokens` array. These are distinct contracts. Do not publish fake
  tokens, overwrite an existing challenge or add a placeholder verification route.
  Authorized portal-generated values and domain ownership are prerequisites.
- **Policy:** [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
  §1.G prohibits profile-building from conversation content or cross-session
  behavioral changes; §2.F prohibits dynamically fetching behavioral instructions
  for execution. Review requested personal-record storage, knowledge/rules tools
  and persistent-context messaging against those clauses. This is an unresolved
  policy assessment, not a compatibility fix or a finding that all record storage
  is prohibited. OpenAI's [guidelines](https://developers.openai.com/plugins/plugin-guidelines)
  separately restrict credentials and require purpose-limited inputs and privacy
  disclosures; broad private `/mcp` secrets tools must not be inferred to belong
  in an approved public listing.
- **Existing work:** Track per-client execution in TC-1360, OpenKey CIMD in
  TC-1649, confidential clients in TC-2165, and public ChatGPT resource/callback
  work in TC-2107. TC-1366/TC-2170 cover existing approval-design context.
  Their issue descriptions and historical results are not fresh live proof.
  Keep TC-2196 and TinyChat #609 intact. No duplicate auth implementation is proposed.

## Smallest next checks

The read-only discovery checks found no unimplemented transport or annotation gap
in the checked source. After the existing source is released through its authorized
process, verify the exposed MCP response headers. Authorized per-client QA must
then prove real OAuth, exact tool discovery, an approved synthetic write/read-back,
expiry/refresh and revocation where applicable. Directory reviewers additionally
need their independently usable seeded accounts, actual domain challenges and
policy-approved materials. Do not report any of those as completed from metadata,
configuration, a prompt link or this draft.
