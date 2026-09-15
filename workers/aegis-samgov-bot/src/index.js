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
 * Follow-up reminders: a qualifying item that sits at status='new' (never
 * approved/declined/saved) gets re-e-mailed REMINDER_FIRST_AFTER_DAYS after
 * it was first flagged, then every REMINDER_INTERVAL_DAYS after that, up to
 * REMINDER_MAX_COUNT times — same Approve/Decline/Save links, still valid.
 * Runs as part of the daily cron, right after the scan. Items whose
 * response_deadline has already passed are excluded (nothing to act on).
 *
 * Outcome tracking (approved leads): OUTCOME_FIRST_CHECK_DAYS after Robert
 * approves an item, GET /outcome-linked e-mail asks how it went: won,
 * declined, waiting on a meeting (requires a date), or remind me later.
 * "Remind me later" re-asks every OUTCOME_CHECK_INTERVAL_DAYS, up to
 * OUTCOME_MAX_CHECKS times. Picking a meeting date schedules a check on
 * that date asking whether the meeting happened — yes triggers Phase 2C
 * (an AI-drafted follow-up e-mail, same strict-grounding + draft-only
 * pattern as Phase 2A/2B), no lets Robert pick a new date or mark it dead.
 * A separate weekly cron (WEEKLY_SUMMARY_CRON) e-mails a pipeline summary:
 * counts by outcome, win rate, what changed since the last summary, and
 * upcoming meetings — so the whole system can be tuned if the cadence or
 * thresholds aren't right.
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
 *
 * Same story for SBA SubNet (legacy.sba.gov/.../subcontracting-opportunities)
 * — confirmed via testing that it 403s every request from Cloudflare
 * Workers, so .github/workflows/subnet-scan.yml fetches and HTML-parses it
 * from a normal GitHub Actions runner and POSTs structured results to
 * POST /ingest-subnet (same INGEST_SECRET). SubNet items are subcontracting
 * opportunities posted by large prime contractors, not open government
 * solicitations, so approving one drafts a "propose teaming as your
 * subcontractor" e-mail (see buildSubcontractOutreachSystem), not a
 * requirements checklist.
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
  { term: "payment processing", weight: 20, label: "Payment Processing" },
  { term: "billing system", weight: 15, label: "Billing System" },
];

// Robert also owns three other businesses. Each gets its own NAICS codes
// (see NAICS_CODES vars below) and its own keyword rules -- mixing them
// into KEYWORD_RULES above would dilute Aegis's own scoring with terms
// that mean nothing to an IT/compliance consultancy, and vice versa. Every
// sam_gov item is tagged with a "business" (see buildNaicsBusinessMap) and
// scored only against that business's own rules. The veteran-set-aside
// bonus below stays universal across all four -- it's a structural bidding
// advantage regardless of which business would bid.
const LOANSERVICING_KEYWORD_RULES = [
  { term: "loan servicing", weight: 30, label: "Loan Servicing" },
  { term: "mortgage servicing", weight: 25, label: "Mortgage Servicing" },
  { term: "default servicing", weight: 20, label: "Default Servicing" },
  { term: "escrow", weight: 15, label: "Escrow" },
  { term: "consumer lending", weight: 15, label: "Consumer Lending" },
  { term: "collections", weight: 15, label: "Collections" },
];
const MODMEDIATIONS_KEYWORD_RULES = [
  { term: "alternative dispute resolution", weight: 30, label: "ADR" },
  { term: "mediation", weight: 30, label: "Mediation" },
  { term: "arbitration", weight: 25, label: "Arbitration" },
  { term: "dispute resolution", weight: 20, label: "Dispute Resolution" },
  { term: "neutral", weight: 10, label: "Neutral/Mediator" },
];
// Bare "attorney"/"counsel" deliberately excluded -- confirmed live during
// testing that a plain DOJ court-reporting-services contract scored as a
// Newark Firm match purely because its description said "UNITED STATES
// ATTORNEY'S OFFICE" (the office name, not a legal-services signal). Same
// false-positive class already fixed once for veteran-set-aside scoring
// (agency names containing "veteran" with no actual set-aside) -- narrative
// government text is full of office names ("District Attorney," "County
// Counsel," "Attorney General") that say nothing about a legal-services
// need. Every term below is specific enough that it wouldn't appear as
// part of an office name.
const NEWARKFIRM_KEYWORD_RULES = [
  { term: "outside counsel", weight: 30, label: "Outside Counsel" },
  { term: "general counsel", weight: 20, label: "General Counsel" },
  { term: "legal services", weight: 20, label: "Legal Services" },
  { term: "litigation support", weight: 20, label: "Litigation Support" },
  { term: "law firm", weight: 20, label: "Law Firm" },
];

const BUSINESS_KEYWORD_RULES = {
  aegis: KEYWORD_RULES,
  loanservicing: LOANSERVICING_KEYWORD_RULES,
  modmediations: MODMEDIATIONS_KEYWORD_RULES,
  newarkfirm: NEWARKFIRM_KEYWORD_RULES,
};
const BUSINESS_LABELS = {
  aegis: "Aegis Global Holdings",
  loanservicing: "Veteran Loan Servicing",
  modmediations: "Mod Mediations",
  newarkfirm: "Newark Firm",
};

