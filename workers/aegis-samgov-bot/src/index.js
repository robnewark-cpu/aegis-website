/**
 * aegis-samgov-bot — daily opportunity + awarded-contract scan, one approval digest
 *
 * Two independent scans feed the same D1 table and the same digest e-mail:
 *
 *   "sam_gov"    — SAM.gov open solicitations Aegis could bid on directly.
 *                  Query per NAICS_CODES, score by keyword rules.
 *   "usaspending"— Contracts OTHERS just won (USASpending.gov award search).
 *                  Not something to bid on — a signal that the winning
 *                  company may now need compliance/security/IT help to
 *                  perform on it. Filtered server-side by the same keyword
 *                  list plus an award-size band (AWARD_MIN/AWARD_MAX) so we
 *                  only see mid-size wins realistic for Aegis to approach,
 *                  not tiny purchase orders or mega-prime contracts.
 *
 * Flow
 * ────
 * 1.  Cron trigger fires once a day (see wrangler.jsonc)
 * 2.  Run both scans, normalize results to a common shape
 * 3.  Score each new item against a fixed, auditable keyword list — no LLM
 *     judgment, so "Why Match" reasons are always real substring matches
 * 4.  Store every item seen (any score) in D1; e-mail Robert a digest of
 *     the ones scoring >= SCORE_THRESHOLD, each with Approve / Decline /
 *     Save-for-later links
 * 5.  GET /respond?id=...&token=...&action=approve|decline|save updates
 *     that item's status in D1
 *
 * This bot does NOT do anything after approval yet (no proposal drafting,
 * no compliance matrix, no outreach) — intentional v1 scope cut. Approving
 * just marks status in D1 for you to act on manually.
 *
 * Required secrets  (wrangler secret put <NAME> --name aegis-samgov-bot)
 *   SAM_API_KEY      — free key from sam.gov -> Account Details -> Request API Key
 *   RESEND_API_KEY   — same Resend account used by the other Aegis workers
 *   INGEST_SECRET    — shared secret for POST /ingest-usaspending (see below)
 *   ADZUNA_APP_ID / ADZUNA_APP_KEY — from developer.adzuna.com
 *   USAJOBS_API_KEY  — from developer.usajobs.gov
 *   USAJOBS_EMAIL    — the email registered with that key; USAJOBS requires
 *                      it as the User-Agent header on every request, not
 *                      just the key
 *
 * IMPORTANT: Cloudflare Workers cannot reach api.usaspending.gov directly —
 * every request (even a bare GET /) fails with a 525 TLS handshake error
 * between Cloudflare's edge and USASpending's origin. Confirmed by testing,
 * not a guess. So the USASpending fetch runs from a GitHub Actions workflow
 * instead (.github/workflows/usaspending-scan.yml), which has normal
 * outbound networking, and POSTs the raw API response to
 * POST /ingest-usaspending here (authenticated via the X-Ingest-Secret
 * header matching INGEST_SECRET). This Worker still does all the scoring,
 * D1 storage, and digest e-mail — GitHub Actions is only a network relay
 * for the one domain Workers can't reach.
 */

const SAM_API = "https://api.sam.gov/opportunities/v2/search";
const RESEND_API = "https://api.resend.com/emails";
const WORKER_URL = "https://aegis-samgov-bot.robert-bb6.workers.dev";

// Fixed, auditable scoring rules. Every match here is a literal substring
// found in the item's title/description — nothing here is inferred or
// guessed by an LLM. Edit these to tune what the bot flags as relevant.
// Also doubles as the USASpending "keywords" server-side filter.
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

