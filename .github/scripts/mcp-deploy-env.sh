#!/usr/bin/env bash

validate_mcp_native_service_credential() {
  local credential=${TC_MCP_NATIVE_SERVICE_CREDENTIAL-}
  [ -n "$credential" ] || { echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL is required" >&2; return 1; }

  case "$credential" in
    *$'\r'*|*$'\n'*)
      echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL must be a single-line value for Phala env-file transport" >&2
      return 1
      ;;
  esac

  local credential_bytes
  credential_bytes=$(LC_ALL=C printf '%s' "$credential" | wc -c | tr -d '[:space:]')
  if [ "$credential_bytes" -lt 32 ]; then
    echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL must contain at least 32 bytes" >&2
    return 1
  fi

  quote_mcp_phala_env_value TC_MCP_NATIVE_SERVICE_CREDENTIAL "$credential" >/dev/null
}

quote_mcp_phala_env_value() {
  local key=$1
  local value=$2

  case "$value" in
    *$'\r'*|*$'\n'*)
      echo "::error::$key must be a single-line value for Phala env-file transport" >&2
      return 1
      ;;
  esac

  case "$value" in
    *"'"*)
      case "$value" in
        *'`'*)
          case "$value" in
            *'"'*|*'\n'*|*'\r'*)
              echo "::error::$key cannot be represented faithfully in a Phala env file" >&2
              return 1
              ;;
          esac
          printf '"%s"' "$value"
          ;;
        *)
          printf "\`%s\`" "$value"
          ;;
      esac
      ;;
    *)
      printf "'%s'" "$value"
      ;;
  esac
}

write_mcp_deploy_env_file() {
  local -a keys=(
    TINYCLOUD_MCP_IMAGE
    CLOUDFLARE_API_TOKEN
    TC_MCP_STATE_SECRET
    TC_MCP_INTROSPECTION_CLIENT_ID
    TC_MCP_INTROSPECTION_CLIENT_SECRET
    TC_MCP_NATIVE_SERVICE_CREDENTIAL
    CERTBOT_EMAIL
  )
  local -a entries=()
  local key value quoted

  validate_mcp_native_service_credential || return 1

  for key in "${keys[@]}"; do
    if [[ ! -v $key ]]; then
      echo "::error::$key is required for MCP deployment" >&2
      return 1
    fi
    value=${!key}
    if [ -z "$value" ]; then
      echo "::error::$key is required for MCP deployment" >&2
      return 1
    fi
    if ! quoted=$(quote_mcp_phala_env_value "$key" "$value"); then
      return 1
    fi
    entries+=("$key=$quoted")
  done

  umask 077
  MCP_DEPLOY_ENV_FILE=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mcp-deploy-env.XXXXXX") || return 1
  if ! printf '%s\n' "${entries[@]}" > "$MCP_DEPLOY_ENV_FILE" || ! chmod 0600 "$MCP_DEPLOY_ENV_FILE"; then
    rm -f -- "$MCP_DEPLOY_ENV_FILE"
    MCP_DEPLOY_ENV_FILE=
    echo "::error::Could not create the MCP deployment environment file" >&2
    return 1
  fi

  trap 'rm -f -- "$MCP_DEPLOY_ENV_FILE"' EXIT
  unset value quoted entries
}
