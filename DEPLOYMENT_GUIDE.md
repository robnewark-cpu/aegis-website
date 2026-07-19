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

# Store the Resend API key as a secret (never commit this value)
npx wrangler secret put RESEND_API_KEY
# → paste your key from https://resend.com/api-keys (starts with "re_")

# Optional: override the sender/recipient addresses at runtime
# npx wrangler secret put FROM_EMAIL   # e.g. noreply@aegisglobalholdings.com
# npx wrangler secret put TO_EMAIL     # e.g. info@aegisglobalholdings.com

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

### Troubleshooting the 502

| Resend status | Root cause | Fix |
|---|---|---|
| 401 | `RESEND_API_KEY` missing or revoked | `wrangler secret put RESEND_API_KEY` |
| 422 | `FROM_EMAIL` domain not verified | Verify domain at resend.com/domains |
| 429 | Rate-limited | Reduce test volume or upgrade Resend plan |

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
