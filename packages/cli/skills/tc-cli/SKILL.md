---
name: tc-cli
description: Stores, retrieves, and shares data on TinyCloud using the tc CLI or @tinycloud/node-sdk. Use when the user wants to store key-value data, create sharing links, manage delegations, or interact with a TinyCloud node.
---

# TinyCloud CLI

## Setup

```bash
npm install -g @tinycloud/cli
tc init                   # Generate key + authenticate via OpenKey
tc init --paste           # Headless/CI (manual paste)
tc init --key-only        # Key only, skip auth
```

Creates profile at `~/.tinycloud/profiles/default/` with key, config, and session.

## Authentication

```bash
tc auth login             # Browser-based OpenKey flow
tc auth login --paste     # Manual paste mode
tc auth status            # JSON: authenticated, DIDs, spaceId
tc auth whoami            # Identity info
tc auth logout            # Clear session, keep key
```

## Key-Value Storage

```bash
tc kv put mykey "value"                # String
tc kv put config '{"k":"v"}'           # JSON
tc kv put doc --file ./data.txt        # From file
echo "data" | tc kv put notes --stdin  # From stdin

tc kv get mykey                        # JSON: {key, data, metadata}
tc kv get mykey --raw                  # Raw value to stdout
tc kv get mykey --raw -o out.txt       # Raw value to file

tc kv list                             # All keys
tc kv list --prefix "logs/"            # Filter by prefix
tc kv head mykey                       # Metadata only
tc kv delete mykey                     # Delete
```

## Sharing

```bash
tc share publish ./decision.md
cat decision.md | tc share publish - --name decision.md --expires 7d
printf '%s' "$SHARE_URL" | tc share inspect - --json
printf '%s' "$SHARE_URL" | tc share receive - --output .
printf '%s' "$SHARE_URL" | tc share receive - --stdout
```

Modern bearer links are verified through the canonical headless Share SDK.
Keep the complete URL, including its fragment, local to the process; the
fragment is the read authority. Publish human mode prints only the canonical
URL, and receive writes create-exclusive output unless `--force` is explicit.

For detailed command reference and all options, see [REFERENCE.md](REFERENCE.md).

For programmatic usage with `@tinycloud/node-sdk`, see [SDK.md](SDK.md).

## Common Patterns

```bash
# Store and share in one shot
tc kv put report "$(cat report.json)"

# Pipe from curl into TinyCloud
curl -s https://api.example.com/data | tc kv put snapshot --stdin

# Read back and process
tc kv get snapshot --raw | jq '.results'
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Usage or invalid input |
| 3 | Share upload authority required |
| 4 | Share unavailable or expired |
| 5 | Share verification failed |
| 6 | Network or registry error |
| 7 | Share byte limit exceeded |
| 8 | Output conflict or unsafe filename |
| 9 | Partial share success |
