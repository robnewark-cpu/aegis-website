/**
 * aegis-stripe-webhook — post-purchase fulfillment for AegisOS software SKUs
 *
 * Flow
 * ────
 * 1.  Stripe POSTs to /stripe on checkout.session.completed
 * 2.  Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET
 * 3.  Return HTTP 200 immediately (Stripe expects a fast ack)
 * 4.  Background (ctx.waitUntil):
 *       a. Look up the Checkout Session's line items (Stripe API, expand)
 *       b. Match the purchased product name against FULFILLMENT_CATALOG
 *       c. E-mail the buyer their next-step instructions
 *       d. E-mail Robert a "new sale" notice
 *
 * Required secrets  (wrangler secret put <NAME> --name aegis-stripe-webhook)
 *   STRIPE_SECRET_KEY    — Stripe secret key (sk_live_… or a restricted key
 *                          with read access to Checkout Sessions)
 *   STRIPE_WEBHOOK_SECRET — the signing secret (whsec_…) Stripe shows when
 *                          you create the webhook endpoint
 *   RESEND_API_KEY       — same Resend key used by aegis-form-worker
 *
 * This worker only handles fulfillment e-mails. It does not provision
 * AegisOS tenants — that is a manual step today (see the buyer e-mail,
 * which tells them to book a demo / reply to be onboarded).
 */

const STRIPE_API = "https://api.stripe.com/v1";
const RESEND_API = "https://api.resend.com/emails";

// Matched against the Checkout Session line item's product name. Add a new
// entry here (and create the matching Stripe Payment Link + stripe-skus.js
// entry) whenever a new self-serve software SKU goes live.
const FULFILLMENT_CATALOG = {
  "AegisPay Launch Pack": {
    price: "$1,500",
    nextSteps: [
      "We'll stand up AegisPay on a new AegisOS tenant for your firm.",
      "Reply to this e-mail with your firm name and the payment methods you want confirmed (invoicing, online payments, trust accounting), and we'll schedule the working session to configure them.",
    ],
  },
  "InventorOS Intake Pack": {
    price: "$249",
    nextSteps: [
      "We'll set up your InventorOS intake project on AegisOS.",
      "Reply to this e-mail with the name of the invention/project and who should have access, and we'll send your intake link.",
    ],
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.RESEND_API_KEY),
        stripeSecretConfigured: Boolean(env.STRIPE_SECRET_KEY),
        webhookSecretConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
        resendConfigured: Boolean(env.RESEND_API_KEY),
      });
    }

    if (request.method !== "POST" || url.pathname !== "/stripe") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (!env.STRIPE_WEBHOOK_SECRET) {
      console.error("[aegis-stripe-webhook] STRIPE_WEBHOOK_SECRET is not set");
      return jsonResponse({ error: "Server misconfiguration" }, 500);
    }

    const signatureHeader = request.headers.get("Stripe-Signature") || "";
    const rawBody = await request.text();

    const verified = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!verified) {
      console.error("[aegis-stripe-webhook] Signature verification failed");
      return jsonResponse({ error: "Invalid signature" }, 400);
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    if (event.type === "checkout.session.completed") {
      ctx.waitUntil(handleCheckoutCompleted(env, event.data.object));
    }

    // Ack fast — Stripe retries on non-2xx and on timeout.
    return jsonResponse({ received: true }, 200);
  },
};

// ── Signature verification ────────────────────────────────────────────────

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject events older than 5 minutes to limit replay risk.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Fulfillment ────────────────────────────────────────────────────────────

