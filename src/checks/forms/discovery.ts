import type { PageSnapshot } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Information about a single form field */
export interface FormFieldInfo {
  /** CSS selector for the field */
  selector: string;
  /** Outer HTML of the field element */
  html: string;
  /** Tag name (input, select, textarea) */
  tagName: string;
  /** Input type (text, email, password, etc.) */
  type: string;
  /** Field name attribute */
  name: string | null;
  /** Associated label text (from <label>, aria-label, or aria-labelledby) */
  label: string;
  /** Whether the field is marked required */
  required: boolean;
  /** Current autocomplete attribute value */
  autocomplete: string | null;
  /** Placeholder text */
  placeholder: string | null;
  /** aria-describedby value */
  ariaDescribedby: string | null;
  /** aria-invalid value */
  ariaInvalid: string | null;
}

/** Detected purpose of a form */
export type FormPurpose =
  | "login"
  | "registration"
  | "contact"
  | "search"
  | "newsletter"
  | "checkout"
  | "payment"
  | "comment"
  | "password_reset"
  | "unknown";

/** Complete information about a discovered form */
export interface FormInfo {
  /** CSS selector for the form element */
  selector: string;
  /** Outer HTML of the form (truncated for large forms) */
  html: string;
  /** Action URL (from action attribute) */
  action: string | null;
  /** Method (GET/POST) */
  method: string;
  /** All fields within the form */
  fields: FormFieldInfo[];
  /** Submit button text */
  submitButtonText: string;
  /** Submit button selector */
  submitButtonSelector: string | null;
  /** Detected form purpose from context */
  purpose: FormPurpose;
  /** Whether this appears to be a Webflow form component */
  isWebflowForm: boolean;
  /** Whether this is a div-based "form" (no <form> element) */
  isDivBased: boolean;
}

