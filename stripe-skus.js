/**
 * Public consulting SKUs for fees.html.
 *
 * After you create each Stripe Payment Link, paste the buy.stripe.com URL
 * into `url`. Until then the page shows "Request this" (proposal form),
 * not a checkout button — so we never send someone to the wrong product.
 *
 * Stripe Dashboard → Payment Links → New:
 *   - Product name: exactly `name` below
 *   - Price: exactly `amount` USD, one-time (not subscription)
 *   - After payment: https://aegisglobalholdings.com/thank-you.html?paid=1
 *   - Quantity: customers cannot adjust
 *
 * Also paste the same URLs into workers/aegis-form-worker/wrangler.jsonc
 * so AI-scan emails charge the same SKUs.
 *
 * Do not reuse the old mismatched links (retainers named alike, "Website
 * Mitigation - Deposit", All-in-one Care Plan as a silent fallback).
 */
window.AEGIS_STRIPE_SKUS = {
  website: {
    id: "website",
    name: "Website Migration & Redesign",
    amount: 3000,
    display: "$3,000",
    url: ""
  },
  fedramp: {
    id: "fedramp",
    name: "FedRAMP 20x Readiness Kickoff",
    amount: 3000,
    display: "$3,000",
    url: ""
  },
  content: {
    id: "content",
    name: "Content & Schema Rewrite",
    amount: 1500,
    display: "$1,500",
    url: ""
  },
  audit: {
    id: "audit",
    name: "AI Visibility Audit & Strategy",
    amount: 500,
    display: "$500",
    url: ""
  },
  schema: {
    id: "schema",
    name: "Structured Data Implementation",
    amount: 500,
    display: "$500",
    url: ""
  },
  gbp: {
    id: "gbp",
    name: "Google Business Profile Optimization",
    amount: 300,
    display: "$300",
    url: ""
  },
  citations: {
    id: "citations",
    name: "Local Citation Building",
    amount: 200,
    display: "$200",
    url: ""
  }
};
