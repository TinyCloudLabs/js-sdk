#!/usr/bin/env bash
# Install or remove the deploy key the Release workflow pushes master with.
#
#   release-deploy-key.sh install   needs RELEASE_DEPLOY_KEY in the environment
#   release-deploy-key.sh remove
#
# The key and the pinned github.com host keys live in $RUNNER_TEMP/release-ssh.
# Push steps use them through GIT_SSH_COMMAND (see the workflow); nothing is
# written to ~/.ssh and the key is never printed.
set -euo pipefail

dir="${RUNNER_TEMP:?RUNNER_TEMP is not set}/release-ssh"

case "${1:-}" in
  install)
    if [ -z "${RELEASE_DEPLOY_KEY:-}" ]; then
      echo "::error title=RELEASE_DEPLOY_KEY is not set::Release commits are pushed to master with a deploy key; there is no fallback to GH_TOKEN. Add the RELEASE_DEPLOY_KEY secret (see docs/versioning.md, \"How releases push\"). Nothing was versioned or published."
      exit 1
    fi
    rm -rf "$dir"
    (umask 077 && mkdir -p "$dir")
    (umask 077 && printf '%s\n' "$RELEASE_DEPLOY_KEY" > "$dir/id")
    chmod 600 "$dir/id"
    if ! ssh-keygen -y -f "$dir/id" >/dev/null 2>&1; then
      rm -rf "$dir"
      echo "::error title=RELEASE_DEPLOY_KEY is not a usable private key::ssh-keygen could not read the secret. Nothing was versioned or published."
      exit 1
    fi
    # GitHub's published SSH host keys (fingerprints:
    # https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
    # ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
    # ecdsa   SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM
    # rsa     SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s).
    cat > "$dir/known_hosts" <<'KNOWN_HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
KNOWN_HOSTS
    ;;
  remove)
    rm -rf "$dir"
    ;;
  *)
    echo "usage: $0 install|remove" >&2
    exit 2
    ;;
esac
