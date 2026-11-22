---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": patch
"@tinycloud/web-sdk": patch
---

An app that signs in without a manifest gets a folder named by its domain and port: `notes.example.com:8443` gets `applications/com.example.notes_8443/`, and ports 80 and 443 add nothing. A host that isn't a domain name, such as an IPv6 address, gets a folder of its own named `o_` and 16 hex characters. Apps with no domain share one folder and log, once, how to get their own.

An app that used 3.14.0-beta.5 on another port with no manifest gets a new folder: data it saved in that beta is in the folder without the port, such as `applications/com.example.notes/`.

Details: TC-3443
