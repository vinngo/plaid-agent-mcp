import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { runTool, type ToolDeps } from "../src/core/tools.js";
import { MockProvider } from "../src/providers/mock.js";
import { S3SnapshotStore } from "../src/storage/snapshots.js";
import { SecretsManagerTokenStore, type StoredItem } from "../src/storage/tokens.js";

test("S3 snapshot store writes and reads objects through the AWS SDK", async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof GetObjectCommand) {
        return {
          Body: {
            async transformToString(encoding: string) {
              assert.equal(encoding, "utf-8");
              return "snapshot body";
            },
          },
        };
      }
      return {};
    },
  } as unknown as S3Client;
  const store = new S3SnapshotStore("snapshots-bucket", client);

  await store.put("snapshots/2026-10-13T2240/holdings.csv", "csv body", "text/csv");
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.deepEqual((commands[0] as PutObjectCommand).input, {
    Bucket: "snapshots-bucket",
    Key: "snapshots/2026-10-13T2240/holdings.csv",
    Body: "csv body",
    ContentType: "text/csv",
  });

  assert.equal(await store.get("latest.json"), "snapshot body");
  assert.ok(commands[1] instanceof GetObjectCommand);
  assert.deepEqual((commands[1] as GetObjectCommand).input, {
    Bucket: "snapshots-bucket",
    Key: "latest.json",
  });
  assert.equal(store.uri("latest.json"), "s3://snapshots-bucket/latest.json");
});

test("S3 snapshot store returns null only for a missing key", async () => {
  const missingClient = {
    async send() {
      throw new NoSuchKey({ $metadata: {}, message: "missing" });
    },
  } as unknown as S3Client;
  assert.equal(await new S3SnapshotStore("bucket", missingClient).get("missing.json"), null);

  const denied = new Error("access denied");
  const deniedClient = {
    async send() {
      throw denied;
    },
  } as unknown as S3Client;
  await assert.rejects(new S3SnapshotStore("bucket", deniedClient).get("private.json"), denied);
});

test("pull_holdings writes its complete snapshot through the mocked S3 SDK", async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      return {};
    },
  } as unknown as S3Client;
  const deps: ToolDeps = {
    provider: new MockProvider(),
    snapshots: new S3SnapshotStore("snapshots-bucket", client),
    staleAfterHours: 12,
    now: () => new Date("2026-10-13T22:40:00Z"),
  };

  const result = await runTool("pull_holdings", {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.ok && (result.data as { s3_key: string }).s3_key, "snapshots/2026-10-13T2240/holdings.csv");

  const puts = commands.filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
  assert.deepEqual(puts.map((command) => command.input.Key), [
    "snapshots/2026-10-13T2240/holdings.csv",
    "snapshots/2026-10-13T2240/accounts.json",
    "latest.json",
  ]);
  assert.match(puts[0].input.Body as string, /^as_of,broker,account_id,/);
  assert.equal(JSON.parse(puts[2].input.Body as string).holdings.key, puts[0].input.Key);
  assert.equal(commands.filter((command) => command instanceof GetObjectCommand).length, 1);
});

test("Secrets Manager token store paginates, filters, fetches, and caches items", async () => {
  const commands: unknown[] = [];
  const secrets: Record<string, StoredItem> = {
    "plaid-agent/items/item-1": {
      itemId: "item-1",
      institution: "First Platypus Bank",
      linkedAt: "2026-10-13T20:00:00Z",
      accessToken: "access-sandbox-1",
    },
    "plaid-agent/items/item-2": {
      itemId: "item-2",
      institution: "Tartan Investments",
      institutionId: "ins_2",
      linkedAt: "2026-10-13T21:00:00Z",
      accessToken: "access-sandbox-2",
    },
  };
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof ListSecretsCommand) {
        return command.input.NextToken
          ? { SecretList: [{ Name: "plaid-agent/items/item-2" }] }
          : {
              SecretList: [
                { Name: "plaid-agent/items/item-1" },
                { Name: "another-service/item" },
              ],
              NextToken: "page-2",
            };
      }
      if (command instanceof GetSecretValueCommand) {
        return { SecretString: JSON.stringify(secrets[command.input.SecretId as string]) };
      }
      throw new Error(`Unexpected command: ${(command as object).constructor.name}`);
    },
  } as unknown as SecretsManagerClient;
  const store = new SecretsManagerTokenStore("plaid-agent/items/", client);

  const first = await store.list();
  assert.deepEqual(first, [
    { ...secrets["plaid-agent/items/item-1"], institutionId: undefined },
    secrets["plaid-agent/items/item-2"],
  ]);
  assert.equal(commands.filter((command) => command instanceof ListSecretsCommand).length, 2);
  assert.deepEqual((commands[0] as ListSecretsCommand).input, {
    Filters: [{ Key: "name", Values: ["plaid-agent/items/"] }],
    NextToken: undefined,
  });
  assert.deepEqual(
    commands
      .filter((command) => command instanceof GetSecretValueCommand)
      .map((command) => (command as GetSecretValueCommand).input.SecretId),
    ["plaid-agent/items/item-1", "plaid-agent/items/item-2"],
  );

  assert.strictEqual(await store.list(), first);
  assert.equal(commands.length, 4, "a second list uses the five-minute cache");
});

test("Secrets Manager token store creates new secrets and updates existing ones", async () => {
  const item: StoredItem = {
    itemId: "item-1",
    institution: "First Platypus Bank",
    linkedAt: "2026-10-13T20:00:00Z",
    accessToken: "access-sandbox-1",
  };

  const created: unknown[] = [];
  const createClient = {
    async send(command: unknown) {
      created.push(command);
      return {};
    },
  } as unknown as SecretsManagerClient;
  await new SecretsManagerTokenStore("plaid-agent/items/", createClient).upsert(item);
  assert.equal(created.length, 1);
  assert.ok(created[0] instanceof CreateSecretCommand);
  assert.deepEqual((created[0] as CreateSecretCommand).input, {
    Name: "plaid-agent/items/item-1",
    SecretString: JSON.stringify(item),
  });

  const updated: unknown[] = [];
  const updateClient = {
    async send(command: unknown) {
      updated.push(command);
      if (command instanceof CreateSecretCommand) {
        throw new ResourceExistsException({ $metadata: {}, message: "already exists" });
      }
      return {};
    },
  } as unknown as SecretsManagerClient;
  await new SecretsManagerTokenStore("plaid-agent/items/", updateClient).upsert(item);
  assert.equal(updated.length, 2);
  assert.ok(updated[0] instanceof CreateSecretCommand);
  assert.ok(updated[1] instanceof PutSecretValueCommand);
  assert.deepEqual((updated[1] as PutSecretValueCommand).input, {
    SecretId: "plaid-agent/items/item-1",
    SecretString: JSON.stringify(item),
  });
});
