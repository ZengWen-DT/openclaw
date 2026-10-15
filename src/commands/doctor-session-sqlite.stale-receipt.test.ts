import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  readDeferredPluginSessionImportReceipt,
  readStaleDeferredPluginSessionImport,
  rebuildDeferredPluginSessionSourceIndex,
} from "../infra/deferred-plugin-session-sources.js";
import * as sessionVerification from "../infra/deferred-plugin-session-verification.js";
import * as migrationArtifacts from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { readOnlySqliteValidationSnapshot } from "../infra/session-sqlite-migration-readers.js";
import { migrateLegacyAcpSessionMetadata } from "../infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareRetainedSessionImport } from "./doctor-session-sqlite-retained.js";
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import {
  seedDeferredPluginSessionSource,
  seedStaleDeferredPluginSessionImport,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

it.each([
  { available: true, pending: true },
  { available: false, pending: true },
  { available: true, pending: false },
])(
  "settles a foreign receipt with history available=$available and plugin pending=$pending",
  async ({ available, pending }) => {
    await withOpenClawTestState({ label: "stale-session-receipt" }, async (state) => {
      const { cfg, storePath, scope, foreignReport } =
        await seedStaleDeferredPluginSessionImport(state);
      const options = { cfg, env: state.env, allAgents: true };
      if (!pending) {
        await recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["brave"],
        });
      }
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:deleted" },
        { label: "Live settings" },
      );
      const source = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const original = fs.readFileSync(source);
      fs.unlinkSync(storePath);
      if (!available) {
        fs.unlinkSync(source);
      }

      const report = await runDoctorSessionSqlite({
        ...options,
        mode: available ? "recover" : "import",
      });
      const issues = report.targets.flatMap((target) => target.issues);
      expect(issues).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_receipt_superseded" }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      );
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })?.entry.label,
      ).toBe("Live settings");
      if (available) {
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:recovered:legacy-kept" })?.entry
            .archivedAt,
        ).toBeTruthy();
        if (pending) {
          expect(fs.readFileSync(source)).toEqual(original);
        } else {
          expect(fs.existsSync(source)).toBe(false);
          expect(
            report.targets
              .flatMap((target) => target.archivedTranscriptFiles)
              .map((file) => fs.readFileSync(file)),
          ).toContainEqual(original);
        }
      } else {
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual([]);
        expect(issues).toContainEqual(
          expect.objectContaining({
            code: "historical_transcript_deferred",
            message: expect.stringContaining(source),
          }),
        );
      }
      const superseded = withExistingOpenClawStateDatabaseReadOnly(
        ({ db: stateDb }) =>
          stateDb
            .prepare("SELECT report_json FROM migration_runs WHERE status = 'superseded'")
            .all(),
        { env: state.env },
      );
      expect(superseded).toHaveLength(1);
      expect(JSON.parse(String(superseded?.[0]?.report_json))).toMatchObject({
        receipt: JSON.parse(foreignReport),
        reason: expect.stringContaining("different database"),
      });
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      const repeated = await runDoctorSessionSqlite({ ...options, mode: "import" });
      expect(repeated.totals.importedTranscriptEvents).toBe(0);
      if (available) {
        expect(repeated.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_receipt_superseded" }),
        );
      }
    });
  },
);

it("preserves live generations and archived deletions while recovering foreign history", async () => {
  await withOpenClawTestState({ label: "stale-receipt-live-owners" }, async (state) => {
    const { cfg, scope, storePath } = await seedStaleDeferredPluginSessionImport(state);
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:kept" },
      { sessionId: "current-kept", label: "Current generation", updatedAt: Date.now() },
    );
    await expect(
      deleteSessionEntryLifecycle({
        ...scope,
        archiveTranscript: true,
        target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
      }),
    ).resolves.toMatchObject({ deleted: true });
    const archivedHistory = loadTranscriptEventsSync({ ...scope, sessionId: "legacy-deleted" });
    const report = await runDoctorSessionSqlite({
      cfg,
      env: state.env,
      allAgents: true,
      mode: "import",
    });
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry).toMatchObject(
      { sessionId: "current-kept", label: "Current generation" },
    );
    expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
    expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-deleted" })).toEqual(
      archivedHistory,
    );
    const snapshot = readOnlySqliteValidationSnapshot({ agentId: "main", storePath });
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    expect(snapshot.snapshot.transcriptEventCountsBySessionId.has("legacy-deleted")).toBe(false);
    expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
      expect.objectContaining({
        code: "historical_transcript_deferred",
        message: expect.stringContaining(
          "existing deletion and archive state remain authoritative",
        ),
      }),
    );
    expect(fs.existsSync(storePath)).toBe(true);
    expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
  });
});

