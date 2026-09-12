/**
 * Last-resort process-level error handlers.
 *
 * Without them, a rejection escaping a transport handler is printed by Node as
 * a raw stack trace — the one output path that has never been through
 * `redact()`, and the one most likely to carry a credential-bearing URL from a
 * `fetch` failure.
 *
 * Lives next to the HTTP entrypoint because that is where escaping rejections
 * come from in practice, but it is installed for every transport mode.
 *
 * Policy:
 * - `unhandledRejection` is logged and the process keeps running. One failed
 *   request must not take the whole HTTP server down.
 * - `uncaughtException` is logged and the process exits: after one the runtime
 *   state is undefined and continuing is worse than restarting.
 */
import type { EventEmitter } from "node:events";
import { errorClass, log, redact } from "../logging";

/** Same cap `logFatal` applies, so no free text can grow the log unbounded. */
const MESSAGE_LIMIT = 200;

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw).slice(0, MESSAGE_LIMIT);
}

/** Log an escaping rejection. Never prints the raw value or a stack. */
export function logUnhandledRejection(reason: unknown): void {
  log("error", "unhandled_rejection", {
    error_class: errorClass(reason),
    message: safeMessage(reason),
  });
}

/** Log a fatal uncaught exception. Never prints the raw value or a stack. */
export function logUncaughtException(error: unknown): void {
  log("error", "uncaught_exception", {
    error_class: errorClass(error),
    message: safeMessage(error),
  });
}

export interface ProcessErrorHandlerOptions {
  /** Injected for tests; defaults to terminating the process. */
  exit?: (code: number) => void;
}

/**
 * Install the handlers on `target` (the real `process` by default). Returns an
 * uninstall function so tests — and anything embedding this server — can undo it.
 */
export function installProcessErrorHandlers(
  target: EventEmitter = process,
  options: ProcessErrorHandlerOptions = {}
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const onRejection = (reason: unknown): void => logUnhandledRejection(reason);
  const onException = (error: unknown): void => {
    logUncaughtException(error);
    exit(1);
  };

  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);

  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}
