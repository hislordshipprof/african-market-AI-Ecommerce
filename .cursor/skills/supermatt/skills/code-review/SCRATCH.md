# Scratch dependency preflight

Before a copied tree runs a reproduction, mutation, or hook, prove its dependencies resolve from that tree. A worktree can inherit packages from an ancestor even when its own `node_modules` exists; copying that local directory alone loses the inherited packages.

For Node or Bun, run `node <this file's directory>/scripts/check-scratch-dependencies.mjs <scratch> <required-package>...`, using the packages imported by the check and its preload. Bun can run the same helper with `bun --no-env-file`. The helper resolves package entry points without executing them and reports their canonical paths. Run it against the source tree to locate a missing package's actual installation, then prepare the scratch dependencies with the repository's supported setup. Keep generated caches private and preserve restrictions on environment files and credentials.

After resolution passes, run the actual runtime's preload or smallest startup check from the scratch tree. Other ecosystems use their equivalent dependency-resolution and startup checks. A failed preflight stops the scratch run before a mutation or push; report it as a setup failure. Keep normal hooks enabled. Retain the dependency paths and successful preflight commands with the verification evidence for the next worker.