async function handleCheckoutCompleted(env, session) {
  const buyerEmail = session.customer_details?.email;
  const buyerName = session.customer_details?.name || "there";

  let lineItems;
  try {
    lineItems = await fetchLineItems(env, session.id);
  } catch (err) {
    console.error("[aegis-stripe-webhook] Failed to fetch line items:", err.message);
    await notifyRobert(env, {
      subject: `New sale — could not fetch product details (session ${session.id})`,
      html: `<p>A payment completed but line items could not be fetched: ${escHtml(err.message)}</p>
             <p>Session: ${escHtml(session.id)} · Amount: ${formatAmount(session.amount_total, session.currency)} · Buyer: ${escHtml(buyerEmail || "unknown")}</p>`,
    });
    return;
  }

  const productName = lineItems?.[0]?.description || "Unknown product";
  const entry = FULFILLMENT_CATALOG[productName];

  if (!buyerEmail) {
    console.error(`[aegis-stripe-webhook] No buyer email on session ${session.id}`);
  } else if (env.RESEND_API_KEY) {
    await sendBuyerEmail(env, { buyerEmail, buyerName, productName, entry });
  }

  await notifyRobert(env, {
    subject: `New sale — ${productName} (${formatAmount(session.amount_total, session.currency)})`,
    html: `
      <h2 style="font-family:sans-serif;color:#0E141B">New Stripe Sale</h2>
      <table style="font-family:sans-serif;font-size:15px;border-collapse:collapse" cellpadding="8">
        <tr><td><strong>Product</strong></td><td>${escHtml(productName)}</td></tr>
        <tr><td><strong>Amount</strong></td><td>${formatAmount(session.amount_total, session.currency)}</td></tr>
        <tr><td><strong>Buyer</strong></td><td>${escHtml(buyerName)} &lt;${escHtml(buyerEmail || "no email")}&gt;</td></tr>
        <tr><td><strong>Session</strong></td><td>${escHtml(session.id)}</td></tr>
      </table>
      ${entry ? "" : `<p style="color:#c0392b">No fulfillment entry matched "${escHtml(productName)}" — the buyer was NOT sent an automated onboarding e-mail. Follow up manually.</p>`}`,
  });
}

async function fetchLineItems(env, sessionId) {
  const res = await fetch(`${STRIPE_API}/checkout/sessions/${sessionId}/line_items`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stripe ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.data;
}

async function sendBuyerEmail(env, { buyerEmail, buyerName, productName, entry }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const replyTo = env.TO_EMAIL || "info@aegisglobalholdings.com";
  const steps = entry?.nextSteps || [
    "We received your payment and will follow up shortly with next steps.",
  ];

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [buyerEmail],
    reply_to: replyTo,
    subject: `Thanks for your purchase — ${productName}`,
    html: `
      <p style="font-family:sans-serif;font-size:15px">Hi ${escHtml(buyerName.split(" ")[0])},</p>
      <p style="font-family:sans-serif;font-size:15px">Thanks for purchasing <strong>${escHtml(productName)}</strong>${entry ? ` (${escHtml(entry.price)})` : ""}.</p>
      <ul style="font-family:sans-serif;font-size:15px">${steps.map((s) => `<li>${escHtml(s)}</li>`).join("")}</ul>
      <p style="font-family:sans-serif;font-size:14px;color:#666">Questions? Reply to this e-mail — you'll reach Robert directly.<br>Aegis Global Holdings · Edmond, OK · Veteran-Owned</p>`,
    text: [
      `Hi ${buyerName.split(" ")[0]},`,
      "",
      `Thanks for purchasing ${productName}${entry ? ` (${entry.price})` : ""}.`,
      "",
      ...steps.map((s) => `- ${s}`),
      "",
      "Questions? Reply to this e-mail to reach Robert directly.",
      "Aegis Global Holdings · Edmond, OK",
    ].join("\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-stripe-webhook] Buyer e-mail failed ${res.status}:`, body);
  }
}

async function notifyRobert(env, { subject, html }) {
  if (!env.RESEND_API_KEY) {
    console.error("[aegis-stripe-webhook] RESEND_API_KEY not set — cannot notify Robert:", subject);
    return;
  }
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  const res = await sendViaResend(env.RESEND_API_KEY, { from, to: [to], subject, html });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-stripe-webhook] Robert notification failed ${res.status}:`, body);
  }
}

function sendViaResend(apiKey, payload) {
  return fetch(RESEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatAmount(amountInCents, currency) {
  if (typeof amountInCents !== "number") return "unknown amount";
  return `$${(amountInCents / 100).toFixed(2)} ${(currency || "usd").toUpperCase()}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
