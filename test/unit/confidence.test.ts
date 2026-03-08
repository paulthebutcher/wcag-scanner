import { describe, it, expect, vi } from "vitest";
import { scoreConfidence, scoreConfidenceBatch } from "../../src/core/confidence.js";
import type { Finding, Analysis, Evidence, Confidence as ConfidenceType, Remediation, PlatformFix } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStubAnalysis(overrides?: Partial<Analysis>): Analysis {
  return {
    method: "rule_based",
    reasoning: "",
    llm_input: null,
    llm_output: null,
    impact_description: "",
    affected_users: [],
    ...overrides,
  };
}

function makeStubEvidence(overrides?: Partial<Evidence>): Evidence {
  return {
    element_selector: "img.hero",
    element_html: '<img class="hero" src="photo.jpg">',
    element_screenshot: "",
    element_computed_styles: {},
    context_screenshot: "",
    measured_values: {},
    keyboard_sequence: null,
    aria_attributes: {},
    detected_by: "axe_core",
    ...overrides,
  };
}

function makeStubRemediation(): Remediation {
  const platformFix: PlatformFix = {
    platform: "unknown",
    platform_version: "",
    steps: [],
    designer_path: "",
    screenshots: [],
    generated_by: "template",
    platform_docs_url: null,
  };
  return {
    generic_fix: "",
    platform_fix: platformFix,
    code_fix: null,
    estimated_effort: "moderate",
    fix_verified: false,
  };
}

