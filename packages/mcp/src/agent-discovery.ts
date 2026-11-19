import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENTATION_URL = "https://docs.tinycloud.xyz/cli/mcp";
const SKILL_NAME = "tinycloud-delegated-secrets";
const LOCAL_PACKAGES = [["@tinycloud", "cli"].join("/"), ["@tinycloud", "mcp"].join("/")];
export const WEBMCP_SCRIPT_PATH = "/webmcp.js";
export const WEBMCP_TOOL_NAME = "get_tinycloud_mcp_connection";
/**
 * The hosted MCP server does not speak A2A. TinyCloud's A2A agent is the
 * public discovery agent at tinycloud.xyz/a2a, so this host points to its card.
 */
export const A2A_AGENT_CARD_URL = "https://tinycloud.xyz/.well-known/agent-card.json";

// Same anchor rule as tools.ts: bun and CJS define __dirname, ESM uses import.meta.url.
const moduleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
// src/ and dist/ both sit directly under the package root, which ships skills/.
const skillPath = join(moduleDirectory, "..", "skills", SKILL_NAME, "SKILL.md");

/**
 * The public agent-discovery documents of the hosted surface, by pathname:
 * the RFC 9727 API catalog, the Agent Skills discovery index with the skill it
 * lists, the A2A agent card redirect and the page's WebMCP script.
 */
export function agentDiscoveryRoutes(
  resourceUrl: URL,
  issuer: string,
  requiredScope: string,
): ReadonlyMap<string, () => Response> {
  const at = (path: string) => new URL(path, resourceUrl).toString();
  const serverCardUrl = at("/.well-known/mcp/server-card.json");
  const skillUrlPath = `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`;
  const skill = readFileSync(skillPath);

  const apiCatalog = JSON.stringify({
    linkset: [{
      anchor: resourceUrl.toString(),
      "service-desc": [{ href: serverCardUrl, type: "application/json" }],
      "service-doc": [{ href: DOCUMENTATION_URL, type: "text/html" }],
      status: [{ href: at("/healthz"), type: "application/json" }],
    }],
  });
  const skillsIndex = JSON.stringify({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [{
      name: SKILL_NAME,
      type: "skill-md",
      description: skillDescription(skill.toString("utf8")),
      url: at(skillUrlPath),
      digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`,
    }],
  });
  const connection = {
    endpoint: resourceUrl.toString(),
    transport: "streamable-http",
    authorization: {
      type: "oauth2",
      authorizationServer: issuer,
      protectedResourceMetadata: at(`/.well-known/oauth-protected-resource${resourceUrl.pathname}`),
      scope: requiredScope,
    },
    serverCard: serverCardUrl,
    documentation: DOCUMENTATION_URL,
    localAlternative: { packages: LOCAL_PACKAGES, stdioServer: "tinycloud-mcp" },
  };
  const webMcpScript = `(() => {
  const modelContext = (typeof document !== "undefined" && document.modelContext) ||
    (typeof navigator !== "undefined" && navigator.modelContext);
  if (!modelContext || typeof modelContext.registerTool !== "function") return;
  const connection = ${JSON.stringify(connection)};
  modelContext.registerTool({
    name: ${JSON.stringify(WEBMCP_TOOL_NAME)},
    description: "Get the hosted TinyCloud MCP endpoint, its transport and OAuth discovery, the connection documentation, and the local stdio alternative shown on this page.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      return { content: [{ type: "text", text: JSON.stringify(connection) }], structuredContent: connection };
    },
  });
})();
`;

  const cached = (body: string | Buffer, contentType: string) => () => new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
  return new Map([
    ["/.well-known/api-catalog", cached(apiCatalog, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"')],
    ["/.well-known/agent-skills/index.json", cached(skillsIndex, "application/json; charset=utf-8")],
    [skillUrlPath, cached(skill, "text/markdown; charset=utf-8")],
    ["/.well-known/agent-card.json", () => new Response(null, {
      status: 302,
      headers: { location: A2A_AGENT_CARD_URL, "cache-control": "public, max-age=300" },
    })],
    [WEBMCP_SCRIPT_PATH, cached(webMcpScript, "text/javascript; charset=utf-8")],
  ]);
}

function skillDescription(skill: string): string {
  const description = /^---\n(?:.*\n)*?description: (.+)\n(?:.*\n)*?---\n/.exec(skill)?.[1];
  if (description === undefined) throw new Error(`${SKILL_NAME}/SKILL.md must declare a frontmatter description.`);
  return description;
}
