import type { SquarespaceEnv } from '../../integrations/squarespace/config.js'
import type { MatcherConfig } from './matcher.js'
import type { MembershipConfig } from './membership.js'
import { ProductMap } from './product-map.js'
import type { SyncConfig } from './sync.js'

/** Maps the validated SQSP_* environment onto the pure modules' configuration objects. */
export function paymentsSyncConfigFromEnv(env: SquarespaceEnv): {
  sync: Partial<SyncConfig>
  matcher: Partial<MatcherConfig>
  membership: Partial<MembershipConfig>
  productMap: ProductMap
} {
  return {
    sync: {
      overlapMs: env.SQSP_OVERLAP_SECONDS * 1000,
      maxRequestsPerRun: env.SQSP_MAX_REQUESTS_PER_RUN,
      reconcileDays: env.SQSP_RECONCILE_DAYS,
      includeTestMode: env.SQSP_INCLUDE_TEST_ORDERS,
    },
    matcher: {
      confidenceThreshold: env.SQSP_MATCH_CONFIDENCE_THRESHOLD,
      varianceAlertCents: env.SQSP_VARIANCE_ALERT_CENTS,
      linkWindowMs: env.SQSP_LINK_WINDOW_DAYS * 86_400_000,
      linkAmountToleranceCents: env.SQSP_LINK_AMOUNT_TOLERANCE_CENTS,
      includeTestMode: env.SQSP_INCLUDE_TEST_ORDERS,
    },
    membership: {
      graceDays: env.SQSP_MEMBERSHIP_GRACE_DAYS,
      includeTestMode: env.SQSP_INCLUDE_TEST_ORDERS,
    },
    productMap: ProductMap.fromJson(env.SQSP_PRODUCT_MAP),
  }
}
