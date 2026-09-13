/**
 * aegis-samgov-bot — daily SAM.gov opportunity scan + Robert-approval digest
 *
 * Flow
 * ────
 * 1.  Cron trigger fires once a day (see wrangler.jsonc)
 * 2.  Query SAM.gov's public Opportunities API for each NAICS code in
 *     NAICS_CODES, over the last 2 days (overlap is fine — dedupe is by
 *     notice_id in D1)
 * 3.  Score each new opportunity against a fixed, auditable keyword list —
 *     no LLM judgment here, so the "Why Match" reasons are always real
 *     substring matches, never invented
 * 4.  Store every opportunity seen (any score) in D1; e-mail Robert a
 *     digest of only the ones scoring >= SCORE_THRESHOLD, each with
 *     Approve / Decline / Save-for-later links
 * 5.  GET /respond?id=...&token=...&action=approve|decline|save updates
 *     that opportunity's status in D1
 *
 * This bot does NOT do anything after approval yet (no proposal drafting,
 * no compliance matrix) — that's an intentional v1 scope cut. Approving an
 * opportunity here just marks it "approved" in D1 for you to act on
 * manually.
 *
 * Required secrets  (wrangler secret put <NAME> --name aegis-samgov-bot)
 *   SAM_API_KEY     — free key from sam.gov -> Account Details -> Request API Key
 *   RESEND_API_KEY  — same Resend account used by the other Aegis workers
 */

const SAM_API = "https://api.sam.gov/opportunities/v2/search";
const RESEND_API = "https://api.resend.com/emails";
const WORKER_URL = "https://aegis-samgov-bot.robert-bb6.workers.dev";

// Fixed, auditable scoring rules. Every match here is a literal substring
// found in the opportunity's title/description — nothing here is inferred
// or guessed by an LLM. Edit these to tune what the bot flags as relevant.
const KEYWORD_RULES = [
  { term: "fedramp", weight: 30, label: "FedRAMP" },
  { term: "cmmc", weight: 20, label: "CMMC" },
  { term: "nist 800", weight: 15, label: "NIST 800-series" },
  { term: "compliance", weight: 15, label: "Compliance" },
  { term: "cybersecurity", weight: 15, label: "Cybersecurity" },
  { term: "information security", weight: 15, label: "Cybersecurity" },
  { term: "cloud", weight: 10, label: "Cloud" },
  { term: "audit", weight: 10, label: "Audit" },
  { term: "it consulting", weight: 10, label: "IT Consulting" },
  { term: "information technology", weight: 10, label: "IT Consulting" },
  { term: "software development", weight: 10, label: "Software Development" },
  { term: "web application", weight: 5, label: "Web/Digital" },
  { term: "website", weight: 5, label: "Web/Digital" },
];

const VETERAN_SET_ASIDE_CODES = ["SDVOSBC", "SDVOSBS", "VSA", "VSS"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: Boolean(env.SAM_API_KEY && env.RESEND_API_KEY),
        samApiKeyConfigured: Boolean(env.SAM_API_KEY),
        resendConfigured: Boolean(env.RESEND_API_KEY),
      });
    }

    if (request.method === "GET" && url.pathname === "/respond") {
      return handleRespond(env, url);
    }

    // Manual trigger for testing without waiting for the cron.
    if (request.method === "GET" && url.pathname === "/run-now") {
      const result = await runScan(env);
      return jsonResponse(result);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
};

// ── Main scan ────────────────────────────────────────────────────────────

