import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger };

/**
 * Keys that must never appear in logs. pino redaction replaces matching paths
 * with "[REDACTED]". This is defence-in-depth: code should not log secrets in
 * the first place, but this guards against accidental leakage of credentials,
 * signatures, and wallet material.
 */
const REDACT_PATHS = [
  "secret",
  "*.secret",
  "passphrase",
  "*.passphrase",
  "privateKey",
  "*.privateKey",
  "seed",
  "*.seed",
  "mnemonic",
  "*.mnemonic",
  "password",
  "*.password",
  "apiKey",
  "*.apiKey",
  "signature",
  "*.signature",
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.POLY_SIGNATURE",
  "*.POLY_PASSPHRASE",
  "*.POLY_API_KEY",
];

export interface CreateLoggerOptions {
  level?: LoggerOptions["level"];
  /** Logical service name, e.g. "api" or "worker". */
  name: string;
  /** Pretty-print for local dev; defaults to false (JSON for prod/staging). */
  pretty?: boolean;
}

export const createLogger = (opts: CreateLoggerOptions): Logger => {
  const base: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: { target: "pino-pretty", options: { colorize: true } },
    });
  }
  return pino(base);
};

export { REDACT_PATHS };
