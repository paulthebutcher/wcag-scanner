# Known Issues

## Forms hidden at page load are not interaction-tested

Forms with no visible fields when the page loads (inside a closed modal, a collapsed panel, or a third-party embed such as GrowSurf that opens on click) are skipped by the submission and on-input tests. The scanner logs:

`[forms] <url>: <selector> has no visible fields at page load — submission and on-input tests skipped`

DOM-based checks (1.3.5 input purpose, 3.3.4 high-risk forms) still run on these forms. If *no* form on the site could be exercised, 3.3.1, 3.3.3 and 3.2.2 are reported as `not_tested` rather than `passed`.

**Possible improvement:** reuse the trigger discovery from the modal checks (`src/checks/behavioral/modal.ts`) to open the container, then test the revealed form.

## The crawled page set rotates between scans (P2-016)

With the default 50-page cap, a site with more pages than the cap is sampled differently on each scan. Popfly has about 54 static pages plus CMS samples against 168 sitemap URLs, so each scan drops a different handful (scan ee56b381 kept six `/archive/*` pages; 6d4e82fe kept eleven industry and blog pages instead). Totals then move between scans with no change to the site.

For a before/after comparison, scan the same URL list both times (`wcag scan --urls <file>`) instead of comparing two crawls.

**Possible improvement:** size the default from the sitemap (every non-CMS page plus N samples per collection), report the page-set difference against the baseline in every report, and let a rescan pin a baseline's page list.

## Instagram embeds are not treated as third-party (P2-017)

Links inside an embedded Instagram post (`blockquote.instagram-media` and its iframe) use Instagram's own colours, so axe reports `link-in-text-block` (1.4.1) on them: 22 findings on two blog posts in scan 6d4e82fe. The site owner cannot change those styles.

**Possible improvement:** add Instagram embeds to the third-party matcher in `src/report/clustering.ts` (`exclusionFor`), as was done for GrowSurf.

## Review verdicts do not carry forward (P2-018)

A finding marked as a false positive in `wcag review` is not remembered by the next scan. The decorative `.new-cta-test` image (empty alt, a lifestyle photo in a call-to-action card) is flagged as informative by the alt-text model on 49 pages in every scan.

**Possible improvement:** store review verdicts by cluster signature and apply them to later scans, so a reviewed false positive stays resolved until the element changes.

## Skip link reported broken on some pages whose skip link works (P2-015)

Scans 6d4e82fe and 0705da2d report `broken_skip_navigation` with "focus did not move" on two blog posts and `/brands/collaborate`, although the link and its `#main-content` target exist. Loaded offline without the site's scripts, the same snapshots pass. The likely cause is site script timing: Webflow's smooth scroll moving focus later than the check's 1.5 s wait (inferred, not investigated).

**Possible improvement:** record when focus reaches the target on those pages and extend or adapt the wait.

## AI verdicts can differ between scans of an unchanged page (P2-020, P2-021, P2-022)

Some prompts include page content that changes on every load, so the same element can be sent to the model with slightly different text each scan and get a different verdict. Seen on popfly.com: a hidden `visitor_id` and `landing_timestamp` in a form (form checks), and the order of web-font classes on the page's `html` element in the error-message prompt. Style and script text (GrowSurf's random class) no longer reaches link-text and alt-text prompts since P2-012.

**Possible improvement:** leave hidden-input values out of form prompts, and build the error-message prompt from the form and its error region instead of the start of the page (P2-001).

## The crawler follows links users cannot see (P2-031)

The crawl collects every link in a page's HTML, including links inside hidden elements (a menu item hidden with a `hide` class, `hidden` or `aria-hidden` containers). A scan can therefore check pages that visitors cannot reach from the pages scanned. On popfly.com a hidden mobile-menu link leads to `/archive/pricing` from 73 of 75 pages; that page is noindex, so it only appears in scans run with `--include-noindex`.

**Possible improvement:** discover links from the rendered page, skip links whose element is not rendered, and log the skipped targets.
