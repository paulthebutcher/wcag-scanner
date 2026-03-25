import { describe, it, expect } from "vitest";
import {
  extractTables,
  runTableStructureChecks,
} from "../../src/checks/semantic/table-structure.js";

// ---------------------------------------------------------------------------
// extractTables
// ---------------------------------------------------------------------------

describe("extractTables", () => {
  it("finds tables in DOM", () => {
    const dom = `<html><body>
      <table><tr><td>A</td><td>B</td></tr></table>
      <table id="t2"><tr><th>Name</th><td>Val</td></tr></table>
    </body></html>`;
    const tables = extractTables(dom);
    expect(tables.length).toBe(2);
  });

  it("detects <caption> presence", () => {
    const dom = `<table><caption>Sales Data</caption><tr><th>Q1</th></tr></table>`;
    const tables = extractTables(dom);
    expect(tables[0].hasCaption).toBe(true);
  });

  it("detects aria-label on table", () => {
    const dom = `<table aria-label="Revenue summary"><tr><th>Q1</th></tr></table>`;
    const tables = extractTables(dom);
    expect(tables[0].hasAriaLabel).toBe(true);
  });

  it("counts <th> elements and scope attributes", () => {
    const dom = `<table>
      <tr><th scope="col">Name</th><th>Age</th><th scope="col">City</th></tr>
      <tr><td>Alice</td><td>30</td><td>NYC</td></tr>
    </table>`;
    const tables = extractTables(dom);
    expect(tables[0].headerCells.length).toBe(3);
    expect(tables[0].headerCells.filter((h) => h.hasScope).length).toBe(2);
  });

  it("identifies data vs layout tables", () => {
    const domData = `<table><tr><th>Header</th></tr><tr><td>Data</td></tr></table>`;
    const domLayout = `<table><tr><td>Cell</td></tr></table>`;
    expect(extractTables(domData)[0].isDataTable).toBe(true);
    expect(extractTables(domLayout)[0].isDataTable).toBe(false);
  });

  it("returns empty for no tables", () => {
    const dom = `<html><body><div>No tables here</div></body></html>`;
    expect(extractTables(dom)).toEqual([]);
  });

  it("handles nested content correctly", () => {
    const dom = `<table id="nested">
      <tr><th scope="col"><span class="bold">Name</span></th></tr>
      <tr><td><a href="#">Link</a></td></tr>
    </table>`;
    const tables = extractTables(dom);
    expect(tables.length).toBe(1);
    expect(tables[0].headerCells.length).toBe(1);
    expect(tables[0].dataCells).toBe(1);
    expect(tables[0].selector).toBe("table#nested");
  });

  it("estimates column count from first row", () => {
    const dom = `<table>
      <tr><td>A</td><td>B</td><td>C</td><td>D</td></tr>
      <tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
    </table>`;
    const tables = extractTables(dom);
    expect(tables[0].columnCount).toBe(4);
  });

  it("builds selector from class when no id", () => {
    const dom = `<table class="w-table data"><tr><td>A</td></tr></table>`;
    const tables = extractTables(dom);
    expect(tables[0].selector).toBe("table.w-table.data");
  });
});

// ---------------------------------------------------------------------------
// runTableStructureChecks
// ---------------------------------------------------------------------------

describe("runTableStructureChecks", () => {
  it("flags data table without caption -> table_no_caption", () => {
    const dom = `<table>
      <tr><th>Name</th><th>Value</th></tr>
      <tr><td>A</td><td>1</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const noCaption = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_no_caption",
    );
    expect(noCaption).toBeDefined();
    expect(noCaption!.wcag_criterion).toBe("1.3.1");
  });

  it("flags <th> without scope -> table_header_no_scope", () => {
    const dom = `<table><caption>Test</caption>
      <tr><th>Name</th><th scope="col">Age</th></tr>
      <tr><td>Alice</td><td>30</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const noScope = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_header_no_scope",
    );
    expect(noScope).toBeDefined();
  });

  it("flags table with >3 columns and no headers -> table_missing_headers", () => {
    const dom = `<table>
      <tr><td>A</td><td>B</td><td>C</td><td>D</td></tr>
      <tr><td>1</td><td>2</td><td>3</td><td>4</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const missing = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_missing_headers",
    );
    expect(missing).toBeDefined();
    expect(missing!.wcag_criterion).toBe("1.3.1");
  });

  it("does NOT flag table with all <th> having scope", () => {
    const dom = `<table><caption>Sales</caption>
      <tr><th scope="col">Name</th><th scope="col">Value</th></tr>
      <tr><td>A</td><td>1</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const noScope = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_header_no_scope",
    );
    expect(noScope).toBeUndefined();
  });

  it("does NOT flag table with <caption>", () => {
    const dom = `<table><caption>Revenue</caption>
      <tr><th scope="col">Q1</th><th scope="col">Q2</th></tr>
      <tr><td>100</td><td>200</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const noCaption = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_no_caption",
    );
    expect(noCaption).toBeUndefined();
  });

  it("does NOT flag table with aria-label as missing caption", () => {
    const dom = `<table aria-label="Quarterly results">
      <tr><th scope="col">Q1</th><th scope="col">Q2</th></tr>
      <tr><td>100</td><td>200</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    const noCaption = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "table_no_caption",
    );
    expect(noCaption).toBeUndefined();
  });

  it("returns advisory for layout table", () => {
    const dom = `<table><tr><td>Layout content</td><td>More content</td></tr></table>`;
    const results = runTableStructureChecks(dom);
    const layout = results.find(
      (r) => (r.measured_values as Record<string, unknown>)?.failure_type === "layout_table",
    );
    expect(layout).toBeDefined();
  });

  it("returns empty for no tables", () => {
    const dom = `<html><body><p>No tables</p></body></html>`;
    const results = runTableStructureChecks(dom);
    expect(results).toEqual([]);
  });

  it("sets correct wcag_criterion 1.3.1", () => {
    const dom = `<table>
      <tr><th>Name</th></tr>
      <tr><td>Alice</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    for (const r of results) {
      expect(r.wcag_criterion).toBe("1.3.1");
    }
  });

  it("sets detected_by to playwright", () => {
    const dom = `<table>
      <tr><th>Name</th></tr>
      <tr><td>Alice</td></tr>
    </table>`;
    const results = runTableStructureChecks(dom);
    for (const r of results) {
      expect(r.detected_by).toBe("playwright");
    }
  });
});
