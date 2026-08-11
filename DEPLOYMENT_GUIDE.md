# Aegis Global Holding Website Deployment Guide

## aegis-form-worker Setup (AI Visibility Check form)

The form on `ai-visibility-check.html` posts to the Cloudflare Worker at
`https://aegis-form-worker.robert-bb6.workers.dev`. The worker source now lives
in `workers/aegis-form-worker/`.

### First-time deploy

```bash
cd workers/aegis-form-worker

# If you previously ran `wrangler init` here, a stale wrangler.jsonc with
# placeholder values may exist locally and take priority over the repo file.
# Delete it so the committed wrangler.jsonc (with correct name/date) is used:
rm -f wrangler.jsonc   # only if YOUR local copy has <WORKER_NAME> placeholders

npm install          # installs wrangler v4

# Log in to your Cloudflare account
npx wrangler login

# Store secrets (never commit these values)
npx wrangler secret put RESEND_API_KEY    --name aegis-form-worker
# → paste your Resend key from https://resend.com/api-keys (starts with "re_")

npx wrangler secret put ANTHROPIC_API_KEY --name aegis-form-worker
# → paste your Anthropic key from https://console.anthropic.com (starts with "sk-ant-")

# Optional: override sender/recipient at runtime instead of using wrangler.jsonc vars
# npx wrangler secret put FROM_EMAIL --name aegis-form-worker
# npx wrangler secret put TO_EMAIL   --name aegis-form-worker

# Deploy
npm run deploy
```

### Resend domain verification (fixes 422 / 502 errors)

Resend rejects mail from unverified sender domains with a 422 response, which
the worker surfaces to the browser as a 502.

1. Go to https://resend.com/domains
2. Add `aegisglobalholdings.com` and follow the DNS verification steps
3. Once verified, email from `noreply@aegisglobalholdings.com` will work

Until the domain is verified you can test with `FROM_EMAIL=onboarding@resend.dev`
— but Resend only allows that address to deliver to the email registered on
your Resend account.

### Re-deploy after code changes

```bash
cd workers/aegis-form-worker
npm run deploy
```

### Live log tailing (diagnose errors in real time)

```bash
cd workers/aegis-form-worker
npm run tail
```

### Stripe payment links — one-time setup

Each service in the client e-mail has its own "Get Started" button linked to a Stripe Payment Link. When a client clicks and pays, Stripe automatically generates an invoice and notifies you.

**Step 1 — Create Payment Links in Stripe**

