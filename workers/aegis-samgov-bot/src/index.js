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
 * Phase 2A: approving a sam_gov item has Claude draft a requirements
 * checklist from the full solicitation text (re-fetched fresh from SAM.gov
 * by noticeid — D1 only stores a 500-char excerpt) and e-mails it, clearly
 * labeled as an unverified AI-drafted first pass, never authoritative. The
 * prompt is strictly grounded: only report what's literally in the text,
 * never infer a plausible-sounding requirement.
 *
 * Phase 2B: approving a usaspending/adzuna/adzuna_legal/usajobs/usajobs_legal
 * item has Claude draft a short outreach e-mail instead, grounded only in
 * the D1 row's own data (company/title, why it matched, description
 * excerpt). None of those APIs return a contact e-mail or hiring-manager
 * name, so this is a DRAFT ONLY, e-mailed to Robert — never auto-sent to
 * the prospect. Robert finds the real recipient and sends it himself.
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
 *   ANTHROPIC_API_KEY — for the Phase 2A requirements-checklist draft.
 *                      Approve still works without it (falls back to just
 *                      the D1 status update) — checked at call time.
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
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
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

    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
    }

    // GET only renders a confirmation page -- no side effect. Crawlers,
    // e-mail safe-link scanners (Outlook/Google prefetch every link in an
    // e-mail to check for malware), and any bot that ignores robots.txt
    // could otherwise silently trigger an approve/decline before a human
    // ever clicks. Only a real button click (POST) commits the action.
    if (request.method === "GET" && url.pathname === "/respond") {
      return renderRespondConfirmation(env, url);
    }
    if (request.method === "POST" && url.pathname === "/respond") {
      return handleRespond(env, request, ctx);
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

const RESPOND_ACTIONS = ["approve", "decline", "save"];

async function loadRespondRow(env, id, token) {
  const row = await env.DB
    .prepare(
      `SELECT respond_token, title, source, agency, description_excerpt, award_amount,
              matched_reasons, sam_url, naics_code, set_aside
       FROM opportunities WHERE notice_id = ?`,
    )
    .bind(id)
    .first();
  if (!row || row.respond_token !== token) return null;
  return row;
}

// GET: read-only. Renders a confirmation page with a real <form method="post">
// button -- no DB write happens here, so a prefetching bot or scanner can
// safely fetch this URL with no effect.
async function renderRespondConfirmation(env, url) {
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action");

  if (!id || !token || !RESPOND_ACTIONS.includes(action)) {
    return htmlResponse("Invalid request.", 400);
  }
  const row = await loadRespondRow(env, id, token);
  if (!row) return htmlResponse("Invalid or expired link.", 403);

  const verb = action === "approve" ? "Approve" : action === "decline" ? "Decline" : "Save for later";
  return htmlResponse(
    `<h2>${verb}?</h2>
     <p>"${escHtml(row.title)}"</p>
     <form method="post" action="/respond">
       <input type="hidden" name="id" value="${escHtml(id)}">
       <input type="hidden" name="token" value="${escHtml(token)}">
       <input type="hidden" name="action" value="${escHtml(action)}">
       <button type="submit" style="background:#0E141B;color:#fff;padding:10px 20px;border:none;border-radius:4px;font-size:15px;cursor:pointer">Confirm: ${verb}</button>
     </form>`,
    200,
  );
}

// POST: the only path that actually mutates state, and only in response to
// a real form submission (a button click), never a bare GET fetch.
async function handleRespond(env, request, ctx) {
  const form = await request.formData().catch(() => null);
  const id = form?.get("id");
  const token = form?.get("token");
  const action = form?.get("action");

  if (!id || !token || !RESPOND_ACTIONS.includes(action)) {
    return htmlResponse("Invalid request.", 400);
  }
  const row = await loadRespondRow(env, id, token);
  if (!row) return htmlResponse("Invalid or expired link.", 403);

  const status = action === "approve" ? "approved" : action === "decline" ? "declined" : "saved";
  await env.DB.prepare("UPDATE opportunities SET status = ?, updated_at = datetime('now') WHERE notice_id = ?")
    .bind(status, id)
    .run();

  let extra = "";
  const PROSPECT_SOURCES = ["usaspending", "adzuna", "adzuna_legal", "usajobs", "usajobs_legal"];
  if (action === "approve" && env.ANTHROPIC_API_KEY) {
    if (row.source === "sam_gov") {
      ctx.waitUntil(
        draftSamGovChecklist(env, id, row.title).catch((err) =>
          console.error("[aegis-samgov-bot] Checklist draft failed:", err.message),
        ),
      );
      extra = " Drafting a requirements checklist now — check your e-mail in about a minute.";
    } else if (PROSPECT_SOURCES.includes(row.source)) {
      ctx.waitUntil(
        draftOutreachEmail(env, row).catch((err) =>
          console.error("[aegis-samgov-bot] Outreach draft failed:", err.message),
        ),
      );
      extra = " Drafting an outreach e-mail now — check your e-mail in about a minute.";
    }
  }

  return htmlResponse(`Marked "${escHtml(row.title)}" as <strong>${status}</strong>.${extra}`, 200);
}

// ── Phase 2A: AI-drafted requirements checklist on Approve (sam_gov only) ──
//
// Fetches the full solicitation text fresh from SAM.gov (D1 only stores a
// 500-char excerpt) and has Claude extract a checklist. Strictly grounded —
// the prompt forbids inferring anything not literally in the text — and the
// e-mail is labeled as an unverified first pass, not authoritative.

async function draftSamGovChecklist(env, noticeId, title) {
  const params = new URLSearchParams({ api_key: env.SAM_API_KEY, noticeid: noticeId, limit: "1" });
  const res = await fetch(`${SAM_API}?${params}`);
  if (!res.ok) throw new Error(`SAM.gov lookup ${res.status}`);
  const data = await res.json();
  const opp = data.opportunitiesData?.[0];
  if (!opp) throw new Error("Notice not found on re-fetch");

  const description = await fetchDescription(env, opp.description);
  const resourceLinks = Array.isArray(opp.resourceLinks) ? opp.resourceLinks : [];

  const checklist = await callAnthropicForChecklist(env, { title, description, opp });

  await sendChecklistEmail(env, { title, noticeId, opp, resourceLinks, checklist });
}

async function callAnthropicForChecklist(env, { title, description, opp }) {
  const userContent = [
    `Solicitation title: ${title}`,
    `Notice type: ${opp.type || "unknown"}`,
    `NAICS: ${opp.naicsCode || "unknown"}`,
    `Set-aside: ${opp.typeOfSetAside || "none stated"}`,
    `Response deadline (as recorded by SAM.gov): ${opp.responseDeadLine || "not stated"}`,
    "",
    "Full solicitation text:",
    description || "(no description text available)",
  ].join("\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      // 2048 was too low: Opus 5 has adaptive thinking on by default, and a
      // detailed solicitation (20+ requirements) overran that budget before
      // the JSON closed -- confirmed by testing (every checklist came back
      // truncated mid-string, two came back completely empty).
      max_tokens: 8192,
      system: CHECKLIST_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.content?.find((b) => b.type === "text")?.text ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { parseError: true, raw };
  }
}

const CHECKLIST_SYSTEM_PROMPT = `\
You are extracting a requirements checklist from a U.S. federal government solicitation for a veteran-owned small business considering whether to bid.

STRICT GROUNDING RULE: only report facts literally present in the provided text. Never infer, guess, or fill in a plausible-sounding requirement that is not explicitly stated. If something is not mentioned, say so — do not omit the field or invent an answer.

Respond with ONLY a raw JSON object, no markdown fences, no preamble:
{
  "summary": "2-3 sentence plain-English summary of what is being solicited, using only what the text states",
  "deadline": "the response deadline as stated in the text, or \\"not stated in solicitation text\\"",
  "keyRequirements": ["specific requirement 1 as stated", "specific requirement 2 as stated"],
  "certificationsOrClearances": ["any required certification, clearance, or set-aside status literally mentioned, or empty array if none mentioned"],
  "openQuestions": ["anything a bidder would need to clarify because the text is ambiguous or silent on it"]
}`;

async function sendChecklistEmail(env, { title, noticeId, opp, resourceLinks, checklist }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  const samUrl = opp.uiLink || `https://sam.gov/workspace/contract/opp/${noticeId}/view`;

  const bodyHtml = checklist.parseError
    ? `<p style="color:#c0392b">AI output could not be parsed as JSON. Raw output below.</p>
       <pre style="white-space:pre-wrap;font-size:13px;background:#f9f9f9;padding:12px;border:1px solid #ddd">${escHtml(checklist.raw)}</pre>`
    : `
      <p><strong>Summary:</strong> ${escHtml(checklist.summary || "")}</p>
      <p><strong>Deadline:</strong> ${escHtml(checklist.deadline || "not stated")}</p>
      <p><strong>Key requirements:</strong></p>
      <ul>${(checklist.keyRequirements || []).map((r) => `<li>${escHtml(r)}</li>`).join("") || "<li>None extracted</li>"}</ul>
      <p><strong>Certifications / clearances mentioned:</strong></p>
      <ul>${(checklist.certificationsOrClearances || []).map((r) => `<li>${escHtml(r)}</li>`).join("") || "<li>None mentioned</li>"}</ul>
      <p><strong>Open questions to clarify:</strong></p>
      <ul>${(checklist.openQuestions || []).map((r) => `<li>${escHtml(r)}</li>`).join("") || "<li>None</li>"}</ul>`;

  const linksHtml = resourceLinks.length
    ? `<p><strong>Attachments:</strong></p><ul>${resourceLinks.map((l) => `<li><a href="${escHtml(l)}">${escHtml(l)}</a></li>`).join("")}</ul>`
    : "";

  await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `Requirements checklist (AI draft) — ${title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted from the solicitation text. Not authoritative — verify every item against the actual document before relying on it.
      </p>
      <h2>${escHtml(title)}</h2>
      <p><a href="${escHtml(samUrl)}">View on SAM.gov</a></p>
      ${bodyHtml}
      ${linksHtml}
    </div>`,
    text: `AI-drafted checklist for: ${title}\n(Not authoritative — verify against the actual solicitation.)\n\n${JSON.stringify(checklist, null, 2)}\n\n${samUrl}`,
  });
}

