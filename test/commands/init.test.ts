/**
 * Tests for the `sentry init` command entry point.
 *
 * Uses spyOn on the wizard-runner and projects API namespaces to
 * capture runWizard calls and mock findProjectsBySlug without
 * mock.module (which leaks across test files).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import path from "node:path";
import { initCommand } from "../../src/commands/init.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as projectsApi from "../../src/lib/api/projects.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as errorReportingNs from "../../src/lib/error-reporting.js";
import {
  ApiError,
  ContextError,
  ValidationError,
  WizardError,
} from "../../src/lib/errors.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as prefetchNs from "../../src/lib/init/org-prefetch.js";
import { resetPrefetch } from "../../src/lib/init/org-prefetch.js";
// biome-ignore lint/performance/noNamespaceImport: spyOn requires object reference
import * as wizardRunner from "../../src/lib/init/wizard-runner.js";

/** Minimal org shape for mock returns */
const MOCK_ORG = { id: "1", slug: "resolved-org", name: "Resolved Org" };

/** Minimal project-with-org shape for mock returns */
function mockProject(slug: string, orgSlug = "resolved-org") {
  return { slug, orgSlug, id: "123", name: slug };
}

let capturedArgs: Record<string, unknown> | undefined;
let runWizardSpy: ReturnType<typeof spyOn>;
let findProjectsSpy: ReturnType<typeof spyOn>;
let warmSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;
let reportCliErrorSpy: ReturnType<typeof spyOn>;

type TestContext = {
  cwd: string;
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: ReturnType<typeof mock> };
  stdin: typeof process.stdin;
};

const func = (await initCommand.loader()) as unknown as (
  this: TestContext,
  flags: Record<string, unknown>,
  first?: string,
  second?: string
) => Promise<void>;

function makeContext(cwd = "/projects/app"): TestContext {
  return {
    cwd,
    stdout: { write: () => true },
    // mock() so tests can inspect stderr.write calls for the error-path suite
    stderr: { write: mock(() => true) },
    stdin: process.stdin,
  };
}

const DEFAULT_FLAGS = { yes: true, "dry-run": false } as const;

beforeEach(() => {
  capturedArgs = undefined;
  resetPrefetch();
  runWizardSpy = spyOn(wizardRunner, "runWizard").mockImplementation(
    (args: Record<string, unknown>) => {
      capturedArgs = args;
      return Promise.resolve();
    }
  );
  // Default: mock findProjectsBySlug to return a single project match
  findProjectsSpy = spyOn(projectsApi, "findProjectsBySlug").mockImplementation(
    async (slug: string) => ({
      projects: [mockProject(slug)],
      orgs: [MOCK_ORG],
    })
  );
  // Spy on warmOrgDetection to verify it's called/skipped appropriately.
  // The mock prevents real DSN scans and API calls from the background.
  warmSpy = spyOn(prefetchNs, "warmOrgDetection").mockImplementation(
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op mock
    () => {}
  );
  // The init command force-exits after the wizard to release Bun's fetch
  // keep-alive sockets (src/commands/init.ts). Tests call `func` directly,
  // so without this stub `process.exit` would terminate the test runner
  // mid-suite.
  exitSpy = spyOn(process, "exit").mockImplementation((() => {
    // intentionally no-op — see comment above
  }) as never);
  // Silence Sentry reporting from the init error path; the behavior we
  // care about (force-exit on failure) is asserted via exitSpy.
  reportCliErrorSpy = spyOn(
    errorReportingNs,
    "reportCliError"
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op mock
  ).mockImplementation(() => {});
});

afterEach(() => {
  runWizardSpy.mockRestore();
  findProjectsSpy.mockRestore();
  warmSpy.mockRestore();
  exitSpy.mockRestore();
  reportCliErrorSpy.mockRestore();
  resetPrefetch();
});

