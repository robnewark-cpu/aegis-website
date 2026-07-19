/**
 * aegis-form-worker — AI Visibility Check form handler
 *
 * Flow
 * ────
 * 1.  Validate POST + CORS
 * 2.  Send immediate "new lead" notification e-mail via Resend   (synchronous)
 * 3.  Return HTTP 200 to the browser so the user sees success immediately
 * 4.  Background (ctx.waitUntil — does not block the response):
 *       a. Fetch lead's website, strip HTML tags, truncate to MAX_SITE_CHARS
 *       b. Call Anthropic (claude-sonnet-4-6) for AI-search-readiness analysis
 *       c. Parse JSON result; fall back to raw text if parsing fails (lead not lost)
 *       d. Send "REVIEW NEEDED" draft report e-mail to Robert
 *
 * Required secrets  (set with: wrangler secret put <NAME> --name aegis-form-worker)
 *   RESEND_API_KEY    — Resend API key  (re_…)
 *   ANTHROPIC_API_KEY — Anthropic API key  (sk-ant-…)
 *
 * Optional vars in wrangler.jsonc [vars]
 *   FROM_EMAIL  — verified Resend sender (default: noreply@aegisglobalholdings.com)
 *   TO_EMAIL    — recipient inbox        (default: info@aegisglobalholdings.com)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const RESEND_API    = "https://api.resend.com/emails";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL  = "claude-sonnet-4-6";
const MAX_SITE_CHARS = 8_000;

const ALLOWED_ORIGINS = new Set([
  "https://aegisglobalholdings.com",
  "https://www.aegisglobalholdings.com",
]);

// Edit this list to control which services Claude may recommend.
// Names must match exactly what you want to appear in the review e-mail.
const AEGIS_SERVICES = [
  "AI Visibility Audit & Strategy",
  "Content & Schema Rewrite",
  "Google Business Profile Optimization",
  "Website Migration & Redesign",
  "Local Citation Building",
  "Structured Data Implementation",
];

const SYSTEM_PROMPT = `\
You are an AI search-visibility analyst for Aegis Global Holdings, a veteran-owned technology services company.

A potential client submitted their website for a free AI Visibility Check. You will receive text scraped from their site. Assess how well this business would appear if someone queried ChatGPT, Google AI Overviews, or Perplexity about it.

SERVICES YOU MAY RECOMMEND — use exact names, choose only from this list:
${AEGIS_SERVICES.map(s => `- ${s}`).join("\n")}

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
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    const { name, phone, email, url } = data;
    if (!name || !email) {
      return jsonResponse({ error: "name and email are required" }, 400, origin);
    }

    if (!env.RESEND_API_KEY) {
      console.error("[aegis-form-worker] RESEND_API_KEY is not set");
      return jsonResponse({ error: "Server misconfiguration" }, 500, origin);
    }

    const lead = { name, phone, email, url };

    // ── Step 1: immediate notification (synchronous, existing behaviour) ───────
    const notifyOk = await sendNotificationEmail(env, lead);
    if (!notifyOk) {
      return jsonResponse({ error: "Email service error" }, 502, origin);
    }

    // ── Step 2: background pipeline — does not block the HTTP response ─────────
    ctx.waitUntil(runAiAnalysis(env, lead));

    // ── Step 3: return success so the browser shows the confirmation message ───
    return jsonResponse({ success: true }, 200, origin);
  },
};

// ── Background pipeline ───────────────────────────────────────────────────────

async function runAiAnalysis(env, lead) {
  // a. Fetch website text
  let siteText  = null;
  let fetchNote = null;
  try {
    siteText = await fetchWebsiteText(lead.url);
    console.log(`[aegis-form-worker] Fetched ${siteText.length} chars from ${lead.url}`);
  } catch (err) {
    fetchNote = `Could not fetch website (${err.message}). Analysis based on URL only.`;
    console.error(`[aegis-form-worker] Site fetch failed for ${lead.url}:`, err.message);
  }

  // b–c. Call Anthropic and parse the JSON response
  let report       = null; // parsed JSON object
  let reportRaw    = null; // raw string (fallback)
  let analysisNote = null; // shown in the e-mail when something went wrong

  if (!env.ANTHROPIC_API_KEY) {
    analysisNote = "ANTHROPIC_API_KEY not configured — no AI analysis was performed.";
    console.error("[aegis-form-worker] ANTHROPIC_API_KEY is not set");
  } else {
    try {
      reportRaw = await callAnthropic(env, lead, siteText, fetchNote);

      // Strip markdown fences that Claude may add despite the prompt
      const cleaned = reportRaw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      try {
        report = JSON.parse(cleaned);
      } catch {
        analysisNote = "JSON parsing failed — raw Claude output included below.";
        console.error("[aegis-form-worker] JSON parse failed. Raw output:", reportRaw);
      }
    } catch (err) {
      analysisNote = `Anthropic API call failed: ${err.message}`;
      console.error("[aegis-form-worker] Anthropic error:", err.message);
    }
  }

  // d. Send the review e-mail to Robert
  await sendReviewEmail(env, lead, { report, reportRaw, analysisNote, fetchNote });
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
    fetchNote          ? `Note: ${fetchNote}` : null,
    siteText           ? `Website content (${siteText.length} chars):\n\n${siteText}` : null,
  ].filter(Boolean).join("\n\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key":          env.ANTHROPIC_API_KEY,
      "anthropic-version":  "2023-06-01",
      "content-type":       "application/json",
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

// ── E-mail senders ────────────────────────────────────────────────────────────

/** Step 1 — immediate "new lead received" alert (keeps existing behaviour). */
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
      <p style="font-family:sans-serif;font-size:13px;color:#5C7288;margin-top:24px">
        AI analysis running — full review report will arrive shortly in a second e-mail.
      </p>`,
    text: [
      "New AI Visibility Check Submission",
      `Name:    ${lead.name}`,
      `Phone:   ${lead.phone || "—"}`,
      `Email:   ${lead.email}`,
      `Website: ${lead.url || "—"}`,
      "",
      "AI analysis running — review report arriving shortly.",
    ].join("\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-form-worker] Notification e-mail failed ${res.status}:`, body);

    if (res.status === 401) console.error("[aegis-form-worker] 401 — RESEND_API_KEY invalid or revoked");
    if (res.status === 422) console.error("[aegis-form-worker] 422 — FROM_EMAIL domain not verified in Resend (resend.com/domains)");
    return false;
  }
  return true;
}

