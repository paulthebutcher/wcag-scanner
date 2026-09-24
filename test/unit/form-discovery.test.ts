import { describe, it, expect } from "vitest";
import {
  discoverForms,
  collectFields,
  detectFormPurpose,
  formFingerprint,
  type FormFieldInfo,
  type FormInfo,
} from "../../src/checks/forms/discovery.js";
import type { PageSnapshot } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper to create a PageSnapshot from HTML
// ---------------------------------------------------------------------------

function makeSnapshot(html: string): PageSnapshot {
  return {
    id: "snap-1",
    scan_session_id: "scan-1",
    url: "https://example.com",
    title: "Test Page",
    captured_at: new Date().toISOString(),
    full_dom: html,
    screenshot: "",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  };
}

// ---------------------------------------------------------------------------
// Test HTML snippets
// ---------------------------------------------------------------------------

const LOGIN_FORM_HTML = `
<html><body>
  <form id="login-form" method="POST" action="/login">
    <label for="email">Email</label>
    <input id="email" type="email" name="email" required autocomplete="email">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" required autocomplete="current-password">
    <button type="submit">Log In</button>
  </form>
</body></html>
`;

const REGISTRATION_FORM_HTML = `
<html><body>
  <form id="signup" method="POST" action="/register">
    <label for="reg-name">Full Name</label>
    <input id="reg-name" type="text" name="name" required autocomplete="name">
    <label for="reg-email">Email Address</label>
    <input id="reg-email" type="email" name="email" required autocomplete="email">
    <label for="reg-pass">Password</label>
    <input id="reg-pass" type="password" name="password" required>
    <label for="reg-confirm">Confirm Password</label>
    <input id="reg-confirm" type="password" name="confirm_password" required>
    <button type="submit">Create Account</button>
  </form>
</body></html>
`;

const CONTACT_FORM_HTML = `
<html><body>
  <form class="contact-form" method="POST" action="/contact">
    <label for="c-name">Your Name</label>
    <input id="c-name" type="text" name="name" placeholder="Jane Doe" autocomplete="name">
    <label for="c-email">Email</label>
    <input id="c-email" type="email" name="email" required autocomplete="email">
    <label for="c-message">Message</label>
    <textarea id="c-message" name="message" required></textarea>
    <button type="submit">Send Message</button>
  </form>
</body></html>
`;

const SEARCH_FORM_HTML = `
<html><body>
  <form action="/search" method="GET">
    <input type="search" name="q" placeholder="Search..." aria-label="Search the site">
    <button type="submit">Go</button>
  </form>
</body></html>
`;

const WEBFLOW_FORM_HTML = `
<html><body>
  <div class="w-form">
    <form id="wf-form" data-wf-page-id="abc123" method="POST">
      <label for="wf-name">Name</label>
      <input id="wf-name" class="w-input" type="text" name="name" required>
      <label for="wf-email">Email</label>
      <input id="wf-email" class="w-input" type="email" name="email" required>
      <input type="submit" value="Subscribe" class="w-button">
    </form>
    <div class="w-form-done">Thank you!</div>
    <div class="w-form-fail">Something went wrong.</div>
  </div>
</body></html>
`;

const DIV_BASED_FORM_HTML = `
<html><body>
  <div role="form" aria-label="Newsletter Signup">
    <label for="nl-email">Email</label>
    <input id="nl-email" type="email" name="email" required>
    <button type="submit">Subscribe</button>
  </div>
</body></html>
`;

const MULTIPLE_FORMS_HTML = `
<html><body>
  <form id="search-form" method="GET" action="/search">
    <input type="search" name="q" aria-label="Search">
    <button type="submit">Search</button>
  </form>
  <form id="newsletter" method="POST" action="/subscribe">
    <label for="news-email">Email for updates</label>
    <input id="news-email" type="email" name="email" required>
    <button type="submit">Subscribe</button>
  </form>
</body></html>
`;

const FORM_WITH_HIDDEN_FIELDS_HTML = `
<html><body>
  <form method="POST" action="/submit">
    <input type="hidden" name="csrf_token" value="abc123">
    <input type="hidden" name="form_id" value="42">
    <label for="vis-name">Name</label>
    <input id="vis-name" type="text" name="name" required>
    <button type="submit">Submit</button>
  </form>
</body></html>
`;

const FORM_NO_FIELDS_HTML = `
<html><body>
  <form id="empty-form" action="/api">
    <input type="hidden" name="token" value="xyz">
    <button type="submit">Go</button>
  </form>
  <p>Some content</p>
</body></html>
`;

