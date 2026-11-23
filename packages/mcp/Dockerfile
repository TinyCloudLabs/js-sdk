FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ARG TINYCLOUD_MCP_VERSION=latest
RUN npm install --global "@tinycloud/mcp@${TINYCLOUD_MCP_VERSION}" \
  && command -v tinycloud-mcp-http

ENV NODE_ENV=production
ENV TC_MCP_STATE_DIR=/var/lib/tinycloud-mcp
RUN mkdir -p "$TC_MCP_STATE_DIR" && chown node:node "$TC_MCP_STATE_DIR"

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["tinycloud-mcp-http"]
