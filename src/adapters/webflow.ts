import type {
  PlatformAdapter,
  PlatformInfo,
  PlatformFix,
  Finding,
  Effort,
} from "../types.js";
import type { PromptRunner } from "../core/prompt-runner.js";
import {
  remediationGeneration,
  remediationVerification,
  buildRemediationUserPrompt,
  buildVerificationUserPrompt,
} from "../prompts/remediation.js";

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
// Remediation templates & cache
// ---------------------------------------------------------------------------

const WEBFLOW_PLATFORM_VERSION = "2024.1";

interface RemediationTemplate {
  steps: string[];
  designer_path: string;
  code_fix: string | null;
  estimated_effort: Effort;
  generic_fix: string;
  platform_docs_url: string | null;
}

// Cache by finding_type_hash
const remediationCache = new Map<string, PlatformFix>();

export function getCachedRemediation(hash: string): PlatformFix | undefined {
  return remediationCache.get(hash);
}

export function setCachedRemediation(hash: string, fix: PlatformFix): void {
  remediationCache.set(hash, fix);
}

export function clearRemediationCache(): void {
  remediationCache.clear();
}

// 20 templates keyed by "criterion:failure_type"
const REMEDIATION_TEMPLATES = new Map<string, RemediationTemplate>([
  ["1.1.1:missing_alt", {
    generic_fix: "Add descriptive alt text to the image that conveys the same information as the visual content.",
    steps: [
      "Select the image element in the Webflow Designer.",
      "Open the Element Settings panel (press D).",
      "In the Alt Text field, enter a descriptive alternative text.",
      "If the image is decorative, check the 'Decorative' checkbox to set alt=\"\".",
      "Publish the site and verify with a screen reader.",
    ],
    designer_path: "Select image → Element Settings (D) → Alt Text field",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.1.1:decorative_with_alt", {
    generic_fix: "Remove alt text from decorative images so screen readers skip them.",
    steps: [
      "Select the decorative image in the Webflow Designer.",
      "Open the Element Settings panel (press D).",
      "Clear the Alt Text field completely or check 'Decorative'.",
      "For CMS images, edit the collection item and clear the alt text field.",
    ],
    designer_path: "Select image → Element Settings (D) → Clear Alt Text or check Decorative",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.4.3:insufficient_contrast", {
    generic_fix: "Adjust text or background color to achieve a contrast ratio of at least 4.5:1 (3:1 for large text).",
    steps: [
      "Select the text element in the Webflow Designer.",
      "Open the Style panel (press S).",
      "Change the text color to meet the 4.5:1 contrast ratio for normal text (3:1 for large text).",
      "Use a contrast checker tool to verify the new color against the background.",
      "Check all element states (hover, focus, active) for contrast compliance.",
    ],
    designer_path: "Select text → Style panel (S) → Typography → Color",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.7:no_focus_indicator", {
    generic_fix: "Add a visible focus indicator to all interactive elements so keyboard users can see which element is focused.",
    steps: [
      "Select the interactive element in the Webflow Designer.",
      "In the Style panel (S), click the States dropdown and select 'Focus'.",
      "Add a visible focus indicator: outline, border, or background color change.",
      "Ensure the focus indicator has at least 3:1 contrast against adjacent colors.",
      "Repeat for all interactive elements (links, buttons, form fields).",
    ],
    designer_path: "Select element → Style panel (S) → States → Focus → Add outline/border",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.1:missing_skip_link", {
    generic_fix: "Add a skip navigation link as the first focusable element that jumps to the main content area.",
    steps: [
      "In the Webflow Designer, add a Link Block as the first child of the Body element.",
      "Set the link href to '#main-content'.",
      "Add text 'Skip to main content' inside the link.",
      "Style the link off-screen and add a Focus state that brings it on screen.",
      "Add an ID 'main-content' to the main content container using Element Settings (D).",
    ],
    designer_path: "Add Link Block as first Body child → href='#main-content' → Style Focus state",
    code_fix: '<a href="#main-content" class="skip-link" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;">Skip to main content</a>\n<style>.skip-link:focus{position:static;width:auto;height:auto;padding:8px 16px;background:#000;color:#fff;z-index:9999;}</style>',
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:missing_form_label", {
    generic_fix: "Associate a visible label with each form input using the label element's 'for' attribute or aria-label.",
    steps: [
      "Select the form input element in the Webflow Designer.",
      "Ensure there is a visible Label element linked to the input.",
      "In the Label element settings, set the 'For' attribute to match the input's ID.",
      "Alternatively, add an aria-label via Element Settings (D) → Custom Attributes.",
    ],
    designer_path: "Select input → Add Label element → Link via For attribute, or Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["3.1.1:missing_lang", {
    generic_fix: "Add a lang attribute to the <html> element to declare the page's primary language.",
    steps: [
      "Go to Project Settings in the Webflow Designer.",
      "Navigate to Custom Code → Head Code.",
      "The lang attribute is set on the html element automatically based on site locale.",
      "If missing, add a custom code embed in the head to set the lang attribute.",
      "For multilingual sites, set lang per page in Page Settings → Custom Code → Head Code.",
    ],
    designer_path: "Project Settings → Custom Code → Head Code",
    code_fix: "<script>document.documentElement.lang = document.documentElement.lang || 'en';</script>",
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:heading_hierarchy", {
    generic_fix: "Fix heading hierarchy to follow a logical order without skipping levels.",
    steps: [
      "Select the heading element in the Webflow Designer.",
      "In the Style panel (S), use the Tag dropdown above the class field to change the heading level.",
      "Ensure headings follow a logical order: h1 → h2 → h3 (no skipping levels).",
      "Use only one h1 per page.",
      "If visual size must differ from semantic level, adjust font-size via CSS instead.",
    ],
    designer_path: "Select heading → Style panel (S) → Tag dropdown → Change heading level",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:missing_nav_role", {
    generic_fix: "Add role='navigation' and aria-label to navigation containers to create proper landmarks.",
    steps: [
      "Select the navigation container (usually w-nav) in the Webflow Designer.",
      "Open Element Settings (D) → Custom Attributes.",
      "Click + to add: name='role', value='navigation'.",
      "Add another attribute: name='aria-label', value='Main navigation'.",
      "If there are multiple nav elements, give each a unique aria-label.",
    ],
    designer_path: "Select w-nav → Element Settings (D) → Custom Attributes → role='navigation'",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.1.1:not_keyboard_accessible", {
    generic_fix: "Make interactive elements keyboard accessible by adding tabindex, role, and keyboard event handlers.",
    steps: [
      "Select the interactive element (often a div with IX2 click trigger).",
      "Open Element Settings (D) → Custom Attributes.",
      "Add tabindex='0' to make the element focusable.",
      "Add role='button' (or appropriate role).",
      "Add a custom code embed with a keydown handler for Enter and Space keys.",
    ],
    designer_path: "Element Settings (D) → Custom Attributes → tabindex='0' + role='button'",
    code_fix: "<script>\ndocument.querySelectorAll('[data-w-id]').forEach(el => {\n  if (!el.closest('a, button') && !el.getAttribute('tabindex')) {\n    el.setAttribute('tabindex', '0');\n    el.setAttribute('role', 'button');\n    el.addEventListener('keydown', e => {\n      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }\n    });\n  }\n});\n</script>",
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["3.3.1:error_not_announced", {
    generic_fix: "Ensure form error messages are announced to screen readers using aria-live regions.",
    steps: [
      "In the Webflow Designer, add an Embed block (w-embed) near the form.",
      "Add an aria-live region div that mirrors the form error message.",
      "Add JavaScript to observe the w-form-fail element and copy its text to the aria-live region.",
      "Ensure the aria-live region has role='alert' or aria-live='assertive' for critical errors.",
    ],
    designer_path: "Add Embed block near w-form → Add aria-live region + MutationObserver script",
    code_fix: '<div aria-live="polite" id="form-errors" style="position:absolute;left:-9999px;"></div>\n<script>\nconst form = document.querySelector(\'.w-form\');\nif (form) {\n  const observer = new MutationObserver(() => {\n    const fail = form.querySelector(\'.w-form-fail\');\n    const errDiv = document.getElementById(\'form-errors\');\n    if (fail && fail.style.display !== \'none\' && errDiv) {\n      errDiv.textContent = fail.textContent;\n    }\n  });\n  observer.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: [\'style\'] });\n}\n</script>',
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.4:empty_link", {
    generic_fix: "Add descriptive text or aria-label to links so screen reader users understand the link's purpose.",
    steps: [
      "Select the link element in the Webflow Designer.",
      "Add visible text content to the link, or",
      "Open Element Settings (D) → Custom Attributes → + → 'aria-label' with a descriptive value.",
      "For icon-only links, add aria-hidden='true' to the icon and aria-label to the link.",
    ],
    designer_path: "Select link → Add text content, or Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.4:non_descriptive_link", {
    generic_fix: "Replace generic link text with descriptive text that explains the link's destination or purpose.",
    steps: [
      "Select the link in the Webflow Designer.",
      "Replace generic text like 'Click here' or 'Read more' with descriptive text.",
      "If changing visible text isn't possible, add aria-label via Element Settings (D) → Custom Attributes.",
      "The aria-label should describe the destination, e.g., 'Read more about accessibility testing'.",
    ],
    designer_path: "Select link → Change text content or Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.2:missing_title", {
    generic_fix: "Add a descriptive <title> element that identifies the page content.",
    steps: [
      "Open Page Settings for the page in the Webflow Designer.",
      "Enter a descriptive title in the 'Title Tag' field.",
      "The title should describe the page content and include the site name.",
      "Example format: 'Page Description | Site Name'.",
    ],
    designer_path: "Page Settings → SEO Settings → Title Tag",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.4.2:auto_playing_media", {
    generic_fix: "Disable autoplay on audio/video elements, or provide a mechanism to pause or stop the media.",
    steps: [
      "Select the video or audio element in the Webflow Designer.",
      "In Element Settings (D), uncheck 'Autoplay'.",
      "If autoplay is needed, ensure a pause/stop mechanism is provided.",
      "For background videos, add Custom Attributes: muted='true' and add a visible pause button.",
    ],
    designer_path: "Select media → Element Settings (D) → Uncheck Autoplay",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["3.3.2:missing_required_indication", {
    generic_fix: "Indicate required fields both visually and programmatically using aria-required and visible indicators.",
    steps: [
      "Select the required form field in the Webflow Designer.",
      "Open Element Settings (D) → check the 'Required' checkbox.",
      "Add Custom Attributes → + → 'aria-required' = 'true'.",
      "Add a visible asterisk (*) or 'Required' text to the field label.",
      "Add instructions at the top of the form explaining the required field indicator.",
    ],
    designer_path: "Element Settings (D) → Required checkbox + Custom Attributes → aria-required='true'",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.1.1:tabs_keyboard", {
    generic_fix: "Add ARIA roles and keyboard navigation (arrow keys) to tab components.",
    steps: [
      "Webflow's w-tabs component needs keyboard enhancement for full WCAG compliance.",
      "Add a custom code embed with JavaScript that adds arrow key navigation between tab buttons.",
      "Ensure tab panels have role='tabpanel' and tab buttons have role='tab'.",
      "Add aria-selected='true' to the active tab and 'false' to others.",
      "Add aria-controls on each tab pointing to its panel ID.",
    ],
    designer_path: "Add Embed block → Custom JavaScript for arrow key navigation",
    code_fix: "<script>\ndocument.querySelectorAll('.w-tabs .w-tab-menu').forEach(menu => {\n  const tabs = menu.querySelectorAll('.w-tab-link');\n  tabs.forEach((tab, i) => {\n    tab.setAttribute('role', 'tab');\n    tab.setAttribute('aria-selected', tab.classList.contains('w--current') ? 'true' : 'false');\n    tab.addEventListener('keydown', e => {\n      let target;\n      if (e.key === 'ArrowRight') target = tabs[(i + 1) % tabs.length];\n      else if (e.key === 'ArrowLeft') target = tabs[(i - 1 + tabs.length) % tabs.length];\n      if (target) { e.preventDefault(); target.click(); target.focus(); }\n    });\n  });\n});\n</script>",
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["2.1.1:dropdown_keyboard", {
    generic_fix: "Add ARIA attributes and keyboard handlers to dropdown components for full keyboard accessibility.",
    steps: [
      "Webflow's w-dropdown component may not be fully keyboard accessible.",
      "Add Custom Attributes to the dropdown toggle: role='button', aria-haspopup='true', aria-expanded='false'.",
      "Add a custom code embed that handles Enter/Space to toggle, Escape to close.",
      "Ensure focus moves into the dropdown list on open and returns to toggle on close.",
    ],
    designer_path: "Element Settings (D) → Custom Attributes → role, aria-haspopup, aria-expanded",
    code_fix: "<script>\ndocument.querySelectorAll('.w-dropdown').forEach(dd => {\n  const toggle = dd.querySelector('.w-dropdown-toggle');\n  const list = dd.querySelector('.w-dropdown-list');\n  if (toggle && list) {\n    toggle.setAttribute('aria-haspopup', 'true');\n    toggle.setAttribute('aria-expanded', 'false');\n    const observer = new MutationObserver(() => {\n      const open = list.classList.contains('w--open');\n      toggle.setAttribute('aria-expanded', String(open));\n      if (open) { const first = list.querySelector('a'); if (first) first.focus(); }\n    });\n    observer.observe(list, { attributes: true, attributeFilter: ['class'] });\n    dd.addEventListener('keydown', e => {\n      if (e.key === 'Escape') { toggle.click(); toggle.focus(); }\n    });\n  }\n});\n</script>",
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.3:modal_focus_trap", {
    generic_fix: "Implement focus trapping in modal dialogs: move focus on open, trap Tab within modal, return focus on close.",
    steps: [
      "Webflow IX2 modals require custom focus management code.",
      "Add a custom code embed with JavaScript that traps focus inside the modal when open.",
      "On modal open: move focus to the first focusable element in the modal.",
      "On modal close: return focus to the element that triggered the modal.",
      "Trap Tab and Shift+Tab to cycle within the modal's focusable elements.",
    ],
    designer_path: "Add Embed block → Custom JavaScript for focus trapping",
    code_fix: "<script>\nfunction trapFocus(modal) {\n  const focusable = modal.querySelectorAll('a,button,input,textarea,select,[tabindex]:not([tabindex=\"-1\"])');\n  if (!focusable.length) return;\n  const first = focusable[0], last = focusable[focusable.length - 1];\n  first.focus();\n  modal.addEventListener('keydown', e => {\n    if (e.key === 'Tab') {\n      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }\n      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }\n    }\n    if (e.key === 'Escape') modal.style.display = 'none';\n  });\n}\n</script>",
    estimated_effort: "significant" as Effort,
    platform_docs_url: null,
  }],
  ["1.4.1:color_alone", {
    generic_fix: "Ensure color is not the only means of conveying information. Add text, icons, or patterns as secondary indicators.",
    steps: [
      "Identify elements where color is the only means of conveying information.",
      "Add a secondary visual indicator: icons, patterns, text labels, or underlines.",
      "For links within text, add an underline in addition to color differentiation.",
      "In the Style panel (S), add text-decoration: underline to links.",
    ],
    designer_path: "Select element → Style panel (S) → Add secondary visual indicator",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  // -----------------------------------------------------------------------
  // Templates keyed by actual failure_type values from scan data
  // (aliases for existing templates or new entries for types without templates)
  // -----------------------------------------------------------------------
  ["1.4.3:color-contrast", {
    generic_fix: "Adjust text or background color to achieve a contrast ratio of at least 4.5:1 for normal text or 3:1 for large text.",
    steps: [
      "Open the element in the Webflow Designer.",
      "Identify the text color and background color in the Style panel (S).",
      "Adjust one or both colors until the contrast ratio meets 4.5:1 for normal text or 3:1 for large text.",
      "Use a contrast checker tool to verify the new values.",
      "Check all element states (hover, focus, active) for contrast compliance.",
    ],
    designer_path: "Select text → Style panel (S) → Typography → Color",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.7:focus_indicator_low_contrast", {
    generic_fix: "Add a high-contrast visible focus indicator to all interactive elements using a global CSS rule or Webflow's Focus state.",
    steps: [
      "Add a custom CSS rule via Project Settings → Custom Code → Head Code or a global stylesheet.",
      "Use :focus { outline: 3px solid #005FCC; outline-offset: 2px; } as a baseline.",
      "Alternatively, select each interactive element in the Designer, open States → Focus, and style the focus indicator.",
      "Ensure the focus indicator has at least 3:1 contrast against adjacent colors.",
    ],
    designer_path: "Project Settings → Custom Code → Head Code, or Style panel (S) → States → Focus",
    code_fix: '<style>\n:focus {\n  outline: 3px solid #005FCC;\n  outline-offset: 2px;\n}\n:focus:not(:focus-visible) {\n  outline: none;\n}\n:focus-visible {\n  outline: 3px solid #005FCC;\n  outline-offset: 2px;\n}\n</style>',
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.7:no_visible_focus_indicator", {
    generic_fix: "Add a visible focus indicator to all interactive elements so keyboard users can see which element is focused.",
    steps: [
      "Select the interactive element in the Webflow Designer.",
      "In the Style panel (S), click the States dropdown and select 'Focus'.",
      "Add a visible focus indicator: outline, border, or background color change.",
      "Ensure the focus indicator has at least 3:1 contrast against adjacent colors.",
      "Repeat for all interactive elements (links, buttons, form fields).",
    ],
    designer_path: "Select element → Style panel (S) → States → Focus → Add outline/border",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.4:link-name", {
    generic_fix: "Add descriptive text or aria-label to links so that screen reader users understand each link's purpose.",
    steps: [
      "Select the link element in the Webflow Designer.",
      "If the link contains an image, select the image and add alt text in Element Settings (D) → Alt Text.",
      "For icon-only links, open Element Settings (D) → Custom Attributes → add aria-label with a descriptive value.",
      "For links with generic text like 'Click here', replace with descriptive text.",
    ],
    designer_path: "Select link → Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.4:image_link_no_alt", {
    generic_fix: "Add alt text to images inside links so screen readers can describe the link's purpose.",
    steps: [
      "Select the image element inside the link in the Webflow Designer.",
      "Open Element Settings (D) and add descriptive alt text in the Alt Text field.",
      "The alt text should describe the link destination, not just the image content.",
      "For icon-only links, add aria-label to the parent link via Custom Attributes instead.",
    ],
    designer_path: "Select image inside link → Element Settings (D) → Alt Text field",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.1.1:unreachable_interactive_element", {
    generic_fix: "Ensure all interactive elements are reachable via keyboard by fixing z-index, visibility, and pointer-events issues.",
    steps: [
      "Check the element's z-index, visibility, and display properties in the Webflow Style panel.",
      "Ensure no parent element has pointer-events: none or visibility: hidden set.",
      "Verify the element is not obscured by an overlay or positioned off-screen.",
      "Add tabindex='0' if the element is a custom interactive component not natively focusable.",
      "Test keyboard access by pressing Tab and verifying the element receives focus.",
    ],
    designer_path: "Select element → Style panel (S) → Check position, z-index, visibility, pointer-events",
    code_fix: null,
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.1:missing_skip_navigation", {
    generic_fix: "Add a skip navigation link as the first focusable element that jumps to the main content area.",
    steps: [
      "Add a custom HTML embed as the first element inside the Body, before the navigation.",
      "Use: <a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>",
      "Add id=\"main-content\" to the main content wrapper via Element Settings (D).",
      "Style the skip link to be visually hidden until focused using the CSS below.",
    ],
    designer_path: "Add Embed block as first Body child → Add id='main-content' to main content wrapper",
    code_fix: '<a href="#main-content" class="skip-link">Skip to main content</a>\n<style>\n.skip-link {\n  position: absolute;\n  left: -9999px;\n  top: auto;\n  width: 1px;\n  height: 1px;\n  overflow: hidden;\n}\n.skip-link:focus {\n  position: static;\n  width: auto;\n  height: auto;\n  padding: 8px 16px;\n  background: #000;\n  color: #fff;\n  z-index: 9999;\n  text-decoration: none;\n}\n</style>',
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["1.1.1:semantic", {
    generic_fix: "Add descriptive alt text to images, or mark decorative images appropriately so screen readers handle them correctly.",
    steps: [
      "Select the image in the Webflow Designer.",
      "Open Element Settings (D) and add descriptive alt text in the Alt Text field.",
      "For decorative images, leave alt blank and check 'Decorative' if available.",
      "If 'Decorative' is not available, add role='presentation' via Custom Attributes.",
      "For CMS images, ensure the alt text field is filled in for each collection item.",
    ],
    designer_path: "Select image → Element Settings (D) → Alt Text field",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.1.1:empty_alt_on_informative", {
    generic_fix: "Add descriptive alt text to informative images that currently have empty alt attributes.",
    steps: [
      "Select the image in the Webflow Designer.",
      "Open Element Settings (D) and enter meaningful alt text that describes the image content.",
      "If the image conveys information not available in surrounding text, the alt text must capture that information.",
    ],
    designer_path: "Select image → Element Settings (D) → Alt Text field",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.5:missing_autocomplete", {
    generic_fix: "Add the autocomplete attribute with the appropriate value to form inputs that collect personal information.",
    steps: [
      "Select the form input in the Webflow Designer.",
      "Open Element Settings (D) → Custom Attributes.",
      "Click + and add: name='autocomplete', value matching the input purpose (e.g. 'name', 'email', 'tel', 'street-address').",
      "Common values: name, email, tel, street-address, postal-code, country, cc-number, cc-exp.",
    ],
    designer_path: "Select input → Element Settings (D) → Custom Attributes → autocomplete",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.5:input_purpose", {
    generic_fix: "Add the autocomplete attribute to form inputs so browsers and assistive technologies can identify the input's purpose.",
    steps: [
      "Select the form input in the Webflow Designer.",
      "Open Element Settings (D) → Custom Attributes.",
      "Click + and add: name='autocomplete', value matching the input purpose.",
      "Common values: name, email, tel, street-address, postal-code, country.",
    ],
    designer_path: "Select input → Element Settings (D) → Custom Attributes → autocomplete",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.3:focus_order_mismatch", {
    generic_fix: "Reorder elements in the DOM so that the tab order matches the visual reading order.",
    steps: [
      "Open the Navigator panel in the Webflow Designer to see the DOM order.",
      "Drag elements to reorder them so the DOM sequence matches the visual reading order.",
      "Avoid using CSS order, flex-direction: row-reverse, or absolute positioning to visually reorder tab-focusable elements.",
      "Test by pressing Tab through the page and verifying focus moves in a logical sequence.",
    ],
    designer_path: "Navigator panel → Drag elements to match visual order",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.6:missing_heading", {
    generic_fix: "Add heading elements to sections that lack them, ensuring proper heading hierarchy.",
    steps: [
      "Identify sections of the page that lack heading elements.",
      "Add appropriate heading elements (H2, H3, etc.) in the Webflow Designer.",
      "Ensure headings follow a logical hierarchy: H1 → H2 → H3 without skipping levels.",
      "Use the Tag dropdown in the Style panel to set the correct heading level.",
    ],
    designer_path: "Add heading element → Style panel (S) → Tag dropdown → Set heading level",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.6:skipped_level", {
    generic_fix: "Fix the heading hierarchy so no levels are skipped. Change the heading tag to maintain proper order.",
    steps: [
      "Select the heading element in the Webflow Designer.",
      "In the Style panel (S), use the Tag dropdown to change the heading level.",
      "Ensure headings follow a logical order: H1 → H2 → H3 without skipping levels.",
      "If the visual size needs to differ from the semantic level, adjust font-size via CSS instead of changing the tag.",
    ],
    designer_path: "Select heading → Style panel (S) → Tag dropdown → Change heading level",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["2.4.5:insufficient_navigation_methods", {
    generic_fix: "Provide at least two ways for users to find content on the site, such as a sitemap page and a search function.",
    steps: [
      "Add a sitemap page listing all major pages and link it in the footer.",
      "Consider adding a search widget via Webflow's site search feature or a third-party embed.",
      "Ensure the main navigation is consistent across all pages.",
      "If using CMS collections, add collection-level navigation or breadcrumbs.",
    ],
    designer_path: "Add sitemap page → Link in footer → Add search via embed or Webflow search",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  ["3.3.4:high_risk_form", {
    generic_fix: "Add a confirmation step or review screen before final submission of legal or financial forms.",
    steps: [
      "Add a confirmation step before the final form submission.",
      "Implement via Webflow Interactions (show a review panel before submitting) or a custom embed.",
      "Display a summary of the user's inputs and ask them to confirm before submitting.",
      "Ensure legal or financial forms provide the ability to review, correct, and confirm data.",
      "Consider adding a checkbox: 'I have reviewed the information above' before the submit button.",
    ],
    designer_path: "Add review step via IX2 interaction or custom embed before form submission",
    code_fix: null,
    estimated_effort: "significant" as Effort,
    platform_docs_url: null,
  }],
  // -----------------------------------------------------------------------
  // Check 1: Landmark labels
  // -----------------------------------------------------------------------
  ["1.3.1:duplicate_nav_landmark", {
    generic_fix: "Add unique aria-label attributes to each navigation landmark so screen readers can distinguish between them.",
    steps: [
      "Select each nav element in the Webflow Designer.",
      "Open Element Settings (D) → Custom Attributes.",
      "Click + and add: name='aria-label', value describing the nav purpose (e.g. 'Main navigation', 'Mobile navigation', 'Footer links').",
      "Each nav element must have a unique label — do not reuse the same label for multiple navs.",
    ],
    designer_path: "Select nav → Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:unlabeled_nav_landmark", {
    generic_fix: "Add an aria-label to the navigation element so screen readers announce its purpose.",
    steps: [
      "Select the nav element in the Webflow Designer.",
      "Open Element Settings (D) → Custom Attributes.",
      "Click + and add: name='aria-label', value='Main navigation' (or appropriate description).",
    ],
    designer_path: "Select nav → Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  // -----------------------------------------------------------------------
  // Check 2: Widget ARIA roles
  // -----------------------------------------------------------------------
  ["4.1.2:missing_aria_expanded", {
    generic_fix: "The accordion trigger needs aria-expanded toggling between true/false. Replace with native <details>/<summary> or add custom JS to manage aria-expanded.",
    steps: [
      "Identify the accordion/disclosure trigger element.",
      "Replace the Webflow interaction with a custom HTML embed using native <details>/<summary> elements.",
      "Alternatively, add a custom JS embed that sets the trigger as a <button> and toggles aria-expanded='true'/'false' on click.",
      "Ensure the content panel has a unique id and the trigger references it via aria-controls.",
    ],
    designer_path: "Replace with Embed block → native <details>/<summary> or custom JS managing aria-expanded",
    code_fix: null,
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["4.1.2:missing_tab_role", {
    generic_fix: "Add ARIA tab roles to tab trigger and panel elements. Webflow's native interactions cannot produce valid ARIA tab patterns — implement via custom HTML/JS embed.",
    steps: [
      "Add role='tab', aria-selected, and aria-controls to each tab trigger.",
      "Add role='tabpanel' with aria-labelledby to each panel.",
      "Wrap the tab triggers in a container with role='tablist'.",
      "Implement via a custom HTML/JS embed — Webflow's native w-tabs cannot produce valid ARIA tab patterns.",
    ],
    designer_path: "Replace w-tabs with Embed block → Custom HTML/JS with ARIA tab roles",
    code_fix: null,
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  ["4.1.2:custom_interactive_no_role", {
    generic_fix: "Replace the custom interactive element with a native <button> or <a>, or add role='button', tabindex='0', and keyboard event handling.",
    steps: [
      "Replace the div/span interactive element with a native <button> or <a> element.",
      "If replacement is not possible, add role='button' and tabindex='0' via Custom Attributes.",
      "Add a custom JS embed handling Enter and Space key events.",
      "Ensure the element has an accessible name via text content or aria-label.",
    ],
    designer_path: "Element Settings (D) → Custom Attributes → role='button' + tabindex='0'",
    code_fix: null,
    estimated_effort: "moderate" as Effort,
    platform_docs_url: null,
  }],
  // -----------------------------------------------------------------------
  // Check 3: Table structure
  // -----------------------------------------------------------------------
  ["1.3.1:table_no_caption", {
    generic_fix: "Add a <caption> or aria-label to data tables so assistive technology can describe the table's purpose.",
    steps: [
      "Add a <caption> as the first child of the <table> element via a custom HTML embed.",
      "Alternatively, add aria-label to the table element via Custom Attributes in Element Settings (D).",
      "The caption should describe what data the table contains.",
    ],
    designer_path: "Add Embed block with <caption> inside <table>, or Element Settings (D) → Custom Attributes → aria-label",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:table_header_no_scope", {
    generic_fix: "Add scope='col' or scope='row' to table header cells so assistive technology can associate headers with data cells.",
    steps: [
      "Webflow does not expose scope on table headers natively.",
      "Add scope='col' or scope='row' to each <th> via a custom HTML embed replacing the table.",
      "Alternatively, add a post-render JS snippet that adds the scope attribute to all <th> elements.",
    ],
    designer_path: "Add Embed block with custom <table> HTML including scope attributes",
    code_fix: '<script>\ndocument.querySelectorAll("th").forEach(th => {\n  if (!th.getAttribute("scope")) {\n    const isRow = th.parentElement?.firstElementChild === th && th.parentElement?.parentElement?.tagName === "TBODY";\n    th.setAttribute("scope", isRow ? "row" : "col");\n  }\n});\n</script>',
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
  ["1.3.1:table_missing_headers", {
    generic_fix: "Add proper header associations to complex data tables using scope or headers/id attributes.",
    steps: [
      "Add <th> elements in the first row or column of the table with appropriate scope attributes.",
      "For complex tables, use the headers attribute on <td> elements referencing <th> ids.",
      "Implement via a custom HTML embed replacing Webflow's native table.",
    ],
    designer_path: "Replace table with Embed block → Custom HTML with proper <th> and scope/headers attributes",
    code_fix: null,
    estimated_effort: "minor" as Effort,
    platform_docs_url: null,
  }],
  // -----------------------------------------------------------------------
  // Check 4: Duplicate link text
  // -----------------------------------------------------------------------
  ["2.4.4:duplicate_link_text", {
    generic_fix: "Add unique aria-label to each repeated link that includes distinguishing context (e.g. the year or document name).",
    steps: [
      "For each repeated link, open Element Settings (D) → Custom Attributes.",
      "Add aria-label with a value that includes the distinguishing context.",
      "Example: aria-label='Download 2024 Annual Report' instead of just 'Download Report'.",
      "For CMS-driven repeated links, use a dynamic aria-label field bound to a CMS field.",
    ],
    designer_path: "Element Settings (D) → Custom Attributes → aria-label with unique context",
    code_fix: null,
    estimated_effort: "trivial" as Effort,
    platform_docs_url: null,
  }],
]);

export function getTemplateKey(finding: Finding): string | null {
  const criterion = finding.wcag_criterion;
  const failureType = finding.evidence.measured_values?.failure_type as string | undefined;
  if (!failureType) return null;
  return `${criterion}:${failureType}`;
}

export function getTemplateCount(): number {
  return REMEDIATION_TEMPLATES.size;
}

/**
 * Look up a remediation template by key (criterion:failure_type).
 * Returns the template data if found, or undefined.
 */
export function getRemediationTemplate(key: string): RemediationTemplate | undefined {
  return REMEDIATION_TEMPLATES.get(key);
}

// ---------------------------------------------------------------------------
// LLM-based remediation (Prompt 12 + 13)
// ---------------------------------------------------------------------------

export interface RemediationOutput {
  generic_fix: string;
  platform_steps: string[];
  designer_path?: string;
  code_fix: string | null;
  estimated_effort: string;
  fix_category: string;
  platform_docs_url?: string | null;
  notes?: string;
}

export interface VerificationOutput {
  fix_applied: boolean;
  violation_resolved: boolean;
  confidence: number;
  reasoning: string;
  remaining_issues?: string[];
  new_issues_introduced?: string[];
}

export async function generateLlmRemediation(
  finding: Finding,
  runner: PromptRunner,
  platformContext?: string,
): Promise<PlatformFix> {
  const hash = finding.finding_type_hash;

  // Check cache
  const cached = getCachedRemediation(hash);
  if (cached && cached.generated_by === "llm") return cached;

  const failureType = (finding.evidence.measured_values?.failure_type as string) ?? "unknown";
  const ctx = platformContext ?? WEBFLOW_CONTEXT;

  const userMessage = buildRemediationUserPrompt({
    wcagCriterion: finding.wcag_criterion,
    failureType,
    elementHtml: finding.evidence.element_html,
    reasoning: finding.analysis.reasoning,
    platform: "webflow",
    platformVersion: WEBFLOW_PLATFORM_VERSION,
  }) + `\n\n${ctx}`;

  const result = await runner.runPrompt<RemediationOutput>({
    template: remediationGeneration,
    userMessage,
  });

  if (result.success && result.data) {
    const fix: PlatformFix = {
      platform: "webflow",
      platform_version: WEBFLOW_PLATFORM_VERSION,
      steps: result.data.platform_steps,
      designer_path: result.data.designer_path ?? "",
      screenshots: [],
      generated_by: "llm",
      platform_docs_url: result.data.platform_docs_url ?? null,
    };

    setCachedRemediation(hash, fix);
    return fix;
  }

  // Fallback to template-based
  const adapter = new WebflowAdapter();
  return adapter.getRemediationSteps(finding);
}

export async function verifyRemediation(
  finding: Finding,
  fixDescription: string,
  fixedHtml: string,
  runner: PromptRunner,
): Promise<VerificationOutput | null> {
  const userMessage = buildVerificationUserPrompt({
    wcagCriterion: finding.wcag_criterion,
    originalHtml: finding.evidence.element_html,
    fixDescription,
    fixedHtml,
  });

  const result = await runner.runPrompt<VerificationOutput>({
    template: remediationVerification,
    userMessage,
  });

  if (result.success && result.data) {
    return result.data;
  }

  return null;
}

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

  getRemediationSteps(finding: Finding): PlatformFix {
    const hash = finding.finding_type_hash;

    // Check cache first
    const cached = getCachedRemediation(hash);
    if (cached) return cached;

    // Try template match
    const key = getTemplateKey(finding);
    const template = key ? REMEDIATION_TEMPLATES.get(key) : undefined;

    let fix: PlatformFix;

    if (template) {
      fix = {
        platform: "webflow",
        platform_version: WEBFLOW_PLATFORM_VERSION,
        steps: template.steps,
        designer_path: template.designer_path,
        screenshots: [],
        generated_by: "template",
        platform_docs_url: template.platform_docs_url,
      };
    } else {
      fix = {
        platform: "webflow",
        platform_version: WEBFLOW_PLATFORM_VERSION,
        steps: [
          `Review the element and fix the WCAG ${finding.wcag_criterion} violation using the Webflow Designer.`,
          "Open Element Settings (D) → Custom Attributes to add necessary ARIA attributes.",
        ],
        designer_path: "Element Settings (D) → Custom Attributes",
        screenshots: [],
        generated_by: "template",
        platform_docs_url: null,
      };
    }

    // Cache the result
    setCachedRemediation(hash, fix);
    return fix;
  }
}
