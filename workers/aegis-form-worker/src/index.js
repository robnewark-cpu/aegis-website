/**
 * aegis-form-worker — AI Visibility Check form handler
 *
 * Flow
 * ────
 * 1.  Validate POST + CORS
 * 2.  Send immediate "new lead" notification e-mail to Robert      (synchronous)
 * 3.  Return HTTP 200 to the browser
 * 4.  Background (ctx.waitUntil):
 *       a. Fetch lead's website, strip HTML, truncate to MAX_SITE_CHARS
 *       b. Call Anthropic claude-sonnet-4-6 → strict JSON report
 *       c. Send Robert's internal copy ("SENT TO CLIENT" banner)
 *       d. Send branded client e-mail with report + pricing + Stripe CTAs
 *
 * Required secrets  (wrangler secret put <NAME> --name aegis-form-worker)
 *   RESEND_API_KEY    — Resend API key  (re_…)
 *   ANTHROPIC_API_KEY — Anthropic API key  (sk-ant-…)
 *
 * Optional vars in wrangler.jsonc [vars]
 *   FROM_EMAIL  — verified Resend sender
 *   TO_EMAIL    — Robert's inbox
 *
 * Optional Stripe payment-link vars (wrangler.jsonc [vars] or secrets)
 *   STRIPE_LINK_AI_AUDIT       — Payment link for "AI Visibility Audit & Strategy"
 *   STRIPE_LINK_CONTENT_SCHEMA — Payment link for "Content & Schema Rewrite"
 *   STRIPE_LINK_GBP            — Payment link for "Google Business Profile Optimization"
 *   STRIPE_LINK_WEBSITE        — Payment link for "Website Migration & Redesign"
 *   STRIPE_LINK_CITATIONS      — Payment link for "Local Citation Building"
 *   STRIPE_LINK_SCHEMA         — Payment link for "Structured Data Implementation"
 *   STRIPE_BOOKING_LINK        — Fallback CTA when per-service links aren't set
 *   STRIPE_ANNUAL_LINK         — CTA for the "Discuss annual rates" section
 *                                 (falls back to STRIPE_BOOKING_LINK if not set)
 *
 * To update prices, discount %, or service descriptions edit the constants
 * below, then run:  npm run deploy
 */

// ── Config ────────────────────────────────────────────────────────────────────

const RESEND_API    = "https://api.resend.com/emails";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL  = "claude-sonnet-4-6";
const MAX_SITE_CHARS = 8_000;

// Discount shown in the "Annual Plans" section of the client e-mail.
// Edit this value and redeploy to change the advertised discount.
const ANNUAL_DISCOUNT_PCT = "15%";

const ALLOWED_ORIGINS = new Set([
  "https://aegisglobalholdings.com",
  "https://www.aegisglobalholdings.com",
]);

/**
 * Service catalog — edit prices, taglines, and Stripe env-var keys here.
 * stripeEnvKey maps to an env var you set in wrangler.jsonc [vars] or as a secret.
 * If the env var is not set the button falls back to STRIPE_BOOKING_LINK,
 * and if that is also absent it falls back to a mailto: contact link.
 */
const SERVICE_CATALOG = {
  "AI Visibility Audit & Strategy": {
    price:       "$500",
    tagline:     "Comprehensive AI search audit + 90-day roadmap delivered in 5 business days.",
    stripeEnvKey: "STRIPE_LINK_AI_AUDIT",
  },
  "Content & Schema Rewrite": {
    price:       "$1,500",
    tagline:     "Full site copy rewrite with schema markup — done-for-you, AI-optimized.",
    stripeEnvKey: "STRIPE_LINK_CONTENT_SCHEMA",
  },
  "Google Business Profile Optimization": {
    price:       "$300",
    tagline:     "GBP setup, keyword-rich description, categories, and Q&A optimized for AI.",
    stripeEnvKey: "STRIPE_LINK_GBP",
  },
  "Website Migration & Redesign": {
    price:       "$3,000",
    tagline:     "Modern, fast, AI-readable website built to surface in AI Overviews and ChatGPT.",
    stripeEnvKey: "STRIPE_LINK_WEBSITE",
  },
  "Local Citation Building": {
    price:       "$200",
    tagline:     "Consistent NAP across 50+ AI-indexed directories so every platform agrees.",
    stripeEnvKey: "STRIPE_LINK_CITATIONS",
  },
  "Structured Data Implementation": {
    price:       "$500",
    tagline:     "JSON-LD schema markup so AI assistants can read, cite, and surface your business.",
    stripeEnvKey: "STRIPE_LINK_SCHEMA",
  },
};

