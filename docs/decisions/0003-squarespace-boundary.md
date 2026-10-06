# 0003 Squarespace boundary
Status: accepted (2026-10-06)

Squarespace stays the card processor. Verified: its Commerce APIs read/import orders, read transactions (read-only; brand
enum, no last4), manage contacts and send order webhooks (webhooks need OAuth; API keys need Commerce Advanced). They cannot
charge, refund, create payment links/invoices, expose saved cards or manage Member Areas billing.
Therefore Oasis owns invoices and an append-only ledger, and syncs from Squarespace by polling (webhooks optional). Card
payments recorded by staff count as Paid immediately and carry `processor_state=awaiting_processor` until the Transactions feed
or staff confirm. Refunds follow Oasis limits/approvals, then are completed in Squarespace. Memberships = Squarespace
subscription products mapped to tiers. A `PaymentProcessor` seam allows a later Stripe adapter without UI changes.