// ── Phase 2B: AI-drafted outreach e-mail on Approve (prospect sources) ─────
//
// usaspending/adzuna/usajobs rows are "this company might need Aegis" leads,
// not open solicitations -- there's no bid to draft a checklist for. None of
// those APIs return a contact e-mail or hiring-manager name, so the real
// ceiling here is "draft it, Robert finds the recipient and sends it
// himself" -- never auto-send. The draft goes to Robert, never the prospect.

// Real Aegis service names/one-liners only, so the model can reference an
// actual offering instead of inventing one. Keep in sync with fees.html.
const AEGIS_SERVICES_CONTEXT = `\
- FedRAMP 20x Readiness Kickoff ($3,000): advisory gap review and evidence-mapping against current FedRAMP 20x rules
- AI Visibility Audit & Strategy ($500): AI search visibility audit + 90-day roadmap
- Content & Schema Rewrite ($1,500): site copy rewrite with schema markup for AI-search readability
- Structured Data Implementation ($500): JSON-LD schema so AI assistants can read business facts from a site
- Google Business Profile Optimization ($300) and Local Citation Building ($200): local search/AI visibility hygiene
- Website Migration & Redesign ($3,000): marketing-site build
- LexFlow (part of AegisOS): legal practice management software -- client/matter records, trust/IOLTA foundation, billing`;

