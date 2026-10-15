// ---------------------------------------------------------------------------
// Serialized-DOM helpers (P2-012). Checks that find elements in
// `PageSnapshot.full_dom` with regular expressions must not read the text of
// raw-text elements as markup: a browser never renders what is inside
// <style>, <script> or <noscript> (scripting on) as elements, and <template>
// content is inert. In scan 8e03985c an unclosed <style> held the whole
// header, and the alt-text check reported the logo link inside it on 49 pages.
// ---------------------------------------------------------------------------

/** Elements whose contents are never rendered as page elements. */
export const RAW_TEXT_ELEMENTS = ["style", "script", "noscript", "template"] as const;

const OPEN_RE = new RegExp(`<(${RAW_TEXT_ELEMENTS.join("|")})(?=[\\s>/])[^>]*>`, "gi");

/**
 * The serialized DOM with the contents of every <style>, <script>,
 * <noscript> and <template> element removed (the tags stay). An element with
 * no closing tag runs to the end of the document, as it does in a browser.
 * Use for element extraction; checks that read CSS or script text by design
 * (CSS animation rules, motion listeners) keep using the full DOM for that.
 */
export function withoutRawTextContent(html: string): string {
  let out = "";
  let from = 0;
  OPEN_RE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = OPEN_RE.exec(html)) !== null) {
    const contentStart = open.index + open[0].length;
    const close = new RegExp(`</${open[1]}\\s*>`, "gi");
    close.lastIndex = contentStart;
    const end = close.exec(html);
    out += html.slice(from, contentStart);
    if (!end) {
      from = html.length;
      break;
    }
    from = end.index;
    OPEN_RE.lastIndex = end.index + end[0].length;
  }
  return out + html.slice(from);
}
