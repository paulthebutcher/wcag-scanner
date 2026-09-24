# Known Issues

## Forms hidden at page load are not interaction-tested

Forms with no visible fields when the page loads (inside a closed modal, a collapsed panel, or a third-party embed such as GrowSurf that opens on click) are skipped by the submission and on-input tests. The scanner logs:

`[forms] <url>: <selector> has no visible fields at page load — submission and on-input tests skipped`

DOM-based checks (1.3.5 input purpose, 3.3.4 high-risk forms) still run on these forms. If *no* form on the site could be exercised, 3.3.1, 3.3.3 and 3.2.2 are reported as `not_tested` rather than `passed`.

**Possible improvement:** reuse the trigger discovery from the modal checks (`src/checks/behavioral/modal.ts`) to open the container, then test the revealed form.