async function draftOutreachEmail(env, row) {
  const reasons = JSON.parse(row.matched_reasons || "[]");
  const isLegal = row.source === "adzuna_legal" || row.source === "usajobs_legal";

  const context = [
    `Source: ${row.source}`,
    `Title/company line as recorded: ${row.title}`,
    row.agency ? `Location/agency: ${row.agency}` : null,
    row.award_amount ? `Award amount: $${Math.round(row.award_amount).toLocaleString()}` : null,
    `Why this matched Aegis's criteria: ${reasons.join(", ") || "none recorded"}`,
    `Excerpt of the original posting/contract description: ${row.description_excerpt || "(none captured)"}`,
    row.sam_url ? `Source link: ${row.sam_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const draft = await callAnthropicForOutreach(env, { context, isLegal });
  await sendOutreachDraftEmail(env, { row, draft, isLegal });
}

// Newark Firm is a general-practice law firm -- do not claim any specialty
// or practice area beyond that. The pitch is a B2B legal relationship
// (referral, overflow capacity, outside-counsel support), never AegisOS/
// LexFlow -- this draft has nothing to do with Aegis Global Holdings.
const LEGAL_OUTREACH_SYSTEM = `\
You are drafting a SHORT, formal B2B outreach e-mail for Robert, an attorney at Newark Firm, a general-practice law firm. Robert will send this himself from his own law-firm e-mail address. This is entirely separate from Aegis Global Holdings -- do NOT mention Aegis, AegisOS, LexFlow, or any software product anywhere in this draft.

STRICT GROUNDING RULE: use only the facts given below about the recipient (company/agency name, the role they are hiring for, location). Never invent details about their legal needs, their case volume, or their internal operations. Never claim Newark Firm has a specialty or practice area -- it is a general practice; do not imply otherwise.

CONTEXT FOR THE PITCH: the recipient organization appears to be hiring for an attorney/counsel role, based on a public job posting. Robert is not applying for that job and is not a candidate. He is proposing that Newark Firm and the recipient explore a business-to-business legal relationship -- for example, referral arrangements, overflow or outside-counsel capacity for matters beyond their team's current bandwidth, or general local counsel support. Frame this as one general practice firm reaching out to another legal department/firm professionally, not as a vendor pitch.

TONE AND STYLE -- formal attorney-to-attorney correspondence:
- No standalone greeting like "Hello," or "Hi," on its own line -- open with a formal salutation ("Dear [Company] Legal Team," or similar) or begin directly with the context sentence.
- No contractions anywhere (write "that is" not "that's", "we do not" not "we don't").
- No hype, no false familiarity, no filler transitions ("So," "Also," "Just wanted to...").
- Structure: one sentence of factual context (why you are writing) -> one sentence introducing Newark Firm as a general-practice firm -> the specific type of B2B relationship being proposed -> a single, low-pressure next step (e.g., a brief call) -> a brief, courteous closing sentence. No signature block.
- 100-160 words.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

async function callAnthropicForOutreach(env, { context, isLegal }) {
  const system = isLegal
    ? LEGAL_OUTREACH_SYSTEM
    : `\
You are drafting a SHORT, professional cold-outreach e-mail on behalf of Aegis Global Holdings, a veteran-owned technology/compliance consulting company, for Robert (the owner) to review before sending.

STRICT GROUNDING RULE: use only the facts given below about the recipient. Never invent details about their company, their internal operations, their needs, or their budget beyond what's stated. If you reference why Aegis might help, tie it directly and specifically to the "why this matched" reasons given -- don't generalize into generic sales language.

You may reference ONE of Aegis's real services from this list if it genuinely fits (do not invent a service or price not on this list):
${AEGIS_SERVICES_CONTEXT}

TONE AND STYLE -- formal business-development correspondence, not a casual cold email:
- No standalone greeting like "Hello," or "Hi," on its own line -- either open with a formal salutation appropriate for an unnamed recipient ("Good afternoon," or "To the [Company] team,") or begin directly with the context sentence, no greeting at all.
- No contractions anywhere (write "that is" not "that's", "we do not" not "we don't", "I am" not "I'm").
- No hype, no false familiarity ("I noticed your company is doing great things!"), no filler transitions ("So," "Also," "Just wanted to..." to open a sentence).
- Precise, declarative sentences. Assume the recipient is a senior decision-maker with little time.
- Structure: one sentence of factual context (why you are writing) -> one sentence introducing Aegis Global Holdings -> the specific service and price -> a single, low-pressure next step -> a brief, courteous closing sentence. No signature block.
- 120-180 words.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: context }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.content?.find((b) => b.type === "text")?.text ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { parseError: true, raw };
  }
}

async function sendOutreachDraftEmail(env, { row, draft, isLegal }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const senderBanner = isLegal
    ? `<p style="background:#e8f4fd;border-left:3px solid #0E141B;padding:12px 16px;font-size:13px">
         📨 This is a Newark Firm draft, not Aegis. <strong>Send it yourself from robert@newarkfirm.com</strong> -- it was generated by this pipeline but has nothing to do with Aegis Global Holdings and must not go out from an Aegis address.
       </p>`
    : "";

  const draftHtml = draft.parseError
    ? `<p style="color:#c0392b">AI output could not be parsed as JSON. Raw output below.</p>
       <pre style="white-space:pre-wrap;font-size:13px;background:#f9f9f9;padding:12px;border:1px solid #ddd">${escHtml(draft.raw)}</pre>`
    : `
      <p><strong>Suggested subject:</strong> ${escHtml(draft.subject || "")}</p>
      <div style="background:#f9f9f9;border:1px solid #ddd;padding:16px;white-space:pre-wrap;font-family:sans-serif">${escHtml(draft.body || "")}</div>`;

  await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `${isLegal ? "Newark Firm outreach draft (AI, unsent)" : "Outreach draft (AI, unsent)"} — ${row.title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted, NOT sent to anyone. No contact e-mail is available from this source (${escHtml(row.source)}) --
        find the right recipient yourself before using this. Verify the claims against the source link below.
      </p>
      ${senderBanner}
      <h2>${escHtml(row.title)}</h2>
      ${row.sam_url ? `<p><a href="${escHtml(row.sam_url)}">Source link</a></p>` : ""}
      ${draftHtml}
    </div>`,
    text: `${isLegal ? "NEWARK FIRM DRAFT -- send from robert@newarkfirm.com, not Aegis.\n\n" : ""}AI-drafted outreach e-mail for: ${row.title}\n(NOT sent -- no contact info available, find the recipient yourself.)\n\n${JSON.stringify(draft, null, 2)}\n\n${row.sam_url || ""}`,
  });
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
