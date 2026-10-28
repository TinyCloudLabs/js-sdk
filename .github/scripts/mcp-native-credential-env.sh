validate_mcp_native_service_credential() {
  local credential=${TC_MCP_NATIVE_SERVICE_CREDENTIAL-}
  [ -n "$credential" ] || return 0

  case "$credential" in
    *$'\r'*|*$'\n'*)
      echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL must be a single-line value for Phala env-file transport"
      return 1
      ;;
  esac

  local credential_bytes
  credential_bytes=$(LC_ALL=C printf '%s' "$credential" | wc -c | tr -d '[:space:]')
  if [ "$credential_bytes" -lt 32 ]; then
    echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL must contain at least 32 bytes"
    return 1
  fi

  # Phala 1.1.22 trims parsed values and splits lines; require a lossless single-line representation.
  case "$credential" in
    *"'"*)
      case "$credential" in
        *'`'*)
          case "$credential" in
            *'"'*|*'\n'*|*'\r'*)
              echo "::error::TC_MCP_NATIVE_SERVICE_CREDENTIAL cannot be represented faithfully in a Phala env file"
              return 1
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

write_mcp_native_service_credential_env_file() {
  local credential=${TC_MCP_NATIVE_SERVICE_CREDENTIAL-}
  MCP_NATIVE_SERVICE_CREDENTIAL_ENV_FILE=
  [ -n "$credential" ] || return 0
  validate_mcp_native_service_credential || return 1

  local credential_env_value=$credential
  # Select a quote delimiter Phala's parser removes without transforming the credential.
  case "$credential_env_value" in
    *"'"*)
      case "$credential_env_value" in
        *'`'*)
          credential_env_value="\"$credential_env_value\""
          ;;
        *)
          credential_env_value="\`$credential_env_value\`"
          ;;
      esac
      ;;
    *)
      credential_env_value="'$credential_env_value'"
      ;;
  esac

  umask 077
  MCP_NATIVE_SERVICE_CREDENTIAL_ENV_FILE=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mcp-native-credential.XXXXXX")
  trap 'rm -f "$MCP_NATIVE_SERVICE_CREDENTIAL_ENV_FILE"' EXIT
  printf 'TC_MCP_NATIVE_SERVICE_CREDENTIAL=%s\n' "$credential_env_value" > "$MCP_NATIVE_SERVICE_CREDENTIAL_ENV_FILE"
  unset credential_env_value credential
}
