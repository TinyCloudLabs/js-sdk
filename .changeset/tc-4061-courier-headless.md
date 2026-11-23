---
"@tinycloud/courier": minor
---

Courier exports a headless API for services that host many owners' agents: `acceptPairing`, `finalizePairing`, `listInbound`, `acknowledgeInbound`, `sendMessage`, `unpair` and `peerReference`. It runs from an explicit owner, agent, Node origin, session and peer store, and never reads a Courier home.

Pairing artifacts gain a signed completion. B carries a random challenge, and C must sign it with the initiator's agent key. Headless pairing refuses initiators that cannot sign; pairing between two CLI agents is unchanged.

`unpair` keeps deleting a peer's mailbox until the Node lists nothing left, and can clear a pairing whose grant never reached the Node. Headless `acceptPairing` refuses a handle while any grant this agent issued over its mailbox is still live.

Details: TC-4061
