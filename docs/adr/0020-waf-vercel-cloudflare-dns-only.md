# 20. Put the application firewall on Vercel, and leave Cloudflare as DNS only

Date: 2026-11-05 · Status: recommendation only, decision deferred

## Context

The app already runs on Vercel, with Cloudflare in front of DNS and image assets (ADR-0013). A second firewall at Cloudflare would have to proxy the hostname, terminate TLS, and sit in front of Vercel. That fights the hosting decision and is a production change this ticket does not make.

Vercel documents the current firewall limits at [vercel.com/pricing](https://vercel.com/pricing) and [the WAF usage page](https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing) (checked 2026-11-05):

- Custom rules: Hobby 3, Pro 40, Enterprise 250. DDoS mitigation, IP blocking, and custom rules are included. Pro IP blocking is 40 addresses. Pro system bypass rules are 10.
- WAF rate limiting is usage-priced. Pro's published rate-limit line starts at $0.50 per 1 million allowed requests. Managed OWASP rulesets are Enterprise only.
- Production is on Vercel Hobby today. The owner corrected this on 2026-11-05: ADR-0013 assumed Pro, and an upgrade is a later decision. Hobby has 3 custom rules. Pro's 40 apply only after that upgrade.

[Custom rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules) are on every plan. A rule's conditions can be combined with AND or OR. The actions on every plan are log, deny, challenge, bypass, and redirect. Test with log, then change the action. [Persistent actions](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules) (a timed follow-up block) are Pro and Enterprise only. [WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing) is usage-priced, and the published included line is Pro. This recommendation does not use either one.

Cloudflare's proxy is a different bill, and it changes how a market hostname works. [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) (checked 2026-11-05) include 100 custom hostnames on Free, Pro, and Business, then $0.10 each, up to 50,000. WAF for those hostnames is the zone plan's WAF. Enterprise is the plan that adds custom rulesets and advanced bot mitigation, and it is priced by the account team. Turning the proxy on would terminate TLS at Cloudflare, replace the Vercel certificate for each market domain, and stop the market's DNS being a CNAME to Vercel (ADR-0013). That is a second certificate and a per-hostname charge on top of the Hobby plan.

Bot Fight Mode is the free Cloudflare control. The matching control on the host we already pay for is Vercel Bot Protection. Bot Management on Cloudflare is an Enterprise feature. This ticket does not turn either one on.

## Decision

Recommend the Vercel Web Application Firewall, and keep Cloudflare DNS-only for the application hostnames. The owner has not accepted this yet. The choice waits until the owner decides whether to stay on Hobby or upgrade.

No Vercel, DNS, or plan setting is changed by this ticket.

## Owner steps

1. Open the Vercel project, then Firewall. Hobby allows three custom rules. Use two, and leave the third free.
2. Rule 1, first in order: path is `/api/webhooks/stripe` OR `/api/stripe/connect`. Log only. These two move money or open a connected account, and neither has an application rate limit. The path alone also matches every real Stripe delivery and every owner onboarding, so a quiet log is not a reason to Deny. Keep the rule in log mode until an abuse-specific condition (one that real Stripe deliveries and owners never meet) is written into this ADR.
3. Rule 2: path starts with `/api/auth` OR is `/api/invite/accept`. Log, then Challenge. Better Auth's window limits `/api/auth`. Invite accept has no application limit: only sending an invite is counted in `app_rate_limits`. Accept needs a signed-in, two-factor-verified session and a valid invite token, so Challenge is its only rate layer. For `/api/auth` Challenge is the second layer. A real person can pass it. OR is a custom-rule condition on every plan, so these two paths share one of the three Hobby rules.
4. Do not add a WAF rate-limit rule or a persistent block on Hobby. Rate limiting is usage-priced. A persistent block is Pro and Enterprise only.
5. Leave the managed OWASP ruleset off unless the project moves to Enterprise.
6. Do not turn on the Cloudflare proxy for the app hostname. Image and asset hostnames stay as they are in ADR-0013.
7. Do not preload HSTS, and do not enforce the full Content-Security-Policy, until a browser pass confirms Stripe.js and the report-only policy. Those stay owner actions outside this ticket.

## Consequences

- Application rate limits in `app_rate_limits` stay the source of truth for search, chat, sending invites, and payment setup. The Vercel rules are a second layer, not a replacement.
- A Cloudflare proxy added later would have to be re-decided, because it would hide the visitor address Vercel writes into `x-forwarded-for`.
