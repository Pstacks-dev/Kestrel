// Heroku Common Runtime pricing catalog. Values are the published maximum monthly
// charges for a dyno running 24/7, sourced from Heroku Usage & Billing (updated
// 2026-09-09). Actual usage is prorated; add-ons, taxes and account-level plans
// are not included. Refresh this catalog when Heroku publishes a pricing change.
export const HEROKU_PRICING_CATALOG_VERSION = '2026-09-09';

export const HEROKU_DYNO_PLANS = Object.freeze({
  basic: Object.freeze({ label: 'Basic', monthlyUsd: 7 }),
  'standard-1x': Object.freeze({ label: 'Standard-1X', monthlyUsd: 25 }),
  'standard-2x': Object.freeze({ label: 'Standard-2X', monthlyUsd: 50 }),
  'performance-m': Object.freeze({ label: 'Performance-M', monthlyUsd: 250 }),
  'performance-l': Object.freeze({ label: 'Performance-L', monthlyUsd: 500 }),
  'performance-l-ram': Object.freeze({ label: 'Performance-L-RAM', monthlyUsd: 500 }),
  'performance-xl': Object.freeze({ label: 'Performance-XL', monthlyUsd: 750 }),
  'performance-2xl': Object.freeze({ label: 'Performance-2XL', monthlyUsd: 1500 }),
});

export function estimateHerokuDynoCost(dynoSize, quantity) {
  const plan = HEROKU_DYNO_PLANS[String(dynoSize || '').toLowerCase()];
  const count = Number(quantity);
  if (!plan) throw Object.assign(new Error('Select a supported Heroku Common Runtime dyno plan'), { status: 422 });
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw Object.assign(new Error('Heroku web dyno quantity must be between 1 and 10'), { status: 422 });
  }
  return {
    dynoSize: String(dynoSize).toLowerCase(),
    dynoQuantity: count,
    monthlyCostUsd: Number((plan.monthlyUsd * count).toFixed(2)),
    unitMonthlyCostUsd: plan.monthlyUsd,
    planLabel: plan.label,
    pricingCatalogVersion: HEROKU_PRICING_CATALOG_VERSION,
  };
}

export function validateHerokuCostApproval(approval, workspaceRole) {
  if (!['owner', 'admin'].includes(workspaceRole)) {
    throw Object.assign(new Error('Only workspace owners or admins can approve Heroku recurring costs'), { status: 403 });
  }
  if (!approval || approval.approved !== true) {
    throw Object.assign(new Error('Explicit workspace-admin approval is required before creating a Heroku app'), { status: 422 });
  }
  const estimate = estimateHerokuDynoCost(approval.dynoSize, approval.dynoQuantity);
  if (approval.pricingCatalogVersion !== HEROKU_PRICING_CATALOG_VERSION ||
      Number(approval.monthlyCostUsd) !== estimate.monthlyCostUsd) {
    throw Object.assign(new Error('Heroku cost estimate is outdated or does not match the selected dyno plan and quantity. Refresh the estimate and approve again.'), { status: 409 });
  }
  return estimate;
}