// Weighted highest of any single rule: a veteran set-aside is a structural
// bidding advantage (other bidders are excluded entirely), which matters
// more for "will Aegis actually win this" than a generic keyword hit.
const VETERAN_SET_ASIDE_WEIGHT = 35;
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

    // Receives raw USASpending.gov results fetched by the GitHub Actions
    // workflow (Workers can't reach that domain directly — see file header).
    if (request.method === "POST" && url.pathname === "/ingest-usaspending") {
      return handleIngestUsaSpending(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
};

// ── Main scan (SAM.gov + Adzuna — see file header re: USASpending) ────────

async function runScan(env) {
  const fetchErrors = [];
  const allItems = [];

  if (env.SAM_API_KEY) {
    try {
      allItems.push(...(await scanSamGov(env)));
    } catch (err) {
      fetchErrors.push(`SAM.gov: ${err.message}`);
    }
  } else {
    fetchErrors.push("SAM.gov: SAM_API_KEY not configured");
  }

  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    try {
      allItems.push(...(await scanAdzuna(env)));
    } catch (err) {
      fetchErrors.push(`Adzuna: ${err.message}`);
    }
  }

  if (env.USAJOBS_API_KEY && env.USAJOBS_EMAIL) {
    try {
      allItems.push(...(await scanUsaJobs(env)));
    } catch (err) {
      fetchErrors.push(`USAJOBS: ${err.message}`);
    }
  }

  const result = await ingestAndNotify(env, allItems, "sam.gov");
  if (fetchErrors.length > 0 && env.RESEND_API_KEY && result.totalNew === 0) {
    await notifyRobert(env, {
      subject: "Opportunity bot — fetch errors, nothing new found",
      html: `<p>Errors: ${escHtml(fetchErrors.join("; "))}</p>`,
    });
  }
  return { ...result, fetchErrors };
}

// ── Shared: dedupe against D1, score, store, digest e-mail ─────────────────

async function ingestAndNotify(env, allItems) {
  const threshold = Number(env.SCORE_THRESHOLD || "20");
  const newQualifying = [];
  let totalSeen = 0;
  let totalNew = 0;

  for (const item of allItems) {
    totalSeen++;
    const existing = await env.DB.prepare("SELECT notice_id FROM opportunities WHERE notice_id = ?")
      .bind(item.id)
      .first();
    if (existing) continue;

    totalNew++;
    // Only resolve the full description now, for genuinely new items — SAM.gov
    // descriptions are a separate subrequest each, and Workers has a hard cap
    // on subrequests per invocation. Resolving these for all 40+ opportunities
    // seen (most already in D1) blew through that limit.
    if (item.source === "sam_gov" && item.descriptionRef) {
      item.description = await fetchDescription(env, item.descriptionRef).catch(() => "");
    }
    const { score, reasons } = scoreItem(item);
    const token = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO opportunities
        (notice_id, title, agency, notice_type, naics_code, set_aside, posted_date,
         response_deadline, sam_url, description_excerpt, score, matched_reasons,
         respond_token, source, award_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        item.id,
        item.title,
        item.agency,
        item.noticeType,
        item.naicsCode,
        item.setAside,
        item.postedDate,
        item.responseDeadline,
        item.url,
        (item.description || "").slice(0, 500),
        score,
        JSON.stringify(reasons),
        token,
        item.source,
        item.awardAmount,
      )
      .run();

    if (score >= threshold) {
      newQualifying.push({ ...item, score, reasons, token });
    }
  }

  if (newQualifying.length > 0 && env.RESEND_API_KEY) {
    await sendDigestEmail(env, newQualifying);
  }

  return { totalSeen, totalNew, qualifying: newQualifying.length };
}

// ── USASpending ingest endpoint (called by GitHub Actions) ─────────────────

