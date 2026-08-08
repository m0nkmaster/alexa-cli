export const EXIT_CODES = {
  OK: 0,
  USAGE: 2,
  AUTH: 10,
  NOT_FOUND: 11,
  AMBIGUOUS: 12,
  PARTIAL: 20,
  API: 30,
  INTERNAL: 99,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
