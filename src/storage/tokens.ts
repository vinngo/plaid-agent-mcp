import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import { config } from "../config.js";
import { log } from "../logger.js";

/** One linked Plaid Item (an institution login). The access token is only ever held in memory. */
export interface StoredItem {
  itemId: string;
  institution: string;
  institutionId?: string;
  linkedAt: string;
  accessToken: string;
}

export interface TokenStore {
  list(): Promise<StoredItem[]>;
  /** Used by the link script locally; in AWS the web app creates secrets directly. */
  upsert(item: StoredItem): Promise<void>;
}

// --- Secrets Manager: one secret per Item ----------------------------------
//
// Per-item secrets let IAM express the spec's split: the MCP Lambda can
// ListSecrets + GetSecretValue on the prefix, the web app can only
// CreateSecret, and nothing else can read tokens at all.
//
// Secrets carry the institution id as a tag. The web app (flannel) reads it
// with ListSecrets to refuse linking an institution twice; an untagged secret
// makes that check fail closed, so every write sets it.

const CACHE_TTL_MS = 5 * 60 * 1000;
const INSTITUTION_ID_TAG = "institution-id";

export class SecretsManagerTokenStore implements TokenStore {
  private cache: { at: number; items: StoredItem[] } | null = null;

  constructor(
    private prefix = config.tokens.secretPrefix,
    private client: SecretsManagerClient = new SecretsManagerClient({}),
  ) {}

  async list(): Promise<StoredItem[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.items;

    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListSecretsCommand({ Filters: [{ Key: "name", Values: [this.prefix] }], NextToken: nextToken }),
      );
      for (const s of page.SecretList ?? []) if (s.Name?.startsWith(this.prefix)) names.push(s.Name);
      nextToken = page.NextToken;
    } while (nextToken);

    const items: StoredItem[] = [];
    for (const name of names) {
      try {
        const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
        const parsed = parseItem(res.SecretString);
        if (parsed) items.push(parsed);
        else log.warn("Skipping malformed token secret", { secretName: name });
      } catch (err) {
        log.error("Could not read token secret", { secretName: name, error: (err as Error).name });
      }
    }
    this.cache = { at: Date.now(), items };
    return items;
  }

  async upsert(item: StoredItem): Promise<void> {
    const name = `${this.prefix}${item.itemId}`;
    const body = JSON.stringify(item);
    const tags = item.institutionId ? [{ Key: INSTITUTION_ID_TAG, Value: item.institutionId }] : undefined;
    try {
      await this.client.send(new CreateSecretCommand({ Name: name, SecretString: body, ...(tags && { Tags: tags }) }));
    } catch (err) {
      if (!(err instanceof ResourceExistsException)) throw err;
      await this.client.send(new PutSecretValueCommand({ SecretId: name, SecretString: body }));
      // Backfills the tag on secrets written before it existed.
      if (tags) await this.client.send(new TagResourceCommand({ SecretId: name, Tags: tags }));
    }
    this.cache = null;
    log.info("Stored linked item", { itemId: item.itemId, institution: item.institution });
  }
}

function parseItem(raw: string | undefined): StoredItem | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredItem>;
    if (typeof v.itemId !== "string" || typeof v.accessToken !== "string") return null;
    return {
      itemId: v.itemId,
      accessToken: v.accessToken,
      institution: typeof v.institution === "string" ? v.institution : "Linked institution",
      institutionId: typeof v.institutionId === "string" ? v.institutionId : undefined,
      linkedAt: typeof v.linkedAt === "string" ? v.linkedAt : "unknown",
    };
  } catch {
    return null;
  }
}

// --- Local encrypted file (development only) -------------------------------

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

interface FileShape {
  version: 1;
  items: (Omit<StoredItem, "accessToken"> & { accessToken: EncryptedBlob })[];
}

export class FileTokenStore implements TokenStore {
  private file: string;

  constructor(filePath = config.tokens.filePath, private secret = config.tokens.encryptionKey) {
    this.file = path.resolve(filePath);
  }

  private key(): Buffer {
    if (!this.secret) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be set (32+ chars) to use the local token store.");
    }
    return crypto.scryptSync(this.secret, "plaid-agent-token-store", 32);
  }

  private async read(): Promise<FileShape> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as FileShape;
      return parsed.items ? parsed : { version: 1, items: [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
      throw err;
    }
  }

  async list(): Promise<StoredItem[]> {
    const store = await this.read();
    if (store.items.length === 0) return [];
    const key = this.key();
    const out: StoredItem[] = [];
    for (const it of store.items) {
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(it.accessToken.iv, "base64"));
        d.setAuthTag(Buffer.from(it.accessToken.tag, "base64"));
        const token = Buffer.concat([d.update(Buffer.from(it.accessToken.data, "base64")), d.final()]).toString("utf8");
        out.push({ ...it, accessToken: token });
      } catch {
        log.error("Failed to decrypt a stored item (wrong TOKEN_ENCRYPTION_KEY?)", { itemId: it.itemId });
      }
    }
    return out;
  }

  async upsert(item: StoredItem): Promise<void> {
    const store = await this.read();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([c.update(item.accessToken, "utf8"), c.final()]);
    const record = {
      itemId: item.itemId,
      institution: item.institution,
      institutionId: item.institutionId,
      linkedAt: item.linkedAt,
      accessToken: { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") },
    };
    const idx = store.items.findIndex((i) => i.itemId === item.itemId);
    if (idx >= 0) store.items[idx] = record;
    else store.items.push(record);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(store, null, 2), { mode: 0o600 });
    log.info("Stored linked item", { itemId: item.itemId, institution: item.institution });
  }
}

let tokenStore: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!tokenStore) {
    tokenStore = config.tokens.kind === "secrets-manager" ? new SecretsManagerTokenStore() : new FileTokenStore();
  }
  return tokenStore;
}
