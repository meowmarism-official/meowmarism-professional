# meowmarism PROFESSIONAL

Minecraft servers in Docker containers with hard CPU and memory limits, managed from one panel. Under development, not released yet.

- One container per instance (image `itzg/minecraft-server`, Java version chosen per Minecraft version)
- Hard CPU and memory limits through Docker (cgroups), changeable per instance
- Vanilla, Paper, Purpur, Fabric, NeoForge and Forge
- Live console, commands, start, stop, restart, kill

It shares the design (tokens and brand) with meowmarism LITE through meowmarism core. The panel code is separate.

## Install

Linux with systemd and sudo. The installer installs Node.js and Docker if they are missing.

```
curl -fsSL https://raw.githubusercontent.com/meowmarism-official/meowmarism-professional/master/install.sh | bash
```

Run it again later to update, reset the owner or remove meowmarism (press M for more options).

Licensed under the Meowmarism License 1.0, see [LICENSE](LICENSE). Use of the name and logo follows the [Brand Policy](BRAND-POLICY.md).