const SYSTEM_PROMPT = `\
You are an AI search-visibility analyst for Aegis Global Holdings, a veteran-owned technology services company.

A potential client submitted their website for a free AI Visibility Check. You will receive text scraped from their site. Assess how well this business would appear if someone queried ChatGPT, Google AI Overviews, or Perplexity about it.

SERVICES YOU MAY RECOMMEND — use exact names, choose only from this list:
${Object.keys(SERVICE_CATALOG).map(s => `- ${s}`).join("\n")}

ANALYSIS CRITERIA
- Are key business details present? (location, hours, services offered, pricing range, service area)
- Is content clear, specific, and substantive? (thin content = poor AI representation)
- Is there structured, machine-readable information? (named entities, business type, schema markup)
- Would an AI assistant confidently answer questions about this business?

OUTPUT — respond with ONLY a raw JSON object. No markdown fences, no preamble, no trailing text:
{
  "summary": "2–3 sentence plain-English assessment of current AI visibility status",
  "gaps": ["specific gap 1", "specific gap 2", "specific gap 3"],
  "recommended_services": ["Exact Service Name"],
  "reasoning": "1–2 sentences connecting the gaps to the recommended services"
}

Rules:
- gaps: 2–4 items; each must be specific and actionable (e.g. "No business hours listed anywhere on the site" not "Missing info")
- recommended_services: 1–3 items; must match the list above exactly
- reasoning: concise, written for a non-technical business owner`;

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    let data;
    try { data = await request.json(); }
    catch { return jsonResponse({ error: "Invalid JSON body" }, 400, origin); }

    const { name, phone, email, url } = data;
    if (!name || !email) {
      return jsonResponse({ error: "name and email are required" }, 400, origin);
    }
    if (!env.RESEND_API_KEY) {
      console.error("[aegis-form-worker] RESEND_API_KEY is not set");
      return jsonResponse({ error: "Server misconfiguration" }, 500, origin);
    }

    const lead = { name, phone, email, url };

    // 1. Immediate notification to Robert (synchronous)
    const notifyOk = await sendNotificationEmail(env, lead);
    if (!notifyOk) {
      return jsonResponse({ error: "Email service error" }, 502, origin);
    }

    // 2. Background: fetch site → analyze → send both emails
    ctx.waitUntil(runAiAnalysis(env, lead));

    // 3. Browser sees success immediately
    return jsonResponse({ success: true }, 200, origin);
  },
};

// ── Background pipeline ───────────────────────────────────────────────────────

async function runAiAnalysis(env, lead) {
  // a. Fetch website
  let siteText  = null;
  let fetchNote = null;
  try {
    siteText = await fetchWebsiteText(lead.url);
    console.log(`[aegis-form-worker] Fetched ${siteText.length} chars from ${lead.url}`);
  } catch (err) {
    fetchNote = `Could not fetch website (${err.message}). Analysis based on URL only.`;
    console.error(`[aegis-form-worker] Site fetch failed for ${lead.url}:`, err.message);
  }

  // b. Call Anthropic
  let report       = null;
  let reportRaw    = null;
  let analysisNote = null;

  if (!env.ANTHROPIC_API_KEY) {
    analysisNote = "ANTHROPIC_API_KEY not configured — no AI analysis performed.";
    console.error("[aegis-form-worker] ANTHROPIC_API_KEY is not set");
  } else {
    try {
      reportRaw = await callAnthropic(env, lead, siteText, fetchNote);
      const cleaned = reportRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      try {
        report = JSON.parse(cleaned);
      } catch {
        analysisNote = "JSON parsing failed — raw Claude output included.";
        console.error("[aegis-form-worker] JSON parse failed:", reportRaw);
      }
    } catch (err) {
      analysisNote = `Anthropic API call failed: ${err.message}`;
      console.error("[aegis-form-worker] Anthropic error:", err.message);
    }
  }

  const analysis = { report, reportRaw, analysisNote, fetchNote };

  // c. Robert's internal copy (now says "SENT TO CLIENT")
  await sendReviewEmail(env, lead, analysis);

  // d. Branded client e-mail with report + pricing + Stripe links
  await sendClientEmail(env, lead, analysis);
}

// ── Fetch & strip website ─────────────────────────────────────────────────────