it.each(["changed", "unreadable"] as const)(
  "recovers independently of a foreign receipt's %s source",
  async (kind) => {
    await withOpenClawTestState({ label: "stale-receipt-source" }, async (state) => {
      const { cfg, storePath, scope } = await seedStaleDeferredPluginSessionImport(state);
      const source = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      fs.unlinkSync(storePath);
      if (kind === "changed") {
        fs.appendFileSync(source, "\n");
      }
      const readIdentity = migrationArtifacts.readMigrationArtifactIdentity;
      const unreadable =
        kind === "unreadable"
          ? vi
              .spyOn(migrationArtifacts, "readMigrationArtifactIdentity")
              .mockImplementation((file, ...args) => {
                if (file === source) {
                  throw new Error("fixture retained input unreadable");
                }
                return readIdentity(file, ...args);
              })
          : undefined;
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      const first = await runDoctorSessionSqlite(options).finally(() => unreadable?.mockRestore());
      if (kind === "unreadable") {
        expect(first.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            code: "historical_transcript_deferred",
            message: expect.stringContaining("fixture retained input unreadable"),
          }),
        );
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toEqual([]);
      } else {
        expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
      }
      const recovered = await runDoctorSessionSqlite(options);
      expect(recovered.totals.importedTranscriptEvents).toBe(kind === "unreadable" ? 2 : 0);
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
      if (kind === "changed") {
        expect(recovered.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_receipt_superseded" }),
        );
      }
    });
  },
);

it("keeps canonical ACP metadata authoritative on the next Doctor pass", async () => {
  await withOpenClawTestState({ label: "stale-receipt-acp-repeat" }, async (state) => {
    const { cfg, scope } = await seedStaleDeferredPluginSessionImport(state);
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:kept" },
      { sessionId: "legacy-kept", label: "Canonical settings", updatedAt: Date.now() },
    );
    const migrate = () =>
      migrateLegacyAcpSessionMetadata({
        cfg,
        env: state.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
    expect((await migrate()).warnings).toEqual([]);
    await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
    expect((await migrate()).warnings).toEqual([]);
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
      "Canonical settings",
    );
    expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-kept" })).toHaveLength(2);
    expect(
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT count(*) AS count FROM acp_sessions").get(),
        { env: state.env },
      ),
    ).toEqual({ count: 0 });
  });
});

it.each(["receipt", "physical", "foreign"] as const)(
  "only supersedes a foreign binding before verification (%s receipt)",
  async (binding) => {
    await withOpenClawTestState({ label: "receipt-verification-io" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
      const params = { cfg, target: { agentId: "main", storePath }, sqlitePath, env: state.env };
      const original = readDeferredPluginSessionImportReceipt(params)!;
      const recorded = JSON.parse(original.reportJson);
      recorded.databaseIdentity =
        binding === "foreign"
          ? "123:456"
          : sessionVerification.databaseIdentity(sqlitePath, binding);
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?").run(
            JSON.stringify(recorded),
            original.sourceKey,
          );
        },
        { env: state.env },
      );
      const before = readDeferredPluginSessionImportReceipt(params);
      const source = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      fs.writeFileSync(source, "");
      const failure = new Error("EIO: fixture database verification read failed");
      const verify = vi
        .spyOn(sessionVerification, "verifyDeferredSessionDatabase")
        .mockRejectedValue(failure);
      try {
        if (binding === "foreign") {
          await expect(rebuildDeferredPluginSessionSourceIndex(params)).resolves.toBe(true);
          expect(verify).not.toHaveBeenCalled();
          expect(readDeferredPluginSessionImportReceipt(params)).toMatchObject({
            removedSource: false,
            reportJson: expect.stringContaining('"superseded":"different-database"'),
          });
        } else {
          await expect(rebuildDeferredPluginSessionSourceIndex(params)).rejects.toBe(failure);
          expect(verify).toHaveBeenCalledOnce();
          expect(readDeferredPluginSessionImportReceipt(params)).toEqual(before);
          expect(
            withExistingOpenClawStateDatabaseReadOnly(
              ({ db }) =>
                db
                  .prepare(
                    "SELECT count(*) AS count FROM migration_runs WHERE status = 'superseded'",
                  )
                  .get(),
              { env: state.env },
            ),
          ).toEqual({ count: 0 });
        }
      } finally {
        verify.mockRestore();
      }
    });
  },
);

