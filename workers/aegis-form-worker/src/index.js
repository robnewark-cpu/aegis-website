/**
 * aegis-form-worker
 *
 * Receives the AI-visibility-check form submission (JSON POST), forwards it to
 * Resend, and returns a plain JSON response to the browser.
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   RESEND_API_KEY  – Resend API key (starts with "re_")
 *
 * Optional vars (set in wrangler.toml [vars] or as secrets):
 *   FROM_EMAIL – verified sender address, e.g. "noreply@aegisglobalholdings.com"
 *   TO_EMAIL   – destination inbox, e.g. "info@aegisglobalholdings.com"
 */

const RESEND_API = "https://api.resend.com/emails";

// Allowed origins for CORS. Add your production domain here.
const ALLOWED_ORIGINS = new Set([
  "https://aegisglobalholdings.com",
  "https://www.aegisglobalholdings.com",
  // Allow any *.pages.dev preview deployment
]);

function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.has(origin) || (origin && origin.endsWith(".pages.dev"))
      ? origin
      : "https://aegisglobalholdings.com";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // ── CORS preflight ────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    const { name, phone, email, url } = data;

    if (!name || !email) {
      return jsonResponse({ error: "name and email are required" }, 400, origin);
    }

    // ── Guard: API key must be present ────────────────────────────────────────
    if (!env.RESEND_API_KEY) {
      console.error("[aegis-form-worker] RESEND_API_KEY secret is not set.");
      return jsonResponse({ error: "Server misconfiguration" }, 500, origin);
    }

    // ── Resolve addresses ─────────────────────────────────────────────────────
    // FROM_EMAIL must be an address on a Resend-verified domain.
    // During Resend onboarding (before domain verification) you can use:
    //   onboarding@resend.dev  — but only sends to your own Resend-account email.
    const fromEmail = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
    const toEmail = env.TO_EMAIL || "info@aegisglobalholdings.com";

    // ── Build email ───────────────────────────────────────────────────────────
    const htmlBody = `
      <h2 style="font-family:sans-serif;color:#0E141B">New AI Visibility Check Request</h2>
      <table style="font-family:sans-serif;font-size:15px;border-collapse:collapse" cellpadding="8">
        <tr><td><strong>Name</strong></td><td>${escHtml(name)}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${escHtml(phone || "—")}</td></tr>
        <tr><td><strong>Email</strong></td><td>${escHtml(email)}</td></tr>
        <tr><td><strong>Website</strong></td><td>${escHtml(url || "—")}</td></tr>
      </table>
      <p style="font-family:sans-serif;font-size:13px;color:#5C7288;margin-top:24px">
        Submitted via ai-visibility-check.html
      </p>
    `;

    const textBody = [
      "New AI Visibility Check Request",
      `Name:    ${name}`,
      `Phone:   ${phone || "—"}`,
      `Email:   ${email}`,
      `Website: ${url || "—"}`,
    ].join("\n");

    // ── Send via Resend ───────────────────────────────────────────────────────
    let resendRes;
    try {
      resendRes = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [toEmail],
          reply_to: email,
          subject: `AI Visibility Check — ${name}`,
          html: htmlBody,
          text: textBody,
        }),
      });
    } catch (networkErr) {
      console.error("[aegis-form-worker] Network error reaching Resend:", networkErr);
      return jsonResponse({ error: "Could not reach email service" }, 502, origin);
    }

    // ── Handle Resend errors ──────────────────────────────────────────────────
    if (!resendRes.ok) {
      let resendBody = "";
      try {
        resendBody = await resendRes.text();
      } catch {}

      console.error(
        `[aegis-form-worker] Resend returned ${resendRes.status}:`,
        resendBody
      );

      // Surface a specific message for the two most common misconfigurations
      // so they appear in Worker logs and are easy to diagnose.
      if (resendRes.status === 401) {
        console.error(
          "[aegis-form-worker] 401 Unauthorized — RESEND_API_KEY is invalid or revoked."
        );
        return jsonResponse({ error: "Email service authentication failed" }, 502, origin);
      }

      if (resendRes.status === 422) {
        console.error(
          "[aegis-form-worker] 422 Unprocessable — FROM_EMAIL domain is not verified in Resend. " +
            "See: https://resend.com/domains"
        );
        return jsonResponse({ error: "Email service configuration error" }, 502, origin);
      }

      return jsonResponse({ error: "Email service error" }, 502, origin);
    }

    return jsonResponse({ success: true }, 200, origin);
  },
};

// Minimal HTML-escape to prevent header-injection / XSS in the email body.
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
