// The four plans exactly as the Operations design shows them (cc-domain 1.7): badge colours (memberMeta), card tint
// (planTint) and the marketing perks, verbatim. Percent-discount basis points are DISPLAY data (review B12: 1000 / 1500 /
// 2000 / 2500), never applied automatically; the credit rules are the only thing a visit can redeem (tags are the
// services.tags vocabulary: express, premium, executive, handwash).
//
// ADR 0170: the plans are editable tiers. The design's Premium and Executive are the tiers the website sells, Gold and VIP (keys
// gold and vip; the old keys stay as legacyKey so old Squarespace product names and links resolve); Essential and Exotic are not
// sold online. A rule becomes an inclusion: ensurePlans resolves its tags to the services that carry them when it creates it.
import type { PlanKey } from './schema.js'

export interface DesignCreditRule {
  label: string
  includeTags: string[]
  excludeTags?: string[]
  /** null = unlimited */
  perCycle: number | null
}

export interface DesignPlan {
  key: PlanKey
  /** The key before ADR 0170 (premium, executive). */
  legacyKey: string | null
  name: string
  /** Sold on the website and by the assistant. */
  public: boolean
  /** Members get the VIP slot rules. */
  vipBooking: boolean
  color: string
  bgColor: string
  tint: string
  perks: string[]
  addonDiscountBp: number
  serviceDiscountBp: number
  rules: DesignCreditRule[]
}

export const DESIGN_PLANS: readonly DesignPlan[] = [
  {
    key: 'essential',
    legacyKey: null,
    name: 'Essential',
    public: false,
    vipBooking: false,
    color: '#7A8B73',
    bgColor: '#E9EDE4',
    tint: '#5E7A52',
    perks: ['2 express washes / month', 'Priority booking', '10% off add-ons', 'Free vacuum anytime'],
    addonDiscountBp: 1000,
    serviceDiscountBp: 0,
    rules: [{ label: 'Express wash', includeTags: ['express'], perCycle: 2 }],
  },
  {
    key: 'gold',
    legacyKey: 'premium',
    name: 'Gold',
    public: true,
    vipBooking: false,
    color: '#8A6D3B',
    bgColor: '#F2E9D6',
    tint: '#8A6D3B',
    perks: [
      '2 premium washes / month',
      'Skip-the-line priority',
      '15% off all add-ons',
      'Monthly interior refresh',
      'Free rain repellent',
    ],
    addonDiscountBp: 1500,
    serviceDiscountBp: 0,
    rules: [{ label: 'Premium wash', includeTags: ['premium'], perCycle: 2 }],
  },
  {
    key: 'vip',
    legacyKey: 'executive',
    name: 'VIP',
    public: true,
    vipBooking: true,
    color: '#3B5A8A',
    bgColor: '#E0E8F4',
    tint: '#3B5A8A',
    perks: [
      'Unlimited express washes',
      '2 executive details / month',
      '20% off add-ons',
      'Dedicated detailer',
      'Loaner coordination',
    ],
    addonDiscountBp: 2000,
    serviceDiscountBp: 0,
    rules: [
      { label: 'Express wash', includeTags: ['express'], perCycle: null },
      { label: 'Executive detail', includeTags: ['executive'], perCycle: 2 },
    ],
  },
  {
    key: 'exotic',
    legacyKey: null,
    name: 'Exotic',
    public: false,
    vipBooking: false,
    color: '#7A3B8A',
    bgColor: '#EEDFF2',
    tint: '#7A3B8A',
    perks: [
      'Unlimited hand washes',
      'Concierge pickup & delivery',
      'Paint protection reviews',
      '25% off all services',
      'Private appointment windows',
    ],
    addonDiscountBp: 2500,
    serviceDiscountBp: 2500,
    rules: [{ label: 'Hand wash', includeTags: ['handwash'], perCycle: null }],
  },
]
