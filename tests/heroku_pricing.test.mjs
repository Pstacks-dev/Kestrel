import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEROKU_DYNO_PLANS,
  HEROKU_PRICING_CATALOG_VERSION,
  estimateHerokuDynoCost,
  validateHerokuCostApproval,
} from '../server/lib/heroku-pricing.mjs';

test('estimates published 24/7 Heroku Common Runtime monthly maximums', () => {
  assert.equal(estimateHerokuDynoCost('basic', 1).monthlyCostUsd, 7);
  assert.equal(estimateHerokuDynoCost('standard-1x', 2).monthlyCostUsd, 50);
  assert.equal(estimateHerokuDynoCost('performance-m', 3).monthlyCostUsd, 750);
  assert.equal(estimateHerokuDynoCost('performance-2xl', 1).monthlyCostUsd, 1500);
  assert.equal(HEROKU_DYNO_PLANS['performance-l-ram'].monthlyUsd, 500);
});

test('rejects unknown plans and unsafe dyno quantities', () => {
  assert.throws(() => estimateHerokuDynoCost('eco', 1), /supported Heroku/);
  assert.throws(() => estimateHerokuDynoCost('basic', 0), /between 1 and 10/);
  assert.throws(() => estimateHerokuDynoCost('basic', 11), /between 1 and 10/);
  assert.throws(() => estimateHerokuDynoCost('basic', 2), /Basic supports only one web dyno/);
  assert.throws(() => estimateHerokuDynoCost('basic', 1.5), /between 1 and 10/);
});

test('requires explicit approval by a workspace owner or admin', () => {
  const approval = {
    approved: true, dynoSize: 'basic', dynoQuantity: 1,
    monthlyCostUsd: 7, pricingCatalogVersion: HEROKU_PRICING_CATALOG_VERSION,
  };
  assert.deepEqual(validateHerokuCostApproval(approval, 'owner'), {
    dynoSize: 'basic', dynoQuantity: 1, monthlyCostUsd: 7,
    unitMonthlyCostUsd: 7, planLabel: 'Basic',
    pricingCatalogVersion: HEROKU_PRICING_CATALOG_VERSION,
  });
  assert.throws(() => validateHerokuCostApproval(approval, 'developer'), /Only workspace owners or admins/);
  assert.throws(() => validateHerokuCostApproval({ ...approval, approved: false }, 'admin'), /Explicit workspace-admin approval/);
});

test('rejects stale or client-tampered cost estimates', () => {
  const approval = {
    approved: true, dynoSize: 'standard-1x', dynoQuantity: 2,
    monthlyCostUsd: 25, pricingCatalogVersion: HEROKU_PRICING_CATALOG_VERSION,
  };
  assert.throws(() => validateHerokuCostApproval(approval, 'admin'), /does not match/);
  assert.throws(() => validateHerokuCostApproval({
    ...approval, monthlyCostUsd: 50, pricingCatalogVersion: 'stale',
  }, 'admin'), /outdated/);
});