describe("init command func", () => {
  // ── Features parsing ──────────────────────────────────────────────────

  describe("features parsing", () => {
    test("splits comma-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing,logs"],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing", "logs"]);
    });

    test("splits plus-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors+tracing+logs"],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing", "logs"]);
    });

    test("splits space-separated features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors tracing logs"],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing", "logs"]);
    });

    test("merges multiple --features flags", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,tracing", "logs"],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing", "logs"]);
    });

    test("trims whitespace from features", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: [" errors , tracing "],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing"]);
    });

    test("filters empty segments", async () => {
      const ctx = makeContext();
      await func.call(ctx, {
        ...DEFAULT_FLAGS,
        features: ["errors,,tracing,"],
      });
      expect(capturedArgs?.features).toEqual(["errors", "tracing"]);
    });

    test("passes undefined when features not provided", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(capturedArgs?.features).toBeUndefined();
    });
  });

  // ── No arguments ──────────────────────────────────────────────────────

  describe("no arguments", () => {
    test("defaults to cwd with auto-detect", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS);
      expect(capturedArgs?.directory).toBe("/projects/app");
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBeUndefined();
    });
  });

  // ── Single path argument ──────────────────────────────────────────────

  describe("single path argument", () => {
    test(". resolves to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, ".");
      expect(capturedArgs?.directory).toBe(path.resolve("/projects/app", "."));
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBeUndefined();
    });

    test("./subdir resolves relative to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("../other resolves relative to cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "../other");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "../other")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("/absolute/path used as-is", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "/absolute/path");
      expect(capturedArgs?.directory).toBe("/absolute/path");
      expect(capturedArgs?.org).toBeUndefined();
    });

    test("~/path treated as literal path (no shell expansion)", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "~/projects/other");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "~/projects/other")
      );
      expect(capturedArgs?.org).toBeUndefined();
    });
  });

  // ── Single target argument ────────────────────────────────────────────

  describe("single target argument", () => {
    test("org/ sets explicit org, dir = cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("org/project sets both, dir = cwd", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug found → uses existing project", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      expect(findProjectsSpy).toHaveBeenCalledWith("my-app");
      expect(capturedArgs?.org).toBe("resolved-org");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug not found → passes as new project name", async () => {
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [MOCK_ORG],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "new-app");
      expect(capturedArgs?.org).toBeUndefined();
      expect(capturedArgs?.project).toBe("new-app");
      expect(capturedArgs?.directory).toBe("/projects/app");
    });

    test("bare slug matches org name → treated as org-only", async () => {
      const orgSlug = "acme-corp";
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [{ id: "2", slug: orgSlug, name: "Acme Corp" }],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, orgSlug);
      expect(capturedArgs?.org).toBe(orgSlug);
      expect(capturedArgs?.project).toBeUndefined();
    });

    test("bare slug in multiple orgs → force-exits with ValidationError", async () => {
      findProjectsSpy.mockImplementation(async (slug: string) => ({
        projects: [mockProject(slug, "org-a"), mockProject(slug, "org-b")],
        orgs: [
          { id: "1", slug: "org-a", name: "Org A" },
          { id: "2", slug: "org-b", name: "Org B" },
        ],
      }));
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(reportCliErrorSpy).toHaveBeenCalledTimes(1);
      expect(reportCliErrorSpy.mock.calls[0]?.[0]).toBeInstanceOf(
        ValidationError
      );
    });
  });

  // ── Two arguments: target + directory ─────────────────────────────────

  describe("two arguments (target + directory)", () => {
    test("org/ + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/", "./subdir");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });

    test("org/project + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app", "./subdir");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });

    test("bare slug + path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "my-app", "./subdir");
      expect(findProjectsSpy).toHaveBeenCalled();
      expect(capturedArgs?.org).toBe("resolved-org");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });

  // ── Swapped arguments ─────────────────────────────────────────────────

  describe("swapped arguments (path first, target second)", () => {
    test(". org/ swaps with warning", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, ".", "acme/");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBeUndefined();
      expect(capturedArgs?.directory).toBe(path.resolve("/projects/app", "."));
    });

    test("./subdir org/project swaps with warning", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir", "acme/my-app");
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.directory).toBe(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });

  // ── Error cases ───────────────────────────────────────────────────────

  describe("error cases", () => {
    // Argument/validation errors are caught by init's outer try/catch so
    // the process still force-exits (issue #798). We assert the error
    // type by inspecting the value passed to reportCliError.

    test("two paths force-exits with ContextError", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "./dir1", "./dir2");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(reportCliErrorSpy.mock.calls[0]?.[0]).toBeInstanceOf(ContextError);
    });

    test("two targets force-exits with ContextError", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme/", "other/");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(reportCliErrorSpy.mock.calls[0]?.[0]).toBeInstanceOf(ContextError);
    });

    test("org slug with whitespace is rejected by validateResourceId", async () => {
      // Spaces in org slugs now hit validateResourceId and throw
      // ValidationError — normalizeSlug no longer converts them.
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme corp/");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(reportCliErrorSpy.mock.calls[0]?.[0]).toBeInstanceOf(
        ValidationError
      );
    });
  });

  // ── Flag forwarding ───────────────────────────────────────────────────

  describe("flag forwarding", () => {
    test("forwards yes and dry-run flags", async () => {
      const ctx = makeContext();
      await func.call(ctx, { yes: true, "dry-run": true });
      expect(capturedArgs?.yes).toBe(true);
      expect(capturedArgs?.dryRun).toBe(true);
    });

    test("forwards team flag alongside org/project", async () => {
      const ctx = makeContext();
      await func.call(
        ctx,
        { ...DEFAULT_FLAGS, team: "backend" },
        "acme/my-app"
      );
      expect(capturedArgs?.org).toBe("acme");
      expect(capturedArgs?.project).toBe("my-app");
      expect(capturedArgs?.team).toBe("backend");
    });
  });

  // ── Background org detection ──────────────────────────────────────────

  describe("background org detection", () => {
    test("warms prefetch when org is not explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(warmSpy).toHaveBeenCalledTimes(1);
      expect(warmSpy).toHaveBeenCalledWith("/projects/app");
    });

    test("skips prefetch when org is explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme/my-app");
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("skips prefetch when org-only is explicit", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "acme/");
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("skips prefetch for bare slug when project found", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      // findProjectsBySlug returns a match → org is known, no prefetch needed
      expect(warmSpy).not.toHaveBeenCalled();
    });

    test("warms prefetch for bare slug when project not found", async () => {
      findProjectsSpy.mockImplementation(async () => ({
        projects: [],
        orgs: [MOCK_ORG],
      }));
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "new-app");
      // No project found → org is undefined → prefetch warms
      expect(warmSpy).toHaveBeenCalledTimes(1);
      expect(warmSpy).toHaveBeenCalledWith("/projects/app");
    });

    test("warms prefetch for path-only arg", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(warmSpy).toHaveBeenCalledTimes(1);
    });

    test("warms prefetch with resolved directory path", async () => {
      const ctx = makeContext("/projects/app");
      await func.call(ctx, DEFAULT_FLAGS, "./subdir");
      expect(warmSpy).toHaveBeenCalledWith(
        path.resolve("/projects/app", "./subdir")
      );
    });
  });

  // ── Error paths — force-exit regression (issue #798) ──────────────────
  //
  // The init command must call process.exit on failure as well as success,
  // otherwise Bun's fetch keep-alive sockets and the forwarded /dev/tty
  // stream keep the libuv loop alive and the shell hangs.

  describe("error paths — force exit", () => {
    test("success path calls process.exit(0)", async () => {
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test("rendered WizardError still calls process.exit and skips re-render", async () => {
      runWizardSpy.mockImplementation(() =>
        Promise.reject(new WizardError("boom", { rendered: true }))
      );
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      // Wizard already rendered via clack; we must NOT duplicate the message.
      expect(ctx.stderr.write).not.toHaveBeenCalled();
      expect(reportCliErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("unrendered WizardError is printed to stderr", async () => {
      runWizardSpy.mockImplementation(() =>
        Promise.reject(new WizardError("interactive only", { rendered: false }))
      );
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(ctx.stderr.write).toHaveBeenCalledTimes(1);
      const [msg] = ctx.stderr.write.mock.calls[0] ?? [];
      expect(msg).toContain("interactive only");
    });

    test("unexpected non-CliError still calls process.exit(1) and is printed", async () => {
      runWizardSpy.mockImplementation(() =>
        Promise.reject(new Error("network down"))
      );
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(ctx.stderr.write).toHaveBeenCalledTimes(1);
      const [msg] = ctx.stderr.write.mock.calls[0] ?? [];
      expect(msg).toContain("network down");
      expect(reportCliErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("pre-wizard API failure force-exits without calling the wizard", async () => {
      findProjectsSpy.mockImplementation(() =>
        Promise.reject(new ApiError("Forbidden", 403))
      );
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "some-project");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      // ApiError.exitCode is inherited from CliError (default 1)
      expect(exitSpy.mock.calls[0]?.[0]).not.toBe(0);
      expect(ctx.stderr.write).toHaveBeenCalledTimes(1);
      const [msg] = ctx.stderr.write.mock.calls[0] ?? [];
      expect(msg).toContain("Forbidden");
      expect(reportCliErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("synchronous ValidationError also force-exits", async () => {
      // resolveTarget throws synchronously for multi-match bare slugs;
      // ValidationError extends CliError so it takes the CliError branch.
      findProjectsSpy.mockImplementation(async () => ({
        projects: [
          { slug: "my-app", orgSlug: "org-a", id: "1", name: "my-app" },
          { slug: "my-app", orgSlug: "org-b", id: "2", name: "my-app" },
        ],
        orgs: [MOCK_ORG],
      }));
      const ctx = makeContext();
      await func.call(ctx, DEFAULT_FLAGS, "my-app");
      expect(runWizardSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(ctx.stderr.write).toHaveBeenCalledTimes(1);
    });
  });
});