1. Go to [dashboard.stripe.com/payment-links](https://dashboard.stripe.com/payment-links)
2. Click **+ New** for each service
3. Set the price, name, and description to match the service
4. Copy the resulting URL (looks like `https://buy.stripe.com/xxxx`)

| Service | Default price | `wrangler.jsonc` var |
|---|---|---|
| AI Visibility Audit & Strategy | $497 | `STRIPE_LINK_AI_AUDIT` |
| Content & Schema Rewrite | $1,497 | `STRIPE_LINK_CONTENT_SCHEMA` |
| Google Business Profile Optimization | $297 | `STRIPE_LINK_GBP` |
| Website Migration & Redesign | $2,997 | `STRIPE_LINK_WEBSITE` |
| Local Citation Building | $197 | `STRIPE_LINK_CITATIONS` |
| Structured Data Implementation | $497 | `STRIPE_LINK_SCHEMA` |

**Step 2 — Paste links into `wrangler.jsonc`**

Open `workers/aegis-form-worker/wrangler.jsonc` and fill in the `[vars]` section:
```jsonc
"STRIPE_LINK_AI_AUDIT":      "https://buy.stripe.com/xxxx",
"STRIPE_LINK_CONTENT_SCHEMA": "https://buy.stripe.com/yyyy",
// …etc
```

Or set a single `STRIPE_BOOKING_LINK` as a fallback for all services:
```jsonc
"STRIPE_BOOKING_LINK": "https://buy.stripe.com/your-general-link"
```

**Step 3 — Redeploy**
```bash
npm run deploy
```

**To update prices** — edit the `price` field in `SERVICE_CATALOG` at the top of `src/index.js` and redeploy. The Stripe payment link price is set in the Stripe dashboard independently.

---

### Worker e-mail flow

| Step | Timing | Description |
|---|---|---|
| Notification e-mail | Synchronous (before HTTP 200) | "New AI Visibility Check — {name}" — immediate alert |
| Website fetch | Background | `fetch(url)`, strip HTML, truncate to 8,000 chars |
| Anthropic analysis | Background | `claude-sonnet-4-6` assesses AI-search-readiness, returns JSON |
| Review e-mail | Background | "REVIEW NEEDED: {url} visibility report" — draft for Robert |

The browser sees a 200 response as soon as the notification e-mail is sent. The AI analysis and review e-mail arrive typically within 15–30 seconds.

### Updating the recommended-services list

Edit the `AEGIS_SERVICES` constant at the top of `src/index.js`, then redeploy:
```bash
npm run deploy
```

### Required: ANTHROPIC_API_KEY (AI report)

If review/client emails say **`ANTHROPIC_API_KEY not configured — no AI analysis performed.`**,
Resend is working but Claude is not. Set the Worker secret (this is **not** a website HTML issue):

```bash
cd workers/aegis-form-worker
npx wrangler login   # if needed
npx wrangler secret put ANTHROPIC_API_KEY --name aegis-form-worker
# paste sk-ant-... from https://console.anthropic.com
```

Verify without submitting a lead:

```bash
curl -s https://aegis-form-worker.robert-bb6.workers.dev/health
# Expect: {"ok":true,"resendConfigured":true,"anthropicConfigured":true}
```

`anthropicConfigured: false` means the secret is still missing on the live Worker.
After `secret put`, no redeploy is required — secrets apply immediately.

Confirm secrets are present (names only):

```bash
npx wrangler secret list --name aegis-form-worker
# should include ANTHROPIC_API_KEY and RESEND_API_KEY
```

### Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| `{"error":"Server misconfiguration"}` (500) | `RESEND_API_KEY` not set | `wrangler secret put RESEND_API_KEY --name aegis-form-worker` |
| Notification e-mail fails (502) with Resend 401 | `RESEND_API_KEY` invalid/revoked | Regenerate key at resend.com/api-keys |
| Notification e-mail fails (502) with Resend 422 | `FROM_EMAIL` domain not verified | Verify domain at resend.com/domains |
| Review e-mail missing AI report — note says "ANTHROPIC_API_KEY not configured" | Secret not set on Worker | `wrangler secret put ANTHROPIC_API_KEY --name aegis-form-worker` then `curl …/health` |
| `/health` returns `anthropicConfigured: false` (503) | Same as above | Set `ANTHROPIC_API_KEY` Worker secret |
| Review e-mail shows "JSON parse failed" with raw text | Claude returned non-JSON | Raw output still included — lead not lost; check logs with `npm run tail` |

---

## Files Created (Round 2)

### New Pages
1. **blog-revised.html** - Conservative blog with unverified stats removed
2. **services.html** - Detailed services page with 6 core offerings
3. **about.html** - Company story, values, team, and why choose Aegis
4. **case-studies.html** - 4 detailed case studies across different industries

## Deployment Steps

### 1. Update Your Repository

Copy these files to your GitHub repository at `robnewark-cpu/aegis-website`:

```bash
# Navigate to your repo directory
cd ~/path/to/aegis-website

# Copy the files
cp /home/claude/blog-revised.html ./blog.html    # Replace existing
cp /home/claude/services.html ./services.html    # New file
cp /home/claude/about.html ./about.html          # New file
cp /home/claude/case-studies.html ./case-studies.html  # New file
```

### 2. Commit Changes

```bash
git add blog.html services.html about.html case-studies.html
git commit -m "Update: Conservative blog revision, add services/about/case-studies pages"
git push origin main
```

GitHub Pages will automatically rebuild and deploy (typically within 2 minutes).

### 3. Update Sitemap

When your sitemap.xml is updated, include these new pages:

```xml
<url>
    <loc>https://aegisglobalholding.com/blog.html</loc>
    <priority>0.8</priority>
</url>
<url>
    <loc>https://aegisglobalholding.com/services.html</loc>
    <priority>0.9</priority>
</url>
<url>
    <loc>https://aegisglobalholding.com/about.html</loc>
    <priority>0.8</priority>
</url>
<url>
    <loc>https://aegisglobalholding.com/case-studies.html</loc>
    <priority>0.9</priority>
</url>
```

### 4. Verify Deployment

Check that pages are live at:
- https://aegisglobalholding.com/blog.html
- https://aegisglobalholding.com/services.html
- https://aegisglobalholding.com/about.html
- https://aegisglobalholding.com/case-studies.html

## Key Changes in This Update

### Blog.html (Revised)
- **Removed**: All unverified statistics and quantitative claims
- **Added**: 6 comprehensive blog articles with verifiable, conservative content
- **Focus**: Industry insights without data-driven claims
- **Articles cover**: Application management, data integration, web design, digital transformation, cloud readiness, security frameworks
- **Interactive**: Blog list view with clickable article cards linking to full article views

### Services.html (New)
- **6 Service Categories**:
  1. Application Management
  2. Data Integration
  3. Web Design & Development
  4. Digital Transformation
  5. Security & Compliance
  6. Consulting & Strategy
- **Process Section**: "How We Work" with 4-step journey
- **CTA**: Clear call-to-action for proposal requests

### About.html (New)
- **Mission & Vision**: Clear statements of purpose
- **6 Core Values**: With icons and descriptions
- **Team Section**: Leadership team placeholder with Rob Newark's bio
- **Why Choose Aegis**: 6 differentiation points
- **Trust Indicators**: Emphasizes veteran-owned status, integrity, partnership approach

### Case-Studies.html (New)
- **4 Detailed Case Studies**:
  1. Application Portfolio Modernization (Manufacturing)
  2. Data Integration for BI (Financial Services)
  3. Digital Transformation & Cloud Migration (Healthcare)
  4. Enterprise Website Redesign (Professional Services)
- **Structure Per Case Study**:
  - Challenge description
  - Solution approach (with bullet points)
  - Results (with specific metrics displayed)
  - Services used (tagged)
- **Measurable Results**: Each case shows concrete outcomes without overstatement

## Design & SEO Considerations

### Design Features (Consistent Across All Pages)
- ✅ Dark mode support via `prefers-color-scheme`
- ✅ Fully responsive (mobile-first)
- ✅ Accessibility: WCAG-compliant semantic HTML
- ✅ Color scheme: Navy (#0F1B2E), Teal (#00D9FF), Gold (#B8860B)
- ✅ Navigation consistent across all pages
- ✅ Footer with social links and site map

### SEO Elements Included
- Unique meta descriptions for each page
- Canonical tags for each page
- Semantic HTML (h1, h2, h3 hierarchy)
- Mobile viewport meta tag
- Social media links (LinkedIn, Google Maps)
- Internal linking between pages

### Performance Considerations
- All CSS inlined (no external stylesheets needed)
- No external dependencies (fully self-contained)
- Efficient CSS Grid/Flexbox layouts
- Minimal JavaScript (blog article loading only)

## Content Customization

### For Services Page
You may want to customize:
- Service icons (currently using emoji)
- Service descriptions to match your specific offerings
- Process steps to reflect your actual workflow

### For About Page
Customize:
- Rob Newark's biography (currently placeholder)
- Team section (add more team members when hired)
- Location and contact information

### For Case Studies
The current case studies are generic examples. To maximize their impact:
- Replace with actual client projects (with permission)
- Use real metrics from your past work
- Include client testimonials if available
- Add client logos or industry context

## Next Steps (Future Phases)

### Phase 3 Recommendations
1. **Contact/Proposal Page**: Dedicated form page (or modal)
2. **Resources**: Downloadable guides, whitepapers, templates
3. **Blog Enhancement**: Add category filtering and search
4. **Client Testimonials**: Dedicated page or section in case studies
5. **Team Expansion**: More detailed team member pages

### Analytics & Tracking
- Add Google Analytics tracking (if not already present)
- Set up goal tracking for proposal requests
- Monitor page performance and user flow
- A/B test CTA button copy and placement

### SEO & Marketing
- Submit sitemap to Google Search Console
- Create XML sitemap if not already done
- Build internal linking strategy
- Plan content calendar for regular blog updates

## Troubleshooting

### Pages Not Appearing
- Verify files are in repository root (not in subdirectory)
- Check GitHub Pages is enabled for the repository
- Allow 2-5 minutes for deployment
- Clear browser cache (Ctrl+Shift+Delete)

### Styling Issues
- Verify CSS variables are not conflicting
- Check dark mode preference in your browser settings
- Test on different browsers (Chrome, Firefox, Safari, Edge)

### Links Not Working
- Verify all internal links use relative paths (/page.html)
- Check email links use proper mailto format
- Test social media links are correct

## File Statistics

| File | Size | Lines | Type |
|------|------|-------|------|
| blog-revised.html | ~28KB | ~550 | Blog with 6 articles |
| services.html | ~25KB | ~450 | Service descriptions |
| about.html | ~24KB | ~430 | Company info & team |
| case-studies.html | ~32KB | ~600 | 4 Case studies |

**Total**: ~109KB of production-ready HTML

All files are fully self-contained with no external dependencies.