const ARIA_FORM_HTML = `
<html><body>
  <form id="aria-form" method="POST">
    <input type="text" name="username" aria-label="Username" aria-required="true" required>
    <input type="password" name="pwd" aria-label="Password" aria-describedby="pwd-hint">
    <span id="pwd-hint">Must be 8+ characters</span>
    <button type="submit">Log In</button>
  </form>
</body></html>
`;

// ---------------------------------------------------------------------------
// discoverForms — native forms
// ---------------------------------------------------------------------------

describe("discoverForms", () => {
  it("discovers a login form with correct fields", () => {
    const forms = discoverForms(makeSnapshot(LOGIN_FORM_HTML));
    expect(forms.length).toBe(1);
    const form = forms[0];
    expect(form.selector).toBe("#login-form");
    expect(form.action).toBe("/login");
    expect(form.method).toBe("POST");
    expect(form.fields.length).toBe(2);
    expect(form.submitButtonText).toBe("Log In");
    expect(form.purpose).toBe("login");
    expect(form.isDivBased).toBe(false);
  });

  it("catalogs field details correctly", () => {
    const forms = discoverForms(makeSnapshot(LOGIN_FORM_HTML));
    const emailField = forms[0].fields.find((f) => f.name === "email")!;
    expect(emailField.type).toBe("email");
    expect(emailField.label).toBe("Email");
    expect(emailField.required).toBe(true);
    expect(emailField.autocomplete).toBe("email");
    expect(emailField.selector).toBe("#email");
  });

  it("detects registration form purpose", () => {
    const forms = discoverForms(makeSnapshot(REGISTRATION_FORM_HTML));
    expect(forms.length).toBe(1);
    expect(forms[0].purpose).toBe("registration");
    expect(forms[0].fields.length).toBe(4);
  });

  it("detects contact form purpose", () => {
    const forms = discoverForms(makeSnapshot(CONTACT_FORM_HTML));
    expect(forms.length).toBe(1);
    expect(forms[0].purpose).toBe("contact");
    // textarea should be included
    const messageField = forms[0].fields.find((f) => f.tagName === "textarea");
    expect(messageField).toBeDefined();
    expect(messageField!.name).toBe("message");
  });

  it("detects search form purpose", () => {
    const forms = discoverForms(makeSnapshot(SEARCH_FORM_HTML));
    expect(forms.length).toBe(1);
    expect(forms[0].purpose).toBe("search");
    expect(forms[0].method).toBe("GET");
    expect(forms[0].fields.length).toBe(1);
    expect(forms[0].fields[0].type).toBe("search");
  });

  it("detects Webflow form components", () => {
    const forms = discoverForms(makeSnapshot(WEBFLOW_FORM_HTML));
    expect(forms.length).toBe(1);
    expect(forms[0].isWebflowForm).toBe(true);
    expect(forms[0].fields.length).toBe(2); // name + email (submit input excluded)
    expect(forms[0].submitButtonText).toBe("Subscribe");
  });

  it("handles div-based forms with role=form", () => {
    const forms = discoverForms(makeSnapshot(DIV_BASED_FORM_HTML));
    expect(forms.length).toBe(1);
    expect(forms[0].isDivBased).toBe(true);
    expect(forms[0].fields.length).toBe(1);
    expect(forms[0].fields[0].type).toBe("email");
  });

  it("discovers multiple forms on one page", () => {
    const forms = discoverForms(makeSnapshot(MULTIPLE_FORMS_HTML));
    expect(forms.length).toBe(2);
    expect(forms[0].purpose).toBe("search");
    expect(forms[1].purpose).toBe("newsletter");
  });

  it("skips hidden fields", () => {
    const forms = discoverForms(makeSnapshot(FORM_WITH_HIDDEN_FIELDS_HTML));
    expect(forms.length).toBe(1);
    // Only visible fields (no hidden inputs)
    expect(forms[0].fields.length).toBe(1);
    expect(forms[0].fields[0].name).toBe("name");
  });

  it("skips forms with no visible fields", () => {
    const forms = discoverForms(makeSnapshot(FORM_NO_FIELDS_HTML));
    expect(forms.length).toBe(0);
  });

  it("handles aria-label and aria-describedby", () => {
    const forms = discoverForms(makeSnapshot(ARIA_FORM_HTML));
    expect(forms.length).toBe(1);
    const usernameField = forms[0].fields.find((f) => f.name === "username")!;
    expect(usernameField.label).toBe("Username");
    expect(usernameField.required).toBe(true);

    const pwdField = forms[0].fields.find((f) => f.name === "pwd")!;
    expect(pwdField.label).toBe("Password");
    expect(pwdField.ariaDescribedby).toBe("pwd-hint");
  });

  it("returns empty array for page with no forms", () => {
    const html = "<html><body><h1>No forms here</h1></body></html>";
    const forms = discoverForms(makeSnapshot(html));
    expect(forms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectFields
// ---------------------------------------------------------------------------

describe("collectFields", () => {
  it("collects input, select, and textarea fields", () => {
    const html = `
      <input type="text" name="first" id="first">
      <select name="country" id="country"><option>US</option></select>
      <textarea name="bio" id="bio"></textarea>
    `;
    const fields = collectFields(html, html);
    expect(fields.length).toBe(3);
    expect(fields.map((f) => f.tagName)).toEqual(["input", "select", "textarea"]);
  });

  it("skips hidden, submit, button, image, and reset inputs", () => {
    const html = `
      <input type="hidden" name="token">
      <input type="submit" value="Go">
      <input type="button" value="Cancel">
      <input type="image" src="btn.png">
      <input type="reset" value="Reset">
      <input type="text" name="visible">
    `;
    const fields = collectFields(html, html);
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe("visible");
  });

  it("detects required via attribute", () => {
    const html = `<input type="text" name="req" required>`;
    const fields = collectFields(html, html);
    expect(fields[0].required).toBe(true);
  });

  it("detects required via aria-required", () => {
    const html = `<input type="text" name="req" aria-required="true">`;
    const fields = collectFields(html, html);
    expect(fields[0].required).toBe(true);
  });

  it("marks non-required fields correctly", () => {
    const html = `<input type="text" name="opt">`;
    const fields = collectFields(html, html);
    expect(fields[0].required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectFormPurpose
// ---------------------------------------------------------------------------

describe("detectFormPurpose", () => {
  it("detects login from password field without confirm", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#email", html: "", tagName: "input", type: "email", name: "email", label: "Email", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
      { selector: "#pass", html: "", tagName: "input", type: "password", name: "password", label: "Password", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form>login form</form>", fields, "Log In")).toBe("login");
  });

  it("detects registration from confirm password", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#email", html: "", tagName: "input", type: "email", name: "email", label: "Email", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
      { selector: "#pass", html: "", tagName: "input", type: "password", name: "password", label: "Password", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
      { selector: "#confirm", html: "", tagName: "input", type: "password", name: "confirm_password", label: "Confirm Password", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form>sign up</form>", fields, "Create Account")).toBe("registration");
  });

  it("detects search from single search input", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#q", html: "", tagName: "input", type: "search", name: "q", label: "Search", required: false, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form>search</form>", fields, "Go")).toBe("search");
  });

  it("returns unknown for unrecognizable form", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#x", html: "", tagName: "input", type: "text", name: "data", label: "Data", required: false, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form></form>", fields, "OK")).toBe("unknown");
  });

  it("detects newsletter from email + subscribe text", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#email", html: "", tagName: "input", type: "email", name: "email", label: "Email", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form>newsletter subscribe</form>", fields, "Subscribe")).toBe("newsletter");
  });

  it("detects payment from billing keywords", () => {
    const fields: FormFieldInfo[] = [
      { selector: "#card", html: "", tagName: "input", type: "text", name: "card", label: "Credit Card", required: true, autocomplete: null, placeholder: null, ariaDescribedby: null, ariaInvalid: null },
    ];
    expect(detectFormPurpose("<form>payment info</form>", fields, "Pay Now")).toBe("payment");
  });
});

describe("formFingerprint", () => {
  const signup = (extra = "") => `
    <html><body><main><p>Page-specific copy ${extra}</p></main>
    <form class="grsf-signup-form" novalidate>
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required>
      <button type="submit">Join</button>
    </form></body></html>`;

  it("matches the same form on pages with different surrounding content", () => {
    const [a] = discoverForms(makeSnapshot(signup("home")));
    const [b] = discoverForms(makeSnapshot(signup("pricing")));
    expect(formFingerprint(a)).toBe(formFingerprint(b));
  });

  it("differs when a field's validation attributes differ", () => {
    const [a] = discoverForms(makeSnapshot(signup()));
    const [b] = discoverForms(makeSnapshot(signup().replace(" required>", ">")));
    expect(formFingerprint(a)).not.toBe(formFingerprint(b));
  });

  it("differs when the form action differs", () => {
    const [a] = discoverForms(makeSnapshot(signup()));
    const [b] = discoverForms(makeSnapshot(signup().replace("novalidate", 'novalidate action="/other"')));
    expect(formFingerprint(a)).not.toBe(formFingerprint(b));
  });
});