async function fetchWebsiteText(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AegisBot/1.0; +https://aegisglobalholdings.com)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const html = await res.text();
  return stripHtml(html).substring(0, MAX_SITE_CHARS);
}

function normalizeUrl(url) {
  url = (url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Anthropic call ────────────────────────────────────────────────────────────

async function callAnthropic(env, lead, siteText, fetchNote) {
  const userContent = [
    `Business URL: ${lead.url || "(none provided)"}`,
    fetchNote ? `Note: ${fetchNote}` : null,
    siteText  ? `Website content (${siteText.length} chars):\n\n${siteText}` : null,
  ].filter(Boolean).join("\n\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key":         env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

// ── E-mail: immediate notification ───────────────────────────────────────────

async function sendNotificationEmail(env, lead) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to   = env.TO_EMAIL   || "info@aegisglobalholdings.com";

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    reply_to: lead.email,
    subject: `New AI Visibility Check — ${lead.name}`,
    html: `
      <h2 style="font-family:sans-serif;color:#0E141B">New AI Visibility Check Submission</h2>
      <table style="font-family:sans-serif;font-size:15px;border-collapse:collapse" cellpadding="8">
        <tr><td><strong>Name</strong></td><td>${escHtml(lead.name)}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${escHtml(lead.phone || "—")}</td></tr>
        <tr><td><strong>Email</strong></td><td>${escHtml(lead.email)}</td></tr>
        <tr><td><strong>Website</strong></td><td>${escHtml(lead.url || "—")}</td></tr>
      </table>
      <p style="font-family:sans-serif;font-size:13px;color:#5C7288;margin-top:20px">
        AI report generating — client e-mail will be sent automatically in ~30 seconds.
      </p>`,
    text: [
      "New AI Visibility Check Submission",
      `Name:    ${lead.name}`,
      `Phone:   ${lead.phone || "—"}`,
      `Email:   ${lead.email}`,
      `Website: ${lead.url || "—"}`,
      "",
      "AI report generating — client e-mail sends automatically.",
    ].join("\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-form-worker] Notification e-mail failed ${res.status}:`, body);
    if (res.status === 401) console.error("[aegis-form-worker] 401 — RESEND_API_KEY invalid or revoked");
    if (res.status === 422) console.error("[aegis-form-worker] 422 — FROM_EMAIL domain not verified (resend.com/domains)");
    return false;
  }
  return true;
}

// ── E-mail: Robert's internal copy ───────────────────────────────────────────

async function sendReviewEmail(env, lead, { report, reportRaw, analysisNote, fetchNote }) {
  const from  = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to    = env.TO_EMAIL   || "info@aegisglobalholdings.com";
  const label = lead.url || lead.name;

  let reportHtml, reportText;

  if (report) {
    reportHtml = `
      <h3 style="font-family:sans-serif;color:#0E141B;margin-top:0">AI Visibility Report</h3>
      <p style="font-family:sans-serif"><strong>Summary</strong><br>${escHtml(report.summary || "")}</p>
      <p style="font-family:sans-serif"><strong>Gaps identified</strong></p>
      <ul style="font-family:sans-serif">${(report.gaps || []).map(g => `<li>${escHtml(g)}</li>`).join("")}</ul>
      <p style="font-family:sans-serif">
        <strong>Recommended services</strong><br>
        ${(report.recommended_services || []).map(s => `<strong>${escHtml(s)}</strong>`).join(", ")}
      </p>
      <p style="font-family:sans-serif"><strong>Reasoning</strong><br>${escHtml(report.reasoning || "")}</p>`;
    reportText = [
      "AI VISIBILITY REPORT",
      `Summary: ${report.summary || ""}`,
      `Gaps:\n${(report.gaps || []).map(g => `  • ${g}`).join("\n")}`,
      `Recommended: ${(report.recommended_services || []).join(", ")}`,
      `Reasoning: ${report.reasoning || ""}`,
    ].join("\n\n");
  } else if (reportRaw) {
    reportHtml = `
      <h3 style="font-family:sans-serif;color:#c0392b;margin-top:0">AI Output (JSON parse failed)</h3>
      ${analysisNote ? `<p style="font-family:sans-serif;color:#c0392b">${escHtml(analysisNote)}</p>` : ""}
      <pre style="font-family:monospace;background:#f9f9f9;border:1px solid #ddd;padding:12px;white-space:pre-wrap;font-size:13px">${escHtml(reportRaw)}</pre>`;
    reportText = `${analysisNote || ""}\n\n${reportRaw}`;
  } else {
    reportHtml = `<p style="font-family:sans-serif;color:#c0392b">${escHtml(analysisNote || "AI analysis could not be completed.")}</p>`;
    reportText = analysisNote || "AI analysis could not be completed.";
  }

  const fetchWarningHtml = fetchNote
    ? `<p style="font-family:sans-serif;font-size:13px;color:#856404;background:#fff8e1;padding:10px 12px;border-left:3px solid #FFB300;margin:16px 0">⚠ ${escHtml(fetchNote)}</p>`
    : "";

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    reply_to: lead.email,
    subject: `SENT TO CLIENT: ${label} visibility report`,
    html: `
      <p style="font-family:sans-serif;font-weight:700;background:#d4edda;border:1px solid #c3e6cb;padding:12px 16px;color:#155724;margin-bottom:24px">
        ✅ SENT TO CLIENT — this report was automatically e-mailed to ${escHtml(lead.email)}.<br>
        Follow up within 24 hours.
      </p>
      <h2 style="font-family:sans-serif;color:#0E141B">Lead Information</h2>
      <table style="font-family:sans-serif;font-size:15px;border-collapse:collapse" cellpadding="8">
        <tr><td><strong>Name</strong></td><td>${escHtml(lead.name)}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${escHtml(lead.phone || "—")}</td></tr>
        <tr><td><strong>Email</strong></td><td>${escHtml(lead.email)}</td></tr>
        <tr><td><strong>Website</strong></td><td>${lead.url ? `<a href="${escHtml(normalizeUrl(lead.url))}">${escHtml(lead.url)}</a>` : "—"}</td></tr>
      </table>
      ${fetchWarningHtml}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:28px 0">
      ${reportHtml}`,
    text: [
      `✅ SENT TO CLIENT — report automatically e-mailed to ${lead.email}. Follow up within 24 hours.`,
      "",
      `Name: ${lead.name} | Phone: ${lead.phone || "—"} | Website: ${lead.url || "—"}`,
      fetchNote ? `\nNote: ${fetchNote}` : "",
      "",
      reportText,
    ].join("\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-form-worker] Review e-mail to Robert failed ${res.status}:`, body);
  }
}

// ── E-mail: branded client report with pricing + Stripe CTAs ─────────────────

async function sendClientEmail(env, lead, { report, analysisNote }) {
  const from  = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const replyTo = env.TO_EMAIL || "info@aegisglobalholdings.com";
  const label = lead.url || lead.name;

  // Resolve recommended + add-on services from the catalog
  const recommended = report?.recommended_services?.filter(s => SERVICE_CATALOG[s]) ?? [];
  const addOns      = Object.keys(SERVICE_CATALOG).filter(s => !recommended.includes(s));

  // Build service card HTML
  function serviceCard(name, isRecommended) {
    const svc    = SERVICE_CATALOG[name];
    const link   = env[svc.stripeEnvKey] || env.STRIPE_BOOKING_LINK || null;
    const cta    = link
      ? `<a href="${escHtml(link)}"
           style="display:inline-block;background:${isRecommended ? "#FFB300" : "#f0f0f0"};
                  color:${isRecommended ? "#1a1300" : "#333"};
                  font-family:sans-serif;font-weight:700;font-size:14px;
                  padding:10px 20px;border-radius:4px;text-decoration:none;margin-top:12px">
           ${isRecommended ? "Get Started →" : "Add This →"}
         </a>`
      : `<a href="mailto:${escHtml(replyTo)}?subject=${encodeURIComponent("Aegis: " + name)}"
           style="display:inline-block;background:#f0f0f0;color:#333;
                  font-family:sans-serif;font-weight:700;font-size:14px;
                  padding:10px 20px;border-radius:4px;text-decoration:none;margin-top:12px">
           Contact Us →
         </a>`;

    return `
      <div style="background:${isRecommended ? "#fffbf0" : "#fafafa"};
                  border:${isRecommended ? "2px solid #FFB300" : "1px solid #e0e0e0"};
                  border-radius:6px;padding:20px 24px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div style="flex:1;min-width:200px">
            ${isRecommended ? `<span style="font-family:sans-serif;font-size:11px;font-weight:700;color:#856404;text-transform:uppercase;letter-spacing:.08em">Recommended for You</span><br>` : ""}
            <strong style="font-family:sans-serif;font-size:16px;color:#0E141B">${escHtml(name)}</strong>
            <p style="font-family:sans-serif;font-size:14px;color:#555;margin:6px 0 0">${escHtml(svc.tagline)}</p>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <span style="font-family:sans-serif;font-size:22px;font-weight:700;color:#0E141B">${escHtml(svc.price)}</span>
            <br>${cta}
          </div>
        </div>
      </div>`;
  }

  // Report section
  let reportSection = "";
  if (report) {
    reportSection = `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
        <tr>
          <td style="background:#0E141B;border-radius:6px;padding:28px">
            <p style="font-family:sans-serif;font-size:11px;font-weight:700;color:#FFB300;
                       text-transform:uppercase;letter-spacing:.12em;margin:0 0 12px">
              What We Found
            </p>
            <p style="font-family:sans-serif;font-size:15px;color:#EAE7E0;margin:0 0 20px;line-height:1.6">
              ${escHtml(report.summary || "")}
            </p>
            <p style="font-family:sans-serif;font-size:12px;font-weight:700;color:#8FA1AF;
                       text-transform:uppercase;letter-spacing:.1em;margin:20px 0 12px">
              Gaps Identified
            </p>
            <ul style="margin:0;padding-left:20px">
              ${(report.gaps || []).map(g =>
                `<li style="font-family:sans-serif;font-size:14px;color:#EAE7E0;margin-bottom:8px;line-height:1.5">${escHtml(g)}</li>`
              ).join("")}
            </ul>
          </td>
        </tr>
      </table>`;
  } else {
    reportSection = `
      <p style="font-family:sans-serif;font-size:15px;color:#555;margin:28px 0">
        ${escHtml(analysisNote || "Your AI visibility check is being processed. We'll follow up with your full report shortly.")}
      </p>`;
  }

  const recommendedSection = recommended.length > 0 ? `
    <h2 style="font-family:sans-serif;font-size:18px;color:#0E141B;margin:36px 0 16px">
      Recommended For ${escHtml(label)}
    </h2>
    ${recommended.map(s => serviceCard(s, true)).join("")}` : "";

  const addOnSection = addOns.length > 0 ? `
    <h2 style="font-family:sans-serif;font-size:18px;color:#0E141B;margin:36px 0 16px">
      Additional Services
    </h2>
    <p style="font-family:sans-serif;font-size:14px;color:#666;margin:0 0 20px">
      Everything else we offer — add any of these to your package:
    </p>
    ${addOns.map(s => serviceCard(s, false)).join("")}` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

  <!-- Header -->
  <tr>
    <td style="background:#0E141B;padding:28px 32px">
      <p style="font-family:monospace;font-size:12px;color:#FFB300;margin:0 0 4px;letter-spacing:.12em;text-transform:uppercase">
        AEGIS GLOBAL HOLDINGS
      </p>
      <p style="font-family:sans-serif;font-size:22px;font-weight:700;color:#ffffff;margin:0">
        Your AI Visibility Report
      </p>
      <p style="font-family:monospace;font-size:12px;color:#5C7288;margin:8px 0 0">${escHtml(label)}</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:32px">

      <p style="font-family:sans-serif;font-size:15px;color:#333;line-height:1.6;margin:0 0 8px">
        Hi ${escHtml(lead.name.split(" ")[0])},
      </p>
      <p style="font-family:sans-serif;font-size:15px;color:#333;line-height:1.6;margin:0 0 4px">
        We ran your free AI visibility check. Here's what we found and exactly what it would take to fix it.
      </p>

      ${reportSection}

      ${recommendedSection}

      ${addOnSection}

      <!-- Annual rates & discounts -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:36px 0 0">
        <tr>
          <td style="background:#0E141B;border-radius:6px;padding:28px 32px;text-align:center">
            <p style="font-family:monospace;font-size:11px;font-weight:700;color:#FFB300;
                       text-transform:uppercase;letter-spacing:.12em;margin:0 0 10px">
              Annual Plans &amp; Bundle Discounts
            </p>
            <p style="font-family:sans-serif;font-size:16px;font-weight:700;color:#ffffff;margin:0 0 8px">
              Save ${ANNUAL_DISCOUNT_PCT} when you commit annually
            </p>
            <p style="font-family:sans-serif;font-size:14px;color:#8FA1AF;margin:0 0 20px;line-height:1.6">
              Monthly retainers, bundled packages, and multi-service discounts are available.<br>
              Reply to this e-mail or click below and we'll put together a custom quote.
            </p>
            <a href="${escHtml(env.STRIPE_ANNUAL_LINK || env.STRIPE_BOOKING_LINK || `mailto:${env.TO_EMAIL || "info@aegisglobalholdings.com"}?subject=${encodeURIComponent("Annual Plan — " + label)}`)}"
               style="display:inline-block;background:#FFB300;color:#1a1300;
                      font-family:sans-serif;font-weight:700;font-size:15px;
                      padding:13px 28px;border-radius:4px;text-decoration:none">
              Discuss Annual Rates →
            </a>
          </td>
        </tr>
      </table>

      <!-- Guarantee note -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 0">
        <tr>
          <td style="background:#f8f8f8;border-left:3px solid #FFB300;padding:16px 20px;border-radius:0 4px 4px 0">
            <p style="font-family:sans-serif;font-size:13px;color:#444;margin:0;line-height:1.6">
              <strong>Veteran-owned. No contracts. No fluff.</strong><br>
              Every engagement comes with a plain-English deliverable you can take anywhere.
              If you're not satisfied after the first deliverable, we'll refund you in full.
            </p>
          </td>
        </tr>
      </table>

      <p style="font-family:sans-serif;font-size:14px;color:#666;margin:32px 0 0;line-height:1.6">
        Questions? Reply to this e-mail — you'll reach Robert directly.<br>
        <strong style="color:#0E141B">Aegis Global Holdings</strong> · Edmond, OK · Veteran-Owned
      </p>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#0E141B;padding:20px 32px">
      <p style="font-family:monospace;font-size:11px;color:#3A4A5C;margin:0;text-align:center;letter-spacing:.05em">
        © 2026 AEGIS GLOBAL HOLDINGS, LLC — EDMOND, OK<br>
        You received this because you requested a free AI Visibility Check at aegisglobalholdings.com
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body></html>`;

  // Plain-text fallback
  const serviceLines = [
    ...recommended.map(s => {
      const svc  = SERVICE_CATALOG[s];
      const link = env[svc.stripeEnvKey] || env.STRIPE_BOOKING_LINK;
      return `★ ${s} — ${svc.price}\n   ${svc.tagline}${link ? `\n   Get started: ${link}` : ""}`;
    }),
    ...addOns.map(s => {
      const svc  = SERVICE_CATALOG[s];
      const link = env[svc.stripeEnvKey] || env.STRIPE_BOOKING_LINK;
      return `  ${s} — ${svc.price}\n   ${svc.tagline}${link ? `\n   Add this: ${link}` : ""}`;
    }),
  ];

  const text = [
    "AEGIS GLOBAL HOLDINGS — Your AI Visibility Report",
    `${label}`,
    "",
    report ? [
      "WHAT WE FOUND",
      report.summary || "",
      "",
      "Gaps identified:",
      ...(report.gaps || []).map(g => `  • ${g}`),
    ].join("\n") : (analysisNote || ""),
    "",
    "──────────────────────────────",
    "SERVICES & PRICING",
    "",
    ...serviceLines,
    "",
    "──────────────────────────────",
    `ANNUAL PLANS & BUNDLE DISCOUNTS`,
    `Save ${ANNUAL_DISCOUNT_PCT} when you commit annually. Monthly retainers and bundled packages available.`,
    `Reply to this e-mail or visit: ${env.STRIPE_ANNUAL_LINK || env.STRIPE_BOOKING_LINK || `mailto:${env.TO_EMAIL || "info@aegisglobalholdings.com"}`}`,
    "",
    "──────────────────────────────",
    "Veteran-owned. No contracts. No fluff.",
    "Reply to this e-mail to reach Robert directly.",
    "Aegis Global Holdings · Edmond, OK",
  ].join("\n");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [lead.email],
    reply_to: replyTo,
    subject: `Your AI Visibility Report — ${label}`,
    html,
    text,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-form-worker] Client e-mail failed ${res.status}:`, body);
  } else {
    console.log(`[aegis-form-worker] Client e-mail sent to ${lead.email}`);
  }
}

// ── Shared Resend helper ──────────────────────────────────────────────────────

function sendViaResend(apiKey, payload) {
  return fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

// ── CORS & response helpers ───────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.has(origin) || (origin && origin.endsWith(".pages.dev"))
      ? origin
      : "https://aegisglobalholdings.com";
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
