/**
 * Table structure checks — detects table accessibility issues via pure DOM parsing.
 *
 * WCAG criteria:
 * - 1.3.1 Info and Relationships (tables must have proper headers, captions, scope)
 *
 * Failure types:
 * - table_no_caption — data table has no <caption> or aria-label
 * - table_header_no_scope — <th> element lacks scope attribute
 * - table_missing_headers — table with >3 columns and no <th> at all
 * - layout_table — table used for layout (no <th>, no <caption>), advisory
 */

import type { CheckResult } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TableInfo {
  selector: string;
  html: string; // truncated outer HTML
  hasCaption: boolean;
  hasAriaLabel: boolean;
  headerCells: Array<{ html: string; hasScope: boolean }>;
  dataCells: number;
  columnCount: number;
  isDataTable: boolean; // has at least one <th>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an attribute value from an attribute string.
 * Handles double-quoted, single-quoted, and unquoted values.
 */
function getAttr(attrStr: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = attrStr.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Build a CSS selector from an element's attributes. */
function buildSelector(tagName: string, attrStr: string, index: number): string {
  const id = getAttr(attrStr, "id");
  if (id) return `${tagName}#${id}`;
  const cls = getAttr(attrStr, "class");
  if (cls) {
    const classes = cls.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${tagName}.${classes}`;
  }
  return `${tagName}:nth-of-type(${index + 1})`;
}

/** Strip HTML tags from a string. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// DOM extraction
// ---------------------------------------------------------------------------

/**
 * Extract all tables from serialized DOM.
 * Parses each table for caption, aria-label, header cells, data cells,
 * and estimated column count.
 */
export function extractTables(dom: string): TableInfo[] {
  const tables: TableInfo[] = [];
  const tableRegex = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let tableIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(dom)) !== null) {
    const attrStr = match[1];
    const innerHtml = match[2];
    const fullHtml = match[0];

    // Check for <caption>
    const hasCaption = /<caption\b[^>]*>[\s\S]*?<\/caption>/i.test(innerHtml);

    // Check for aria-label on table
    const ariaLabel = getAttr(attrStr, "aria-label");
    const hasAriaLabel = ariaLabel !== null && ariaLabel.trim().length > 0;

    // Extract <th> elements
    const headerCells: Array<{ html: string; hasScope: boolean }> = [];
    const thRegex = /<th\b([^>]*)>([\s\S]*?)<\/th>/gi;
    let thMatch: RegExpExecArray | null;
    while ((thMatch = thRegex.exec(innerHtml)) !== null) {
      const thAttrStr = thMatch[1];
      const hasScope = getAttr(thAttrStr, "scope") !== null;
      headerCells.push({
        html: thMatch[0],
        hasScope,
      });
    }

    // Count <td> elements
    const tdRegex = /<td\b[^>]*>/gi;
    let dataCells = 0;
    while (tdRegex.exec(innerHtml) !== null) {
      dataCells++;
    }

    // Estimate column count from first <tr>
    let columnCount = 0;
    const firstTrMatch = innerHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    if (firstTrMatch) {
      const firstRowHtml = firstTrMatch[1];
      const cellRegex = /<(?:td|th)\b[^>]*>/gi;
      while (cellRegex.exec(firstRowHtml) !== null) {
        columnCount++;
      }
    }

    const isDataTable = headerCells.length > 0;

    const selector = buildSelector("table", attrStr, tableIndex);
    tables.push({
      selector,
      html: fullHtml.length > 200 ? fullHtml.slice(0, 200) + "..." : fullHtml,
      hasCaption,
      hasAriaLabel,
      headerCells,
      dataCells,
      columnCount,
      isDataTable,
    });

    tableIndex++;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

/**
 * Run table structure checks on a serialized DOM string.
 *
 * Returns CheckResult[] for:
 * - Data tables without caption or aria-label -> table_no_caption
 * - <th> elements without scope attribute -> table_header_no_scope
 * - Tables with >3 columns but no headers -> table_missing_headers
 * - Layout tables (no <th>, no <caption>) -> layout_table (advisory)
 */
export function runTableStructureChecks(dom: string): CheckResult[] {
  const tables = extractTables(dom);
  const results: CheckResult[] = [];

  for (const table of tables) {
    const ariaAttrs: Record<string, string> = {};
    if (table.hasAriaLabel) {
      // Re-extract the actual aria-label value for reporting
      const tableMatch = dom.match(new RegExp(`<table\\b([^>]*)>[\\s\\S]*?<\\/table>`, "gi"));
      if (tableMatch) {
        for (const tm of tableMatch) {
          const attrMatch = tm.match(/<table\b([^>]*)/i);
          if (attrMatch) {
            const val = getAttr(attrMatch[1], "aria-label");
            if (val) ariaAttrs["aria-label"] = val;
          }
        }
      }
    }

    if (table.isDataTable) {
      // Data table checks

      // Check: no caption and no aria-label
      if (!table.hasCaption && !table.hasAriaLabel) {
        results.push({
          element_selector: table.selector,
          element_html: table.html,
          wcag_criterion: "1.3.1",
          detected_by: "playwright",
          raw_result: {
            type: "table_no_caption",
            header_count: table.headerCells.length,
            data_cells: table.dataCells,
            column_count: table.columnCount,
          },
          measured_values: {
            failure_type: "table_no_caption",
            has_caption: false,
            header_count: table.headerCells.length,
            scope_count: table.headerCells.filter((h) => h.hasScope).length,
            column_count: table.columnCount,
          },
          aria_attributes: ariaAttrs,
        });
      }

      // Check: any <th> lacking scope
      const headersWithoutScope = table.headerCells.filter((h) => !h.hasScope);
      if (headersWithoutScope.length > 0) {
        results.push({
          element_selector: table.selector,
          element_html: table.html,
          wcag_criterion: "1.3.1",
          detected_by: "playwright",
          raw_result: {
            type: "table_header_no_scope",
            headers_without_scope: headersWithoutScope.length,
            total_headers: table.headerCells.length,
          },
          measured_values: {
            failure_type: "table_header_no_scope",
            has_caption: table.hasCaption,
            header_count: table.headerCells.length,
            scope_count: table.headerCells.filter((h) => h.hasScope).length,
            column_count: table.columnCount,
          },
          aria_attributes: ariaAttrs,
        });
      }
    } else {
      // Non-data table checks

      // Check: table with >3 columns but no headers at all
      if (table.columnCount > 3) {
        results.push({
          element_selector: table.selector,
          element_html: table.html,
          wcag_criterion: "1.3.1",
          detected_by: "playwright",
          raw_result: {
            type: "table_missing_headers",
            column_count: table.columnCount,
            data_cells: table.dataCells,
          },
          measured_values: {
            failure_type: "table_missing_headers",
            has_caption: table.hasCaption,
            header_count: 0,
            scope_count: 0,
            column_count: table.columnCount,
          },
          aria_attributes: ariaAttrs,
        });
      } else if (!table.hasCaption) {
        // Layout table: no <th>, no <caption>, has content
        const hasContent = stripTags(table.html).trim().length > 0;
        if (hasContent) {
          results.push({
            element_selector: table.selector,
            element_html: table.html,
            wcag_criterion: "1.3.1",
            detected_by: "playwright",
            raw_result: {
              type: "layout_table",
              data_cells: table.dataCells,
              column_count: table.columnCount,
            },
            measured_values: {
              failure_type: "layout_table",
              has_caption: false,
              header_count: 0,
              scope_count: 0,
              column_count: table.columnCount,
            },
            aria_attributes: ariaAttrs,
          });
        }
      }
    }
  }

  return results;
}