function splitCsv(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Maps a NAICS code back to the business whose SAM.gov search codes
// (below) include it, so a fetched opportunity can be scored against the
// right business's keyword rules. Codes not found here (shouldn't happen
// since fetchOpportunities only ever searches codes drawn from these same
// four vars) fall back to "aegis" to preserve the original single-business
// behavior.
function buildNaicsBusinessMap(env) {
  const map = {};
  for (const code of splitCsv(env.NAICS_CODES)) map[code] = "aegis";
  for (const code of splitCsv(env.LOANSERVICING_NAICS_CODES)) map[code] = "loanservicing";
  for (const code of splitCsv(env.MODMEDIATIONS_NAICS_CODES)) map[code] = "modmediations";
  for (const code of splitCsv(env.NEWARKFIRM_NAICS_CODES)) map[code] = "newarkfirm";
  return map;
}

// Weighted highest of any single rule: a veteran set-aside is a structural
// bidding advantage (other bidders are excluded entirely), which matters
// more for "will Aegis actually win this" than a generic keyword hit.
const VETERAN_SET_ASIDE_WEIGHT = 35;
const VETERAN_SET_ASIDE_CODES = ["SDVOSBC", "SDVOSBS", "VSA", "VSS"];

// Follow-up reminders for qualifying items nobody has approved/declined/
// saved yet. First nudge REMINDER_FIRST_AFTER_DAYS after the item was
// first flagged; repeat every REMINDER_INTERVAL_DAYS after that; stop
// after REMINDER_MAX_COUNT nudges so this never turns into permanent spam
// for a lead Robert has consciously decided to just leave sitting.
const REMINDER_FIRST_AFTER_DAYS = 3;
const REMINDER_INTERVAL_DAYS = 3;
const REMINDER_MAX_COUNT = 3;

// Outcome tracking for approved leads: how did the outreach/checklist Robert
// approved actually turn out? OUTCOME_FIRST_CHECK_DAYS after approval, ask.
// If he snoozes it ("remind me later"), ask again every
// OUTCOME_CHECK_INTERVAL_DAYS, up to OUTCOME_MAX_CHECKS times. Picking
// "waiting for a meeting" requires a date; once that date arrives the bot
// asks whether it happened and, if yes, drafts a follow-up e-mail.
const OUTCOME_FIRST_CHECK_DAYS = 7;
const OUTCOME_CHECK_INTERVAL_DAYS = 7;
const OUTCOME_MAX_CHECKS = 4;
const OUTCOME_ACTIONS = [
  "sent",
  "won",
  "lost",
  "remind_later",
  "schedule_meeting",
  "meeting_occurred",
  "meeting_reschedule",
  "meeting_cancelled",
];
const OUTCOME_ACTIONS_NEEDING_DATE = ["schedule_meeting", "meeting_reschedule"];

// Sources where approving triggers an outreach draft (Phase 2B) rather than
// a requirements checklist (sam_gov, Phase 2A). Used both to route Approve
// and to decide which rows participate in same-company-same-day dedup.
const PROSPECT_SOURCES = ["usaspending", "adzuna", "adzuna_legal", "adzuna_loanservicing", "usajobs", "usajobs_legal", "subnet"];

// Short, factual identity lines for the SubNet subcontracting-outreach
// prompt -- these are the only claims the model is allowed to make about
// who's sending the e-mail, so keep them to what's already established
// elsewhere in this codebase (fees.html, lexflow.html, newarkfirm framing).
const BUSINESS_IDENTITY = {
  aegis: "Aegis Global Holdings, a veteran-owned IT and compliance consulting company",
  loanservicing: "Veteran Loan Servicing, a loan servicing company",
  modmediations: "Mod Mediations, a mediation and alternative dispute resolution provider",
  newarkfirm: "Newark Firm, a general-practice law firm",
};

// Weekly pipeline summary, separate cron entry (see wrangler.jsonc). Mondays
// 9am Central (14:00 UTC / 8am during CDT) -- same DST caveat as the daily
// cron. Cron has no native "every other week"; to switch to biweekly later,
// the cleanest change is checking bot_meta.last_summary_sent_at inside
// sendWeeklyTrackingSummary() and skipping if under 13 days -- not done
// here since Robert asked for weekly OR biweekly and this defaults weekly.
const WEEKLY_SUMMARY_CRON = "0 14 * * 1";

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

    // Every remaining route touches columns added by these migrations
    // (reminders, outcome tracking, company dedup) -- run them up front so
    // a route hit before the next cron cycle never sees "no such column".
    await ensureReminderColumns(env);
    await ensureOutcomeColumns(env);

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

    // Same GET-renders / POST-mutates split as /respond, for the outcome
    // check-in on already-approved leads (won / lost / meeting scheduling).
    if (request.method === "GET" && url.pathname === "/outcome") {
      return renderOutcomeConfirmation(env, url);
    }
    if (request.method === "POST" && url.pathname === "/outcome") {
      return handleOutcome(env, request, ctx);
    }

    // Manual trigger for testing without waiting for the cron.
    if (request.method === "GET" && url.pathname === "/run-now") {
      const result = await runScan(env);
      return jsonResponse(result);
    }

    // Manual trigger for testing follow-up reminders without waiting for
    // the cron or for REMINDER_FIRST_AFTER_DAYS to actually elapse.
    if (request.method === "GET" && url.pathname === "/send-reminders-now") {
      const result = await sendFollowUpReminders(env);
      return jsonResponse(result);
    }

    // Manual triggers for testing outcome tracking without waiting for the
    // cron or for the configured day thresholds to actually elapse.
    if (request.method === "GET" && url.pathname === "/check-outcomes-now") {
      const result = await checkOutcomes(env);
      return jsonResponse(result);
    }
    if (request.method === "GET" && url.pathname === "/send-tracking-summary-now") {
      const result = await sendWeeklyTrackingSummary(env);
      return jsonResponse(result);
    }

    // Receives raw USASpending.gov results fetched by the GitHub Actions
    // workflow (Workers can't reach that domain directly — see file header).
    if (request.method === "POST" && url.pathname === "/ingest-usaspending") {
      return handleIngestUsaSpending(request, env);
    }

    // Receives raw SBA SubNet results fetched by the GitHub Actions
    // workflow (SubNet 403s every Workers request — see handleIngestSubnet).
    if (request.method === "POST" && url.pathname === "/ingest-subnet") {
      return handleIngestSubnet(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === WEEKLY_SUMMARY_CRON) {
      ctx.waitUntil(sendWeeklyTrackingSummary(env));
    } else {
      ctx.waitUntil(runDailyJobs(env));
    }
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

  const result = await ingestAndNotify(env, allItems);
  // Notify on ANY fetch error, not just when nothing at all was found --
  // a SAM.gov-only failure used to go completely silent whenever Adzuna or
  // USAJOBS still turned up something new that day, which could hide a
  // real outage on one source for weeks. Confirmed missing items (in-range
  // NAICS, verified fetchable via a direct API call) that never reached D1
  // on days other sources kept a digest going -- this is why.
  if (fetchErrors.length > 0 && env.RESEND_API_KEY) {
    await notifyRobert(env, {
      subject: `Opportunity bot — ${fetchErrors.length} source${fetchErrors.length === 1 ? "" : "s"} failed today`,
      html: `<p>${result.totalNew} new item(s) were still found from other sources, but the following failed and were skipped entirely today:</p><ul>${fetchErrors.map((e) => `<li>${escHtml(e)}</li>`).join("")}</ul>`,
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
         respond_token, source, award_amount, company_key, business, contact_name, contact_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        PROSPECT_SOURCES.includes(item.source) ? normalizeCompanyKey(item.title) : null,
        item.business || "aegis",
        item.contactName || null,
        item.contactEmail || null,
      )
      .run();

    if (score >= threshold) {
      newQualifying.push({ ...item, score, reasons, token });
    }
  }

  if (newQualifying.length > 0 && env.RESEND_API_KEY) {
    // Only qualifying items get an AI summary -- these already passed the
    // score threshold, so the volume is small and bounded, unlike scoring
    // every item seen.
    if (env.ANTHROPIC_API_KEY) {
      for (const item of newQualifying) {
        item.aiSummary = await summarizeForDigest(env, item).catch((err) => {
          console.error("[aegis-samgov-bot] Digest summary failed:", err.message);
          return null;
        });
      }
    }
    await sendDigestEmail(env, newQualifying);
  }

  return { totalSeen, totalNew, qualifying: newQualifying.length };
}

// ── Daily cron orchestration ─────────────────────────────────────────────

async function runDailyJobs(env) {
  await ensureReminderColumns(env);
  await ensureOutcomeColumns(env);
  await runScan(env);
  await sendFollowUpReminders(env);
  await checkOutcomes(env);
}

// ── Follow-up reminders ──────────────────────────────────────────────────

// Idempotent — safe to call every day. D1 has no ALTER TABLE ... IF NOT
// EXISTS, so we just try the ALTER and swallow "duplicate column".
async function ensureReminderColumns(env) {
  const statements = [
    // Belt-and-suspenders: add created_at too, in case the original table
    // doesn't have it — the reminder query needs a "first seen" timestamp
    // to measure days pending against.
    "ALTER TABLE opportunities ADD COLUMN created_at TEXT DEFAULT (datetime('now'))",
    "ALTER TABLE opportunities ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE opportunities ADD COLUMN last_reminded_at TEXT",
  ];
  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}

async function sendFollowUpReminders(env) {
  if (!env.RESEND_API_KEY) return { remindersSent: 0 };

  const threshold = Number(env.SCORE_THRESHOLD || "20");
  const { results } = await env.DB.prepare(
    `SELECT notice_id, title, agency, source, score, matched_reasons, respond_token,
            sam_url, response_deadline, reminder_count, created_at, business
     FROM opportunities
     WHERE status = 'new'
       AND score >= ?
       AND reminder_count < ?
       AND (julianday('now') - julianday(created_at)) >= ?
       AND (last_reminded_at IS NULL OR (julianday('now') - julianday(last_reminded_at)) >= ?)
       AND (response_deadline IS NULL OR response_deadline = '' OR date(response_deadline) >= date('now'))
     ORDER BY score DESC`,
  )
    .bind(threshold, REMINDER_MAX_COUNT, REMINDER_FIRST_AFTER_DAYS, REMINDER_INTERVAL_DAYS)
    .all();

  const rows = results || [];
  if (rows.length === 0) return { remindersSent: 0 };

  const items = rows.map((row) => ({
    id: row.notice_id,
    token: row.respond_token,
    title: row.title,
    agency: row.agency,
    source: row.source,
    business: row.business,
    score: row.score,
    reasons: JSON.parse(row.matched_reasons || "[]"),
    url: row.sam_url,
    responseDeadline: row.response_deadline,
    daysPending: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000),
    reminderNumber: row.reminder_count + 1,
  }));

  await sendReminderDigestEmail(env, items);

  const now = new Date().toISOString();
  for (const item of items) {
    await env.DB.prepare(
      "UPDATE opportunities SET reminder_count = reminder_count + 1, last_reminded_at = ? WHERE notice_id = ?",
    )
      .bind(now, item.id)
      .run();
  }

  return { remindersSent: items.length };
}

// ── Outcome tracking for approved leads ─────────────────────────────────────

// Idempotent — same pattern as ensureReminderColumns.
async function ensureOutcomeColumns(env) {
  const statements = [
    "ALTER TABLE opportunities ADD COLUMN outcome TEXT",
    "ALTER TABLE opportunities ADD COLUMN outcome_updated_at TEXT",
    "ALTER TABLE opportunities ADD COLUMN meeting_date TEXT",
    "ALTER TABLE opportunities ADD COLUMN outcome_check_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE opportunities ADD COLUMN outcome_check_sent_at TEXT",
    "ALTER TABLE opportunities ADD COLUMN meeting_check_sent_at TEXT",
    // company_key backs the same-company-same-day outreach dedup check;
    // outreach_drafted_at is when a draft actually went out (used both for
    // that dedup window and, via the "I sent this" outcome action, as the
    // real start of the follow-up clock instead of the approval time).
    "ALTER TABLE opportunities ADD COLUMN company_key TEXT",
    // Which of the four businesses (aegis/loanservicing/modmediations/
    // newarkfirm) a sam_gov item was scored for. NULL/'aegis' for every
    // pre-existing row and for every non-sam_gov source, matching the
    // single-business behavior this column didn't previously need to track.
    "ALTER TABLE opportunities ADD COLUMN business TEXT",
    // Real point-of-contact data SAM.gov, USAJOBS, and SubNet all actually
    // return but this bot previously discarded -- see mapSubnetResults,
    // mapUsaJobsResult, and scanSamGov's item.contactEmail.
    "ALTER TABLE opportunities ADD COLUMN contact_name TEXT",
    "ALTER TABLE opportunities ADD COLUMN contact_email TEXT",
    "ALTER TABLE opportunities ADD COLUMN outreach_drafted_at TEXT",
    "CREATE TABLE IF NOT EXISTS bot_meta (key TEXT PRIMARY KEY, value TEXT)",
  ];
  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}

// Finds approved leads due for a status check-in (never asked, or asked
// and snoozed) and approved leads whose scheduled meeting date has arrived,
// sends the relevant digest e-mail for each group, and stamps what was sent
// so the next cron run doesn't re-ask the same question immediately.
async function checkOutcomes(env) {
  if (!env.RESEND_API_KEY) return { asksSent: 0, meetingChecksSent: 0 };

  const { results: askRows } = await env.DB.prepare(
    `SELECT notice_id, title, agency, source, respond_token, sam_url, matched_reasons
     FROM opportunities
     WHERE status = 'approved'
       AND (
         (outcome IS NULL AND updated_at IS NOT NULL AND (julianday('now') - julianday(updated_at)) >= ?)
         OR (outcome = 'pending' AND outcome_check_count < ?
             AND outcome_check_sent_at IS NOT NULL
             AND (julianday('now') - julianday(outcome_check_sent_at)) >= ?)
       )
     ORDER BY updated_at ASC`,
  )
    .bind(OUTCOME_FIRST_CHECK_DAYS, OUTCOME_MAX_CHECKS, OUTCOME_CHECK_INTERVAL_DAYS)
    .all();

  const asks = askRows || [];
  if (asks.length > 0) {
    await sendOutcomeAskDigest(env, asks.map(toOutcomeItem));
    const now = new Date().toISOString();
    for (const row of asks) {
      await env.DB.prepare(
        `UPDATE opportunities
         SET outcome = 'pending', outcome_check_count = outcome_check_count + 1,
             outcome_check_sent_at = ?, outcome_updated_at = ?
         WHERE notice_id = ?`,
      )
        .bind(now, now, row.notice_id)
        .run();
    }
  }

  const { results: meetingRows } = await env.DB.prepare(
    `SELECT notice_id, title, agency, source, respond_token, sam_url, matched_reasons, meeting_date
     FROM opportunities
     WHERE status = 'approved'
       AND outcome = 'meeting_scheduled'
       AND meeting_date IS NOT NULL
       AND date(meeting_date) <= date('now')
       AND meeting_check_sent_at IS NULL
     ORDER BY meeting_date ASC`,
  ).all();

  const meetingChecks = meetingRows || [];
  if (meetingChecks.length > 0) {
    await sendMeetingCheckDigest(env, meetingChecks.map(toOutcomeItem));
    const now = new Date().toISOString();
    for (const row of meetingChecks) {
      await env.DB.prepare("UPDATE opportunities SET meeting_check_sent_at = ? WHERE notice_id = ?")
        .bind(now, row.notice_id)
        .run();
    }
  }

  return { asksSent: asks.length, meetingChecksSent: meetingChecks.length };
}

function toOutcomeItem(row) {
  return {
    id: row.notice_id,
    token: row.respond_token,
    title: row.title,
    agency: row.agency,
    source: row.source,
    reasons: JSON.parse(row.matched_reasons || "[]"),
    url: row.sam_url,
    meetingDate: row.meeting_date,
  };
}

// GET: read-only, renders a confirmation/form page. Actions that need a
// meeting date get a real <input type="date">; everything else is a plain
// confirm button — same safe-link pattern as /respond.
async function renderOutcomeConfirmation(env, url) {
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action");

  if (!id || !token || !OUTCOME_ACTIONS.includes(action)) {
    return htmlResponse("Invalid request.", 400);
  }
  const row = await loadRespondRow(env, id, token);
  if (!row) return htmlResponse("Invalid or expired link.", 403);

  const needsDate = OUTCOME_ACTIONS_NEEDING_DATE.includes(action);
  const label = {
    sent: "I sent/submitted this — start tracking",
    won: "Mark as won — got the contract",
    lost: "Mark as declined",
    remind_later: "Remind me later",
    schedule_meeting: "Record the meeting date",
    meeting_occurred: "Yes, the meeting happened — draft a follow-up",
    meeting_reschedule: "No — record a new meeting date",
    meeting_cancelled: "No meeting will occur",
  }[action];

  return htmlResponse(
    `<h2 style="margin:0 0 12px">${escHtml(label)}?</h2>
     <div style="border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin-bottom:20px;color:#333">${escHtml(row.title)}</div>
     <form method="post" action="/outcome">
       <input type="hidden" name="id" value="${escHtml(id)}">
       <input type="hidden" name="token" value="${escHtml(token)}">
       <input type="hidden" name="action" value="${escHtml(action)}">
       ${needsDate ? `<p><label>Meeting date: <input type="date" name="meeting_date" required style="margin-left:8px;padding:6px 8px"></label></p>` : ""}
       <button type="submit" style="background:#0E141B;color:#fff;padding:10px 20px;border:none;border-radius:4px;font-size:15px;cursor:pointer">Confirm</button>
     </form>`,
    200,
  );
}

// POST: the only path that mutates outcome state, and only from a real
// form submission.
async function handleOutcome(env, request, ctx) {
  const form = await request.formData().catch(() => null);
  const id = form?.get("id");
  const token = form?.get("token");
  const action = form?.get("action");
  const meetingDate = form?.get("meeting_date");

  if (!id || !token || !OUTCOME_ACTIONS.includes(action)) {
    return htmlResponse("Invalid request.", 400);
  }
  if (OUTCOME_ACTIONS_NEEDING_DATE.includes(action) && !meetingDate) {
    return htmlResponse("A meeting date is required.", 400);
  }
  const row = await loadRespondRow(env, id, token);
  if (!row) return htmlResponse("Invalid or expired link.", 403);

  const now = new Date().toISOString();
  let extra = "";

  if (action === "sent" || action === "remind_later") {
    // "sent" starts the tracking clock from when Robert actually sent/
    // submitted it (more accurate than approval time, since he may not
    // send it the same day he approves it). "remind_later" re-anchors the
    // same clock after a snooze. Same DB effect either way.
    await env.DB.prepare(
      "UPDATE opportunities SET outcome = 'pending', outcome_check_sent_at = ?, outcome_updated_at = ? WHERE notice_id = ?",
    )
      .bind(now, now, id)
      .run();
  } else if (action === "won") {
    await env.DB.prepare("UPDATE opportunities SET outcome = 'won', outcome_updated_at = ? WHERE notice_id = ?")
      .bind(now, id)
      .run();
  } else if (action === "lost" || action === "meeting_cancelled") {
    await env.DB.prepare("UPDATE opportunities SET outcome = 'lost', outcome_updated_at = ? WHERE notice_id = ?")
      .bind(now, id)
      .run();
  } else if (action === "schedule_meeting" || action === "meeting_reschedule") {
    await env.DB.prepare(
      `UPDATE opportunities
       SET outcome = 'meeting_scheduled', meeting_date = ?, meeting_check_sent_at = NULL, outcome_updated_at = ?
       WHERE notice_id = ?`,
    )
      .bind(meetingDate, now, id)
      .run();
  } else if (action === "meeting_occurred") {
    await env.DB.prepare("UPDATE opportunities SET outcome = 'meeting_held', outcome_updated_at = ? WHERE notice_id = ?")
      .bind(now, id)
      .run();
    if (env.ANTHROPIC_API_KEY) {
      ctx.waitUntil(
        draftMeetingFollowup(env, row).catch((err) =>
          console.error("[aegis-samgov-bot] Meeting follow-up draft failed:", err.message),
        ),
      );
      extra = " Drafting a follow-up e-mail now — check your e-mail in about a minute.";
    }
  }

  const summary = {
    sent: "pending — tracking started, we'll check in soon",
    won: "won",
    lost: "declined",
    remind_later: "pending — we'll ask again later",
    schedule_meeting: `meeting scheduled for ${meetingDate}`,
    meeting_reschedule: `meeting rescheduled to ${meetingDate}`,
    meeting_occurred: "meeting held",
    meeting_cancelled: "declined (meeting did not occur)",
  }[action];

  return htmlResponse(
    `<h2 style="margin:0 0 12px">✓ Done</h2>
     <div style="border:1px solid #e0e0e0;border-radius:6px;padding:16px;color:#333">
       <div style="margin-bottom:8px">${escHtml(row.title)}</div>
       <div>Marked as <strong>${escHtml(summary)}</strong>.${extra}</div>
     </div>`,
    200,
  );
}

// ── Phase 2C: AI-drafted meeting follow-up e-mail ───────────────────────────
//
// Triggered when Robert confirms a scheduled meeting actually happened.
// There is no transcript or notes from the meeting anywhere in this
// system, so the prompt is explicit that it must not invent anything
// supposedly discussed or agreed — this is a generic, warm "thank you for
// your time, here's a next step" draft, not a summary of the conversation.

const LEGAL_MEETING_FOLLOWUP_SYSTEM = `\
You are drafting a SHORT, formal follow-up e-mail for Robert, an attorney at Newark Firm (general practice), to send after a meeting he already had with this contact about a possible B2B legal relationship. Robert will send this himself from robert@newarkfirm.com. Do NOT mention Aegis, AegisOS, LexFlow, or any software product.

STRICT GROUNDING RULE: you have NO transcript or notes from the meeting -- do not invent anything that was supposedly discussed, decided, or promised. Write a generic, warm, professional thank-you-for-your-time follow-up that references the original context (the role/company from the initial outreach) and proposes a concrete next step (a follow-up call, sending information, or checking back in a set timeframe). Never claim a specific commitment was made.

TONE: formal attorney-to-attorney correspondence, no contractions, no hype, no signature block, 80-140 words.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block"
}`;

async function draftMeetingFollowup(env, row) {
  const reasons = JSON.parse(row.matched_reasons || "[]");
  const isLegal = row.source === "adzuna_legal" || row.source === "usajobs_legal";

  const context = [
    `Source: ${row.source}`,
    `Title/company line as recorded: ${row.title}`,
    row.agency ? `Location/agency: ${row.agency}` : null,
    `Why this matched: ${reasons.join(", ") || "none recorded"}`,
    `Excerpt of the original posting/contract description: ${row.description_excerpt || "(none captured)"}`,
    row.sam_url ? `Source link: ${row.sam_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const draft = await callAnthropicForFollowup(env, { context, isLegal });
  await sendFollowupDraftEmail(env, { row, draft, isLegal });
}

async function callAnthropicForFollowup(env, { context, isLegal }) {
  const system = isLegal
    ? LEGAL_MEETING_FOLLOWUP_SYSTEM
    : `\
You are drafting a SHORT, professional follow-up e-mail on behalf of Aegis Global Holdings, for Robert to send after a meeting he already had with this contact.

STRICT GROUNDING RULE: you have NO transcript or notes from the meeting -- do not invent anything that was supposedly discussed, decided, or promised. Write a generic, warm, professional thank-you-for-your-time follow-up that references the original context (why Aegis reached out) and proposes a concrete next step. Never claim a specific commitment was made. You may reference one real Aegis service from this list if it fits (do not invent a service or price not on this list):
${AEGIS_SERVICES_CONTEXT}

TONE: formal business-development correspondence, no contractions, no hype, no signature block, 90-150 words.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block"
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

async function sendFollowupDraftEmail(env, { row, draft, isLegal }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const senderBanner = isLegal
    ? `<p style="background:#e8f4fd;border-left:3px solid #0E141B;padding:12px 16px;font-size:13px">
         📨 This is a Newark Firm draft, not Aegis. <strong>Send it yourself from robert@newarkfirm.com</strong>.
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
    subject: `${isLegal ? "Newark Firm meeting follow-up (AI, unsent)" : "Meeting follow-up draft (AI, unsent)"} — ${row.title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted, NOT sent to anyone. No meeting notes were available — this is a generic thank-you/next-step follow-up. Edit before sending.
      </p>
      ${senderBanner}
      <h2>${escHtml(row.title)}</h2>
      ${draftHtml}
    </div>`,
    text: `${isLegal ? "NEWARK FIRM DRAFT -- send from robert@newarkfirm.com, not Aegis.\n\n" : ""}AI-drafted meeting follow-up for: ${row.title}\n(NOT sent.)\n\n${JSON.stringify(draft, null, 2)}`,
  });
}

// ── Outcome-tracking e-mails ─────────────────────────────────────────────────

async function sendOutcomeAskDigest(env, items) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const cardsHtml = items
    .map((item) => {
      const base = `${WORKER_URL}/outcome?id=${encodeURIComponent(item.id)}&token=${item.token}`;
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <h3 style="margin:6px 0">${escHtml(item.title)}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">${item.agency ? escHtml(item.agency) : ""}</p>
          <p style="margin:8px 0;font-size:14px">You approved this and an e-mail was drafted. How did it go?</p>
          <div style="margin-top:12px">
            <a href="${base}&action=won" style="background:#0E141B;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin:0 6px 6px 0;display:inline-block">I got the contract</a>
            <a href="${base}&action=schedule_meeting" style="background:#0E141B;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin:0 6px 6px 0;display:inline-block">Waiting for a meeting</a>
            <a href="${base}&action=lost" style="background:#f0f0f0;color:#333;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin:0 6px 6px 0;display:inline-block">Declined</a>
            <a href="${base}&action=remind_later" style="background:#f0f0f0;color:#333;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block">Remind me later</a>
          </div>
        </div>`;
    })
    .join("");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `How did it go? ${items.length} approved lead${items.length === 1 ? "" : "s"} to update`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <h2>Status check on approved leads</h2>
      <p style="color:#555">These were approved and had an e-mail drafted. Let us know where things stand so we can track win rate and follow up at the right time.</p>
      ${cardsHtml}
    </div>`,
    text: items
      .map(
        (item) =>
          `${item.title}\nGot the contract: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=won\nWaiting for a meeting: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=schedule_meeting\nDeclined: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=lost\nRemind me later: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=remind_later`,
      )
      .join("\n\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-samgov-bot] Outcome-ask e-mail failed ${res.status}:`, body);
  }
}

