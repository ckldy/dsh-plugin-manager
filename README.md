# DSH Plugin Manager Local

A profile-scoped plugin marketplace and lifecycle manager for DeepSeek Harness.

Features:

- GitHub `dsh-plugin` discovery, search, descriptions, stars, and caching
- GitHub/npm URL resolution and batch installation
- Installed plugin inventory and one-click uninstall planning
- Custom HTTPS JSON and GitHub Topic sources
- Duplicate plugin, dependency reuse, version conflict, capability overlap, lifecycle-script, and native-dependency analysis
- Per-profile mutation locks, snapshots, baseline hashes, rollback, bundle reconciliation, and offline `--dump-config` health validation

The browser UI is contributed to `Settings -> Plugins -> Plugin Center`. Mutations affect only the selected DSH profile and take effect after that profile restarts.