async function runScan(env) {
  if (!env.SAM_API_KEY) {
    console.error("[aegis-samgov-bot] SAM_API_KEY not set");
    return { error: "SAM_API_KEY not configured" };
  }

  const naicsCodes = (env.NAICS_CODES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = Number(env.SCORE_THRESHOLD || "40");

  const today = new Date();
  const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
  const postedFrom = formatSamDate(twoDaysAgo);
  const postedTo = formatSamDate(today);

  const byNoticeId = new Map();
  const fetchErrors = [];

  for (const code of naicsCodes) {
    try {
      const results = await fetchOpportunities(env, code, postedFrom, postedTo);
      for (const opp of results) {
        if (opp.noticeId) byNoticeId.set(opp.noticeId, opp);
      }
    } catch (err) {
      console.error(`[aegis-samgov-bot] NAICS ${code} fetch failed:`, err.message);
      fetchErrors.push(`${code}: ${err.message}`);
    }
  }

  const newQualifying = [];
  let totalSeen = 0;
  let totalNew = 0;

  for (const opp of byNoticeId.values()) {
    totalSeen++;
    const existing = await env.DB.prepare("SELECT notice_id FROM opportunities WHERE notice_id = ?")
      .bind(opp.noticeId)
      .first();
    if (existing) continue;

    totalNew++;
    const description = await fetchDescription(env, opp).catch(() => "");
    const { score, reasons } = scoreOpportunity(opp, description);
    const token = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO opportunities
        (notice_id, title, agency, notice_type, naics_code, set_aside, posted_date,
         response_deadline, sam_url, description_excerpt, score, matched_reasons, respond_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        opp.noticeId,
        opp.title || "(untitled)",
        opp.fullParentPathName || opp.department || null,
        opp.type || null,
        opp.naicsCode || null,
        opp.setAside || opp.setAsideCode || null,
        opp.postedDate || null,
        opp.responseDeadLine || opp.reponseDeadLine || null,
        `https://sam.gov/opp/${opp.noticeId}/view`,
        description.slice(0, 500),
        score,
        JSON.stringify(reasons),
        token,
      )
      .run();

    if (score >= threshold) {
      newQualifying.push({ ...opp, score, reasons, token });
    }
  }

  if (newQualifying.length > 0 && env.RESEND_API_KEY) {
    await sendDigestEmail(env, newQualifying);
  }

  if (fetchErrors.length > 0 && env.RESEND_API_KEY && totalNew === 0) {
    // Only surface fetch errors if we got nothing useful this run, so a
    // single flaky NAICS code among several working ones doesn't spam you.
    await notifyRobert(env, {
      subject: "SAM.gov bot — fetch errors, no new opportunities found",
      html: `<p>Errors: ${escHtml(fetchErrors.join("; "))}</p>`,
    });
  }

  return { totalSeen, totalNew, qualifying: newQualifying.length, fetchErrors };
}

async function fetchOpportunities(env, naicsCode, postedFrom, postedTo) {
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    postedFrom,
    postedTo,
    ncode: naicsCode,
    limit: "1000",
  });
  const res = await fetch(`${SAM_API}?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SAM.gov ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Defensive: the documented response key is "opportunitiesData", but
  // handle a couple of plausible alternates rather than assume and fail
  // silently if SAM.gov's shape differs from what's documented.
  const list = data.opportunitiesData || data.data || data.results || [];
  if (!Array.isArray(list)) {
    console.error("[aegis-samgov-bot] Unrecognized SAM.gov response shape, keys:", Object.keys(data));
    return [];
  }
  return list;
}

async function fetchDescription(env, opp) {
  // The search API's "description" field is often a URL to fetch the full
  // notice text separately, not the text itself. Handle both cases.
  const desc = opp.description;
  if (!desc) return "";
  if (typeof desc === "string" && /^https?:\/\//.test(desc)) {
    try {
      const res = await fetch(`${desc}${desc.includes("?") ? "&" : "?"}api_key=${env.SAM_API_KEY}`);
      if (!res.ok) return "";
      const text = await res.text();
      // Response may be JSON with a "description" field, or plain text.
      try {
        const json = JSON.parse(text);
        return typeof json.description === "string" ? json.description : text;
      } catch {
        return text;
      }
    } catch {
      return "";
    }
  }
  return String(desc);
}

// ── Scoring (deterministic, no LLM) ────────────────────────────────────────

function scoreOpportunity(opp, description) {
  const haystack = `${opp.title || ""} ${description || ""}`.toLowerCase();
  const reasons = new Set();
  let score = 0;

  for (const rule of KEYWORD_RULES) {
    if (haystack.includes(rule.term)) {
      score += rule.weight;
      reasons.add(rule.label);
    }
  }

  const setAsideCode = (opp.setAsideCode || opp.setAside || "").toUpperCase();
  if (VETERAN_SET_ASIDE_CODES.some((c) => setAsideCode.includes(c)) || haystack.includes("veteran")) {
    score += 20;
    reasons.add("Veteran-Owned Set-Aside");
  }

  return { score: Math.min(score, 100), reasons: [...reasons] };
}

// ── Approve / decline / save ────────────────────────────────────────────────

async function handleRespond(env, url) {
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action");

  if (!id || !token || !["approve", "decline", "save"].includes(action)) {
    return htmlResponse("Invalid request.", 400);
  }

  const row = await env.DB.prepare("SELECT respond_token, title FROM opportunities WHERE notice_id = ?")
    .bind(id)
    .first();

  if (!row || row.respond_token !== token) {
    return htmlResponse("Invalid or expired link.", 403);
  }

  const status = action === "approve" ? "approved" : action === "decline" ? "declined" : "saved";
  await env.DB.prepare("UPDATE opportunities SET status = ?, updated_at = datetime('now') WHERE notice_id = ?")
    .bind(status, id)
    .run();

  return htmlResponse(`Marked "${escHtml(row.title)}" as <strong>${status}</strong>.`, 200);
}

// ── E-mail ──────────────────────────────────────────────────────────────────

async function sendDigestEmail(env, opportunities) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const sorted = [...opportunities].sort((a, b) => b.score - a.score);

  const cardsHtml = sorted
    .map((opp) => {
      const approveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(opp.noticeId)}&token=${opp.token}&action=approve`;
      const declineUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(opp.noticeId)}&token=${opp.token}&action=decline`;
      const saveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(opp.noticeId)}&token=${opp.token}&action=save`;
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <div style="font-size:12px;font-weight:700;color:#856404;text-transform:uppercase;letter-spacing:.08em">Score: ${opp.score}/100</div>
          <h3 style="margin:6px 0">${escHtml(opp.title || "(untitled)")}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">
            ${opp.fullParentPathName ? escHtml(opp.fullParentPathName) + " · " : ""}
            NAICS ${escHtml(opp.naicsCode || "n/a")}
            ${opp.setAside ? " · " + escHtml(opp.setAside) : ""}
          </p>
          <p style="margin:8px 0;font-size:14px"><strong>Why matched:</strong> ${opp.reasons.map((r) => `✓ ${escHtml(r)}`).join(" &nbsp; ")}</p>
          <p style="margin:8px 0;font-size:14px">
            <a href="https://sam.gov/opp/${escHtml(opp.noticeId)}/view">View on SAM.gov</a>
            ${opp.responseDeadLine ? ` · Response due: ${escHtml(opp.responseDeadLine)}` : ""}
          </p>
          <div style="margin-top:12px">
            <a href="${approveUrl}" style="background:#0E141B;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Approve</a>
            <a href="${declineUrl}" style="background:#f0f0f0;color:#333;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Decline</a>
            <a href="${saveUrl}" style="background:#f0f0f0;color:#333;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px">Save for later</a>
          </div>
        </div>`;
    })
    .join("");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `SAM.gov: ${sorted.length} new matching opportunit${sorted.length === 1 ? "y" : "ies"}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <h2>New SAM.gov opportunities</h2>
      <p style="color:#555">Scored against your keyword rules. Nothing here was auto-approved — click a link below to act.</p>
      ${cardsHtml}
    </div>`,
    text: sorted
      .map(
        (opp) =>
          `[${opp.score}/100] ${opp.title}\nWhy: ${opp.reasons.join(", ")}\nhttps://sam.gov/opp/${opp.noticeId}/view\nApprove: ${WORKER_URL}/respond?id=${opp.noticeId}&token=${opp.token}&action=approve\nDecline: ${WORKER_URL}/respond?id=${opp.noticeId}&token=${opp.token}&action=decline`,
      )
      .join("\n\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-samgov-bot] Digest e-mail failed ${res.status}:`, body);
  }
}

async function notifyRobert(env, { subject, html }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  await sendViaResend(env.RESEND_API_KEY, { from, to: [to], subject, html }).catch(() => {});
}

function sendViaResend(apiKey, payload) {
  return fetch(RESEND_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatSamDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function htmlResponse(message, status) {
  return new Response(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">${message}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
