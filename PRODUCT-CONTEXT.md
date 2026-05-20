# Slipstream — Product Context

> Canonical cross-product map: `komatik-agents/PRODUCT-MAP.md`.

**Internal Komatik use:** Unify model context/memory issues; resolve per-session context problems.

**External product (what we sell):** Context/memory unification for the **user's** sessions.

## Rule
This repo ships a **platform-agnostic** product for an end user. Komatik-specific
functionality (Komatik's Supabase project `sdmfolczsaqiyararqwh`, its RPCs, service-role
keys, prebuild hooks, repo lists) is **internal dogfood only** — gate it behind an instance
flag (e.g. `KOMATIK_INSTANCE`) or parameterize it per-user; never let it leak into shippable
paths. **"Works for Komatik" = validation, not the deliverable.** Komatik the platform is the
IP centerpiece; these products are spokes that ship for general use.
