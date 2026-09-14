/**
 * Public SKUs for fees.html and product pages.
 *
 * After you create each Stripe Payment Link, paste the buy.stripe.com URL
 * into `url`. Until then the page shows "Request this" (proposal form),
 * not a checkout button — so we never send someone to the wrong product.
 *
 * Stripe Dashboard → Payment Links → New:
 *   - Product name: exactly `name` below
 *   - Price: exactly `amount` USD
 *   - Type: `interval` null = one-time; "month" = recurring monthly
 *   - After payment: https://aegisglobalholdings.com/thank-you.html?paid=1
 *   - Quantity: locked unless `quantityAdjustable` is true (seat count)
 *
 * Also paste consulting URLs into workers/aegis-form-worker/wrangler.jsonc
 * so AI-scan emails charge the same GEO SKUs. Software SKUs are website
 * checkout only — do not add them to the scan-email catalog.
 *
 * Do not reuse the old mismatched consulting links (retainers named alike,
 * "Website Mitigation - Deposit", All-in-one Care Plan as a silent fallback).
 * Create NEW links for the software names below even if older Practice
 * Launch / Professional subscription links still exist in the dashboard.
 */
window.AEGIS_STRIPE_SKUS = {
  website: {
    id: "website",
    name: "Website Migration & Redesign",
    amount: 3000,
    display: "$3,000",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/eVq14pb4o5V14Nl7qKffy0b"
  },
  fedramp: {
    id: "fedramp",
    name: "FedRAMP 20x Readiness Kickoff",
    amount: 3000,
    display: "$3,000",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/14A3cxa0k8397Zx6mGffy0c"
  },
  content: {
    id: "content",
    name: "Content & Schema Rewrite",
    amount: 1500,
    display: "$1,500",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/9B6cN71tO3MT3Jh8uOffy0d"
  },
  audit: {
    id: "audit",
    name: "AI Visibility Audit & Strategy",
    amount: 500,
    display: "$500",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/eVq00la0k3MTgw3fXgffy0e"
  },
  schema: {
    id: "schema",
    name: "Structured Data Implementation",
    amount: 500,
    display: "$500",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/9B6fZja0kcjpa7FaCWffy0f"
  },
  gbp: {
    id: "gbp",
    name: "Google Business Profile Optimization",
    amount: 300,
    display: "$300",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/aFadRb0pK3MT1B97qKffy0g"
  },
  citations: {
    id: "citations",
    name: "Local Citation Building",
    amount: 200,
    display: "$200",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/3cI6oJa0k3MTgw3cL4ffy0h"
  },
  aegispay: {
    id: "aegispay",
    name: "AegisPay Launch Pack",
    amount: 1500,
    display: "$1,500",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/eVq00l6O83MT1B926qffy0i"
  },
  inventor: {
    id: "inventor",
    name: "InventorOS Intake Pack",
    amount: 249,
    display: "$249",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/14A4gB3BW5V1cfNfXgffy0j"
  },
  lexflowSolo: {
    id: "lexflowSolo",
    name: "LexFlow Solo",
    amount: 39,
    display: "$39 / mo",
    interval: "month",
    quantityAdjustable: false,
    url: "https://buy.stripe.com/dRm00l6O83MT1B99ySffy0m"
  },
  lexflowProfessional: {
    id: "lexflowProfessional",
    name: "LexFlow Professional",
    amount: 99,
    display: "$99 / mo",
    interval: "month",
    quantityAdjustable: false,
    url: "https://buy.stripe.com/5kQ4gB8Wg4QX3Jh6mGffy0n"
  },
  lexflowUnlimited: {
    id: "lexflowUnlimited",
    name: "LexFlow Unlimited",
    amount: 179,
    display: "$179 / mo",
    interval: "month",
    quantityAdjustable: false,
    url: "https://buy.stripe.com/28E6oJa0k0AH0x526qffy0o"
  },
  lexflowFirm: {
    id: "lexflowFirm",
    name: "LexFlow Firm",
    amount: 199,
    display: "$199 / seat / mo",
    interval: "month",
    quantityAdjustable: true,
    url: "https://buy.stripe.com/3cIaEZdcw1ELenV8uOffy0p"
  },
  lexflowTopup: {
    id: "lexflowTopup",
    name: "LexFlow Top-Up 200",
    amount: 15,
    display: "$15",
    interval: null,
    quantityAdjustable: false,
    url: "https://buy.stripe.com/4gMfZj0pK0AH1B93auffy0q"
  }
};

window.aegisMountStripeCtas = function (root) {
  var skus = window.AEGIS_STRIPE_SKUS || {};
  (root || document).querySelectorAll("[data-sku]").forEach(function (card) {
    var sku = skus[card.getAttribute("data-sku")];
    var slot = card.querySelector(".sku-cta");
    if (!sku || !slot || slot.querySelector("a")) return;
    var pay = sku.url && /^https:\/\/buy\.stripe\.com\//.test(sku.url);
    var a = document.createElement("a");
    a.className = pay ? "btn btn-teal" : "btn btn-outline";
    if (pay) {
      a.href = sku.url;
      a.textContent = sku.interval ? "Subscribe — " + sku.display : "Pay " + sku.display;
      a.rel = "noopener";
    } else {
      a.href = "index.html?sku=" + encodeURIComponent(card.getAttribute("data-sku")) + "#contact";
      a.textContent = "Request this — " + sku.display;
    }
    slot.appendChild(a);
  });
};
