# Heroku managed deployment cost approval

Kestrel keeps Heroku out of automatic provider selection. A workspace owner or
admin must deliberately select Heroku and approve a specific web dyno plan,
quantity, and estimated recurring monthly cost before Kestrel creates or
redeploys a Heroku app.

## Pricing model

Kestrel's Common Runtime catalog is versioned independently from deployments.
It uses Heroku's published maximum monthly charge for one dyno running 24/7:

| Dyno plan | Maximum monthly cost per dyno |
| --- | ---: |
| Basic | $7 |
| Standard-1X | $25 |
| Standard-2X | $50 |
| Performance-M | $250 |
| Performance-L | $500 |
| Performance-L-RAM | $500 |
| Performance-XL | $750 |
| Performance-2XL | $1,500 |

Kestrel limits a web formation to 1–10 dynos. Eco is intentionally not offered:
its $5 subscription covers a shared account-level pool of 1,000 dyno hours, so
it cannot be represented as a reliable per-app monthly estimate. Private,
Shield, and Fir dynos are not offered by this Common Runtime integration.

The displayed estimate is the maximum for continuous 24/7 use. Heroku prorates
actual dyno usage. Add-ons, data services, taxes, and other account charges are
not included. The workspace must review those separately.

Official pricing references:
- https://devcenter.heroku.com/articles/usage-and-billing
- https://devcenter.heroku.com/articles/platform-api-reference

## Approval and deployment

1. Connect and verify the workspace's Heroku API key.
2. Select Heroku explicitly in the managed deployment panel; automatic provider
   selection never chooses Heroku.
3. Choose a supported dyno plan and quantity. Kestrel displays the estimated
   monthly maximum from the current pricing catalog.
4. A workspace owner or admin checks the explicit approval control and submits
   the deployment. Developers cannot approve recurring Heroku charges.
5. The API recalculates the estimate from its server-side catalog and rejects
   stale catalog versions, changed amounts, unsupported plans, or quantities
   outside 1–10.
6. Kestrel records the plan, quantity, estimated monthly cost, catalog version,
   approving user, and approval time on the deployment row and in the audit
   event. The database constraint prevents incomplete Heroku approval records.
7. After Heroku reports a successful build, the readiness worker applies the
   approved formation through the Heroku Platform API and verifies that the
   live app has the approved dyno size and quantity before marking it healthy.

Apply migration \`039_heroku_cost_approval.sql\` before enabling this flow.

## Pricing maintenance

The server catalog lives in \`server/lib/heroku-pricing.mjs\`. When Heroku changes
its published prices, update the catalog values and
\`HEROKU_PRICING_CATALOG_VERSION\` together, update the tests, and deploy the new
server version. The API rejects approvals from older catalog versions so a user
must review and approve the current estimate again.