// ---------------------------------------------------------------------------
// Attribute extraction helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an HTML tag string */
function extractAttr(tag: string, attr: string): string | null {
  const regex = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(regex);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Check if a tag has a boolean attribute (e.g., required, disabled) */
function hasBooleanAttr(tag: string, attr: string): boolean {
  // Match: required, required="required", required="true", required=""
  const regex = new RegExp(`\\b${attr}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*))?(?=\\s|>|/>)`, "i");
  return regex.test(tag);
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Field collection
// ---------------------------------------------------------------------------

/** Build a CSS selector for a field element */
function buildFieldSelector(tag: string, tagName: string, index: number): string {
  const id = extractAttr(tag, "id");
  if (id) return `#${id}`;

  const name = extractAttr(tag, "name");
  const type = extractAttr(tag, "type");
  const className = extractAttr(tag, "class");

  if (name) {
    return `${tagName}[name="${name}"]`;
  }

  if (className) {
    const classes = className.split(/\s+/).filter(Boolean).join(".");
    return `${tagName}.${classes}`;
  }

  if (type) {
    return `${tagName}[type="${type}"]:nth-of-type(${index + 1})`;
  }

  return `${tagName}:nth-of-type(${index + 1})`;
}

/**
 * Find the label text associated with a field.
 * Checks: <label for="id">, wrapping <label>, aria-label, aria-labelledby, placeholder.
 */
function findLabelText(fieldTag: string, dom: string): string {
  // 1. Check aria-label
  const ariaLabel = extractAttr(fieldTag, "aria-label");
  if (ariaLabel) return ariaLabel;

  // 2. Check for <label for="id">
  const fieldId = extractAttr(fieldTag, "id");
  if (fieldId) {
    const labelRegex = new RegExp(`<label[^>]*\\bfor\\s*=\\s*["']${escapeRegex(fieldId)}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i");
    const labelMatch = dom.match(labelRegex);
    if (labelMatch) {
      const text = stripTags(labelMatch[1]);
      if (text) return text;
    }
  }

  // 3. Check for wrapping <label> by looking at context around the field
  const fieldIndex = dom.indexOf(fieldTag);
  if (fieldIndex !== -1) {
    const before = dom.slice(Math.max(0, fieldIndex - 500), fieldIndex);
    const after = dom.slice(fieldIndex + fieldTag.length, Math.min(dom.length, fieldIndex + fieldTag.length + 500));

    // Look for opening <label> before and closing </label> after
    const lastLabelOpen = before.lastIndexOf("<label");
    const labelCloseAfter = after.indexOf("</label>");
    if (lastLabelOpen !== -1 && labelCloseAfter !== -1) {
      // Check no closing </label> between the open and the field
      const betweenLabelAndField = before.slice(lastLabelOpen);
      if (!betweenLabelAndField.includes("</label>")) {
        const labelContent = betweenLabelAndField.replace(/<label[^>]*>/, "");
        const text = stripTags(labelContent);
        if (text) return text;
      }
    }
  }

  // 4. Check placeholder as last resort
  const placeholder = extractAttr(fieldTag, "placeholder");
  if (placeholder) return placeholder;

  // 5. Check name attribute as fallback
  const name = extractAttr(fieldTag, "name");
  if (name) return name;

  return "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect all form fields from a DOM region.
 * Finds <input>, <select>, and <textarea> elements.
 */
export function collectFields(dom: string, regionDom: string): FormFieldInfo[] {
  const fields: FormFieldInfo[] = [];
  const fieldRegex = /<(input|select|textarea)\b[^>]*\/?>/gi;
  let fieldMatch: RegExpExecArray | null;
  const fieldCounts: Record<string, number> = { input: 0, select: 0, textarea: 0 };

  while ((fieldMatch = fieldRegex.exec(regionDom)) !== null) {
    const fieldTag = fieldMatch[0];
    const tagName = fieldMatch[1].toLowerCase();

    // Skip hidden inputs and submit/button inputs
    const inputType = (extractAttr(fieldTag, "type") ?? (tagName === "input" ? "text" : tagName)).toLowerCase();
    if (inputType === "hidden" || inputType === "submit" || inputType === "button" || inputType === "image" || inputType === "reset") {
      continue;
    }

    const index = fieldCounts[tagName] ?? 0;
    fieldCounts[tagName] = index + 1;

    fields.push({
      selector: buildFieldSelector(fieldTag, tagName, index),
      html: fieldTag,
      tagName,
      type: inputType,
      name: extractAttr(fieldTag, "name"),
      label: findLabelText(fieldTag, dom),
      required: hasBooleanAttr(fieldTag, "required") || extractAttr(fieldTag, "aria-required") === "true",
      autocomplete: extractAttr(fieldTag, "autocomplete"),
      placeholder: extractAttr(fieldTag, "placeholder"),
      ariaDescribedby: extractAttr(fieldTag, "aria-describedby"),
      ariaInvalid: extractAttr(fieldTag, "aria-invalid"),
    });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Form purpose detection
// ---------------------------------------------------------------------------

/** Keywords mapping to form purposes */
const PURPOSE_SIGNALS: Array<{ purpose: FormPurpose; patterns: RegExp[] }> = [
  {
    purpose: "login",
    patterns: [
      /\b(log\s*in|sign\s*in|login)\b/i,
      /\bpassword\b/i,
    ],
  },
  {
    purpose: "registration",
    patterns: [
      /\b(sign\s*up|register|create\s*account|join)\b/i,
      /\bconfirm[_\s-]?password\b/i,
    ],
  },
  {
    purpose: "contact",
    patterns: [
      /\b(contact|get\s*in\s*touch|reach\s*out|send\s*message|inquiry)\b/i,
    ],
  },
  {
    purpose: "search",
    patterns: [
      /\b(search|find|look\s*up)\b/i,
      /type\s*=\s*["']search["']/i,
      /role\s*=\s*["']search["']/i,
    ],
  },
  {
    purpose: "newsletter",
    patterns: [
      /\b(newsletter|subscribe|mailing\s*list|email\s*updates)\b/i,
    ],
  },
  {
    purpose: "checkout",
    patterns: [
      /\b(checkout|check\s*out|place\s*order|buy\s*now)\b/i,
    ],
  },
  {
    purpose: "payment",
    patterns: [
      /\b(payment|pay\s*now|credit\s*card|billing)\b/i,
      /autocomplete\s*=\s*["']cc-/i,
    ],
  },
  {
    purpose: "comment",
    patterns: [
      /\b(comment|reply|respond|feedback)\b/i,
    ],
  },
  {
    purpose: "password_reset",
    patterns: [
      /\b(reset\s*password|forgot\s*password|recover)\b/i,
    ],
  },
];

/**
 * Detect form purpose from its HTML content, field labels, and submit button text.
 */
export function detectFormPurpose(formHtml: string, fields: FormFieldInfo[], submitText: string): FormPurpose {
  // Combine all text signals
  const searchText = [
    formHtml,
    submitText,
    ...fields.map((f) => `${f.label} ${f.name ?? ""} ${f.placeholder ?? ""}`),
  ].join(" ");

  // Check for login-specific: has password field + no confirm password
  const hasPassword = fields.some((f) => f.type === "password");
  const hasConfirmPassword = fields.some((f) =>
    f.type === "password" && (
      /confirm/i.test(f.name ?? "") ||
      /confirm/i.test(f.label) ||
      /re.?enter/i.test(f.label) ||
      /repeat/i.test(f.label)
    ),
  );

  if (hasPassword && !hasConfirmPassword && fields.length <= 3) {
    return "login";
  }
  if (hasPassword && hasConfirmPassword) {
    return "registration";
  }

  // Search-only form: single input with type=search or role=search
  if (fields.length === 1 && (fields[0].type === "search" || /search/i.test(fields[0].name ?? ""))) {
    return "search";
  }

  // Newsletter: single email field
  if (fields.length === 1 && fields[0].type === "email" && /subscri|newsletter/i.test(searchText)) {
    return "newsletter";
  }

  // Check pattern matches with priority order
  for (const { purpose, patterns } of PURPOSE_SIGNALS) {
    if (patterns.some((p) => p.test(searchText))) {
      return purpose;
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Submit button detection
// ---------------------------------------------------------------------------

/**
 * Find the submit button within a form's HTML.
 * Checks: <button type="submit">, <input type="submit">, <button> (default), Webflow .w-button
 */
function findSubmitButton(formHtml: string): { text: string; selector: string | null } {
  // 1. <input type="submit">
  const inputSubmitMatch = formHtml.match(/<input\b[^>]*type\s*=\s*["']submit["'][^>]*>/i);
  if (inputSubmitMatch) {
    const value = extractAttr(inputSubmitMatch[0], "value") ?? "Submit";
    const id = extractAttr(inputSubmitMatch[0], "id");
    return { text: value, selector: id ? `#${id}` : 'input[type="submit"]' };
  }

  // 2. <button type="submit"> or <button> (default type is submit)
  const buttonRegex = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  let buttonMatch: RegExpExecArray | null;
  while ((buttonMatch = buttonRegex.exec(formHtml)) !== null) {
    const btnTag = buttonMatch[0];
    const btnType = extractAttr(btnTag, "type");
    if (!btnType || btnType === "submit") {
      const text = stripTags(buttonMatch[1]).trim() || "Submit";
      const id = extractAttr(btnTag, "id");
      const cls = extractAttr(btnTag, "class");
      let selector: string | null = null;
      if (id) selector = `#${id}`;
      else if (cls) selector = `button.${cls.split(/\s+/).filter(Boolean).join(".")}`;
      else selector = 'button[type="submit"]';
      return { text, selector };
    }
  }

  // 3. Webflow .w-button (often an <a> or <div> acting as submit)
  const wButtonMatch = formHtml.match(/<[a-z]+\b[^>]*class\s*=\s*["'][^"']*\bw-button\b[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i);
  if (wButtonMatch) {
    const text = stripTags(wButtonMatch[1]).trim() || "Submit";
    return { text, selector: ".w-button" };
  }

  // 4. Any element with role="button" containing submit-like text
  const roleButtonRegex = /<[a-z]+\b[^>]*role\s*=\s*["']button["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
  let roleMatch: RegExpExecArray | null;
  while ((roleMatch = roleButtonRegex.exec(formHtml)) !== null) {
    const text = stripTags(roleMatch[1]).trim();
    if (/submit|send|go|sign|log|create|join|subscribe/i.test(text)) {
      return { text, selector: '[role="button"]' };
    }
  }

  return { text: "Submit", selector: null };
}

// ---------------------------------------------------------------------------
// Webflow form detection
// ---------------------------------------------------------------------------

/** Check if form HTML contains Webflow form markers */
function isWebflowFormComponent(formHtml: string): boolean {
  return /\bw-form\b/i.test(formHtml) ||
    /\bdata-wf-/i.test(formHtml) ||
    /\bw-input\b/i.test(formHtml) ||
    /\bw-select\b/i.test(formHtml) ||
    /\bw-button\b/i.test(formHtml);
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

/**
 * Build a structural fingerprint for a form so the same form repeated across
 * pages (site-wide newsletter signup, footer contact form, CMS template form)
 * can be tested once.
 *
 * Built from the form selector, action, method, submit button, and each
 * field's type/name/label/validation attributes. Deliberately excludes the
 * page URL and raw HTML so per-page noise doesn't defeat matching, but
 * includes everything that drives validation behavior.
 */
export function formFingerprint(form: FormInfo): string {
  const fields = form.fields.map((f) =>
    [f.tagName, f.type, f.name ?? "", f.label, f.required ? "req" : "", f.autocomplete ?? "",
      f.placeholder ?? "", f.ariaDescribedby ?? ""].join("~"),
  );
  return [
    form.selector,
    form.action ?? "",
    form.method,
    form.isDivBased ? "div" : "form",
    form.submitButtonSelector ?? "",
    form.submitButtonText,
    ...fields,
  ].join("|");
}

/**
 * Discover all forms on a page from its DOM snapshot.
 *
 * Finds:
 * 1. Native <form> elements
 * 2. Div-based "forms" (containers with inputs + a submit-like button)
 * 3. Webflow form components (.w-form)
 *
 * For each form: catalogs fields with type, label, name, required, autocomplete.
 * Detects form purpose from context (login, registration, contact, etc.)
 */
export function discoverForms(snapshot: PageSnapshot): FormInfo[] {
  const dom = snapshot.full_dom;
  const forms: FormInfo[] = [];

  // --- 1. Native <form> elements ---
  const formRegex = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let formMatch: RegExpExecArray | null;
  let formIndex = 0;

  while ((formMatch = formRegex.exec(dom)) !== null) {
    const fullFormHtml = formMatch[0];
    const formContent = formMatch[1];
    const formTag = fullFormHtml.match(/<form\b[^>]*>/i)?.[0] ?? "<form>";

    const fields = collectFields(dom, formContent);

    // Skip forms with no fields (e.g., empty search forms handled by JS)
    if (fields.length === 0) continue;

    const submitButton = findSubmitButton(formContent);
    const purpose = detectFormPurpose(fullFormHtml, fields, submitButton.text);

    const id = extractAttr(formTag, "id");
    const cls = extractAttr(formTag, "class");
    let selector: string;
    if (id) selector = `#${id}`;
    else if (cls) selector = `form.${cls.split(/\s+/).filter(Boolean).join(".")}`;
    else selector = `form:nth-of-type(${formIndex + 1})`;

    forms.push({
      selector,
      html: truncateHtml(fullFormHtml, 5000),
      action: extractAttr(formTag, "action"),
      method: (extractAttr(formTag, "method") ?? "GET").toUpperCase(),
      fields,
      submitButtonText: submitButton.text,
      submitButtonSelector: submitButton.selector,
      purpose,
      isWebflowForm: isWebflowFormComponent(fullFormHtml),
      isDivBased: false,
    });

    formIndex++;
  }

  // --- 2. Webflow .w-form containers that aren't already captured ---
  const wFormRegex = /<div\b[^>]*class\s*=\s*["'][^"']*\bw-form\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/gi;
  let wFormMatch: RegExpExecArray | null;

  while ((wFormMatch = wFormRegex.exec(dom)) !== null) {
    const wFormHtml = wFormMatch[0];

    // Skip if this contains a <form> we already captured
    if (/<form\b/i.test(wFormHtml)) continue;

    const fields = collectFields(dom, wFormHtml);
    if (fields.length === 0) continue;

    const submitButton = findSubmitButton(wFormHtml);
    const purpose = detectFormPurpose(wFormHtml, fields, submitButton.text);

    forms.push({
      selector: ".w-form",
      html: truncateHtml(wFormHtml, 5000),
      action: null,
      method: "POST",
      fields,
      submitButtonText: submitButton.text,
      submitButtonSelector: submitButton.selector,
      purpose,
      isWebflowForm: true,
      isDivBased: true,
    });
  }

  // --- 3. Div-based "forms" — containers with inputs + submit-like button ---
  // Look for groups of related inputs not inside a <form>
  const divFormCandidates = findDivBasedForms(dom, forms);
  forms.push(...divFormCandidates);

  return forms;
}

/**
 * Find div-based "forms" — containers with multiple inputs and a submit-like button
 * that are NOT already inside a discovered <form> or .w-form.
 */
function findDivBasedForms(dom: string, existingForms: FormInfo[]): FormInfo[] {
  const results: FormInfo[] = [];

  // Collect all selectors from fields in existing forms to avoid double-counting
  const knownFieldSelectors = new Set<string>();
  for (const form of existingForms) {
    for (const field of form.fields) {
      knownFieldSelectors.add(field.selector);
    }
  }

  // Find containers with role="form"
  const roleFormRegex = /<([a-z]+)\b[^>]*role\s*=\s*["']form["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let roleMatch: RegExpExecArray | null;

  while ((roleMatch = roleFormRegex.exec(dom)) !== null) {
    const containerHtml = roleMatch[0];
    const fields = collectFields(dom, containerHtml);

    // Filter out fields already claimed by existing forms
    const newFields = fields.filter((f) => !knownFieldSelectors.has(f.selector));
    if (newFields.length === 0) continue;

    const submitButton = findSubmitButton(containerHtml);
    const purpose = detectFormPurpose(containerHtml, newFields, submitButton.text);

    results.push({
      selector: '[role="form"]',
      html: truncateHtml(containerHtml, 5000),
      action: null,
      method: "POST",
      fields: newFields,
      submitButtonText: submitButton.text,
      submitButtonSelector: submitButton.selector,
      purpose,
      isWebflowForm: isWebflowFormComponent(containerHtml),
      isDivBased: true,
    });

    for (const f of newFields) knownFieldSelectors.add(f.selector);
  }

  return results;
}

/** Truncate HTML to a maximum length, appending "..." if truncated */
function truncateHtml(html: string, maxLength: number): string {
  if (html.length <= maxLength) return html;
  return html.slice(0, maxLength) + "...";
}
