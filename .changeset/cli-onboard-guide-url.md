---
"@tinycloud/cli": patch
---

After a finished `onboard`, the CLI prints one line on stderr saying where the guide for agents is, `The TinyCloud CLI guide for agents is at https://agents.tinycloud.xyz/skills/cli.md.`, while no guide is saved on this computer. It replaces the `skill save` offer in that case and is not printed with `--quiet`; an older saved guide still gets the `skill save` offer, and a current one gets no line.

Details: TC-3366
