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
    url: ""
  },
  fedramp: {
    id: "fedramp",
    name: "FedRAMP 20x Readiness Kickoff",
    amount: 3000,
    display: "$3,000",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  content: {
    id: "content",
    name: "Content & Schema Rewrite",
    amount: 1500,
    display: "$1,500",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  audit: {
    id: "audit",
    name: "AI Visibility Audit & Strategy",
    amount: 500,
    display: "$500",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  schema: {
    id: "schema",
    name: "Structured Data Implementation",
    amount: 500,
    display: "$500",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  gbp: {
    id: "gbp",
    name: "Google Business Profile Optimization",
    amount: 300,
    display: "$300",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  citations: {
    id: "citations",
    name: "Local Citation Building",
    amount: 200,
    display: "$200",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  aegispay: {
    id: "aegispay",
    name: "AegisPay Launch Pack",
    amount: 1500,
    display: "$1,500",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  inventor: {
    id: "inventor",
    name: "InventorOS Intake Pack",
    amount: 249,
    display: "$249",
    interval: null,
    quantityAdjustable: false,
    url: ""
  },
  practice: {
    id: "practice",
    name: "AegisOS - Practice Launch",
    amount: 99,
    display: "$99 / user / mo",
    interval: "month",
    quantityAdjustable: true,
    url: "https://buy.stripe.com/14AbJ3goIabh2FdcL4ffy09"
  },
  professional: {
    id: "professional",
    name: "AegisOS - Professional",
    amount: 189,
    display: "$189 / user / mo",
    interval: "month",
    quantityAdjustable: true,
    url: "https://buy.stripe.com/eVq9AVdcw5V1frZcL4ffy0a"
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
