# 3. Storefronts carry the store's brand, with a "Powered by" footer

Date: 2026-10-30 · Status: accepted

## Context
Store owners want to own their customers. Marketplace branding ("X on Uber Eats") is what they are trying to get away from. The platform name is not chosen yet.

## Decision
A store's storefront shows **only that store's brand** (name, logo, colors, domain). The platform appears only as a small "Powered by …" line in the footer and in transactional email footers.

## Consequences
- Every customer-facing surface (storefront, emails, SMS sender name, tracking page) is themed per store.
- Choosing the platform name blocks no build work. The footer text is configuration.
- The Phase 2 combined marketplace is the one surface where the platform brand leads.
