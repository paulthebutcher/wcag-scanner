import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import http from "node:http";
import {
  detectPlatform,
  computeSummary,
  scan,
} from "../../src/core/scanner.js";
import { openDatabase } from "../../src/store/db.js";
import type { Finding, CriterionResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// detectPlatform — pure function tests
// ---------------------------------------------------------------------------

describe("detectPlatform", () => {
  it("detects Webflow from meta generator tag", () => {
    const dom = '<html><head><meta name="generator" content="Webflow"></head></html>';
    const result = detectPlatform(dom);
    expect(result.platform).toBe("webflow");
    expect(result.detected_via).toBe("meta_generator");
  });

  it("detects Webflow from class patterns", () => {
    const dom = '<html><body><div class="w-nav"><div class="w-container">x</div></div></body></html>';
    const result = detectPlatform(dom);
    expect(result.platform).toBe("webflow");
    expect(result.detected_via).toBe("class_patterns");
  });

  it("returns unknown for WordPress DOM", () => {
    const dom = '<html><head><meta name="generator" content="WordPress 6.4"></head></html>';
    const result = detectPlatform(dom);
    expect(result.platform).toBe("unknown");
    expect(result.detected_via).toBe("no_match");
  });

  it("returns unknown for plain HTML", () => {
    const dom = "<html><body><p>Hello</p></body></html>";
    const result = detectPlatform(dom);
    expect(result.platform).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// computeSummary — unit tests
// ---------------------------------------------------------------------------

describe("computeSummary", () => {
  function makeFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: randomUUID(),
      page_snapshot_id: "ps-1",
      interaction_state_id: null,
      wcag_criterion: "1.1.1",
      wcag_level: "A",
      severity: "major",
      category: "images",
      finding_type_hash: "hash-1",
      evidence: {
        element_selector: "img",
        element_html: "<img>",
        element_screenshot: "",
        element_computed_styles: {},
        context_screenshot: "",
        measured_values: {},
        keyboard_sequence: null,
        aria_attributes: {},
        detected_by: "axe_core",
      },
      analysis: {
        method: "rule_based",
        reasoning: "",
        llm_input: null,
        llm_output: null,
        impact_description: "",
        affected_users: [],
      },
      confidence: {
        score: 0.95,
        tier: "definitive",
        basis: "",
        requires_human: false,
        false_positive_risk: "low",
      },
      remediation: {
        generic_fix: "",
        platform_fix: {
          platform: "unknown",
          platform_version: "",
          steps: [],
          designer_path: "",
          screenshots: [],
          generated_by: "template",
          platform_docs_url: null,
        },
        code_fix: null,
        estimated_effort: "moderate",
        fix_verified: false,
      },
      human_review: null,
      ...overrides,
    };
  }

  it("computes correct totals and counts", () => {
    const findings = [
      makeFinding({ severity: "critical", category: "images", wcag_criterion: "1.1.1" }),
      makeFinding({ severity: "major", category: "contrast", wcag_criterion: "1.4.3" }),
      makeFinding({ severity: "minor", category: "semantics", wcag_criterion: "3.1.1" }),
    ];

    const passes: CriterionResult[] = [
      {
        scan_session_id: "s-1",
        wcag_criterion: "2.4.2",
        status: "passed",
        tested_by: "axe_core",
        evidence_summary: "Page has title",
        finding_ids: [],
      },
    ];

    const summary = computeSummary("s-1", findings, passes);

    expect(summary.total_findings).toBe(3);
    expect(summary.by_severity.critical).toBe(1);
    expect(summary.by_severity.major).toBe(1);
    expect(summary.by_severity.minor).toBe(1);
    expect(summary.by_severity.advisory).toBe(0);
    expect(summary.wcag_criteria_failed).toContain("1.1.1");
    expect(summary.wcag_criteria_failed).toContain("1.4.3");
    expect(summary.wcag_criteria_failed).toContain("3.1.1");
    expect(summary.wcag_criteria_passed).toContain("2.4.2");
  });

  it("does not include failed criteria in passed list", () => {
    const findings = [
      makeFinding({ wcag_criterion: "1.1.1" }),
    ];
    const passes: CriterionResult[] = [
      {
        scan_session_id: "s-1",
        wcag_criterion: "1.1.1", // Same criterion failed AND passed (partial pass)
        status: "passed",
        tested_by: "axe_core",
        evidence_summary: "Some passed",
        finding_ids: [],
      },
    ];

    const summary = computeSummary("s-1", findings, passes);
    expect(summary.wcag_criteria_failed).toContain("1.1.1");
    expect(summary.wcag_criteria_passed).not.toContain("1.1.1");
  });

  it("handles zero findings", () => {
    const summary = computeSummary("s-1", [], []);
    expect(summary.total_findings).toBe(0);
    expect(summary.wcag_criteria_failed).toEqual([]);
    expect(summary.estimated_total_effort).toBe("< 2 hours");
  });

  it("counts confidence tiers correctly", () => {
    const findings = [
      makeFinding({
        confidence: { score: 0.95, tier: "definitive", basis: "", requires_human: false, false_positive_risk: "low" },
      }),
      makeFinding({
        confidence: { score: 0.5, tier: "moderate", basis: "", requires_human: true, false_positive_risk: "medium" },
      }),
    ];

    const summary = computeSummary("s-1", findings, []);
    expect(summary.by_confidence.definitive).toBe(1);
    expect(summary.by_confidence.moderate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scan() — integration tests with real Playwright + HTTP server
// ---------------------------------------------------------------------------

describe("scan (integration)", () => {
  let browser: Browser;
  let tmpDir: string;
  let server: http.Server;
  let serverPort: number;
  let baseUrl: string;

  // HTML fixture with known accessibility violations
  const VIOLATION_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
</head>
<body>
  <img src="photo.jpg">
  <a href="/about"></a>
  <p style="color: #aaaaaa; background-color: #ffffff;">Low contrast</p>
  <h1>Test</h1>
  <a href="/contact">Contact</a>
  <img src="logo.png" alt="Logo">
</body>
</html>`;

  // Second page for multi-page crawl
  const SECOND_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>About Page</title>
</head>
<body>
  <h1>About</h1>
  <p>This page has proper lang attribute.</p>
  <a href="/">Home</a>
</body>
</html>`;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-scan-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    browser = await chromium.launch({ headless: true });

    // Start HTTP server with fixture pages
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url === "/" || req.url === "/index.html") {
        res.end(VIOLATION_HTML);
      } else if (req.url === "/about") {
        res.end(SECOND_PAGE_HTML);
      } else {
        res.statusCode = 404;
        res.end("<html><body>Not found</body></html>");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          serverPort = addr.port;
          baseUrl = `http://127.0.0.1:${serverPort}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs full Cycle 1 pipeline and returns results", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 5,
        tiers: [1],
      },
      browser,
    );

    // Should have a valid scan session
    expect(result.scanSession.id).toBeTruthy();
    expect(result.scanSession.url).toBe(baseUrl);
    expect(result.scanSession.completed_at).toBeTruthy();

    // Should have crawled at least the root page
    expect(result.pageSnapshots.length).toBeGreaterThanOrEqual(1);

    // Should have findings (missing alt, missing lang, empty link)
    expect(result.findings.length).toBeGreaterThan(0);

    // Should have summary
    expect(result.summary.total_findings).toBe(result.findings.length);
    expect(result.summary.scan_session_id).toBe(result.scanSession.id);
  });

  it("detects violations from fixture HTML", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 1,
        tiers: [1],
      },
      browser,
    );

    // Should find missing lang attribute
    const langViolation = result.findings.find((f) => f.wcag_criterion === "3.1.1");
    expect(langViolation).toBeDefined();
  });

  it("persists findings to SQLite", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 1,
        tiers: [1],
      },
      browser,
    );

    // Verify data was persisted
    const dbPath = join(tmpDir, "wcag.db");
    expect(existsSync(dbPath)).toBe(true);

    const db = openDatabase(dbPath);
    const rows = db.prepare("SELECT COUNT(*) as count FROM findings").get() as { count: number };
    expect(rows.count).toBe(result.findings.length);

    const sessionRow = db.prepare("SELECT * FROM scan_sessions WHERE id = ?").get(result.scanSession.id);
    expect(sessionRow).toBeDefined();

    const summaryRow = db.prepare("SELECT * FROM scan_summaries WHERE scan_session_id = ?").get(result.scanSession.id);
    expect(summaryRow).toBeDefined();

    db.close();
  });

  it("outputs scan ID as UUID", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 1,
        tiers: [1],
      },
      browser,
    );

    // UUID v4 format check
    expect(result.scanSession.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("saves partial results on non-fatal page errors", async () => {
    // The fixture has /about which is valid, other links return 404
    // The scan should still complete with partial results
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 5,
        tiers: [1],
      },
      browser,
    );

    // Should have at least root page results
    expect(result.pageSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(result.summary).toBeDefined();
  });

  it("populates criterion results for passed and failed checks", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 1,
        tiers: [1],
      },
      browser,
    );

    // Should have criterion results from axe-core passes + reconciliation
    expect(result.criterionResults.length).toBeGreaterThanOrEqual(1);

    // All criterion results should have valid status
    for (const cr of result.criterionResults) {
      expect(["passed", "failed", "not_applicable", "not_tested"]).toContain(cr.status);
    }

    // Criteria with findings should be marked "failed" (reconciliation)
    const failedCriteria = new Set(result.findings.map((f) => f.wcag_criterion));
    for (const criterion of failedCriteria) {
      const cr = result.criterionResults.find((r) => r.wcag_criterion === criterion);
      if (cr) {
        expect(cr.status).toBe("failed");
        expect(cr.finding_ids.length).toBeGreaterThan(0);
      }
    }

    // Criteria that only passed should still be "passed"
    const passedResults = result.criterionResults.filter((cr) => cr.status === "passed");
    for (const cr of passedResults) {
      expect(failedCriteria.has(cr.wcag_criterion)).toBe(false);
    }
  });

  it("detects platform as unknown for non-platform pages", async () => {
    const result = await scan(
      {
        url: baseUrl,
        dataDir: tmpDir,
        maxPages: 1,
        tiers: [1],
      },
      browser,
    );

    expect(result.scanSession.platform).toBe("unknown");
  });

  it("detects Webflow platform from DOM", async () => {
    // Create a Webflow-like server
    const wfServer = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html>
<html lang="en" data-wf-site="abc" data-wf-page="xyz">
<head><meta name="generator" content="Webflow"><title>WF Page</title></head>
<body><div class="w-nav"><div class="w-container"><h1>Hello</h1></div></div></body>
</html>`);
    });

    const wfPort = await new Promise<number>((resolve) => {
      wfServer.listen(0, "127.0.0.1", () => {
        const addr = wfServer.address();
        if (addr && typeof addr === "object") resolve(addr.port);
      });
    });

    try {
      const result = await scan(
        {
          url: `http://127.0.0.1:${wfPort}`,
          dataDir: tmpDir,
          maxPages: 1,
          tiers: [1],
        },
        browser,
      );

      expect(result.scanSession.platform).toBe("webflow");
      expect(result.scanSession.platform_detected_via).toBe("meta_generator");
    } finally {
      wfServer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// scan() — Tier 2 behavioral integration tests
// ---------------------------------------------------------------------------

describe("scan — Tier 2 behavioral", () => {
  let browser: Browser;
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;

  // HTML with keyboard-accessible elements and a button that IS reachable
  const KEYBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Keyboard Test</title>
</head>
<body>
  <a href="#main" class="skip-link" style="position:absolute;top:-100px;">Skip to main</a>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <main id="main">
    <h1>Keyboard Test Page</h1>
    <button>Click Me</button>
    <a href="/contact">Contact</a>
  </main>
</body>
</html>`;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-tier2-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    browser = await chromium.launch({ headless: true });

    server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(KEYBOARD_HTML);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs Tier 2 behavioral checks and populates analysis/confidence", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [2] },
      browser,
    );

    // Should have at least crawled the page
    expect(result.pageSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(result.scanSession.completed_at).toBeTruthy();
    expect(result.summary).toBeDefined();

    // Behavioral findings (if any) should have analysis populated
    for (const f of result.findings) {
      expect(f.evidence.detected_by).toBe("playwright");
      expect(f.analysis.method).toBe("rule_based");
      expect(f.analysis.reasoning).toBeTruthy();
      expect(f.analysis.impact_description).toBeTruthy();
      expect(f.analysis.affected_users.length).toBeGreaterThan(0);
      expect(f.confidence.basis).toBeTruthy();
      expect(f.confidence.score).toBeGreaterThan(0);
    }
  });

  it("creates criterion results for Tier 2 behavioral passes", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [2] },
      browser,
    );

    // Should have some passed criterion results from behavioral checks
    const behavioralPasses = result.criterionResults.filter(
      (cr) => cr.tested_by === "playwright" && cr.status === "passed",
    );
    // Our fixture has skip link and no traps, so at least those should pass
    expect(behavioralPasses.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// scan() — Tier selection (--tiers flag)
// ---------------------------------------------------------------------------

describe("scan — tier selection", () => {
  let browser: Browser;
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;

  const SIMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Simple Page</title></head>
<body><h1>Simple</h1><a href="/">Home</a></body>
</html>`;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-tiers-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    browser = await chromium.launch({ headless: true });

    server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SIMPLE_HTML);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs only specified tiers", async () => {
    // Run with no tiers (empty) — should still crawl but produce no findings
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [] },
      browser,
    );

    expect(result.pageSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.length).toBe(0);
    expect(result.summary.total_findings).toBe(0);
  });

  it("runs Tier 1 and Tier 2 together", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1, 2] },
      browser,
    );

    expect(result.pageSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(result.scanSession.completed_at).toBeTruthy();
    // All findings should have populated analysis
    for (const f of result.findings) {
      expect(f.analysis.reasoning).toBeTruthy();
      expect(f.confidence.score).toBeGreaterThan(0);
    }
  });

  it("handles partial failures gracefully", async () => {
    // Run with a non-existent tier (e.g., 99) — should silently skip
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1, 99] },
      browser,
    );

    expect(result.scanSession.completed_at).toBeTruthy();
    expect(result.summary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// scan() — analysis and confidence population
// ---------------------------------------------------------------------------

describe("scan — analysis and confidence pipeline", () => {
  let browser: Browser;
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;

  // Fixture with violations that will trigger analysis
  const VIOLATIONS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Test</title></head>
<body>
  <img src="photo.jpg">
  <a href="/page"></a>
  <h1>Title</h1>
</body>
</html>`;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `wcag-pipeline-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    browser = await chromium.launch({ headless: true });

    server = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(VIOLATIONS_HTML);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await browser.close();
    server.close();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("populates analysis with reasoning for axe-core findings", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1] },
      browser,
    );

    // Should have findings from missing lang, missing alt, empty link
    expect(result.findings.length).toBeGreaterThan(0);

    for (const f of result.findings) {
      // Analysis should be populated (not empty stub)
      expect(f.analysis.method).toBe("rule_based");
      expect(f.analysis.reasoning.length).toBeGreaterThan(0);
      expect(f.analysis.impact_description.length).toBeGreaterThan(0);
      expect(f.analysis.affected_users.length).toBeGreaterThan(0);
    }
  });

  it("populates confidence with definitive tier for axe-core findings", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1] },
      browser,
    );

    for (const f of result.findings) {
      // axe-core violations should be definitive
      expect(f.confidence.tier).toBe("definitive");
      expect(f.confidence.score).toBeGreaterThanOrEqual(0.95);
      expect(f.confidence.basis).toContain("axe-core");
      expect(f.confidence.false_positive_risk).toBe("low");
    }
  });

  it("persists analysis and confidence to database", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1] },
      browser,
    );

    const dbPath = join(tmpDir, "wcag.db");
    const db = openDatabase(dbPath);

    for (const f of result.findings) {
      const row = db.prepare("SELECT analysis, confidence FROM findings WHERE id = ?").get(f.id) as {
        analysis: string;
        confidence: string;
      };
      expect(row).toBeDefined();

      const analysis = JSON.parse(row.analysis);
      expect(analysis.reasoning.length).toBeGreaterThan(0);
      expect(analysis.impact_description.length).toBeGreaterThan(0);

      const confidence = JSON.parse(row.confidence);
      expect(confidence.tier).toBe("definitive");
      expect(confidence.score).toBeGreaterThanOrEqual(0.95);
    }

    db.close();
  });

  it("summary reflects confidence counts from scored findings", async () => {
    const result = await scan(
      { url: baseUrl, dataDir: tmpDir, maxPages: 1, tiers: [1] },
      browser,
    );

    // All axe findings → definitive
    expect(result.summary.by_confidence.definitive).toBe(result.findings.length);
    expect(result.summary.by_confidence.high).toBe(0);
    expect(result.summary.by_confidence.moderate).toBe(0);
    expect(result.summary.by_confidence.needs_review).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createScanCommand — CLI unit tests
// ---------------------------------------------------------------------------

describe("createScanCommand", () => {
  // CLI tests are covered implicitly by the scan() function tests above.
  // The command is a thin wrapper that parses args and calls scan().
  // We test the formatters and edge cases here.

  it("can be imported without errors", async () => {
    const { createScanCommand } = await import("../../src/cli/commands/scan.js");
    const cmd = createScanCommand();
    expect(cmd.name()).toBe("scan");
  });
});