/** Step 4d — draft AI report for Robert to review before sending to the client. */
async function sendReviewEmail(env, lead, { report, reportRaw, analysisNote, fetchNote }) {
  const from  = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to    = env.TO_EMAIL   || "info@aegisglobalholdings.com";
  const label = lead.url || lead.name;

  // Build the report section
  let reportHtml, reportText;

  if (report) {
    reportHtml = `
      <h3 style="font-family:sans-serif;color:#0E141B;margin-top:0">AI Visibility Report</h3>
      <p style="font-family:sans-serif"><strong>Summary</strong><br>${escHtml(report.summary || "")}</p>
      <p style="font-family:sans-serif"><strong>Gaps identified</strong></p>
      <ul style="font-family:sans-serif">
        ${(report.gaps || []).map(g => `<li>${escHtml(g)}</li>`).join("")}
      </ul>
      <p style="font-family:sans-serif">
        <strong>Recommended services</strong><br>
        ${(report.recommended_services || []).map(s => `<strong>${escHtml(s)}</strong>`).join(", ")}
      </p>
      <p style="font-family:sans-serif"><strong>Reasoning</strong><br>${escHtml(report.reasoning || "")}</p>`;

    reportText = [
      "AI VISIBILITY REPORT",
      "",
      `Summary:\n${report.summary || ""}`,
      "",
      `Gaps:\n${(report.gaps || []).map(g => `  • ${g}`).join("\n")}`,
      "",
      `Recommended services: ${(report.recommended_services || []).join(", ")}`,
      "",
      `Reasoning:\n${report.reasoning || ""}`,
    ].join("\n");
  } else if (reportRaw) {
    // Claude responded but JSON parse failed — show raw output so lead is not lost
    reportHtml = `
      <h3 style="font-family:sans-serif;color:#c0392b;margin-top:0">AI Output (JSON parse failed)</h3>
      ${analysisNote ? `<p style="font-family:sans-serif;color:#c0392b">${escHtml(analysisNote)}</p>` : ""}
      <pre style="font-family:monospace;background:#f9f9f9;border:1px solid #ddd;padding:12px;white-space:pre-wrap;font-size:13px">${escHtml(reportRaw)}</pre>`;
    reportText = `${analysisNote || ""}\n\n${reportRaw}`;
  } else {
    // No AI output at all
    reportHtml = `<p style="font-family:sans-serif;color:#c0392b">${escHtml(analysisNote || "AI analysis could not be completed.")}</p>`;
    reportText = analysisNote || "AI analysis could not be completed.";
  }

  const fetchWarningHtml = fetchNote
    ? `<p style="font-family:sans-serif;font-size:13px;color:#856404;background:#fff8e1;padding:10px 12px;border-left:3px solid #FFB300;margin:16px 0">⚠ ${escHtml(fetchNote)}</p>`
    : "";

  const html = `
    <p style="font-family:sans-serif;font-weight:700;background:#fff3cd;border:1px solid #ffc107;padding:12px 16px;color:#856404;margin-bottom:24px">
      ⚠ DRAFT — review before sending to client.<br>
      Reply-all or forward manually once approved.
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

    ${reportHtml}`;

  const text = [
    "⚠ DRAFT — review before sending to client.",
    "Reply-all or forward manually once approved.",
    "",
    "LEAD",
    `Name:    ${lead.name}`,
    `Phone:   ${lead.phone || "—"}`,
    `Email:   ${lead.email}`,
    `Website: ${lead.url || "—"}`,
    fetchNote ? `\nNote: ${fetchNote}` : "",
    "",
    "──────────────────────────────────────────",
    "",
    reportText,
  ].join("\n");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    reply_to: lead.email,
    subject: `REVIEW NEEDED: ${label} visibility report`,
    html,
    text,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-form-worker] Review e-mail failed ${res.status}:`, body);
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
