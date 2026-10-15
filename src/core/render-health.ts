import type { Page } from "playwright";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Render health (P2-011). A page whose served HTML is intact can still render
// broken: on 2026-10-13 an unclosed <style> in Webflow head custom code turned
// the body markup into style text, so browsers showed a blank page (scan
// 8e03985c). Every check then ran on what was left and the scan reported
// fewer findings, which reads as progress. This module measures the render
// once per page, on the crawl's own load, and says whether it can be trusted.
// ---------------------------------------------------------------------------

export interface RenderHealthMeasures {
  /** Visible text in the rendered body (innerText, trimmed) */
  visible_text_chars: number;
  /** Structural elements rendered in the body (section, main, header, footer, nav, article) */
  rendered_structure: number;
  /** The same elements in the served HTML, outside script text; null when the response body was unavailable */
  served_structure: number | null;
  /** Approximate text in the served HTML (tags, scripts and styles removed); null when unavailable */
  served_text_chars: number | null;
  /** Element tags found inside <style> text: body markup the browser read as CSS */
  swallowed_elements: number;
  /** Whether the swallowed text holds a <body> tag */
  swallowed_body: boolean;
  /** Full-page screenshot is one flat colour; null when no screenshot was taken */
  screenshot_uniform: boolean | null;
}

export interface RenderHealth {
  status: "ok" | "render_failed";
  /** Why the render failed (empty when ok) */
  reasons: string[];
  measures: RenderHealthMeasures;
}

const STRUCTURE_TAGS = ["section", "main", "header", "footer", "nav", "article"];
const STRUCTURE_RE = new RegExp(`<(?:${STRUCTURE_TAGS.join("|")})(?=[\\s>/])`, "gi");
/** Element markup that never belongs in CSS text */
const SWALLOWED_RE = /<(?:body|header|footer|main|nav|section|article|div|h[1-6]|a|img|p)(?=[\s>/])/gi;

/** Thresholds, exported for tests and documentation. */
export const RENDER_HEALTH_LIMITS = {
  /** Element tags inside style text before the body counts as swallowed (a CSS comment may quote one or two) */
  swallowedElements: 3,
  /** Served structure below this is too small to compare */
  minServedStructure: 4,
  /** Rendered structure below this share of the served structure fails */
  minStructureRatio: 0.5,
  /** Served text above this with almost no rendered text fails */
  minServedText: 500,
  maxBlankText: 20,
  /** A screenshot whose channels all vary less than this is one flat colour */
  uniformStdev: 2,
} as const;

/** Remove the contents of <script> elements (their text may quote markup). */
function withoutScriptText(html: string): string {
  return html.replace(/<script(?=[\s>/])[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, "<script></script>");
}

/** Structural element count and approximate text length of served HTML. */
export function measureServedHtml(html: string): { structure: number; text_chars: number } {
  const noScripts = withoutScriptText(html);
  const structure = (noScripts.match(STRUCTURE_RE) ?? []).length;
  const text = noScripts
    .replace(/<style(?=[\s>/])[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { structure, text_chars: text.length };
}

/** Whether every channel of a screenshot is (almost) one value. */
export async function isUniformImage(png: Buffer): Promise<boolean> {
  const { channels } = await sharp(png).stats();
  return channels.every((c) => c.stdev < RENDER_HEALTH_LIMITS.uniformStdev);
}

/** Pure decision from the measures. */
export function classifyRenderHealth(m: RenderHealthMeasures): RenderHealth {
  const L = RENDER_HEALTH_LIMITS;
  const reasons: string[] = [];
  if (m.swallowed_body || m.swallowed_elements >= L.swallowedElements) {
    reasons.push(`page markup inside a <style> element (${m.swallowed_elements} element tag(s)${m.swallowed_body ? ", including <body>" : ""}); usually an unclosed <style> in custom code`);
  }
  if (m.served_structure !== null && m.served_structure >= L.minServedStructure && m.rendered_structure < m.served_structure * L.minStructureRatio) {
    reasons.push(`rendered ${m.rendered_structure} of ${m.served_structure} served section/landmark elements`);
  }
  if (m.served_text_chars !== null && m.served_text_chars >= L.minServedText && m.visible_text_chars <= L.maxBlankText) {
    reasons.push(`no visible text rendered (${m.visible_text_chars} characters; served HTML has about ${m.served_text_chars})`);
  }
  if (m.screenshot_uniform && ((m.served_structure ?? 0) >= L.minServedStructure || (m.served_text_chars ?? 0) >= L.minServedText)) {
    reasons.push("screenshot is blank (one flat colour)");
  }
  return { status: reasons.length > 0 ? "render_failed" : "ok", reasons, measures: m };
}

/**
 * Measure a loaded page. `servedHtml` is the document response body (null
 * when unavailable); `screenshot` is the page's full-page screenshot.
 */
export async function assessRenderHealth(page: Page, servedHtml: string | null, screenshot: Buffer | null): Promise<RenderHealth> {
  const live = await page.evaluate(({ structureTags, swallowedSource }) => {
    const body = document.body;
    const swallowed = new RegExp(swallowedSource, "gi");
    let swallowedElements = 0;
    let swallowedBody = false;
    for (const style of Array.from(document.querySelectorAll("style"))) {
      const text = style.textContent ?? "";
      swallowedElements += (text.match(swallowed) ?? []).length;
      if (/<body(?=[\s>/])/i.test(text)) swallowedBody = true;
    }
    return {
      visible_text_chars: body ? (body.innerText ?? "").trim().length : 0,
      rendered_structure: body ? body.querySelectorAll(structureTags.join(",")).length : 0,
      swallowed_elements: swallowedElements,
      swallowed_body: swallowedBody,
    };
  }, { structureTags: STRUCTURE_TAGS, swallowedSource: SWALLOWED_RE.source });
  const served = servedHtml === null ? null : measureServedHtml(servedHtml);
  const uniform = screenshot ? await isUniformImage(screenshot).catch(() => null) : null;
  return classifyRenderHealth({
    ...live,
    served_structure: served?.structure ?? null,
    served_text_chars: served?.text_chars ?? null,
    screenshot_uniform: uniform,
  });
}