async function sendMeetingCheckDigest(env, items) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const cardsHtml = items
    .map((item) => {
      const base = `${WORKER_URL}/outcome?id=${encodeURIComponent(item.id)}&token=${item.token}`;
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <h3 style="margin:6px 0">${escHtml(item.title)}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">${item.agency ? escHtml(item.agency) : ""}</p>
          <p style="margin:8px 0;font-size:14px">Meeting was scheduled for ${escHtml(item.meetingDate)}. Did it happen?</p>
          <div style="margin-top:12px">
            <a href="${base}&action=meeting_occurred" style="background:#0E141B;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin:0 6px 6px 0;display:inline-block">Yes — draft follow-up</a>
            <a href="${base}&action=meeting_reschedule" style="background:#f0f0f0;color:#333;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin:0 6px 6px 0;display:inline-block">No — new date</a>
            <a href="${base}&action=meeting_cancelled" style="background:#f0f0f0;color:#333;padding:8px 14px;border-radius:4px;text-decoration:none;font-size:13px;display:inline-block">No meeting will occur</a>
          </div>
        </div>`;
    })
    .join("");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `Did it happen? ${items.length} meeting${items.length === 1 ? "" : "s"} to confirm`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <h2>Meeting check-in</h2>
      ${cardsHtml}
    </div>`,
    text: items
      .map(
        (item) =>
          `${item.title} (meeting was ${item.meetingDate})\nYes: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=meeting_occurred\nNo, new date: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=meeting_reschedule\nNo meeting: ${WORKER_URL}/outcome?id=${item.id}&token=${item.token}&action=meeting_cancelled`,
      )
      .join("\n\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-samgov-bot] Meeting-check e-mail failed ${res.status}:`, body);
  }
}

// ── Weekly pipeline tracking summary ────────────────────────────────────────

async function sendWeeklyTrackingSummary(env) {
  await ensureOutcomeColumns(env);
  if (!env.RESEND_API_KEY) return { sent: false };

  const lastRow = await env.DB.prepare("SELECT value FROM bot_meta WHERE key = 'last_summary_sent_at'").first();
  const since = lastRow?.value || null;

  const { results: counts } = await env.DB.prepare(
    `SELECT COALESCE(outcome, 'awaiting_check') AS bucket, COUNT(*) AS n
     FROM opportunities WHERE status = 'approved' GROUP BY bucket`,
  ).all();
  const byBucket = Object.fromEntries((counts || []).map((r) => [r.bucket, r.n]));

  const won = byBucket.won || 0;
  const lost = byBucket.lost || 0;
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  const sinceClause = since ? "outcome_updated_at >= ?" : "1 = 1";
  const { results: sinceRows } = await env.DB.prepare(
    `SELECT outcome, COUNT(*) AS n FROM opportunities
     WHERE status = 'approved' AND ${sinceClause} AND outcome IS NOT NULL
     GROUP BY outcome`,
  )
    .bind(...(since ? [since] : []))
    .all();
  const sinceByOutcome = Object.fromEntries((sinceRows || []).map((r) => [r.outcome, r.n]));

  const { results: upcoming } = await env.DB.prepare(
    `SELECT title, meeting_date FROM opportunities
     WHERE status = 'approved' AND outcome = 'meeting_scheduled' AND date(meeting_date) >= date('now')
     ORDER BY meeting_date ASC LIMIT 10`,
  ).all();

  const periodLabel = since ? `since ${since.slice(0, 10)}` : "all time (first summary)";

  const html = `<div style="font-family:sans-serif;max-width:640px">
    <h2>Lead pipeline tracking</h2>
    <p style="color:#555">Snapshot of every approved lead's outcome, plus what changed ${escHtml(periodLabel)}.</p>
    <table style="border-collapse:collapse;font-size:14px;width:100%;margin-bottom:20px">
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Awaiting first check-in</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${byBucket.awaiting_check || 0}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Pending (asked, no answer yet)</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${byBucket.pending || 0}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Meeting scheduled</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${byBucket.meeting_scheduled || 0}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Meeting held (follow-up drafted)</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${byBucket.meeting_held || 0}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Won</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${won}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">Declined / Lost</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${lost}</td></tr>
      ${winRate !== null ? `<tr><td style="padding:6px 10px;font-weight:700">Win rate</td><td style="padding:6px 10px;text-align:right;font-weight:700">${winRate}%</td></tr>` : ""}
    </table>
    <p style="font-size:14px"><strong>Changed ${escHtml(periodLabel)}:</strong> ${Object.entries(sinceByOutcome).map(([k, n]) => `${n} → ${escHtml(k)}`).join(", ") || "nothing yet"}</p>
    ${upcoming?.length ? `<p style="font-size:14px"><strong>Upcoming meetings:</strong></p><ul>${upcoming.map((r) => `<li>${escHtml(r.title)} — ${escHtml(r.meeting_date)}</li>`).join("")}</ul>` : ""}
    <p style="font-size:13px;color:#888">This runs weekly. Say the word if you'd rather it come every other week, or if the check-in timing (currently ${OUTCOME_FIRST_CHECK_DAYS} days after approval, repeating every ${OUTCOME_CHECK_INTERVAL_DAYS} days, up to ${OUTCOME_MAX_CHECKS} times) needs adjusting.</p>
  </div>`;

  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `Lead tracking summary — ${won} won / ${lost} lost / ${byBucket.pending || 0} pending`,
    html,
    text: `Approved leads: awaiting check-in ${byBucket.awaiting_check || 0}, pending ${byBucket.pending || 0}, meeting scheduled ${byBucket.meeting_scheduled || 0}, meeting held ${byBucket.meeting_held || 0}, won ${won}, lost ${lost}.${winRate !== null ? ` Win rate ${winRate}%.` : ""}`,
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO bot_meta (key, value) VALUES ('last_summary_sent_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(now)
    .run();

  return { sent: true };
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

// ── SBA SubNet ingest endpoint (called by GitHub Actions) ──────────────────
//
// SubNet (legacy.sba.gov/.../subcontracting-opportunities) 403s every
// request from Cloudflare Workers -- confirmed by testing, same class of
// problem as USASpending.gov. A GitHub Actions workflow fetches and parses
// the HTML there (normal outbound networking, no bot-blocking observed)
// and forwards structured results here. Each result already carries which
// business's keyword search found it (see subnet-scan.yml) -- SubNet's own
// keyword matching is loose (a plain "IT" search returned an HVAC listing
// in testing), so this is a candidate list, not a pre-filtered one; real
// filtering happens in scoreItem() same as every other source.

async function handleIngestSubnet(request, env) {
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
  const items = mapSubnetResults(rawResults);
  const result = await ingestAndNotify(env, items);
  return jsonResponse(result);
}

function mapSubnetResults(results) {
  return results
    .filter((r) => r.url && r.title)
    .map((r) => ({
      id: `subnet_${r.url.replace(/[^a-zA-Z0-9]+/g, "-").slice(-120)}`,
      source: "subnet",
      business: ["aegis", "loanservicing", "modmediations", "newarkfirm"].includes(r.business)
        ? r.business
        : "aegis",
      title: `${r.primeContractor || "Unknown prime"} — ${r.title}`,
      agency: r.placeOfPerformance || null,
      noticeType: "Subcontracting Opportunity (prime seeking a subcontractor)",
      naicsCode: r.naicsCode || null,
      setAside: null,
      postedDate: null,
      responseDeadline: r.closingDate || null,
      url: r.url.startsWith("http") ? r.url : `https://www.sba.gov${r.url}`,
      description: r.description || "",
      awardAmount: null,
      contactName: r.pointOfContactName || null,
      contactEmail: r.pointOfContactEmail || null,
    }));
}

// ── Source 1: SAM.gov open solicitations ────────────────────────────────────

async function scanSamGov(env) {
  const naicsBusinessMap = buildNaicsBusinessMap(env);
  const naicsCodes = Object.keys(naicsBusinessMap);
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
      // The actual code SAM.gov returns for this notice, not necessarily
      // the one it was found under -- falls back to "aegis" if it's not in
      // any of the four business NAICS lists (shouldn't normally happen).
      business: naicsBusinessMap[opp.naicsCode] || "aegis",
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
      // SAM.gov actually returns a real point of contact -- previously
      // discarded. Surfaced in the Phase 2A checklist e-mail so Robert
      // knows who to reach with questions instead of hunting for it.
      contactName: opp.pointOfContact?.[0]?.fullName || null,
      contactEmail: opp.pointOfContact?.[0]?.email || null,
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
      // Tagged by usaspending-scan.yml per which business's keyword search
      // found it (that workflow runs one query per business now, not just
      // Aegis's). Falls back to "aegis" for safety if ever missing.
      business: ["aegis", "loanservicing", "modmediations", "newarkfirm"].includes(r._business)
        ? r._business
        : "aegis",
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
// Paused TX/OK per Robert -- he's still practicing law in both states and
// wants to avoid Newark Firm outreach to firms he could professionally
// encounter there. Expanded to neighboring states instead of narrowing to
// nothing, so the pipeline keeps producing real leads.
const ADZUNA_LEGAL_LOCATIONS = ["Kansas", "Missouri", "Arkansas", "New Mexico", "Colorado"];
// Adzuna's "what" search is relevance-based, not a strict match -- a
// what=attorney query returned "Medical Records Specialist" and "Sales
// Executive" postings (confirmed by testing) purely because they were in
// the same location bucket. Require the role itself to actually be legal.
const LEGAL_TITLE_PATTERN = /\battorney\b|\bcounsel\b|\besq\.?\b/i;

// A company hiring loan-servicing staff in TX/OK is a plausible Veteran
// Loan Servicing outsourcing prospect -- same pattern as the legal search
// above, scoped to the same two states per Robert's explicit go-ahead.
const ADZUNA_LOANSERVICING_LOCATIONS = ["Texas", "Oklahoma"];
const LOANSERVICING_TITLE_PATTERN = /\bloan servicing\b|\bmortgage servicing\b|\bservicing specialist\b|\bdefault servicing\b|\bloss mitigation\b/i;

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

  for (const location of ADZUNA_LOANSERVICING_LOCATIONS) {
    const results = await fetchAdzuna(env, { what: "loan servicing", where: location, max_days_old: 2, results_per_page: 20 });
    for (const r of results) {
      if (!LOANSERVICING_TITLE_PATTERN.test(r.title || "")) continue;
      items.push(mapAdzunaResult(r, "adzuna_loanservicing", `Loan Servicing Hiring Signal (${location})`));
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
    // Legal-hiring-signal rows are Newark Firm prospects, not Aegis
    // ones -- previously left untagged (defaulted to "aegis" at insert
    // time), which mislabeled them in the digest even though outreach
    // drafting already correctly used the Newark Firm framing by source.
    business: source === "adzuna_legal" ? "newarkfirm" : source === "adzuna_loanservicing" ? "loanservicing" : "aegis",
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
// Same TX/OK pause as ADZUNA_LEGAL_LOCATIONS -- kept in sync.
const USAJOBS_LEGAL_LOCATIONS = ["Kansas", "Missouri", "Arkansas", "New Mexico", "Colorado"];

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
    // Same Newark Firm tagging fix as mapAdzunaResult.
    business: source === "usajobs_legal" ? "newarkfirm" : "aegis",
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
    // USAJOBS actually returns a real agency contact e-mail -- previously
    // discarded even though the outreach draft e-mail's warning banner
    // claims "no contact e-mail is available from this source." Surfaced
    // so Robert has a real recipient instead of hunting for one himself.
    contactEmail: d.UserArea?.Details?.AgencyContactEmail || null,
  };
}

// ── Scoring (deterministic, no LLM) ────────────────────────────────────────

function scoreItem(item) {
  const haystack = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  const reasons = new Set();
  let score = 0;
  const rules = BUSINESS_KEYWORD_RULES[item.business] || KEYWORD_RULES;

  for (const rule of rules) {
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

const RESPOND_ACTIONS = ["approve", "decline", "save", "approve_software", "approve_counselai"];
// Which prospect-source leads get a second "pitch our software" button in
// the digest, alongside the existing Newark Firm B2B / loan-servicing-
// outsourcing pitch -- Robert's explicit choice: offer both, don't replace
// either, so he can pick per lead (or approve both for a two-touch approach).
const SOFTWARE_PITCH_BUSINESSES = ["newarkfirm", "loanservicing"];
// CounselAI is offered as its own separate pitch (a third button), not just
// folded into the LexFlow pitch -- Newark Firm leads only, since it is a
// legal-research/drafting product. Still the same high-level, no-price,
// no-specific-features framing as the CounselAI mention inside the LexFlow
// pitch -- only how it's offered changes, not what's claimed.
const COUNSELAI_PITCH_BUSINESSES = ["newarkfirm"];

async function loadRespondRow(env, id, token) {
  const row = await env.DB
    .prepare(
      `SELECT respond_token, title, source, agency, description_excerpt, award_amount,
              matched_reasons, sam_url, naics_code, set_aside, business, contact_name, contact_email
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

  const verb =
    action === "approve" ? "Approve" :
    action === "decline" ? "Decline" :
    action === "approve_software" ? "Approve & draft software pitch" :
    action === "approve_counselai" ? "Approve & draft CounselAI pitch" :
    "Save for later";
  return htmlResponse(
    `<h2 style="margin:0 0 12px">${verb}?</h2>
     <div style="border:1px solid #e0e0e0;border-radius:6px;padding:16px;margin-bottom:20px;color:#333">${escHtml(row.title)}</div>
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

  const status =
    action === "approve" || action === "approve_software" || action === "approve_counselai" ? "approved" :
    action === "decline" ? "declined" :
    "saved";
  await env.DB.prepare("UPDATE opportunities SET status = ?, updated_at = datetime('now') WHERE notice_id = ?")
    .bind(status, id)
    .run();

  let extra = "";
  if (action === "approve" && env.ANTHROPIC_API_KEY) {
    if (row.source === "sam_gov") {
      ctx.waitUntil(
        draftSamGovChecklist(env, id, row.title).catch((err) =>
          console.error("[aegis-samgov-bot] Checklist draft failed:", err.message),
        ),
      );
      extra = " Drafting a requirements checklist now — check your e-mail in about a minute.";
    } else if (PROSPECT_SOURCES.includes(row.source)) {
      // draftOutreachEmail itself checks for other same-company approvals
      // already drafted today and, if found, merges them into one combined
      // e-mail instead of sending two separate pitches to the same company
      // on the same day.
      ctx.waitUntil(
        draftOutreachEmail(env, id, row).catch((err) =>
          console.error("[aegis-samgov-bot] Outreach draft failed:", err.message),
        ),
      );
      extra = " Drafting an outreach e-mail now — check your e-mail in about a minute.";
    }
  } else if (action === "approve_software" && env.ANTHROPIC_API_KEY) {
    ctx.waitUntil(
      draftSoftwarePitch(env, id, row).catch((err) =>
        console.error("[aegis-samgov-bot] Software pitch draft failed:", err.message),
      ),
    );
    extra = " Drafting a software pitch now — check your e-mail in about a minute.";
  } else if (action === "approve_counselai" && env.ANTHROPIC_API_KEY) {
    ctx.waitUntil(
      draftSoftwarePitch(env, id, row, { product: "CounselAI" }).catch((err) =>
        console.error("[aegis-samgov-bot] CounselAI pitch draft failed:", err.message),
      ),
    );
    extra = " Drafting a CounselAI pitch now — check your e-mail in about a minute.";
  }

  return htmlResponse(
    `<h2 style="margin:0 0 12px">✓ Done</h2>
     <div style="border:1px solid #e0e0e0;border-radius:6px;padding:16px;color:#333">
       <div style="margin-bottom:8px">${escHtml(row.title)}</div>
       <div>Marked as <strong>${escHtml(status)}</strong>.${extra}</div>
     </div>`,
    200,
  );
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

  const row = await env.DB.prepare("SELECT respond_token, business FROM opportunities WHERE notice_id = ?")
    .bind(noticeId)
    .first();

  await sendChecklistEmail(env, {
    title,
    noticeId,
    token: row?.respond_token,
    business: row?.business,
    // Pulled from the fresh re-fetch, not the days-old D1 copy -- more
    // likely to be current if the notice was amended since it was scanned.
    contactName: opp.pointOfContact?.[0]?.fullName || null,
    contactEmail: opp.pointOfContact?.[0]?.email || null,
    opp,
    resourceLinks,
    checklist,
  });
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

async function sendChecklistEmail(env, { title, noticeId, token, business, contactName, contactEmail, opp, resourceLinks, checklist }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  const samUrl = opp.uiLink || `https://sam.gov/workspace/contract/opp/${noticeId}/view`;
  const businessLabel = BUSINESS_LABELS[business] || BUSINESS_LABELS.aegis;
  const sentLink = token
    ? `<p style="margin-top:20px"><a href="${WORKER_URL}/outcome?id=${encodeURIComponent(noticeId)}&token=${token}&action=sent" style="background:#0E141B;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px">I submitted this bid — start tracking</a></p>`
    : "";
  const contactHtml = contactEmail
    ? `<p><strong>Point of contact:</strong> ${escHtml(contactName || "")} &lt;${escHtml(contactEmail)}&gt;</p>`
    : "";

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
    subject: `[${businessLabel}] Requirements checklist (AI draft) — ${title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted from the solicitation text. Not authoritative — verify every item against the actual document before relying on it.
      </p>
      <h2>${escHtml(title)}</h2>
      <p><a href="${escHtml(samUrl)}">View on SAM.gov</a></p>
      ${contactHtml}
      ${bodyHtml}
      ${linksHtml}
      ${sentLink}
    </div>`,
    text: `AI-drafted checklist for: ${title}\n(Not authoritative — verify against the actual solicitation.)\n${contactEmail ? `\nPoint of contact: ${contactName || ""} <${contactEmail}>\n` : ""}\n${JSON.stringify(checklist, null, 2)}\n\n${samUrl}${token ? `\n\nI submitted this: ${WORKER_URL}/outcome?id=${encodeURIComponent(noticeId)}&token=${token}&action=sent` : ""}`,
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

// ── Digest-time AI summary (qualifying items only) ──────────────────────────
//
// Robert's complaint: the digest's "Why matched" tags are real substring
// hits (kept, still auditable), but a boilerplate mention of a term like
// "fedramp" tells him nothing about what the solicitation actually asks
// for -- he was seeing the same keyword tag on unrelated opportunities and
// couldn't judge relevance without opening each one. This adds one
// strictly-grounded sentence on the actual ask, plus (Aegis items only)
// which real services could apply, plus a standing reminder to always
// consider offering the free AI Visibility Scan -- his own explicit ask,
// applied here since this note is internal (to Robert), never sent to a
// prospect, so it's safe regardless of which business the lead is for.
const DIGEST_SUMMARY_SYSTEM = `\
You are writing a SHORT internal note for Robert (the business owner) inside a daily lead digest, so he can judge relevance before deciding whether to approve a lead -- this note is never sent to anyone outside his own inbox.

STRICT GROUNDING RULE: describe only what the text literally says is being requested or sought. Never infer scope, budget, or requirements the text doesn't state. If the excerpt is too thin to say anything specific, say that plainly instead of guessing.

{{SERVICE_INSTRUCTION}}

Respond with ONLY a raw JSON object, no markdown fences:
{
  "summary": "1-2 sentences, plain language, on what is literally being requested -- not a restatement of the keyword tags",
  "relevantServices": ["real service name from the list above that plausibly applies, or an empty array if none do -- never invent one"]
}`;

async function summarizeForDigest(env, item) {
  const business = item.business || "aegis";
  const isAegis = business === "aegis";
  const serviceInstruction = isAegis
    ? `If a real Aegis service below plausibly applies, name it in relevantServices (never invent a service or price not on this list; leave the array empty if none genuinely fit):\n${AEGIS_SERVICES_CONTEXT}`
    : `This lead was scored for ${BUSINESS_IDENTITY[business] || BUSINESS_IDENTITY.aegis}, not Aegis Global Holdings -- leave relevantServices empty; do not invent or list Aegis services for it.`;
  const system = DIGEST_SUMMARY_SYSTEM.replace("{{SERVICE_INSTRUCTION}}", serviceInstruction);

  const context = [
    `Business this was scored for: ${BUSINESS_LABELS[business] || BUSINESS_LABELS.aegis}`,
    `Title: ${item.title}`,
    item.agency ? `Agency/location: ${item.agency}` : null,
    `Why this matched: ${item.reasons?.join(", ") || "none recorded"}`,
    `Excerpt: ${truncate(item.description || "(no description captured)", 1500)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 1024,
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
    return null;
  }
}

function describeOpportunity(r) {
  const reasons = JSON.parse(r.matched_reasons || "[]");
  return [
    `Source: ${r.source}`,
    `Title/company line as recorded: ${r.title}`,
    r.agency ? `Location/agency: ${r.agency}` : null,
    r.award_amount ? `Award amount: $${Math.round(r.award_amount).toLocaleString()}` : null,
    `Why this matched Aegis's criteria: ${reasons.join(", ") || "none recorded"}`,
    `Excerpt of the original posting/contract description: ${r.description_excerpt || "(none captured)"}`,
    r.sam_url ? `Source link: ${r.sam_url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// Which outreach framing a row needs -- these are mutually exclusive
// senders/pitches and must never be merged into one combined e-mail.
function outreachVariant(row) {
  if (row.source === "subnet") return "subcontract";
  if (row.source === "adzuna_legal" || row.source === "usajobs_legal") return "legal";
  return "aegis";
}

async function draftOutreachEmail(env, id, row) {
  const isLegal = row.source === "adzuna_legal" || row.source === "usajobs_legal";
  const isSubcontract = row.source === "subnet";
  const variant = outreachVariant(row);
  const companyKey = normalizeCompanyKey(row.title);

  // If another lead for the same company already got an outreach draft
  // today, pull it in and write ONE combined e-mail instead of sending the
  // same company two separate pitches on the same day. Only merges across
  // rows with the same outreach variant -- a Newark Firm B2B pitch, an
  // Aegis consulting pitch, and a SubNet subcontracting inquiry are
  // different senders/framings and must stay separate.
  let siblings = [];
  if (companyKey) {
    const { results } = await env.DB.prepare(
      `SELECT notice_id, title, source, agency, award_amount, matched_reasons, description_excerpt, sam_url
       FROM opportunities
       WHERE company_key = ? AND notice_id != ? AND outreach_drafted_at IS NOT NULL
         AND date(outreach_drafted_at) = date('now')`,
    )
      .bind(companyKey, id)
      .all();
    siblings = (results || []).filter((r) => outreachVariant(r) === variant);
  }

  const allOpportunities = [row, ...siblings];
  const context =
    allOpportunities.length > 1
      ? allOpportunities.map((r, i) => `--- Opportunity ${i + 1} of ${allOpportunities.length} ---\n${describeOpportunity(r)}`).join("\n\n")
      : describeOpportunity(row);

  // These sources are literally "this company is currently hiring for a
  // role we could instead perform for them" -- Robert's explicit ask was
  // to make sure the drafted e-mail actually proposes that outsourcing
  // angle, not just a generic capability mention. Legal-hiring-signal rows
  // are excluded: Newark Firm's pitch is a B2B referral/overflow
  // relationship with the firm, not "hire us instead of this attorney."
  const isHiringSignal = ["adzuna", "adzuna_loanservicing", "usajobs"].includes(row.source);

  const draft = await callAnthropicForOutreach(env, {
    context,
    isLegal,
    isSubcontract,
    isHiringSignal,
    business: row.business,
  });
  await sendOutreachDraftEmail(env, {
    row,
    id,
    draft,
    isLegal,
    isSubcontract,
    combinedWith: siblings.map((s) => s.title),
  });

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE opportunities SET outreach_drafted_at = ? WHERE notice_id = ?").bind(now, id).run();
  for (const s of siblings) {
    await env.DB.prepare("UPDATE opportunities SET outreach_drafted_at = ? WHERE notice_id = ?")
      .bind(now, s.notice_id)
      .run();
  }
}

// Newark Firm is a general-practice law firm -- do not claim any specialty
// or practice area beyond that. The pitch is a B2B legal relationship
// (referral, overflow capacity, outside-counsel support), never AegisOS/
// LexFlow -- this draft has nothing to do with Aegis Global Holdings.
const LEGAL_OUTREACH_SYSTEM = `\
You are drafting a SHORT, formal B2B outreach e-mail for Robert, an attorney at Newark Firm, a general-practice law firm. Robert will send this himself from his own law-firm e-mail address. This is entirely separate from Aegis Global Holdings -- do NOT mention Aegis, AegisOS, LexFlow, or any software product anywhere in this draft.

STRICT GROUNDING RULE: use only the facts given below about the recipient (company/agency name, the role they are hiring for, location). Never invent details about their legal needs, their case volume, or their internal operations. Never claim Newark Firm has a specialty or practice area -- it is a general practice; do not imply otherwise.

CONTEXT FOR THE PITCH: the recipient organization appears to be hiring for an attorney/counsel role, based on a public job posting. Robert is not applying for that job and is not a candidate. He is proposing that Newark Firm and the recipient explore a business-to-business legal relationship -- for example, referral arrangements, overflow or outside-counsel capacity for matters beyond their team's current bandwidth, or general local counsel support. Frame this as one general practice firm reaching out to another legal department/firm professionally, not as a vendor pitch.

TONE AND STYLE -- formal attorney-to-attorney correspondence that reads like a specific person wrote it, not a template:
- No standalone greeting like "Hello," or "Hi," on its own line -- open with a formal salutation ("Dear [Company] Legal Team," or similar) or begin directly with the context sentence.
- No contractions anywhere (write "that is" not "that's", "we do not" not "we don't").
- No hype, no false familiarity, no filler transitions ("So," "Also," "Just wanted to..."), and no stock AI-email openers ("I hope this finds you well," "I wanted to reach out," "I noticed that...").
- Cover, in whatever order and sentence count feels natural for this specific situation, not a rigid formula: why you are writing, that Newark Firm is a general-practice firm, the specific type of B2B relationship being proposed, and a single low-pressure next step (e.g., a brief call). Vary sentence length -- do not make every sentence the same length and shape, that is what makes an e-mail read as AI-generated. No signature block, no closing pleasantry that sounds like a form letter.
- 100-160 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate public signals about the SAME organization -- write ONE combined e-mail that naturally references the most relevant point(s), not two pitches stitched together. Never claim more signals exist than are actually listed.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

// SubNet items are posted by a large prime contractor looking for a
// subcontractor on a federal contract they already hold -- the pitch here
// is "we'd like to team with you on this specific posting," not a cold
// sales pitch, and it's the same shape regardless of which of the four
// businesses is sending it (only the identity line changes).
function buildSubcontractOutreachSystem(business) {
  const identity = BUSINESS_IDENTITY[business] || BUSINESS_IDENTITY.aegis;
  return `\
You are drafting a SHORT, professional e-mail from ${identity} to the point of contact listed for a subcontracting opportunity posted on SBA SubNet. A large prime contractor holding a federal contract with a small-business subcontracting plan posted this opportunity looking for a subcontractor -- this is not a bid on a government contract directly, it is a proposal to team with THIS PRIME as their subcontractor.

STRICT GROUNDING RULE: use only the facts given below about the opportunity (the prime contractor's name, the work description, location, NAICS code). Never invent capabilities, past performance, certifications, or details about ${identity} beyond the identity given here. SubNet's own keyword search is loose and sometimes surfaces work that doesn't actually fit -- if the described work does not plausibly match what ${identity} does, say so plainly as the first line of the e-mail body instead of forcing a pitch that doesn't fit.

TONE AND STYLE -- formal, professional subcontracting inquiry that reads like a specific person wrote it, not a cold sales pitch or a template:
- No standalone greeting like "Hello," or "Hi," on its own line -- open with a formal salutation to the named point of contact or the firm.
- No contractions anywhere.
- No hype, no generic sales language, no stock AI-email openers ("I hope this finds you well," "I wanted to reach out") -- this is a capability inquiry, not a pitch.
- Cover, in whatever order and sentence count feels natural, not a rigid formula: the specific posted opportunity by name, interest in teaming as a subcontractor, the relevant capability, and a request for a brief call or more detail on subcontracting requirements. Vary sentence length -- uniform sentence length is what makes an e-mail read as AI-generated. No signature block.
- 100-150 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate postings from the SAME prime contractor -- write ONE combined e-mail, not two pitches stitched together.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;
}

// The generic (non-legal, non-subcontract) outreach pitch, parameterized by
// business identity. Previously hardcoded to Aegis Global Holdings
// regardless of which business a lead was actually scored for -- harmless
// while only Aegis ever populated these prospect sources, but a real bug
// once USASpending/Adzuna started tagging loanservicing/modmediations
// leads too: a loan-servicing prospect would have been pitched an "Aegis"
// e-mail. Only Aegis has a real, grounded service+price list
// (AEGIS_SERVICES_CONTEXT); the other three businesses speak in terms of
// the general capability instead of inventing a service name or price.
function buildGenericOutreachSystem(business, isHiringSignal) {
  const identity = BUSINESS_IDENTITY[business] || BUSINESS_IDENTITY.aegis;
  const isAegis = !business || business === "aegis";
  const serviceBlock = isAegis
    ? `You may reference ONE of Aegis's real services from this list if it genuinely fits (do not invent a service or price not on this list):\n${AEGIS_SERVICES_CONTEXT}`
    : `${identity} has no published service catalog for this pitch -- speak only in terms of the general capability (e.g., "loan servicing support," "mediation services"), never a specific named product or price. Propose a conversation to discuss fit, not a quote.`;
  const hiringSignalBlock = isHiringSignal
    ? `\n\nCONTEXT FOR THE PITCH: this lead comes from a public job posting -- the recipient company is CURRENTLY HIRING for the role described below. The core of this pitch must explicitly propose ${identity}'s outsourced alternative to that hire -- e.g., engaging ${identity} for this function instead of, or alongside, making that hire -- grounded specifically in the role they posted, not a generic "we can help" message.`
    : "";

  return `\
You are drafting a SHORT, professional cold-outreach e-mail on behalf of ${identity}, for Robert (the owner) to review before sending.

STRICT GROUNDING RULE: use only the facts given below about the recipient. Never invent details about their company, their internal operations, their needs, or their budget beyond what's stated. If you reference why ${identity} might help, tie it directly and specifically to the "why this matched" reasons given -- don't generalize into generic sales language.

${serviceBlock}${hiringSignalBlock}

TONE AND STYLE -- formal business-development correspondence that reads like a specific person wrote it for this specific recipient, not a mail-merge template:
- No standalone greeting like "Hello," or "Hi," on its own line -- either open with a formal salutation appropriate for an unnamed recipient ("Good afternoon," or "To the [Company] team,") or begin directly with the context sentence, no greeting at all.
- No contractions anywhere (write "that is" not "that's", "we do not" not "we don't", "I am" not "I'm").
- No hype, no false familiarity ("I noticed your company is doing great things!"), no filler transitions ("So," "Also," "Just wanted to..." to open a sentence), and no stock AI-email openers ("I hope this finds you well," "I wanted to reach out regarding," "I came across your posting").
- Precise, declarative sentences, but vary their length and rhythm -- a run of same-length sentences is what makes an e-mail read as AI-generated, not a person. Assume the recipient is a senior decision-maker with little time.
- Cover, in whatever order and sentence count feels natural for this specific opportunity, not a rigid formula: why you are writing, a brief introduction of ${identity}, the relevant capability${isAegis ? " and price" : ""}, and a single low-pressure next step. No signature block, no closing pleasantry that sounds boilerplate.
- 120-180 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate public signals about the SAME company -- write ONE combined e-mail that naturally references the most relevant point(s), not two pitches stitched together.${isAegis ? " Still recommend only ONE Aegis service overall unless two are both clearly and separately justified." : ""} Never claim more signals exist than are actually listed.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;
}

async function callAnthropicForOutreach(env, { context, isLegal, isSubcontract, isHiringSignal, business }) {
  const system = isSubcontract
    ? buildSubcontractOutreachSystem(business)
    : isLegal
    ? LEGAL_OUTREACH_SYSTEM
    : buildGenericOutreachSystem(business, isHiringSignal);

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

async function sendOutreachDraftEmail(env, { row, id, draft, isLegal, isSubcontract, combinedWith = [] }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const senderBanner = isLegal
    ? `<p style="background:#e8f4fd;border-left:3px solid #0E141B;padding:12px 16px;font-size:13px">
         📨 This is a Newark Firm draft, not Aegis. <strong>Send it yourself from robert@newarkfirm.com</strong> -- it was generated by this pipeline but has nothing to do with Aegis Global Holdings and must not go out from an Aegis address.
       </p>`
    : "";

  const combinedBanner = combinedWith.length
    ? `<p style="background:#eef7ee;border-left:3px solid #2e7d32;padding:12px 16px;font-size:13px">
         🔗 Combined: this covers ${combinedWith.length + 1} approved leads for what looks like the same company today, including "${escHtml(combinedWith.join('", "'))}". Use this one e-mail, not a separate draft per lead.
       </p>`
    : "";

  const draftHtml = draft.parseError
    ? `<p style="color:#c0392b">AI output could not be parsed as JSON. Raw output below.</p>
       <pre style="white-space:pre-wrap;font-size:13px;background:#f9f9f9;padding:12px;border:1px solid #ddd">${escHtml(draft.raw)}</pre>`
    : `
      <p><strong>Suggested subject:</strong> ${escHtml(draft.subject || "")}</p>
      <div style="background:#f9f9f9;border:1px solid #ddd;padding:16px;white-space:pre-wrap;font-family:sans-serif">${escHtml(draft.body || "")}</div>`;

  const sentUrl = `${WORKER_URL}/outcome?id=${encodeURIComponent(id)}&token=${row.respond_token}&action=sent`;

  const subjectPrefix = isSubcontract
    ? "Subcontracting outreach draft (AI, unsent)"
    : isLegal
    ? "Newark Firm outreach draft (AI, unsent)"
    : "Outreach draft (AI, unsent)";
  const contactBanner = row.contact_email
    ? `<p style="background:#e8f8ee;border-left:3px solid #2e7d32;padding:12px 16px;font-size:13px">
         📇 Contact found: <strong>${escHtml(row.contact_name || "")} ${row.contact_name ? "&lt;" : ""}${escHtml(row.contact_email)}${row.contact_name ? "&gt;" : ""}</strong> -- verify it's still current before sending.
       </p>`
    : "";
  const contactWarning = row.contact_email
    ? "A contact is included above -- verify it's current before sending."
    : `No contact e-mail is available from this source (${escHtml(row.source)}) -- find the right recipient yourself before using this.`;

  await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `${subjectPrefix} — ${row.title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted, NOT sent to anyone. ${contactWarning} Verify the claims against the source link below.
      </p>
      ${senderBanner}
      ${contactBanner}
      ${combinedBanner}
      <h2>${escHtml(row.title)}</h2>
      ${row.sam_url ? `<p><a href="${escHtml(row.sam_url)}">Source link</a></p>` : ""}
      ${draftHtml}
      <p style="margin-top:20px"><a href="${sentUrl}" style="background:#0E141B;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px">I sent this — start tracking</a></p>
    </div>`,
    text: `${isLegal ? "NEWARK FIRM DRAFT -- send from robert@newarkfirm.com, not Aegis.\n\n" : ""}${row.contact_email ? `Contact found: ${row.contact_name || ""} <${row.contact_email}> -- verify before sending.\n\n` : ""}${combinedWith.length ? `Combined with: ${combinedWith.join(", ")}\n\n` : ""}AI-drafted outreach e-mail for: ${row.title}\n(NOT sent -- verify recipient before using this.)\n\n${JSON.stringify(draft, null, 2)}\n\n${row.sam_url || ""}\n\nI sent this: ${sentUrl}`,
  });
}

// ── Software pitch: LexFlow to law firms, LoanServ demo to lenders ─────────
//
// Robert's ask: alongside the existing Newark Firm B2B pitch / loan-
// servicing-outsourcing pitch, also let him pitch the actual Aegis
// software products to the same hiring-signal leads -- a law firm hiring
// attorneys is also a plausible LexFlow buyer, a lender hiring servicing
// staff is also a plausible LoanServ prospect. Offered as a SEPARATE
// approve action (approve_software), never replacing the existing pitch,
// per his explicit choice. Always sent from Aegis (both are Aegis/AegisOS
// products), never Newark Firm.
//
// LexFlow has real published pricing (lexflow.html#pricing) to quote.
// LoanServ does not -- fees.html is explicit that it "stays a demo," so its
// pitch never quotes a price and only proposes a demo.
//
// Per Robert's explicit call: the LoanServ pitch (draft-to-Robert-for-review,
// not auto-sent) may list ACH as a standard LoanServ capability -- this
// differs from every other external surface (fees.html, aegispay.html,
// loanserv.html, and the checklist/outreach pitch in this file), which all
// still say ACH is not live. Only this specific pitch prompt carries the
// exception, per his instruction.
//
// LexFlow's pitch may mention CounselAI at a high level (an AI research/
// drafting layer on the roadmap for LexFlow firms) -- no feature specifics,
// matching counselai.html's own "concept, no published spec" stance.

const LEXFLOW_PITCH_SYSTEM = `\
You are drafting a SHORT, professional cold-outreach e-mail on behalf of Aegis Global Holdings, pitching LexFlow (a legal practice management software product on AegisOS) to a law firm, for Robert (the owner) to review before sending.

STRICT GROUNDING RULE: use only the facts given below about the recipient firm (do not invent their practice area, case volume, or internal operations). Only cite these real, published LexFlow facts -- never invent a feature, price, or tier not listed here:
- Features: client and matter management, automated conflict checking, trust/IOLTA three-way reconciliation, billing, client portal and secure messaging, document automation, e-signature.
- Pricing: LexFlow Solo $39/mo, LexFlow Professional $99/mo, LexFlow Unlimited $179/mo, LexFlow Firm $199/seat/mo (for multi-attorney firms).
- Not included: ACH origination, custody of client funds, FedRAMP or HIPAA certification.
- Roadmap, mention at most once and only in passing, no feature list: CounselAI, an AI-assisted legal research and drafting layer planned for LexFlow firms. It is not released, has no price, and must never be described with specific features, a capability claim, or a release date -- point interested firms to counselai.html rather than elaborating.

TONE AND STYLE -- formal business-development correspondence that reads like a specific person wrote it, not a template:
- No standalone greeting like "Hello," or "Hi," on its own line.
- No contractions anywhere.
- No hype, no false familiarity, no stock AI-email openers ("I hope this finds you well," "I wanted to reach out").
- Vary sentence length -- uniform sentence length is what makes an e-mail read as AI-generated.
- Cover, in whatever order feels natural: why you are writing (the firm's apparent hiring/growth signal, if given), a brief introduction of LexFlow and Aegis Global Holdings, ONE pricing tier that plausibly fits the firm's apparent size (a solo hire suggests Solo or Professional; a multi-attorney signal suggests Firm), an optional brief nod to the CounselAI roadmap item above, and a single next step (see pricing at lexflow.html#pricing, or book a demo). No signature block.
- 120-190 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate signals about the SAME firm -- write ONE combined e-mail, not two pitches stitched together.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

const LOANSERV_PITCH_SYSTEM = `\
You are drafting a SHORT, professional cold-outreach e-mail on behalf of Aegis Global Holdings, pitching LoanServ (a lending/loan-servicing operations software product on AegisOS) to a lender, for Robert (the owner) to review before sending.

STRICT GROUNDING RULE: use only the facts given below about the recipient (do not invent their loan volume, portfolio, or internal operations). Only cite these real, published LoanServ facts -- never invent a feature or price:
- Generally available for records, billing, a double-entry general ledger, ACH payment processing, and audit log.
- No published price list -- LoanServ is evaluated through a live demo, not a self-serve price. Never quote a number.

TONE AND STYLE -- formal business-development correspondence that reads like a specific person wrote it, not a template:
- No standalone greeting like "Hello," or "Hi," on its own line.
- No contractions anywhere.
- No hype, no false familiarity, no stock AI-email openers ("I hope this finds you well," "I wanted to reach out").
- Vary sentence length -- uniform sentence length is what makes an e-mail read as AI-generated.
- Cover, in whatever order feels natural: why you are writing (the lender's apparent hiring/growth signal, if given), a brief introduction of LoanServ and Aegis Global Holdings, what it actually does (records, billing, ledger, ACH, audit log), and a single next step: book a demo (book-demo.html?module=LoanServ). No signature block.
- 100-160 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate signals about the SAME lender -- write ONE combined e-mail, not two pitches stitched together.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

const COUNSELAI_PITCH_SYSTEM = `\
You are drafting a SHORT, professional cold-outreach e-mail on behalf of Aegis Global Holdings, introducing CounselAI (an AI-assisted legal research and drafting concept planned for AegisOS) to a law firm, for Robert (the owner) to review before sending.

STRICT GROUNDING RULE: CounselAI is an unreleased concept with no published specification, no price, and no committed release date (see counselai.html). Never invent a feature, a capability claim, a release date, or a price. Only these facts exist:
- CounselAI is being explored as a matter-aware AI research and drafting layer for attorneys, built to work from a firm's own matter data rather than as a general-purpose chatbot -- concept only, nothing released.
- The generally available legal product on AegisOS today is LexFlow (case/matter management, conflict checking, trust/IOLTA reconciliation, billing, client portal, document automation, e-signature).
- Next step: point the firm to counselai.html to register interest, and offer a LexFlow demo today in the meantime.

TONE AND STYLE -- formal business-development correspondence that reads like a specific person wrote it, not a template:
- No standalone greeting like "Hello," or "Hi," on its own line.
- No contractions anywhere.
- No hype, no false familiarity, no stock AI-email openers ("I hope this finds you well," "I wanted to reach out").
- Vary sentence length -- uniform sentence length is what makes an e-mail read as AI-generated.
- Cover, in whatever order feels natural: why you are writing (the firm's apparent hiring/growth signal, if given), that Aegis is exploring CounselAI as described above, and a single next step (see counselai.html, or book a LexFlow demo today). No signature block.
- 90-140 words.

MULTIPLE OPPORTUNITIES: if the context below lists more than one "--- Opportunity N of M ---" block, they are separate signals about the SAME firm -- write ONE combined e-mail, not two pitches stitched together.

Respond with ONLY a raw JSON object, no markdown fences:
{
  "subject": "short subject line",
  "body": "the e-mail body, plain text, no signature block (Robert will add his own)"
}`;

async function draftSoftwarePitch(env, id, row, options = {}) {
  const product = options.product || (row.business === "newarkfirm" ? "LexFlow" : "LoanServ");
  if (product === "CounselAI") {
    if (!COUNSELAI_PITCH_BUSINESSES.includes(row.business)) {
      throw new Error(`CounselAI pitch is only defined for Newark Firm leads, got business "${row.business}"`);
    }
  } else if (!SOFTWARE_PITCH_BUSINESSES.includes(row.business)) {
    throw new Error(`No software pitch defined for business "${row.business}"`);
  }
  const system =
    product === "CounselAI" ? COUNSELAI_PITCH_SYSTEM :
    product === "LexFlow" ? LEXFLOW_PITCH_SYSTEM :
    LOANSERV_PITCH_SYSTEM;
  const context = describeOpportunity(row);

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
  let draft;
  try {
    draft = JSON.parse(cleaned);
  } catch {
    draft = { parseError: true, raw };
  }

  await sendSoftwarePitchDraftEmail(env, { row, id, draft, product });
}

async function sendSoftwarePitchDraftEmail(env, { row, id, draft, product }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const draftHtml = draft.parseError
    ? `<p style="color:#c0392b">AI output could not be parsed as JSON. Raw output below.</p>
       <pre style="white-space:pre-wrap;font-size:13px;background:#f9f9f9;padding:12px;border:1px solid #ddd">${escHtml(draft.raw)}</pre>`
    : `
      <p><strong>Suggested subject:</strong> ${escHtml(draft.subject || "")}</p>
      <div style="background:#f9f9f9;border:1px solid #ddd;padding:16px;white-space:pre-wrap;font-family:sans-serif">${escHtml(draft.body || "")}</div>`;

  const contactBanner = row.contact_email
    ? `<p style="background:#e8f8ee;border-left:3px solid #2e7d32;padding:12px 16px;font-size:13px">
         📇 Contact found: <strong>${escHtml(row.contact_name || "")} ${row.contact_name ? "&lt;" : ""}${escHtml(row.contact_email)}${row.contact_name ? "&gt;" : ""}</strong> -- verify it's still current before sending.
       </p>`
    : "";

  const sentUrl = `${WORKER_URL}/outcome?id=${encodeURIComponent(id)}&token=${row.respond_token}&action=sent`;

  await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `${product} pitch draft (AI, unsent) — ${row.title}`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <p style="background:#fff8e1;border-left:3px solid #FFB300;padding:12px 16px;font-size:13px">
        ⚠ AI-drafted, NOT sent to anyone. This is the ${escHtml(product)} software pitch, separate from any other draft already sent for this lead -- verify the claims and recipient before using this.
      </p>
      ${contactBanner}
      <h2>${escHtml(row.title)}</h2>
      ${row.sam_url ? `<p><a href="${escHtml(row.sam_url)}">Source link</a></p>` : ""}
      ${draftHtml}
      <p style="margin-top:20px"><a href="${sentUrl}" style="background:#0E141B;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px">I sent this — start tracking</a></p>
    </div>`,
    text: `${product} pitch draft for: ${row.title}\n(NOT sent -- verify recipient before using this.)\n${row.contact_email ? `\nContact found: ${row.contact_name || ""} <${row.contact_email}>\n` : ""}\n${JSON.stringify(draft, null, 2)}\n\n${row.sam_url || ""}\n\nI sent this: ${sentUrl}`,
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
      const softwareUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve_software`;
      const softwareProduct = item.business === "newarkfirm" ? "LexFlow" : item.business === "loanservicing" ? "LoanServ" : null;
      const showSoftwareButton = softwareProduct && PROSPECT_SOURCES.includes(item.source);
      const counselaiUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve_counselai`;
      const showCounselaiButton = COUNSELAI_PITCH_BUSINESSES.includes(item.business) && PROSPECT_SOURCES.includes(item.source);
      const sourceLabel =
        item.source === "usaspending" ? "AWARDED CONTRACT — PROSPECT" :
        item.source === "adzuna" ? "HIRING SIGNAL — PROSPECT" :
        item.source === "adzuna_legal" ? "LEGAL HIRING SIGNAL — PROSPECT" :
        item.source === "adzuna_loanservicing" ? "LOAN SERVICING HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs" ? "FEDERAL HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs_legal" ? "FEDERAL LEGAL HIRING SIGNAL — PROSPECT" :
        item.source === "subnet" ? "SUBCONTRACTING OPPORTUNITY — PROSPECT" :
        "OPEN SOLICITATION";
      const businessLabel = BUSINESS_LABELS[item.business] || BUSINESS_LABELS.aegis;
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <div style="font-size:12px;font-weight:700;color:#856404;text-transform:uppercase;letter-spacing:.08em">
            Score: ${item.score}/100 &nbsp;·&nbsp; ${sourceLabel} &nbsp;·&nbsp; For: ${escHtml(businessLabel)}
          </div>
          <h3 style="margin:6px 0">${escHtml(item.title)}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">
            ${item.agency ? escHtml(item.agency) + " · " : ""}
            ${item.naicsCode ? "NAICS " + escHtml(item.naicsCode) + " · " : ""}
            ${item.setAside ? escHtml(item.setAside) + " · " : ""}
            ${item.awardAmount ? "Award: $" + Math.round(item.awardAmount).toLocaleString() : ""}
          </p>
          <p style="margin:8px 0;font-size:14px"><strong>Why matched:</strong> ${item.reasons.map((r) => `✓ ${escHtml(r)}`).join(" &nbsp; ")}</p>
          ${
            item.aiSummary
              ? `<div style="background:#f4f8fb;border-left:3px solid #0E141B;padding:10px 14px;margin:8px 0;font-size:14px">
                   <strong>What's actually being asked for:</strong> ${escHtml(item.aiSummary.summary || "")}
                   ${
                     item.aiSummary.relevantServices?.length
                       ? `<br><strong>Could offer:</strong> ${item.aiSummary.relevantServices.map((s) => escHtml(s)).join(", ")}`
                       : ""
                   }
                   <br><strong>Always worth offering:</strong> the free <a href="https://aegisglobalholdings.com/ai-visibility-check.html">AI Visibility Scan</a> as a low-friction next step.
                 </div>`
              : ""
          }
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
            ${showSoftwareButton ? `<a href="${softwareUrl}" style="background:#00838f;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Pitch ${softwareProduct}</a>` : ""}
            ${showCounselaiButton ? `<a href="${counselaiUrl}" style="background:#5e35b1;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Pitch CounselAI</a>` : ""}
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
      .map((item) => {
        const summaryLines = item.aiSummary
          ? `\nWhat's being asked for: ${item.aiSummary.summary || ""}${item.aiSummary.relevantServices?.length ? `\nCould offer: ${item.aiSummary.relevantServices.join(", ")}` : ""}\nAlways worth offering: free AI Visibility Scan (https://aegisglobalholdings.com/ai-visibility-check.html)`
          : "";
        const softwareProduct = item.business === "newarkfirm" ? "LexFlow" : item.business === "loanservicing" ? "LoanServ" : null;
        const softwareLine =
          softwareProduct && PROSPECT_SOURCES.includes(item.source)
            ? `\nPitch ${softwareProduct}: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=approve_software`
            : "";
        const counselaiLine =
          COUNSELAI_PITCH_BUSINESSES.includes(item.business) && PROSPECT_SOURCES.includes(item.source)
            ? `\nPitch CounselAI: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=approve_counselai`
            : "";
        return `[${item.score}/100] ${item.source === "usaspending" ? "AWARDED — " : ""}${item.title}\nWhy: ${item.reasons.join(", ")}${summaryLines}\n${item.url}\nApprove: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=approve${softwareLine}${counselaiLine}\nDecline: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=decline`;
      })
      .join("\n\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-samgov-bot] Digest e-mail failed ${res.status}:`, body);
  }
}

async function sendReminderDigestEmail(env, items) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";

  const cardsHtml = items
    .map((item) => {
      const approveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve`;
      const declineUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=decline`;
      const saveUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=save`;
      const softwareUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve_software`;
      const softwareProduct = item.business === "newarkfirm" ? "LexFlow" : item.business === "loanservicing" ? "LoanServ" : null;
      const showSoftwareButton = softwareProduct && PROSPECT_SOURCES.includes(item.source);
      const counselaiUrl = `${WORKER_URL}/respond?id=${encodeURIComponent(item.id)}&token=${item.token}&action=approve_counselai`;
      const showCounselaiButton = COUNSELAI_PITCH_BUSINESSES.includes(item.business) && PROSPECT_SOURCES.includes(item.source);
      const sourceLabel =
        item.source === "usaspending" ? "AWARDED CONTRACT — PROSPECT" :
        item.source === "adzuna" ? "HIRING SIGNAL — PROSPECT" :
        item.source === "adzuna_legal" ? "LEGAL HIRING SIGNAL — PROSPECT" :
        item.source === "adzuna_loanservicing" ? "LOAN SERVICING HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs" ? "FEDERAL HIRING SIGNAL — PROSPECT" :
        item.source === "usajobs_legal" ? "FEDERAL LEGAL HIRING SIGNAL — PROSPECT" :
        item.source === "subnet" ? "SUBCONTRACTING OPPORTUNITY — PROSPECT" :
        "OPEN SOLICITATION";
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:20px;margin-bottom:16px;font-family:sans-serif">
          <div style="font-size:12px;font-weight:700;color:#856404;text-transform:uppercase;letter-spacing:.08em">
            Score: ${item.score}/100 &nbsp;·&nbsp; ${sourceLabel} &nbsp;·&nbsp; Pending ${item.daysPending} day${item.daysPending === 1 ? "" : "s"} &nbsp;·&nbsp; Reminder ${item.reminderNumber}/${REMINDER_MAX_COUNT}
          </div>
          <h3 style="margin:6px 0">${escHtml(item.title)}</h3>
          <p style="margin:4px 0;color:#555;font-size:14px">${item.agency ? escHtml(item.agency) : ""}</p>
          <p style="margin:8px 0;font-size:14px"><strong>Why matched:</strong> ${item.reasons.map((r) => `✓ ${escHtml(r)}`).join(" &nbsp; ")}</p>
          <p style="margin:8px 0;font-size:14px">
            ${item.url ? `<a href="${escHtml(item.url)}">View original</a>` : ""}
            ${item.responseDeadline ? ` · Response due: ${escHtml(item.responseDeadline)}` : ""}
          </p>
          <div style="margin-top:12px">
            <a href="${approveUrl}" style="background:#0E141B;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Approve</a>
            ${showSoftwareButton ? `<a href="${softwareUrl}" style="background:#00838f;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Pitch ${softwareProduct}</a>` : ""}
            ${showCounselaiButton ? `<a href="${counselaiUrl}" style="background:#5e35b1;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Pitch CounselAI</a>` : ""}
            <a href="${declineUrl}" style="background:#f0f0f0;color:#333;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px;margin-right:8px">Decline</a>
            <a href="${saveUrl}" style="background:#f0f0f0;color:#333;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:13px">Save for later</a>
          </div>
        </div>`;
    })
    .join("");

  const res = await sendViaResend(env.RESEND_API_KEY, {
    from,
    to: [to],
    subject: `Reminder: ${items.length} valuable lead${items.length === 1 ? "" : "s"} still waiting on your review`,
    html: `<div style="font-family:sans-serif;max-width:640px">
      <h2>Still sitting unreviewed</h2>
      <p style="color:#555">These scored at or above your threshold and haven't been approved, declined, or saved yet. Each has been flagged before — this is a nudge, not a new item. Reminders stop after ${REMINDER_MAX_COUNT} per item, or as soon as you act on it.</p>
      ${cardsHtml}
    </div>`,
    text: items
      .map(
        (item) =>
          `[${item.score}/100] ${item.title} — pending ${item.daysPending} days (reminder ${item.reminderNumber}/${REMINDER_MAX_COUNT})\nWhy: ${item.reasons.join(", ")}\nApprove: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=approve\nDecline: ${WORKER_URL}/respond?id=${item.id}&token=${item.token}&action=decline`,
      )
      .join("\n\n"),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[aegis-samgov-bot] Reminder e-mail failed ${res.status}:`, body);
  }
}

async function notifyRobert(env, { subject, html }) {
  const from = env.FROM_EMAIL || "noreply@aegisglobalholdings.com";
  const to = env.TO_EMAIL || "info@aegisglobalholdings.com";
  await sendViaResend(env.RESEND_API_KEY, { from, to: [to], subject, html }).catch(() => {});
}

function sendViaResend(apiKey, payload) {
  // Every caller passes an html field that's just a <div>...</div> fragment
  // with no declared charset. Wrapping it here (one place) instead of at
  // each of the ~10 call sites means every e-mail this bot sends -- digest,
  // reminders, outcome/meeting check-ins, checklist, outreach, tracking
  // summary -- gets a real charset declaration, not just whichever ones
  // someone remembered to fix. Missing it is what caused an em dash to
  // render as "â€”" (mojibake) instead of "—" in what Robert saw.
  if (payload.html) {
    payload = {
      ...payload,
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${payload.html}</body></html>`,
    };
  }
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


// Every prospect-source title is built as "${company} — ${rest}" by
// mapUsaSpendingResults/mapAdzunaResult/mapUsaJobsResult -- split on that
// same em dash to get a normalized dedup key, no separate company field
// needed.
function normalizeCompanyKey(title) {
  if (!title) return null;
  const key = title.split(" — ")[0]?.trim().toLowerCase();
  return key || null;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function htmlResponse(message, status) {
  // The missing charset here (Content-Type had no "; charset=utf-8") was a
  // real bug, not cosmetic: without it, a browser can fall back to
  // guessing the page's encoding, and any em dash or curly quote in a
  // title (both used throughout this bot's titles/labels) renders as
  // mojibake like "â€”" instead of "—". Confirmed and fixed after Robert
  // saw exactly that on a /respond confirmation page.
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:40px;max-width:520px;margin:0 auto">${message}</body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
