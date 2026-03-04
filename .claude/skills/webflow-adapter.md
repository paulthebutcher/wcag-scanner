# Webflow Adapter — Platform Knowledge

Read this before working on `/src/adapters/webflow.ts` or any Webflow-specific remediation.

## Detection Signals

The `detect(dom)` function checks for these in priority order:

1. **Meta generator tag**: `<meta name="generator" content="Webflow">` — definitive
2. **Class patterns**: Webflow uses `w-` prefix classes extensively: `w-layout-grid`, `w-container`, `w-nav`, `w-slider`, `w-form`, `w-dropdown`, `w-tabs`, `w-commerce-*`
3. **Script tags**: `webflow.js` or `site-assets` from `assets.website-files.com`
4. **URL patterns**: `.webflow.io` subdomain for staging sites
5. **Data attributes**: `data-wf-site`, `data-wf-page`, `data-wf-domain`

Return platform info with `detected_via` explaining which signal matched.

## Webflow Class Conventions

Webflow generates predictable class patterns. Important for check modules:

- **Layout**: `w-layout-grid`, `w-container`, `w-row`, `w-col`
- **Navigation**: `w-nav`, `w-nav-brand`, `w-nav-link`, `w-nav-menu`, `w-nav-button` (hamburger)
- **Forms**: `w-form`, `w-input`, `w-select`, `w-checkbox`, `w-radio`, `w-file-upload`, `w-form-done`, `w-form-fail`
- **Interactions**: `w-slider`, `w-dropdown`, `w-tabs`, `w-lightbox`
- **CMS**: `w-dyn-list`, `w-dyn-item`, `w-dyn-bind-empty`
- **Commerce**: `w-commerce-*` (cart, checkout, product)
- **Utility**: `w-embed` (custom code blocks), `w-richtext` (CMS rich text)
- **Visibility**: `w-condition-invisible` (conditional visibility)

## CMS Collection Patterns

`getCMSPattern()` should return RegExp matching CMS collection URLs:

- Webflow CMS pages follow: `/collection-slug/item-slug`
- Common patterns: `/blog/*`, `/team/*`, `/projects/*`, `/products/*`, `/case-studies/*`
- CMS list containers: `w-dyn-list` wrapping `w-dyn-item` elements
- Empty state: `w-dyn-bind-empty` visible when collection is empty
- CMS-bound elements have `data-wf-collection` and `data-wf-item-id` attributes

Detection strategy: Find all `w-dyn-list` containers, extract the collection slug from hrefs within `w-dyn-item` links.

## IX2 Interactions

Webflow Interactions 2.0 (IX2) creates dynamic states. Important for behavioral testing:

- **Trigger types**: click, hover, scroll-into-view, page-load, mouse-move, tab-focus
- **IX2 data**: stored in `<script>` tag as `Webflow.push(function() { ... })` or in inline `data-w-id` attributes
- **Common patterns**: modal open/close, dropdown toggle, accordion expand/collapse, scroll animations
- **Gotchas**:
  - IX2 click triggers on `div` elements create interactive elements with no keyboard equivalent
  - Focus trapping in IX2 modals is almost never implemented correctly
  - IX2 animations can create flashing content that triggers seizure criteria
  - IX2 "display: none → display: block" transitions don't move focus to revealed content

## Common Webflow Accessibility Failures

Patterns the adapter and checks should watch for:

### Keyboard
- `div` with IX2 click trigger but no `tabindex`, `role`, or `keydown` handler
- Dropdown menus (`w-dropdown`) that open on hover but can't be keyboard-activated
- Tab panels (`w-tabs`) that may not support arrow key navigation
- Slider (`w-slider`) with no keyboard controls

### Focus Management
- IX2 modals: focus doesn't move in on open, doesn't trap, doesn't return on close
- Hamburger menu (`w-nav-button`): mobile nav opens but focus stays on burger
- Dropdowns: focus doesn't move to first item on open

### Semantics
- `h1` used for visual size, not hierarchy (multiple h1s common)
- Link blocks (`w-inline-block` with `a` tag) wrapping large chunks of content
- CMS alt text using field name or slug instead of description
- Decorative images with non-empty alt (CMS auto-populates)

### Forms
- `w-form` error handling uses `w-form-fail` div that appears but isn't aria-live
- `w-form-done` success message not announced to screen readers
- No per-field error messages — only a generic form-level error
- Required fields not indicated programmatically (only visual asterisk via CSS)

### Navigation
- Skip-to-content link almost never present in Webflow sites
- `w-nav` landmark role often missing
- Breadcrumbs implemented as styled divs, not `nav` with `aria-label="Breadcrumb"`

## Remediation — Designer Paths

When generating PlatformFix.designer_path, use these actual Webflow Designer UI paths:

| Action | Path |
|--------|------|
| Add alt text | Select image → Element Settings panel (D) → Alt Text field |
| Add aria-label | Select element → Element Settings (D) → Custom Attributes → + → "aria-label" |
| Add role | Select element → Element Settings (D) → Custom Attributes → + → "role" |
| Add tabindex | Select element → Element Settings (D) → Custom Attributes → + → "tabindex" |
| Change heading level | Select heading → Style panel (S) → Tag dropdown (above class field) |
| Add skip link | Add Link Block as first element in Body → set href="#main-content" → add ID "main-content" to main content container |
| Fix form errors | Webflow Form Settings → Add custom error handling via w-embed + JavaScript |
| Add aria-live | Custom Attributes → + → "aria-live" → "polite" or "assertive" |
| Fix lang attribute | Project Settings → Custom Code → Head → `<html lang="en">` override (or Page Settings per page) |
| Add focus styles | Select element → States → Focus → Style the focus indicator |
| Fix link text | Select link → change visible text, or add aria-label via Custom Attributes |

## Remediation — Common Code Fixes

When `requires_custom_code: true`, the fix goes in a Webflow Embed Block (`w-embed`):

### Skip-to-content (if designer path isn't viable)
```html
<a href="#main-content" class="skip-link" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;&:focus{position:static;width:auto;height:auto;}">Skip to main content</a>
```

### aria-live for form errors
```html
<div aria-live="polite" id="form-errors"></div>
<script>
  // Move Webflow error messages into aria-live region
  const observer = new MutationObserver(() => {
    const fail = document.querySelector('.w-form-fail');
    if (fail && fail.style.display !== 'none') {
      document.getElementById('form-errors').textContent = fail.textContent;
    }
  });
  observer.observe(document.querySelector('.w-form'), { childList: true, subtree: true, attributes: true });
</script>
```

### Keyboard handler for IX2 click triggers
```html
<script>
  document.querySelectorAll('[data-w-id]').forEach(el => {
    if (!el.closest('a, button') && !el.getAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
      });
    }
  });
</script>
```

## Platform Limitations to Declare

When generating remediation, note these Webflow limitations:

- **No server-side form validation** — all error handling must be client-side
- **No native aria-live support** — requires custom code embed
- **No focus management API** — focus trapping in modals requires custom JS
- **CMS alt text is per-item** — can't set a "default alt" for missing values
- **No heading level override without changing the tag** — designers often use wrong tag for visual size
- **Conditional visibility (`w-condition-invisible`)** uses `display:none` which is correct for ARIA but means screen readers won't see it either — can't use `opacity:0` approach in Webflow natively
- **Custom code embeds break in the Webflow Designer preview** — must test on published site
