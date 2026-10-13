import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Local server for the D0 pilot fixture (test/fixtures/eval-pilot). Hosts:
//   www.pilot-site.test        the site
//   cdn.pilot-assets.test      external-looking images (Node-fetched by alt text)
//   telemetry.pilot-assets.test  a beacon host (declared exclusion in the pilot)
// The browser reaches them through --host-resolver-rules and Node through the
// capture fetch's host map. Every request is logged so the pilot can prove
// that no submission endpoint was ever reached.
// ---------------------------------------------------------------------------

export const PILOT_SITE_HOST = "www.pilot-site.test";
export const PILOT_CDN_HOST = "cdn.pilot-assets.test";
export const PILOT_TELEMETRY_HOST = "telemetry.pilot-assets.test";

export interface FixtureHit {
  host: string;
  method: string;
  path: string;
  submission: boolean;
}

export interface FixtureServer {
  port: number;
  siteOrigin: string;
  cdnOrigin: string;
  hits: FixtureHit[];
  /** Requests that reached a submission endpoint (must stay empty) */
  submissionHits(): FixtureHit[];
  /** Chromium flag mapping the fixture hosts to this server */
  hostResolverArg: string;
  hostMap: Record<string, string>;
  close(): Promise<void>;
}

const PAGES: Record<string, string> = {
  "/": "home.html",
  "/contact": "contact.html",
  "/about": "about.html",
  "/trap": "trap.html",
};

/** Submission endpoints: any hit here means containment failed. */
function isSubmission(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return true;
  return path.startsWith("/search") || path.startsWith("/api/");
}

async function png(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

export async function startFixtureServer(fixtureDir: string): Promise<FixtureServer> {
  const images: Record<string, Buffer> = {
    "/images/logo.png": await png(120, 40, [47, 93, 58]),
    "/images/hero.png": await png(1200, 600, [120, 160, 90]),
    "/images/divider.png": await png(600, 8, [200, 200, 200]),
    "/team.png": await png(900, 450, [90, 110, 160]),
  };
  const hits: FixtureHit[] = [];
  let port = 0;
  const site = () => `http://${PILOT_SITE_HOST}:${port}`;
  const template = (text: string) => text
    .replaceAll("{{SITE_WS}}", `ws://${PILOT_SITE_HOST}:${port}`)
    .replaceAll("{{SITE}}", site())
    .replaceAll("{{CDN}}", `http://${PILOT_CDN_HOST}:${port}`)
    .replaceAll("{{TELEMETRY}}", `http://${PILOT_TELEMETRY_HOST}:${port}`);

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);
    const method = req.method ?? "GET";
    hits.push({ host, method, path: url.pathname + url.search, submission: host === PILOT_SITE_HOST && isSubmission(method, url.pathname) });
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };

    if (host === PILOT_CDN_HOST) {
      if (url.pathname === "/team.png") return send(200, "image/png", images["/team.png"]);
      if (url.pathname.startsWith("/x-")) return send(200, "image/png", images["/images/divider.png"]);
      return send(404, "text/plain", "not found");
    }
    if (host === PILOT_TELEMETRY_HOST) return send(204, "text/plain", "");

    const page = PAGES[url.pathname];
    if (page) return send(200, "text/html; charset=utf-8", template(readFileSync(join(fixtureDir, page), "utf8")));
    if (url.pathname === "/css/site.css") return send(200, "text/css", readFileSync(join(fixtureDir, "site.css")));
    if (url.pathname === "/js/site.js") return send(200, "application/javascript", readFileSync(join(fixtureDir, "site.js")));
    if (url.pathname === "/sw.js") return send(200, "application/javascript", readFileSync(join(fixtureDir, "sw.js")));
    if (images[url.pathname]) return send(200, "image/png", images[url.pathname]);
    if (url.pathname === "/robots.txt") return send(200, "text/plain", `User-agent: *\nDisallow: /private\n\nSitemap: ${site()}/sitemap.xml\n`);
    if (url.pathname === "/sitemap.xml") {
      const locs = ["/", "/contact", "/about"].map((p) => `<url><loc>${site()}${p}</loc></url>`).join("");
      return send(200, "application/xml", `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    }
    if (url.pathname.startsWith("/late/")) return send(200, "application/json", '{"late":true}');
    if (url.pathname.startsWith("/search")) return send(200, "text/html", "<p>Search results</p>");
    if (url.pathname.startsWith("/api/")) return send(200, "application/json", '{"ok":true}');
    return send(404, "text/plain", "not found");
  });
  server.on("upgrade", (req, socket) => {
    hits.push({ host: (req.headers.host ?? "").split(":")[0], method: "UPGRADE", path: req.url ?? "", submission: false });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const mapped = `127.0.0.1:${port}`;
  return {
    port,
    siteOrigin: site(),
    cdnOrigin: `http://${PILOT_CDN_HOST}:${port}`,
    hits,
    submissionHits: () => hits.filter((h) => h.submission),
    hostResolverArg: `--host-resolver-rules=MAP ${PILOT_SITE_HOST} 127.0.0.1, MAP ${PILOT_CDN_HOST} 127.0.0.1, MAP ${PILOT_TELEMETRY_HOST} 127.0.0.1`,
    hostMap: { [PILOT_SITE_HOST]: mapped, [PILOT_CDN_HOST]: mapped, [PILOT_TELEMETRY_HOST]: mapped },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
