import sharp from "sharp";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 800;

export type ImageFetcher = (src: string, pageUrl: string) => Promise<string | undefined>;

/**
 * Create a fetcher that downloads an image by its `src`, downsizes it and
 * returns it as base64 PNG for vision prompts. Results are memoised by
 * resolved URL, so an image shared across pages is fetched once.
 *
 * Returns undefined (never throws) when the image can't be fetched or
 * decoded; callers fall back to a text-only evaluation.
 */
export function createImageFetcher(timeoutMs = 10_000): ImageFetcher {
  const cache = new Map<string, Promise<string | undefined>>();

  const load = async (resolved: string): Promise<string | undefined> => {
    try {
      let raw: Buffer;
      if (resolved.startsWith("data:")) {
        const comma = resolved.indexOf(",");
        if (comma === -1) return undefined;
        const meta = resolved.slice(5, comma);
        const body = resolved.slice(comma + 1);
        raw = meta.includes(";base64")
          ? Buffer.from(body, "base64")
          : Buffer.from(decodeURIComponent(body), "utf8");
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(resolved, { signal: controller.signal });
          if (!res.ok) return undefined;
          raw = Buffer.from(await res.arrayBuffer());
        } finally {
          clearTimeout(timer);
        }
      }
      if (raw.length === 0 || raw.length > MAX_BYTES) return undefined;

      const png = await sharp(raw)
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      return png.toString("base64");
    } catch {
      return undefined;
    }
  };

  return (src, pageUrl) => {
    if (!src.trim()) return Promise.resolve(undefined);
    let resolved: string;
    try {
      resolved = src.startsWith("data:") ? src : new URL(src, pageUrl).href;
    } catch {
      return Promise.resolve(undefined);
    }
    let pending = cache.get(resolved);
    if (!pending) {
      pending = load(resolved);
      cache.set(resolved, pending);
    }
    return pending;
  };
}
