import type {
  PlatformAdapter,
  PlatformInfo,
  PlatformFix,
  Finding,
} from "../types.js";

// ---------------------------------------------------------------------------
// Detection helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Check for `<meta name="generator" content="Webflow">`.
 * This is the most definitive Webflow signal.
 */
export function hasWebflowGenerator(dom: string): boolean {
  return /<meta\s[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*Webflow[^"']*["'][^>]*\/?>/i.test(dom)
    || /<meta\s[^>]*content\s*=\s*["'][^"']*Webflow[^"']*["'][^>]*name\s*=\s*["']generator["'][^>]*\/?>/i.test(dom);
}

/**
 * Check for Webflow-specific `w-` prefixed class patterns.
 * Matches common structural classes: w-nav, w-container, w-form, etc.
 */
export function hasWebflowClasses(dom: string): boolean {
  // Look for Webflow structural classes (not just any "w-" prefix)
  const WF_CLASSES = [
    "w-nav",
    "w-container",
    "w-layout-grid",
    "w-row",
    "w-col",
    "w-form",
    "w-input",
    "w-select",
    "w-slider",
    "w-dropdown",
    "w-tabs",
    "w-lightbox",
    "w-dyn-list",
    "w-dyn-item",
    "w-commerce",
    "w-embed",
    "w-richtext",
    "w-inline-block",
    "w-nav-brand",
    "w-nav-link",
    "w-nav-menu",
    "w-nav-button",
    "w-checkbox",
    "w-radio",
    "w-file-upload",
  ];

  // Need at least 2 distinct Webflow class matches to avoid false positives
  let matches = 0;
  for (const cls of WF_CLASSES) {
    if (dom.includes(cls)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

/**
 * Check for Webflow-specific script tags.
 * - webflow.js script
 * - assets.website-files.com domain
 */
export function hasWebflowScripts(dom: string): boolean {
  return /webflow[^"']*\.js/i.test(dom)
    || /assets\.website-files\.com/i.test(dom);
}

/**
 * Check for .webflow.io staging URL in the DOM.
 */
export function hasWebflowDomain(dom: string): boolean {
  return /\.webflow\.io/i.test(dom);
}

/**
 * Check for Webflow-specific data attributes: data-wf-site, data-wf-page, data-wf-domain.
 */
export function hasWebflowDataAttributes(dom: string): boolean {
  return /data-wf-site\s*=/i.test(dom)
    || /data-wf-page\s*=/i.test(dom)
    || /data-wf-domain\s*=/i.test(dom);
}

// ---------------------------------------------------------------------------
// Platform context (injected into remediation prompts)
// ---------------------------------------------------------------------------

const WEBFLOW_CONTEXT = `## Webflow Platform Context

Webflow is a visual web design tool. Users build layouts, interactions, and CMS content
in a visual Designer. Custom code can be added via Embed blocks (w-embed) or Project
Settings > Custom Code.

### Key UI Paths for Fixes
- **Alt text**: Select image > Element Settings panel (D) > Alt Text field
- **Add aria-label**: Element Settings (D) > Custom Attributes > + > "aria-label"
- **Add role**: Element Settings (D) > Custom Attributes > + > "role"
- **Add tabindex**: Element Settings (D) > Custom Attributes > + > "tabindex"
- **Change heading level**: Select heading > Style panel (S) > Tag dropdown
- **Add skip link**: Add Link Block as first Body element > href="#main-content"
- **Focus styles**: Select element > States > Focus > style the indicator
- **Fix lang attribute**: Project Settings > Custom Code > Head code

### Platform Limitations
- No server-side form validation — all error handling must be client-side
- No native aria-live support — requires custom code embed
- No focus management API — focus trapping in modals requires custom JS
- CMS alt text is per-item — can't set a "default alt" for missing values
- Conditional visibility uses display:none (correct for ARIA hiding)
- Custom code embeds break in Designer preview — must test on published site

### Common Class Patterns
- Layout: w-layout-grid, w-container, w-row, w-col
- Navigation: w-nav, w-nav-brand, w-nav-link, w-nav-menu, w-nav-button
- Forms: w-form, w-input, w-select, w-checkbox, w-radio
- CMS: w-dyn-list, w-dyn-item, w-dyn-bind-empty
- Interactions: w-slider, w-dropdown, w-tabs, w-lightbox
- Utility: w-embed (custom code), w-richtext (CMS rich text)`;

// ---------------------------------------------------------------------------
// Webflow adapter
// ---------------------------------------------------------------------------

/**
 * PlatformAdapter for Webflow sites.
 *
 * Detection checks multiple signals in priority order:
 * 1. Meta generator tag (definitive)
 * 2. Webflow class patterns (w-nav, w-form, etc.)
 * 3. Webflow-specific script tags (webflow.js, assets.website-files.com)
 * 4. .webflow.io staging domain
 * 5. data-wf-* attributes
 */
export class WebflowAdapter implements PlatformAdapter {
  private detectedVia = "";

  detect(dom: string): boolean {
    // Priority 1: Meta generator tag — definitive
    if (hasWebflowGenerator(dom)) {
      this.detectedVia = "meta_generator";
      return true;
    }

    // Priority 2: Webflow class patterns
    if (hasWebflowClasses(dom)) {
      this.detectedVia = "class_patterns";
      return true;
    }

    // Priority 3: Webflow script tags
    if (hasWebflowScripts(dom)) {
      this.detectedVia = "script_tags";
      return true;
    }

    // Priority 4: .webflow.io domain
    if (hasWebflowDomain(dom)) {
      this.detectedVia = "webflow_domain";
      return true;
    }

    // Priority 5: data-wf-* attributes
    if (hasWebflowDataAttributes(dom)) {
      this.detectedVia = "data_attributes";
      return true;
    }

    return false;
  }

  getPlatformInfo(): PlatformInfo {
    return {
      platform: "webflow",
      version: null,
      detected_via: this.detectedVia,
    };
  }

  getCMSPattern(): RegExp | null {
    // Webflow CMS pages have data-wf-collection or use w-dyn-list/w-dyn-item classes.
    // URL pattern: /collection-slug/item-slug (2+ segments).
    // We return null here because CMS detection is better done via DOM analysis
    // (w-dyn-list containers) rather than URL patterns alone.
    // The crawler's own collection detection handles URL grouping.
    return null;
  }

  getPlatformContext(): string {
    return WEBFLOW_CONTEXT;
  }

  getRemediationSteps(_finding: Finding): PlatformFix {
    // Stub — full implementation in Cycle 3
    return {
      platform: "webflow",
      platform_version: "",
      steps: [],
      designer_path: "",
      screenshots: [],
      generated_by: "template",
      platform_docs_url: null,
    };
  }
}
