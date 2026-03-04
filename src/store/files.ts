import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Swappable interface for binary file storage.
 * Local filesystem implementation below; replace with S3 adapter later.
 */
export interface FileStore {
  store(scanId: string, filename: string, buffer: Buffer): string;
  retrieve(scanId: string, filename: string): Buffer;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly baseDir: string) {}

  store(scanId: string, filename: string, buffer: Buffer): string {
    const relPath = join(scanId, filename);
    const fullPath = join(this.baseDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, buffer);
    return relPath;
  }

  retrieve(scanId: string, filename: string): Buffer {
    const fullPath = join(this.baseDir, scanId, filename);
    return readFileSync(fullPath);
  }
}
