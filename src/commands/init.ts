/**
 * sentry init
 *
 * Initialize Sentry in a project using the remote wizard workflow.
 * Communicates with the Mastra API via suspend/resume to perform
 * local filesystem operations and interactive prompts.
 *
 * Supports two optional positionals with smart disambiguation:
 *   sentry init                       — auto-detect everything, dir = cwd
 *   sentry init .                     — dir = cwd, auto-detect org
 *   sentry init ./subdir              — dir = subdir, auto-detect org
 *   sentry init acme/                 — explicit org, dir = cwd
 *   sentry init acme/my-app           — explicit org + project, dir = cwd
 *   sentry init my-app                — use existing or create new project
 *   sentry init acme/ ./subdir        — explicit org, dir = subdir
 *   sentry init acme/my-app ./subdir  — explicit org + project, dir = subdir
 *   sentry init ./subdir acme/        — swapped, auto-correct with warning
 */

import path from "node:path";
import type { SentryContext } from "../context.js";
import { findProjectsBySlug } from "../lib/api/projects.js";
import { looksLikePath, parseOrgProjectArg } from "../lib/arg-parsing.js";
import { buildCommand } from "../lib/command.js";
import { reportCliError } from "../lib/error-reporting.js";
import {
  CliError,
  ContextError,
  ValidationError,
  WizardError,
} from "../lib/errors.js";
import { warmOrgDetection } from "../lib/init/org-prefetch.js";
import { runWizard } from "../lib/init/wizard-runner.js";
import { validateResourceId } from "../lib/input-validation.js";
import { logger } from "../lib/logger.js";
import {
  DRY_RUN_ALIASES,
  DRY_RUN_FLAG,
  YES_ALIASES,
  YES_FLAG,
} from "../lib/mutate-command.js";

const log = logger.withTag("init");

const FEATURE_DELIMITER = /[,+ ]+/;

const USAGE_HINT = "sentry init <org>/<project> [directory]";

type InitFlags = {
  readonly yes: boolean;
  readonly "dry-run": boolean;
  readonly features?: string[];
  readonly team?: string;
};

/**
 * Classify and separate two optional positional args into a target and a directory.
 *
 * Uses {@link looksLikePath} to distinguish filesystem paths from org/project targets.
 * Detects swapped arguments and emits a warning when auto-correcting.
 *
 * @returns Resolved target string (or undefined) and directory string (or undefined)
 */
function classifyArgs(
  first?: string,
  second?: string
): { target: string | undefined; directory: string | undefined } {
  // No args — auto-detect everything
  if (!first) {
    return { target: undefined, directory: undefined };
  }

  const firstIsPath = looksLikePath(first);

  // Single arg
  if (!second) {
    return firstIsPath
      ? { target: undefined, directory: first }
      : { target: first, directory: undefined };
  }

  const secondIsPath = looksLikePath(second);

  // Two paths → error
  if (firstIsPath && secondIsPath) {
    throw new ContextError("Arguments", USAGE_HINT, [
      "Two directory paths provided. Only one directory is allowed.",
    ]);
  }

  // Two targets → error
  if (!(firstIsPath || secondIsPath)) {
    throw new ContextError("Arguments", USAGE_HINT, [
      "Two targets provided. Use <org>/<project> for the target and a path (e.g., ./dir) for the directory.",
    ]);
  }

  // (TARGET, PATH) — correct order
  if (!firstIsPath && secondIsPath) {
    return { target: first, directory: second };
  }

  // (PATH, TARGET) — swapped, auto-correct with warning
  log.warn(`Arguments appear reversed. Interpreting as: ${second} ${first}`);
  return { target: second, directory: first };
}

/**
 * Resolve the parsed org/project target into explicit org and project values.
 *
 * For `project-search` (bare slug), searches for an existing project first.
 * If not found, treats the slug as a **new project name** to create —
 * org will be resolved later by init preflight before the workflow starts.
 * If the slug matches an org name, treats it as org-only (like `slug/`).
 */
async function resolveTarget(targetArg: string | undefined): Promise<{
  org: string | undefined;
  project: string | undefined;
}> {
  const parsed = parseOrgProjectArg(targetArg);

  switch (parsed.type) {
    case "explicit":
      // Validate user-provided slugs before they reach API calls
      validateResourceId(parsed.org, "organization slug");
      validateResourceId(parsed.project, "project name");
      return { org: parsed.org, project: parsed.project };
    case "org-all":
      validateResourceId(parsed.org, "organization slug");
      return { org: parsed.org, project: undefined };
    case "project-search": {
      // Bare slug — could be an existing project name or a new project name.
      // Search for an existing project first, then fall back to treating as
      // the name for a new project to create.
      const { projects, orgs } = await findProjectsBySlug(parsed.projectSlug);

      // Multiple matches — disambiguation error
      if (projects.length > 1) {
        const first = projects[0];
        const orgList = projects
          .map((p) => `  ${p.orgSlug}/${p.slug}`)
          .join("\n");
        throw new ValidationError(
          `Project "${parsed.projectSlug}" exists in multiple organizations.\n\n` +
            `Specify the organization:\n${orgList}\n\n` +
            `Example: sentry init ${first?.orgSlug ?? "<org>"}/${parsed.projectSlug}`
        );
      }

      // Exactly one match — use it (wizard handles existing-project flow)
      const [match] = projects;
      if (match) {
        return { org: match.orgSlug, project: match.slug };
      }

      // No project found — is the slug an org name?
      const isOrg = orgs.some((o) => o.slug === parsed.projectSlug);
      if (isOrg) {
        return { org: parsed.projectSlug, project: undefined };
      }

      // Truly not found — treat as the name for a new project to create.
      // Org will be resolved later by init preflight before the workflow starts.
      log.info(
        `No existing project "${parsed.projectSlug}" found — will create a new project with this name.`
      );
      return { org: undefined, project: parsed.projectSlug };
    }
    case "auto-detect":
      return { org: undefined, project: undefined };
    default: {
      const _exhaustive: never = parsed;
      throw new ContextError("Target", String(_exhaustive), []);
    }
  }
}

