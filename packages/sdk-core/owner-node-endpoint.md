# Transcript bootstrap owner-node endpoint v1

`TranscriptShareBootstrap.ownerNode` is an additive, exact-key object:

```json
{
  "schema": "xyz.tinycloud.exchange/owner-node-endpoint/v1",
  "endpoint": "https://node.example",
  "spaceId": "tinycloud:pkh:eip155:1:0x…:applications"
}
```

The endpoint is an **untrusted routing hint**, never authority. Authority comes
only from validation of the signed delegation and holder-signed invocation.
Only HTTPS is supported. URL credentials and fragments are forbidden. The
requester resolves and pins public IP addresses before egress and rejects all
loopback, private, carrier-grade NAT, link-local, multicast, and reserved IPv4
or IPv6 destinations. The transport must report the final URL and connected IP
for every owner-node response; redirects, endpoint changes, missing metadata,
and DNS rebinding fail closed.

The bootstrap and `ownerNode` objects retain exact-key quarantine: unknown keys
are rejected rather than ignored.