async function handleIngestUsaSpending(request, env) {
  if (!env.INGEST_SECRET) {
    return jsonResponse({ error: "INGEST_SECRET not configured" }, 500);
  }
  if (request.headers.get("X-Ingest-Secret") !== env.INGEST_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawResults = Array.isArray(body.results) ? body.results : [];
  const items = mapUsaSpendingResults(rawResults);
  const result = await ingestAndNotify(env, items);
  return jsonResponse(result);
}

// ── Source 1: SAM.gov open solicitations ────────────────────────────────────

async function scanSamGov(env) {
  const naicsCodes = (env.NAICS_CODES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const today = new Date();
  const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
  const postedFrom = formatSamDate(twoDaysAgo);
  const postedTo = formatSamDate(today);

  const byNoticeId = new Map();
  for (const code of naicsCodes) {
    const results = await fetchOpportunities(env, code, postedFrom, postedTo);
    for (const opp of results) {
      if (opp.noticeId) byNoticeId.set(opp.noticeId, opp);
    }
  }

  const items = [];
  for (const opp of byNoticeId.values()) {
    items.push({
      id: opp.noticeId,
      source: "sam_gov",
      title: opp.title || "(untitled)",
      agency: opp.fullParentPathName || opp.department || null,
      noticeType: opp.type || "Solicitation",
      naicsCode: opp.naicsCode || null,
      setAside: opp.typeOfSetAside || null,
      postedDate: opp.postedDate || null,
      responseDeadline: opp.responseDeadLine || null,
      url: opp.uiLink || `https://sam.gov/workspace/contract/opp/${opp.noticeId}/view`,
      description: "", // resolved lazily in runScan, only for new items
      descriptionRef: opp.description || null,
      awardAmount: null,
    });
  }
  return items;
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
  const list = data.opportunitiesData || data.data || data.results || [];
  if (!Array.isArray(list)) {
    console.error("[aegis-samgov-bot] Unrecognized SAM.gov response shape, keys:", Object.keys(data));
    return [];
  }
  return list;
}

async function fetchDescription(env, desc) {
  // The search API's "description" field is often a URL to fetch the full
  // notice text separately, not the text itself. Handle both cases.
  if (!desc) return "";
  if (typeof desc === "string" && /^https?:\/\//.test(desc)) {
    try {
      const res = await fetch(`${desc}${desc.includes("?") ? "&" : "?"}api_key=${env.SAM_API_KEY}`);
      if (!res.ok) return "";
      const text = await res.text();
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

// ── Source 2: USASpending.gov awarded contracts (prospect signal) ─────────
//
// The fetch itself happens in GitHub Actions (see file header) — this just
// maps the raw API rows it forwards into the same item shape SAM.gov uses.

function mapUsaSpendingResults(results) {
  return results
    .filter((r) => r.generated_internal_id)
    .map((r) => ({
      id: `usa_${r.generated_internal_id}`,
      source: "usaspending",
      title: `${r["Recipient Name"] || "Unknown recipient"} — ${truncate(r["Description"] || "(no description)", 80)}`,
      agency: r["Awarding Agency"] || null,
      noticeType: "Awarded Contract (prospect, not open for bid)",
      naicsCode: null,
      setAside: null,
      postedDate: r["Period of Performance Start Date"] || null,
      responseDeadline: null,
      url: `https://www.usaspending.gov/award/${r.generated_internal_id}`,
      description: r["Description"] || "",
      awardAmount: typeof r["Award Amount"] === "number" ? r["Award Amount"] : null,
    }));
}

// ── Source 3: Adzuna job postings (company-hiring signal) ─────────────────
//
// A company posting jobs for compliance/cybersecurity/IT roles may prefer
// to buy that expertise from Aegis instead of hiring it. Separately, a law
// firm hiring attorneys in TX/OK is a plausible LexFlow prospect -- run as
// its own search since "attorney" isn't a compliance keyword.

const ADZUNA_LEAD_KEYWORDS = ["fedramp", "cmmc compliance", "cybersecurity compliance", "information security officer"];
const ADZUNA_LEGAL_LOCATIONS = ["Texas", "Oklahoma"];
// Adzuna's "what" search is relevance-based, not a strict match -- a
// what=attorney query returned "Medical Records Specialist" and "Sales
// Executive" postings (confirmed by testing) purely because they were in
// the same location bucket. Require the role itself to actually be legal.
const LEGAL_TITLE_PATTERN = /\battorney\b|\bcounsel\b|\besq\.?\b/i;

async function scanAdzuna(env) {
  const items = [];

  for (const keyword of ADZUNA_LEAD_KEYWORDS) {
    const results = await fetchAdzuna(env, { what: keyword, max_days_old: 2, results_per_page: 20 });
    for (const r of results) items.push(mapAdzunaResult(r, "adzuna", null));
  }

  for (const location of ADZUNA_LEGAL_LOCATIONS) {
    const results = await fetchAdzuna(env, { what: "attorney", where: location, max_days_old: 2, results_per_page: 20 });
    for (const r of results) {
      if (!LEGAL_TITLE_PATTERN.test(r.title || "")) continue;
      items.push(mapAdzunaResult(r, "adzuna_legal", `Legal Hiring Signal (${location})`));
    }
  }

  return items;
}

async function fetchAdzuna(env, params) {
  const query = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID,
    app_key: env.ADZUNA_APP_KEY,
    sort_by: "date",
    ...params,
  });
  const res = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${query}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Adzuna ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

function mapAdzunaResult(r, source, forcedReason) {
  const company = r.company?.display_name || "Unknown company";
  return {
    id: `adzuna_${r.id}`,
    source,
    title: `${company} — ${r.title || "(untitled posting)"}`,
    agency: r.location?.display_name || null,
    noticeType: "Job Posting (hiring signal, not open for bid)",
    naicsCode: null,
    setAside: null,
    postedDate: r.created || null,
    responseDeadline: null,
    url: r.redirect_url,
    description: r.description || "",
    awardAmount: null,
    forcedReason,
  };
}

// ── Source 4: USAJOBS federal postings ──────────────────────────────────────
//
// Federal-only, so this is a weaker signal than Adzuna for "buy from Aegis
// instead of hiring" (agencies don't substitute a consultant for a hire the
// way a private company might) — kept mainly for the TX/OK attorney search,
// plus a general compliance/cyber sweep as a bonus. Auth requires the
// registered e-mail as User-Agent, not just the API key (USAJOBS-specific).

const USAJOBS_LEAD_KEYWORDS = ["fedramp", "cmmc", "cybersecurity compliance"];
const USAJOBS_LEGAL_LOCATIONS = ["Texas", "Oklahoma"];

async function scanUsaJobs(env) {
  const items = [];

  for (const keyword of USAJOBS_LEAD_KEYWORDS) {
    const results = await fetchUsaJobs(env, { Keyword: keyword, DatePosted: "2", ResultsPerPage: "25" });
    for (const r of results) items.push(mapUsaJobsResult(r, "usajobs", null));
  }

  for (const location of USAJOBS_LEGAL_LOCATIONS) {
    const results = await fetchUsaJobs(env, {
      PositionTitle: "Attorney",
      LocationName: location,
      DatePosted: "2",
      ResultsPerPage: "25",
    });
    for (const r of results) {
      const title = r.MatchedObjectDescriptor?.PositionTitle || "";
      if (!LEGAL_TITLE_PATTERN.test(title)) continue;
      items.push(mapUsaJobsResult(r, "usajobs_legal", `Legal Hiring Signal (${location}, federal)`));
    }
  }

  return items;
}

async function fetchUsaJobs(env, params) {
  const query = new URLSearchParams(params);
  const res = await fetch(`https://data.usajobs.gov/api/search?${query}`, {
    headers: {
      Host: "data.usajobs.gov",
      "User-Agent": env.USAJOBS_EMAIL,
      "Authorization-Key": env.USAJOBS_API_KEY,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`USAJOBS ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.SearchResult?.SearchResultItems || [];
}

function mapUsaJobsResult(r, source, forcedReason) {
  const d = r.MatchedObjectDescriptor || {};
  return {
    id: `usajobs_${r.MatchedObjectId}`,
    source,
    title: `${d.DepartmentName || "Federal agency"} — ${d.PositionTitle || "(untitled posting)"}`,
    agency: d.PositionLocationDisplay || d.OrganizationName || null,
    noticeType: "Federal Job Posting (hiring signal, not open for bid)",
    naicsCode: null,
    setAside: null,
    postedDate: d.PublicationStartDate || null,
    responseDeadline: d.ApplicationCloseDate || null,
    url: d.PositionURI || null,
    description: d.QualificationSummary || d.UserArea?.Details?.JobSummary || "",
    awardAmount: null,
    forcedReason,
  };
}

// ── Scoring (deterministic, no LLM) ────────────────────────────────────────

function scoreItem(item) {
  const haystack = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  const reasons = new Set();
  let score = 0;

  for (const rule of KEYWORD_RULES) {
    if (haystack.includes(rule.term)) {
      score += rule.weight;
      reasons.add(rule.label);
    }
  }

  if (item.forcedReason) {
    score += 25;
    reasons.add(item.forcedReason);
  }

  // Strict exact-code match only — never fall back to a "veteran" text
  // search. Many VA opportunities/awards mention "veteran" throughout
  // (it's the agency's name) with no actual veteran-owned set-aside.
  const setAsideCode = (item.setAside || "").toUpperCase();
  if (VETERAN_SET_ASIDE_CODES.some((c) => setAsideCode === c)) {
    score += VETERAN_SET_ASIDE_WEIGHT;
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

async function sendDigestEmail(env, items) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const sorted = [...items].sort((a, b) => b.score - a.score);

  const cardsHtml = sorted
    .map((item) => {
      const approveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve`;
      const declineUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=decline`;
      const saveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=save`;
      const sourceLabel =
        item.source === "usaspending" ? "AWARDED CONTRACT — PROSPECT" :
        item.source === "adzuna" ? "HIRING SIGNAL — PROSPECT" :
        item.source === "adzuna_legal" ? "LEGAL HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs" ? "FEDERAL HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs_legal" ? "FEDERAL LEGAL HIRING SIGNAL — PROSPECT" :
        "OPEN SOLICITATION";
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <div style="font-size:12px;font-weight:700;color:#856404;text-transform:uppercase;letter-spacing:.08em">
            Score: ${item.score}/100 &nbsp;·&nbsp; ${sourceLabel}
          </div>
          <h3 style="margin:6px 0">${escHtml(item.title)}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">
            ${item.agency ? escHtml(item.agency) + " · " : ""}
            ${item.naicsCode ? "NAICS " + escHtml(item.naicsCode) + " · " : ""}
            ${item.setAside ? escHtml(item.setAside) + " · " : ""}
            ${item.awardAmount ? "Award: $" + Math.round(item.awardAmount).toLocaleString() : ""}
          </p>
          <p style="margin:8px 0;font-size:14px"><strong>Why matched:</strong> ${item.reasons.map((r) => `✓ ${escHtml(r)}`).join(" &nbsp; ")}</p>
          <p style="margin:8px 0;font-size:14px">
            <a href="${escHtml(item.url)}">View ${
              item.source === "usaspending" ? "on USASpending.gov" :
              item.source.startsWith("adzuna") || item.source.startsWith("usajobs") ? "job posting" :
              "on SAM.gov"
            }</a>
            ${item.responseDeadline ? ` · Response due: ${escHtml(item.responseDeadline)}` : ""}
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
    subject: `${sorted.length} new matching item${sorted.length === 1 ? "" : "s"} (SAM.gov + awarded contracts)`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <h2>New opportunities &amp; prospects</h2>
      <p style="color:#555">Scored against your keyword rules. "Awarded Contract" items are companies that just won a contract that may need help performing on it — not something to bid on. Nothing here was auto-approved.</p>
      ${cardsHtml}
    </div>`,
    text: sorted
      .map(
        (item) =>
          `[${item.score}/100] ${item.source === "usaspending" ? "AWARDED — " : ""}${item.title}\nWhy: ${item.reasons.join(", ")}\n${item.url}\nApprove: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=approve\nDecline: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=decline`,
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


function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
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