/**
 * Core init flow extracted from the command `func` body so the wrapping
 * try/catch/finally in {@link initCommand} stays readable.
 */
async function runInit(
  ctx: SentryContext,
  flags: InitFlags,
  first: string | undefined,
  second: string | undefined
): Promise<void> {
  // 1. Classify positionals into target vs directory
  const { target: targetArg, directory: dirArg } = classifyArgs(first, second);

  // 2. Resolve directory
  const targetDir = dirArg ? path.resolve(ctx.cwd, dirArg) : ctx.cwd;

  // 3. Parse features
  const featuresList = flags.features
    ?.flatMap((f) => f.split(FEATURE_DELIMITER))
    .map((f) => f.trim())
    .filter(Boolean);

  // 4. Resolve target → org + project
  //    Validation of user-provided slugs happens inside resolveTarget.
  //    For bare slugs, if no existing project is found, the slug becomes
  //    the name for a new project (org resolved later by the wizard).
  const { org: explicitOrg, project: explicitProject } =
    await resolveTarget(targetArg);

  // 5. Start background org detection when org is not yet known.
  //    The prefetch runs concurrently with the preamble, the wizard startup,
  //    and all early suspend/resume rounds — by the time the wizard needs the
  //    org (inside createSentryProject), the result is already cached.
  if (!explicitOrg) {
    warmOrgDetection(targetDir);
  }

  // 6. Run the wizard
  await runWizard({
    directory: targetDir,
    yes: flags.yes,
    dryRun: flags["dry-run"],
    features: featuresList,
    team: flags.team,
    org: explicitOrg,
    project: explicitProject,
  });
}

/**
 * Report to Sentry and render the error message to stderr. Skips the
 * render for `WizardError.rendered=true` (clack already displayed it).
 */
function handleInitError(stderr: SentryContext["stderr"], err: unknown): void {
  // Stricli's exceptionWhileRunningCommand normally reports to Sentry
  // (src/app.ts:327). Since we exit in `finally`, Stricli never sees
  // the error — we own reporting here.
  reportCliError(err);
  if (err instanceof WizardError && err.rendered) {
    return;
  }
  stderr.write(`Error: ${formatInitError(err)}\n`);
}

function formatInitError(err: unknown): string {
  if (err instanceof CliError) {
    return err.format();
  }
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

function exitCodeFor(caught: unknown): number {
  if (caught instanceof CliError) {
    return caught.exitCode;
  }
  if (caught !== undefined) {
    return 1;
  }
  const existing = process.exitCode;
  if (typeof existing === "number") {
    return existing;
  }
  if (typeof existing === "string") {
    const parsed = Number.parseInt(existing, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export const initCommand = buildCommand<
  InitFlags,
  [string?, string?],
  SentryContext
>({
  docs: {
    brief: "Initialize Sentry in your project (experimental)",
    fullDescription:
      "EXPERIMENTAL: This command may modify your source files.\n\n" +
      "Runs the Sentry setup wizard to detect your project's framework, " +
      "install the SDK, and configure Sentry.\n\n" +
      "Supports org/project syntax and a directory positional. Path-like\n" +
      "arguments (starting with . / ~) are treated as the directory;\n" +
      "everything else is treated as the target.\n\n" +
      "Examples:\n" +
      "  sentry init\n" +
      "  sentry init acme/\n" +
      "  sentry init acme/my-app\n" +
      "  sentry init my-app\n" +
      "  sentry init acme/my-app ./my-project\n" +
      "  sentry init ./my-project",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "target",
          brief: "<org>/<project>, <org>/, <project>, or a directory path",
          parse: String,
          optional: true,
        },
        {
          placeholder: "directory",
          brief: "Project directory (default: current directory)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      yes: { ...YES_FLAG, brief: "Non-interactive mode (accept defaults)" },
      "dry-run": DRY_RUN_FLAG,
      features: {
        kind: "parsed",
        parse: String,
        brief:
          "Features to enable: errors,tracing,logs,replay,profiling,ai-monitoring,user-feedback",
        variadic: true,
        optional: true,
      },
      team: {
        kind: "parsed",
        parse: String,
        brief: "Team slug to create the project under",
        optional: true,
      },
    },
    aliases: {
      ...DRY_RUN_ALIASES,
      ...YES_ALIASES,
      t: "team",
    },
  },
  // biome-ignore lint/correctness/useYield: command func is an async generator by buildCommand convention; final process.exit in the finally block terminates the function without yielding
  async *func(
    this: SentryContext,
    flags: InitFlags,
    first?: string,
    second?: string
  ) {
    // `sentry init` is a terminal command. Bun's global fetch dispatcher
    // (used by MastraClient) holds keep-alive sockets, and the fresh
    // /dev/tty stream opened by forwardFreshTtyToStdin keeps the libuv
    // loop alive — so a natural process exit hangs the shell. We force
    // exit via `finally` on every path (success OR failure) to release
    // those handles. See https://github.com/getsentry/cli/issues/798.
    let caught: unknown;
    try {
      await runInit(this, flags, first, second);
    } catch (err) {
      caught = err;
      handleInitError(this.stderr, err);
    } finally {
      process.exit(exitCodeFor(caught));
    }
  },
});