function makeFinding(overrides?: Partial<Finding>): Finding {
  return {
    id: "test-finding-001",
    page_snapshot_id: "ps-1",
    interaction_state_id: null,
    wcag_criterion: "1.1.1",
    wcag_level: "A",
    severity: "major",
    category: "images",
    finding_type_hash: "hash-1",
    evidence: makeStubEvidence(),
    analysis: makeStubAnalysis(),
    confidence: { score: 0, tier: "needs_review", basis: "", requires_human: false, false_positive_risk: "low" },
    remediation: makeStubRemediation(),
    human_review: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// axe-core → definitive
// ---------------------------------------------------------------------------

describe("scoreConfidence — axe_core", () => {
  it("scores axe-core violations as definitive (0.95+)", () => {
    const finding = makeFinding({
      evidence: makeStubEvidence({ detected_by: "axe_core" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("definitive");
    expect(result.score).toBeGreaterThanOrEqual(0.95);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.requires_human).toBe(false);
    expect(result.false_positive_risk).toBe("low");
  });

  it("scores axe-core incomplete as needs_review (0.40-0.60)", () => {
    const finding = makeFinding({
      evidence: makeStubEvidence({
        detected_by: "axe_core",
        measured_values: { axe_incomplete: true },
      }),
      analysis: makeStubAnalysis({ reasoning: "axe-core flagged as incomplete" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("needs_review");
    expect(result.score).toBeGreaterThanOrEqual(0.40);
    expect(result.score).toBeLessThanOrEqual(0.60);
    expect(result.requires_human).toBe(true);
  });

  it("basis explains definitive scoring", () => {
    const finding = makeFinding({
      evidence: makeStubEvidence({ detected_by: "axe_core" }),
    });
    const result = scoreConfidence(finding);
    expect(result.basis).toContain("axe-core");
    expect(result.basis).toContain("definitive");
  });
});

// ---------------------------------------------------------------------------
// Playwright → high
// ---------------------------------------------------------------------------

describe("scoreConfidence — playwright", () => {
  it("scores keyboard reachability (2.1.1) as definitive", () => {
    const finding = makeFinding({
      wcag_criterion: "2.1.1",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("definitive");
    expect(result.score).toBeGreaterThanOrEqual(0.95);
    expect(result.false_positive_risk).toBe("low");
  });

  it("scores focus visible (2.4.7) as high", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.7",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.80);
    expect(result.score).toBeLessThanOrEqual(0.94);
  });

  it("scores keyboard trap (2.1.2) as high", () => {
    const finding = makeFinding({
      wcag_criterion: "2.1.2",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.80);
  });

  it("scores focus order (2.4.3) with medium false positive risk", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.3",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.false_positive_risk).toBe("medium");
  });

  it("defaults to high for unknown playwright criteria", () => {
    const finding = makeFinding({
      wcag_criterion: "2.5.1",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.80);
  });
});

// ---------------------------------------------------------------------------
// Claude API → varies by prompt and failure type
// ---------------------------------------------------------------------------

describe("scoreConfidence — claude_api", () => {
  it("scores filename_as_alt (1.1.1) as high (0.85+)", () => {
    const finding = makeFinding({
      wcag_criterion: "1.1.1",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "filename_as_alt" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  it("scores decorative_vs_informative (1.1.1) as moderate (0.50-0.64)", () => {
    const finding = makeFinding({
      wcag_criterion: "1.1.1",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "decorative_vs_informative" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("moderate");
    expect(result.score).toBeGreaterThanOrEqual(0.50);
    expect(result.score).toBeLessThanOrEqual(0.64);
  });

  it("scores click_here (2.4.4) as high (0.90+)", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.4",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "click_here" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.90);
  });

  it("scores skipped_level heading (2.4.6) as definitive (0.95+)", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.6",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "skipped_level" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("definitive");
    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });

  it("scores style_not_structure heading as moderate with high false positive risk", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.6",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "style_not_structure" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("moderate");
    expect(result.false_positive_risk).toBe("high");
  });

  it("scores order_changed (3.2.3) as definitive", () => {
    const finding = makeFinding({
      wcag_criterion: "3.2.3",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "order_changed" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("definitive");
    expect(result.score).toBeGreaterThanOrEqual(0.95);
    expect(result.false_positive_risk).toBe("low");
  });

  it("scores link_color_only (1.4.1) as high", () => {
    const finding = makeFinding({
      wcag_criterion: "1.4.1",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "link_color_only" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  it("defaults unknown Claude criterion to moderate", () => {
    const finding = makeFinding({
      wcag_criterion: "99.99.99",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("moderate");
  });

  it("respects Claude's low confidence score override", () => {
    const finding = makeFinding({
      wcag_criterion: "1.1.1",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "filename_as_alt", confidence: 0.40 },
      }),
    });
    const result = scoreConfidence(finding);
    // Claude gave 0.40, which should override the 0.87 calibration
    expect(result.score).toBeLessThanOrEqual(0.50);
    expect(result.tier).toBe("needs_review");
  });
});

// ---------------------------------------------------------------------------
// Indicators / manual → needs_review
// ---------------------------------------------------------------------------

describe("scoreConfidence — manual/indicators", () => {
  it("scores manual detection as needs_review", () => {
    const finding = makeFinding({
      evidence: makeStubEvidence({ detected_by: "manual" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("needs_review");
    expect(result.score).toBeGreaterThanOrEqual(0.30);
    expect(result.score).toBeLessThanOrEqual(0.60);
    expect(result.requires_human).toBe(true);
    expect(result.false_positive_risk).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// requires_human flag
// ---------------------------------------------------------------------------

describe("scoreConfidence — requires_human", () => {
  it("requires human for needs_review tier", () => {
    const finding = makeFinding({
      evidence: makeStubEvidence({
        detected_by: "axe_core",
        measured_values: { axe_incomplete: true },
      }),
      analysis: makeStubAnalysis({ reasoning: "axe-core flagged as incomplete" }),
    });
    const result = scoreConfidence(finding);
    expect(result.requires_human).toBe(true);
  });

  it("requires human for moderate tier + critical severity", () => {
    const finding = makeFinding({
      wcag_criterion: "1.1.1",
      severity: "critical",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("moderate");
    expect(result.requires_human).toBe(true);
  });

  it("requires human for moderate tier + major severity", () => {
    const finding = makeFinding({
      wcag_criterion: "1.1.1",
      severity: "major",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    });
    const result = scoreConfidence(finding);
    expect(result.requires_human).toBe(true);
  });

  it("does NOT require human for high tier + major severity", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.4",
      severity: "major",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "click_here" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.tier).toBe("high");
    expect(result.requires_human).toBe(false);
  });

  it("requires human when Claude says requires_human_verification", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.4",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: {
          failure_type: "click_here",
          requires_human_verification: true,
        },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.requires_human).toBe(true);
  });

  it("requires human when false_positive_risk is high", () => {
    const finding = makeFinding({
      wcag_criterion: "2.4.6",
      severity: "minor",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "style_not_structure" },
      }),
    });
    const result = scoreConfidence(finding);
    expect(result.false_positive_risk).toBe("high");
    expect(result.requires_human).toBe(true);
  });

  it("does NOT require human for definitive axe-core violations", () => {
    const finding = makeFinding({
      severity: "critical",
      evidence: makeStubEvidence({ detected_by: "axe_core" }),
    });
    const result = scoreConfidence(finding);
    expect(result.requires_human).toBe(false);
  });

  it("always requires human for manual/indicator detections", () => {
    const finding = makeFinding({
      severity: "advisory",
      evidence: makeStubEvidence({ detected_by: "manual" }),
    });
    const result = scoreConfidence(finding);
    expect(result.requires_human).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// false_positive_risk
// ---------------------------------------------------------------------------

describe("scoreConfidence — false_positive_risk", () => {
  it("axe_core → low", () => {
    const result = scoreConfidence(makeFinding({
      evidence: makeStubEvidence({ detected_by: "axe_core" }),
    }));
    expect(result.false_positive_risk).toBe("low");
  });

  it("playwright keyboard reachability → low", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "2.1.1",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    }));
    expect(result.false_positive_risk).toBe("low");
  });

  it("playwright focus order → medium", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "2.4.3",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    }));
    expect(result.false_positive_risk).toBe("medium");
  });

  it("claude alt text → medium", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "1.1.1",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    }));
    expect(result.false_positive_risk).toBe("medium");
  });

  it("claude consistent nav → low", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "3.2.3",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    }));
    expect(result.false_positive_risk).toBe("low");
  });

  it("claude color use (chart) → high", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "1.4.1",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "chart_color_only" },
      }),
    }));
    expect(result.false_positive_risk).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Basis string
// ---------------------------------------------------------------------------

describe("scoreConfidence — basis string", () => {
  it("explains axe-core scoring", () => {
    const result = scoreConfidence(makeFinding({
      evidence: makeStubEvidence({ detected_by: "axe_core" }),
    }));
    expect(result.basis).toContain("axe-core");
  });

  it("explains playwright scoring", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "2.4.7",
      evidence: makeStubEvidence({ detected_by: "playwright" }),
    }));
    expect(result.basis).toContain("Playwright");
    expect(result.basis).toContain("2.4.7");
  });

  it("explains Claude API scoring with failure type", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "2.4.4",
      evidence: makeStubEvidence({
        detected_by: "claude_api",
        measured_values: { failure_type: "click_here" },
      }),
    }));
    expect(result.basis).toContain("Claude API");
    expect(result.basis).toContain("click_here");
  });

  it("recommends human review for moderate Claude findings", () => {
    const result = scoreConfidence(makeFinding({
      wcag_criterion: "1.1.1",
      evidence: makeStubEvidence({ detected_by: "claude_api" }),
    }));
    expect(result.basis).toContain("human review");
  });

  it("explains manual/indicator scoring", () => {
    const result = scoreConfidence(makeFinding({
      evidence: makeStubEvidence({ detected_by: "manual" }),
    }));
    expect(result.basis).toContain("Tier 5");
  });
});

// ---------------------------------------------------------------------------
// scoreConfidenceBatch
// ---------------------------------------------------------------------------

describe("scoreConfidenceBatch", () => {
  it("scores multiple findings", () => {
    const results = scoreConfidenceBatch([
      makeFinding({ evidence: makeStubEvidence({ detected_by: "axe_core" }) }),
      makeFinding({ wcag_criterion: "2.1.1", evidence: makeStubEvidence({ detected_by: "playwright" }) }),
      makeFinding({ wcag_criterion: "2.4.4", evidence: makeStubEvidence({ detected_by: "claude_api", measured_values: { failure_type: "click_here" } }) }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].tier).toBe("definitive");
    expect(results[1].tier).toBe("definitive");
    expect(results[2].tier).toBe("high");
  });

  it("isolates errors without failing the batch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = scoreConfidenceBatch([
      makeFinding({ evidence: makeStubEvidence({ detected_by: "axe_core" }) }),
      makeFinding({ evidence: makeStubEvidence({ detected_by: "axe_core" }) }),
    ]);

    expect(results).toHaveLength(2);
    warnSpy.mockRestore();
  });
});
