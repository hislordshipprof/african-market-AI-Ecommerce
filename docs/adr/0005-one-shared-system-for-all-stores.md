# 5. One shared system for every store

Date: 2026-10-30 · Status: accepted

Each store looks like it has its own platform: its own site, name and domain. Behind the scenes, every store runs on **one shared codebase, deployment and database**, isolated per store (Postgres row-level security keyed on the store). We rejected a separate copy per store: every fix would have to ship store by store, and hosting cost would grow with each store. The trade-off is that isolation bugs are a real risk, so cross-store isolation tests run in CI.
