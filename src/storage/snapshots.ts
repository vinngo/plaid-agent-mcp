import { promises as fs } from "node:fs";
import path from "node:path";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

/**
 * Where snapshots and the latest.json pointer live. Keys are always the S3-style
 * relative paths from the spec (`snapshots/<ts>/holdings.csv`), so the local
 * and S3 backends produce identical layouts.
 */
export interface SnapshotStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Human-readable location for a key (s3:// URI or a local path). */
  uri(key: string): string;
}

export class LocalSnapshotStore implements SnapshotStore {
  private root: string;

  constructor(dir = config.snapshots.localDir) {
    this.root = path.resolve(dir);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Key escapes store root: ${key}`);
    return full;
  }

  async put(key: string, body: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  uri(key: string): string {
    return this.resolve(key);
  }
}

export class S3SnapshotStore implements SnapshotStore {
  private client = new S3Client({});

  constructor(private bucket = config.snapshots.bucket) {
    if (!bucket) throw new Error("SNAPSHOT_BUCKET must be set when SNAPSHOT_STORE=s3.");
  }

  // Encryption (SSE-KMS) is the bucket's default, so writes don't set it here.
  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await res.Body?.transformToString("utf-8")) ?? null;
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  uri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }
}

let snapshotStore: SnapshotStore | null = null;

export function getSnapshotStore(): SnapshotStore {
  if (!snapshotStore) {
    snapshotStore = config.snapshots.kind === "s3" ? new S3SnapshotStore() : new LocalSnapshotStore();
  }
  return snapshotStore;
}