it("bounds stale-receipt manifest reads across missing transcripts and fresh verification passes", async () => {
  const commandReads: number[][] = [];
  for (const count of [2, 32]) {
    await withOpenClawTestState({ label: "stale-receipt-manifest-reads" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      for (const entry of Object.values(entries) as Array<{ updatedAt: number }>) {
        entry.updatedAt = Date.now();
      }
      for (let index = 2; index < count; index++) {
        const sessionId = `legacy-volume-${index}`;
        const sessionFile = `${sessionId}.jsonl`;
        entries[`agent:main:volume-${index}`] = { sessionId, sessionFile, updatedAt: Date.now() };
        fs.writeFileSync(
          path.join(path.dirname(storePath), sessionFile),
          `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
        );
      }
      fs.writeFileSync(storePath, JSON.stringify(entries));
      const options = { cfg, env: state.env, allAgents: true, mode: "import" as const };
      expect((await runDoctorSessionSqlite(options)).totals.importedEntries).toBe(count);
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
      const params = { cfg, env: state.env, target: { agentId: "main", storePath }, sqlitePath };
      const receipt = readDeferredPluginSessionImportReceipt(params)!;
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });
      const archived = await runDoctorSessionSqlite(options);
      expect(archived.totals.archivedTranscriptFiles).toBe(count);
      const manifestPath = archived.migrationRun!.manifestPath;
      const manifestBytes = fs.readFileSync(manifestPath);
      const manifest = migrationRun.readSessionSqliteMigrationManifest(manifestPath)!;
      const moves = manifest.targets.flatMap((target) => target.plannedMoves);
      const indexMove = moves.find((move) => move.sourcePath === storePath)!;
      fs.renameSync(indexMove.archivePath, storePath);
      // Model an older import receipt bound to a replaced database, preserving its real sources.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE migration_sources SET removed_source = 0, report_json = ? WHERE source_key = ?",
          ).run(
            JSON.stringify({ ...JSON.parse(receipt.reportJson), databaseIdentity: "123:456" }),
            receipt.sourceKey,
          );
        },
        { env: state.env },
      );
      expect(readDeferredPluginSessionImportReceipt(params)?.removedSource).toBe(false);
      const stale = readStaleDeferredPluginSessionImport(params)!;
      const missing = stale.sources.filter((source) =>
        isPrimarySessionTranscriptFileName(path.basename(source.path)),
      );
      expect(missing).toHaveLength(count);
      for (const source of missing) {
        expect(fs.existsSync(source.path)).toBe(false);
        const move = moves.find((candidate) => candidate.sourcePath === source.path)!;
        expect(fs.existsSync(move.archivePath)).toBe(true);
        expect(move.artifact!.identity.sha256).toBe(source.identity.sha256);
      }
      const verify = async () => {
        const report = createDoctorSessionSqliteTargetReport({ ...params.target, sqlitePath });
        const retained = await prepareRetainedSessionImport({ ...params, mode: "import" }, report);
        expect(retained?.staleImport?.sources).toEqual(stale.sources);
        expect(report.issues).toContainEqual(
          expect.objectContaining({ code: "retained_plugin_receipt_superseded" }),
        );
        return report.issues.filter(
          (issue) =>
            issue.code === "historical_transcript_deferred" &&
            issue.message.startsWith("Retained history source unavailable:"),
        );
      };
      const manifestPaths = migrationRun.listSessionSqliteMigrationManifestPaths(state.env);
      const reads = vi.spyOn(fs, "readFileSync");
      const readCounts = () =>
        manifestPaths.map(
          (manifestFile) => reads.mock.calls.filter(([file]) => file === manifestFile).length,
        );
      try {
        for (let pass = 0; pass < 2; pass++) {
          reads.mockClear();
          expect(await verify()).toEqual([]);
          expect(readCounts()).toEqual(manifestPaths.map(() => 1));
        }
        // Later phases must reread manifests and rehash archives, even after a successful pass.
        const source = missing[0]!;
        const archive = moves.find((move) => move.sourcePath === source.path)!.archivePath;
        for (const target of manifest.targets) {
          target.plannedMoves = target.plannedMoves.filter(
            (move) => move.sourcePath !== source.path,
          );
          target.completedMoves = target.completedMoves.filter(
            (move) => move.sourcePath !== source.path,
          );
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect(await verify()).toEqual([
          expect.objectContaining({ message: expect.stringContaining(source.path) }),
        ]);
        fs.writeFileSync(manifestPath, manifestBytes);
        const archiveBytes = fs.readFileSync(archive);
        fs.appendFileSync(archive, "\n");
        expect(await verify()).toEqual([
          expect.objectContaining({ message: expect.stringContaining(source.path) }),
        ]);
        fs.writeFileSync(archive, archiveBytes);
        expect(await verify()).toEqual([]);
        reads.mockClear();
        const report = await runDoctorSessionSqlite(options);
        expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({ code: "retained_plugin_receipt_superseded" }),
        );
        expect(report.totals.importedEntries).toBe(0);
        commandReads.push(readCounts());
      } finally {
        reads.mockRestore();
      }
    });
  }
  // Discovery, reconciliation, and pruning have their own phases; none scale with source count.
  expect(commandReads[0]?.every((count) => count > 0)).toBe(true);
  expect(commandReads[1]).toEqual(commandReads[0]);
});
