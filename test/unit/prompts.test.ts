import { describe, it, expect } from "vitest";
import {
  ELEMENT_EVAL_BASE_SYSTEM,
  ELEMENT_EVAL_OUTPUT_SCHEMA,
  ELEMENT_EVAL_PROMPTS,
  ELEMENT_EVAL_CALIBRATIONS,
  altTextQuality,
  linkTextQuality,
  headingStructure,
  useOfColor,
  consistentNavigation,
  consistentIdentification,
  labelsOrInstructions,
  contentOnHoverFocus,
  buildAltTextUserPrompt,
  buildLinkTextUserPrompt,
  buildHeadingStructureUserPrompt,
  buildUseOfColorUserPrompt,
  buildConsistentNavUserPrompt,
  buildConsistentIdUserPrompt,
  buildLabelsUserPrompt,
  buildHoverFocusUserPrompt,
  ALT_TEXT_FAILURE_MODES,
  LINK_TEXT_FAILURE_MODES,
  HEADING_FAILURE_MODES,
  COLOR_FAILURE_MODES,
  type ConfidenceCalibration,
} from "../../src/prompts/element-evaluation.js";
import {
  FORM_PROMPTS,
  FORM_CALIBRATIONS,
  errorMessageQuality,
  highRiskFormDetection,
  inputPurposeMatching,
  buildErrorMessageUserPrompt,
  buildHighRiskFormUserPrompt,
  buildInputPurposeUserPrompt,
  ERROR_MESSAGE_FAILURE_MODES,
  HIGH_RISK_FORM_FAILURE_MODES,
  INPUT_PURPOSE_FAILURE_MODES,
} from "../../src/prompts/form-interaction.js";
import {
  REMEDIATION_PROMPTS,
  REMEDIATION_CALIBRATIONS,
  remediationGeneration,
  remediationVerification,
  buildRemediationUserPrompt,
  buildVerificationUserPrompt,
} from "../../src/prompts/remediation.js";
import {
  SYNTHESIS_PROMPTS,
  SYNTHESIS_CALIBRATIONS,
  impactDescription,
  executiveSummary,
  buildImpactUserPrompt,
  buildExecutiveSummaryUserPrompt,
} from "../../src/prompts/synthesis.js";
import type { PromptTemplate } from "../../src/core/prompt-runner.js";

// ---------------------------------------------------------------------------
// Helper: validate a PromptTemplate has required fields
// ---------------------------------------------------------------------------

function validateTemplate(template: PromptTemplate) {
  expect(template.name).toBeTruthy();
  expect(template.family).toBeTruthy();
  expect(["sonnet", "opus"]).toContain(template.model);
  expect(typeof template.vision).toBe("boolean");
  expect(template.systemPrompt.length).toBeGreaterThan(50);
  expect(template.outputSchema).toBeDefined();
  expect(template.outputSchema.type).toBe("object");
}

// ---------------------------------------------------------------------------
// Element Evaluation family (Prompts 1-8)
// ---------------------------------------------------------------------------

