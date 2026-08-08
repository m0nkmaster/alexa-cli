/**
 * Name matching: exact > startsWith > contains.
 * Ambiguous matches at the winning tier return suggestions instead of picking the first.
 */

export class AmbiguousMatchError extends Error {
  readonly query: string;
  readonly suggestions: string[];

  constructor(query: string, suggestions: string[]) {
    super(
      `Ambiguous match for "${query}". Suggestions: ${suggestions.join(", ")}`
    );
    this.name = "AmbiguousMatchError";
    this.query = query;
    this.suggestions = suggestions;
  }
}

export type NameMatchKind = "exact" | "startsWith" | "contains";

export type NameMatchResult<T> =
  | { status: "matched"; kind: NameMatchKind; item: T }
  | { status: "ambiguous"; kind: NameMatchKind; items: T[]; suggestions: string[] }
  | { status: "none" };

/**
 * Match items by name with priority exact > startsWith > contains.
 * Within the highest-priority non-empty tier, a single hit wins; multiple hits are ambiguous.
 */
export function matchByName<T>(
  items: T[],
  query: string,
  getName: (item: T) => string
): NameMatchResult<T> {
  const q = query.toLowerCase().trim();
  if (!q) return { status: "none" };

  const named = items.map((item, index) => ({
    item,
    index,
    name: (getName(item) ?? "").toLowerCase().trim(),
    displayName: (getName(item) ?? "").trim(),
  }));

  const stableSuggestions = (matches: typeof named): string[] =>
    matches
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index)
      .map((n) => n.displayName);

  const exact = named.filter((n) => n.name === q);
  if (exact.length === 1) {
    return { status: "matched", kind: "exact", item: exact[0].item };
  }
  if (exact.length > 1) {
    return {
      status: "ambiguous",
      kind: "exact",
      items: exact.map((n) => n.item),
      suggestions: stableSuggestions(exact),
    };
  }

  const startsWith = named.filter((n) => n.name.startsWith(q));
  if (startsWith.length === 1) {
    return { status: "matched", kind: "startsWith", item: startsWith[0].item };
  }
  if (startsWith.length > 1) {
    return {
      status: "ambiguous",
      kind: "startsWith",
      items: startsWith.map((n) => n.item),
      suggestions: stableSuggestions(startsWith),
    };
  }

  const contains = named.filter((n) => n.name.includes(q));
  if (contains.length === 1) {
    return { status: "matched", kind: "contains", item: contains[0].item };
  }
  if (contains.length > 1) {
    return {
      status: "ambiguous",
      kind: "contains",
      items: contains.map((n) => n.item),
      suggestions: stableSuggestions(contains),
    };
  }

  return { status: "none" };
}

/** Resolve a single match or throw AmbiguousMatchError; returns null when none. */
export function resolveUniqueMatch<T>(
  items: T[],
  query: string,
  getName: (item: T) => string
): T | null {
  const result = matchByName(items, query, getName);
  if (result.status === "matched") return result.item;
  if (result.status === "ambiguous") {
    throw new AmbiguousMatchError(query, result.suggestions);
  }
  return null;
}

/** Control-result flags for group/pattern/batch operations. */
export function controlResultFlags(controlled: number, errors: number): {
  success: boolean;
  partial: boolean;
} {
  return {
    success: controlled > 0 && errors === 0,
    partial: controlled > 0 && errors > 0,
  };
}

/** Process exit code: 0 success, 2 partial, 1 wholly failed / nothing done. */
export function controlExitCode(controlled: number, errors: number): number {
  if (controlled > 0 && errors > 0) return 2;
  if (controlled > 0 && errors === 0) return 0;
  return 1;
}