describe("Element Evaluation prompts", () => {
  it("exports 8 element evaluation prompts", () => {
    expect(Object.keys(ELEMENT_EVAL_PROMPTS)).toHaveLength(8);
  });

  it("all prompts have valid structure", () => {
    for (const template of Object.values(ELEMENT_EVAL_PROMPTS)) {
      validateTemplate(template);
      expect(template.family).toBe("element_evaluation");
      expect(template.model).toBe("sonnet");
    }
  });

  it("shares base system prompt across all element eval prompts", () => {
    for (const template of Object.values(ELEMENT_EVAL_PROMPTS)) {
      expect(template.systemPrompt).toContain(ELEMENT_EVAL_BASE_SYSTEM);
    }
  });

  it("has calibration rules for every prompt", () => {
    for (const name of Object.keys(ELEMENT_EVAL_PROMPTS)) {
      expect(ELEMENT_EVAL_CALIBRATIONS[name]).toBeDefined();
      expect(ELEMENT_EVAL_CALIBRATIONS[name].length).toBeGreaterThan(0);
    }
  });

  describe("Prompt 1: alt_text_quality", () => {
    it("uses vision", () => expect(altTextQuality.vision).toBe(true));
    it("targets 1.1.1", () => expect(altTextQuality.systemPrompt).toContain("1.1.1"));
    it("has failure modes", () => expect(ALT_TEXT_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 2: link_text_quality", () => {
    it("does not use vision", () => expect(linkTextQuality.vision).toBe(false));
    it("targets 2.4.4", () => expect(linkTextQuality.systemPrompt).toContain("2.4.4"));
    it("has failure modes", () => expect(LINK_TEXT_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 3: heading_structure", () => {
    it("does not use vision", () => expect(headingStructure.vision).toBe(false));
    it("targets 2.4.6", () => expect(headingStructure.systemPrompt).toContain("2.4.6"));
    it("has failure modes", () => expect(HEADING_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 4: use_of_color", () => {
    it("uses vision", () => expect(useOfColor.vision).toBe(true));
    it("targets 1.4.1", () => expect(useOfColor.systemPrompt).toContain("1.4.1"));
    it("has failure modes", () => expect(COLOR_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 5: consistent_navigation", () => {
    it("does not use vision", () => expect(consistentNavigation.vision).toBe(false));
    it("targets 3.2.3", () => expect(consistentNavigation.systemPrompt).toContain("3.2.3"));
  });

  describe("Prompt 6: consistent_identification", () => {
    it("uses vision", () => expect(consistentIdentification.vision).toBe(true));
    it("targets 3.2.4", () => expect(consistentIdentification.systemPrompt).toContain("3.2.4"));
  });

  describe("Prompt 7: labels_or_instructions", () => {
    it("uses vision", () => expect(labelsOrInstructions.vision).toBe(true));
    it("targets 3.3.2", () => expect(labelsOrInstructions.systemPrompt).toContain("3.3.2"));
  });

  describe("Prompt 8: content_on_hover_focus", () => {
    it("uses vision", () => expect(contentOnHoverFocus.vision).toBe(true));
    it("targets 1.4.13", () => expect(contentOnHoverFocus.systemPrompt).toContain("1.4.13"));
  });
});

// ---------------------------------------------------------------------------
// Form Interaction family (Prompts 9-11)
// ---------------------------------------------------------------------------

describe("Form Interaction prompts", () => {
  it("exports 3 form prompts", () => {
    expect(Object.keys(FORM_PROMPTS)).toHaveLength(3);
  });

  it("all prompts have valid structure", () => {
    for (const template of Object.values(FORM_PROMPTS)) {
      validateTemplate(template);
      expect(template.family).toBe("form_interaction");
      expect(template.model).toBe("sonnet");
    }
  });

  it("has calibration rules for every prompt", () => {
    for (const name of Object.keys(FORM_PROMPTS)) {
      expect(FORM_CALIBRATIONS[name]).toBeDefined();
      expect(FORM_CALIBRATIONS[name].length).toBeGreaterThan(0);
    }
  });

  describe("Prompt 9: error_message_quality", () => {
    it("uses vision", () => expect(errorMessageQuality.vision).toBe(true));
    it("targets 3.3.1 and 3.3.3", () => {
      expect(errorMessageQuality.systemPrompt).toContain("3.3.1");
      expect(errorMessageQuality.systemPrompt).toContain("3.3.3");
    });
    it("has failure modes", () => expect(ERROR_MESSAGE_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 10: high_risk_form_detection", () => {
    it("uses vision", () => expect(highRiskFormDetection.vision).toBe(true));
    it("targets 3.3.4", () => expect(highRiskFormDetection.systemPrompt).toContain("3.3.4"));
    it("has failure modes", () => expect(HIGH_RISK_FORM_FAILURE_MODES.length).toBeGreaterThan(0));
  });

  describe("Prompt 11: input_purpose_matching", () => {
    it("does not use vision", () => expect(inputPurposeMatching.vision).toBe(false));
    it("targets 1.3.5", () => expect(inputPurposeMatching.systemPrompt).toContain("1.3.5"));
    it("has failure modes", () => expect(INPUT_PURPOSE_FAILURE_MODES.length).toBeGreaterThan(0));
  });
});

// ---------------------------------------------------------------------------
// Remediation family (Prompts 12-13)
// ---------------------------------------------------------------------------

describe("Remediation prompts", () => {
  it("exports 2 remediation prompts", () => {
    expect(Object.keys(REMEDIATION_PROMPTS)).toHaveLength(2);
  });

  it("all prompts have valid structure", () => {
    for (const template of Object.values(REMEDIATION_PROMPTS)) {
      validateTemplate(template);
      expect(template.family).toBe("remediation");
      expect(template.model).toBe("sonnet");
    }
  });

  it("has calibration rules for every prompt", () => {
    for (const name of Object.keys(REMEDIATION_PROMPTS)) {
      expect(REMEDIATION_CALIBRATIONS[name]).toBeDefined();
      expect(REMEDIATION_CALIBRATIONS[name].length).toBeGreaterThan(0);
    }
  });

  describe("Prompt 12: remediation_generation", () => {
    it("uses vision", () => expect(remediationGeneration.vision).toBe(true));
    it("mentions platform-specific steps", () => {
      expect(remediationGeneration.systemPrompt).toContain("platform_steps");
    });
  });

  describe("Prompt 13: remediation_verification", () => {
    it("does not use vision", () => expect(remediationVerification.vision).toBe(false));
    it("mentions fix verification", () => {
      expect(remediationVerification.systemPrompt).toContain("fix_applied");
    });
  });
});

// ---------------------------------------------------------------------------
// Synthesis family (Prompts 14-15)
// ---------------------------------------------------------------------------

describe("Synthesis prompts", () => {
  it("exports 2 synthesis prompts", () => {
    expect(Object.keys(SYNTHESIS_PROMPTS)).toHaveLength(2);
  });

  it("has calibration rules for every prompt", () => {
    for (const name of Object.keys(SYNTHESIS_PROMPTS)) {
      expect(SYNTHESIS_CALIBRATIONS[name]).toBeDefined();
      expect(SYNTHESIS_CALIBRATIONS[name].length).toBeGreaterThan(0);
    }
  });

  describe("Prompt 14: impact_description", () => {
    it("uses sonnet", () => expect(impactDescription.model).toBe("sonnet"));
    it("does not use vision", () => expect(impactDescription.vision).toBe(false));
    it("mentions affected users", () => {
      expect(impactDescription.systemPrompt).toContain("affected_users");
    });
  });

  describe("Prompt 15: executive_summary", () => {
    it("uses opus", () => expect(executiveSummary.model).toBe("opus"));
    it("does not use vision", () => expect(executiveSummary.vision).toBe(false));
    it("mentions grading", () => {
      expect(executiveSummary.systemPrompt).toContain("overall_grade");
    });
  });
});

// ---------------------------------------------------------------------------
// All 15 prompts are registered and loadable
// ---------------------------------------------------------------------------

describe("Prompt registry", () => {
  const ALL_PROMPTS: Record<string, PromptTemplate> = {
    ...ELEMENT_EVAL_PROMPTS,
    ...FORM_PROMPTS,
    ...REMEDIATION_PROMPTS,
    ...SYNTHESIS_PROMPTS,
  };

  it("has exactly 15 prompts total", () => {
    expect(Object.keys(ALL_PROMPTS)).toHaveLength(15);
  });

  it("all prompts have unique names", () => {
    const names = Object.values(ALL_PROMPTS).map((p) => p.name);
    expect(new Set(names).size).toBe(15);
  });

  it("prompt runner can load any prompt by name", () => {
    const promptNames = [
      "alt_text_quality", "link_text_quality", "heading_structure", "use_of_color",
      "consistent_navigation", "consistent_identification", "labels_or_instructions",
      "content_on_hover_focus", "error_message_quality", "high_risk_form_detection",
      "input_purpose_matching", "remediation_generation", "remediation_verification",
      "impact_description", "executive_summary",
    ];
    for (const name of promptNames) {
      expect(ALL_PROMPTS[name]).toBeDefined();
      expect(ALL_PROMPTS[name].name).toBe(name);
    }
  });

  it("only executive_summary uses opus", () => {
    const opusPrompts = Object.values(ALL_PROMPTS).filter((p) => p.model === "opus");
    expect(opusPrompts).toHaveLength(1);
    expect(opusPrompts[0].name).toBe("executive_summary");
  });

  it("vision prompts are correctly flagged", () => {
    const visionPrompts = Object.values(ALL_PROMPTS).filter((p) => p.vision);
    const visionNames = visionPrompts.map((p) => p.name).sort();
    expect(visionNames).toEqual([
      "alt_text_quality",
      "consistent_identification",
      "content_on_hover_focus",
      "error_message_quality",
      "high_risk_form_detection",
      "labels_or_instructions",
      "remediation_generation",
      "use_of_color",
    ]);
  });
});

// ---------------------------------------------------------------------------
// User prompt template functions
// ---------------------------------------------------------------------------

describe("User prompt builders", () => {
  it("buildAltTextUserPrompt includes element and alt text", () => {
    const prompt = buildAltTextUserPrompt({
      elementHtml: '<img src="photo.jpg" alt="IMG_1234.jpg">',
      altText: "IMG_1234.jpg",
      surroundingContext: "A photo of our team",
    });
    expect(prompt).toContain("IMG_1234.jpg");
    expect(prompt).toContain("1.1.1");
  });

  it("buildLinkTextUserPrompt includes link text", () => {
    const prompt = buildLinkTextUserPrompt({
      elementHtml: '<a href="/page">Click here</a>',
      linkText: "Click here",
      surroundingContext: "For more information, click here.",
    });
    expect(prompt).toContain("Click here");
    expect(prompt).toContain("2.4.4");
  });

  it("buildHeadingStructureUserPrompt lists headings", () => {
    const prompt = buildHeadingStructureUserPrompt({
      headings: [
        { level: 1, text: "Welcome" },
        { level: 3, text: "Features" },
      ],
      pageTitle: "Home",
    });
    expect(prompt).toContain("h1: \"Welcome\"");
    expect(prompt).toContain("h3: \"Features\"");
  });

  it("buildUseOfColorUserPrompt includes styles", () => {
    const prompt = buildUseOfColorUserPrompt({
      elementHtml: '<a href="/link">Link</a>',
      computedStyles: { color: "blue", "text-decoration": "none" },
      context: "Body text paragraph",
    });
    expect(prompt).toContain("color: blue");
    expect(prompt).toContain("text-decoration: none");
  });

  it("buildConsistentNavUserPrompt lists pages", () => {
    const prompt = buildConsistentNavUserPrompt({
      pages: [
        { url: "/", navItems: ["Home", "About", "Contact"] },
        { url: "/about", navItems: ["Home", "Contact", "About"] },
      ],
    });
    expect(prompt).toContain('"Home"');
    expect(prompt).toContain("/about");
  });

  it("buildConsistentIdUserPrompt lists components", () => {
    const prompt = buildConsistentIdUserPrompt({
      components: [
        { page: "/", label: "Search", role: "search", html: "<input>" },
        { page: "/about", label: "Find", role: "search", html: "<input>" },
      ],
    });
    expect(prompt).toContain("Search");
    expect(prompt).toContain("Find");
  });

  it("buildLabelsUserPrompt includes ARIA attrs", () => {
    const prompt = buildLabelsUserPrompt({
      elementHtml: "<input type='email'>",
      labelText: "",
      placeholderText: "Enter email",
      ariaAttributes: { "aria-label": "Email address" },
    });
    expect(prompt).toContain("aria-label");
    expect(prompt).toContain("Email address");
  });

  it("buildHoverFocusUserPrompt includes interaction type", () => {
    const prompt = buildHoverFocusUserPrompt({
      triggerHtml: '<button>Info</button>',
      popupHtml: '<div class="tooltip">Details</div>',
      interactionType: "hover",
      dismissable: false,
    });
    expect(prompt).toContain("hover");
    expect(prompt).toContain("false");
  });

  it("buildErrorMessageUserPrompt includes field errors", () => {
    const prompt = buildErrorMessageUserPrompt({
      formHtml: "<form>...</form>",
      errorMessages: [
        { fieldName: "email", message: "Invalid email", associated: true },
      ],
      totalFields: 5,
    });
    expect(prompt).toContain("email");
    expect(prompt).toContain("Invalid email");
    expect(prompt).toContain("Total form fields: 5");
  });

  it("buildHighRiskFormUserPrompt includes risk indicators", () => {
    const prompt = buildHighRiskFormUserPrompt({
      formHtml: "<form>...</form>",
      fieldLabels: ["Credit Card", "CVV"],
      submitButtonText: "Pay Now",
      hasConfirmation: false,
      hasReviewStep: false,
    });
    expect(prompt).toContain("Credit Card");
    expect(prompt).toContain("Pay Now");
  });

  it("buildInputPurposeUserPrompt includes autocomplete info", () => {
    const prompt = buildInputPurposeUserPrompt({
      elementHtml: '<input type="text" name="fname">',
      labelText: "First Name",
      autocompleteValue: null,
      inputType: "text",
    });
    expect(prompt).toContain("First Name");
    expect(prompt).toContain("(not set)");
  });

  it("buildRemediationUserPrompt includes platform", () => {
    const prompt = buildRemediationUserPrompt({
      wcagCriterion: "1.1.1",
      failureType: "missing_alt",
      elementHtml: '<img src="photo.jpg">',
      reasoning: "Image has no alt attribute",
      platform: "webflow",
      platformVersion: "2024.1",
    });
    expect(prompt).toContain("webflow");
    expect(prompt).toContain("1.1.1");
  });

  it("buildVerificationUserPrompt includes before/after", () => {
    const prompt = buildVerificationUserPrompt({
      wcagCriterion: "1.1.1",
      originalHtml: '<img src="photo.jpg">',
      fixDescription: "Added alt attribute",
      fixedHtml: '<img src="photo.jpg" alt="Team photo">',
    });
    expect(prompt).toContain("Team photo");
    expect(prompt).toContain("Added alt attribute");
  });

  it("buildImpactUserPrompt includes severity and count", () => {
    const prompt = buildImpactUserPrompt({
      wcagCriterion: "1.1.1",
      failureType: "missing_alt",
      severity: "critical",
      elementHtml: '<img src="photo.jpg">',
      reasoning: "No alt text",
      instanceCount: 42,
    });
    expect(prompt).toContain("critical");
    expect(prompt).toContain("42");
  });

  it("buildExecutiveSummaryUserPrompt includes statistics", () => {
    const prompt = buildExecutiveSummaryUserPrompt({
      siteUrl: "https://example.com",
      totalPages: 30,
      totalFindings: 120,
      bySeverity: { critical: 5, major: 30, minor: 60, advisory: 25 },
      byCategory: { contrast: 20, keyboard: 15, images: 40 },
      criteriaFailed: ["1.1.1", "2.4.7"],
      criteriaPassed: ["2.4.1", "3.1.1"],
      criteriaTested: 38,
    });
    expect(prompt).toContain("example.com");
    expect(prompt).toContain("120");
    expect(prompt).toContain("critical: 5");
  });
});

// ---------------------------------------------------------------------------
// Confidence calibration validation
// ---------------------------------------------------------------------------

describe("Confidence calibrations", () => {
  const ALL_CALIBRATIONS: Record<string, ConfidenceCalibration[]> = {
    ...ELEMENT_EVAL_CALIBRATIONS,
    ...FORM_CALIBRATIONS,
    ...REMEDIATION_CALIBRATIONS,
    ...SYNTHESIS_CALIBRATIONS,
  };

  it("all calibrations have valid score ranges", () => {
    for (const [name, rules] of Object.entries(ALL_CALIBRATIONS)) {
      for (const rule of rules) {
        expect(rule.minConfidence).toBeGreaterThanOrEqual(0);
        expect(rule.maxConfidence).toBeLessThanOrEqual(1);
        expect(rule.minConfidence).toBeLessThanOrEqual(rule.maxConfidence);
        expect(["low", "medium", "high"]).toContain(rule.falsePositiveRisk);
      }
    }
  });

  it("all calibrations have failure type strings", () => {
    for (const [name, rules] of Object.entries(ALL_CALIBRATIONS)) {
      for (const rule of rules) {
        expect(rule.failureType).toBeTruthy();
        expect(typeof rule.failureType).toBe("string");
      }
    }
  });
});
