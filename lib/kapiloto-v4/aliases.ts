/**
 * TypeScript mirror of private.normalize_entity_alias (alias normalization v1).
 *
 * Unified: Hebrew points and cantillation (removed), geresh/gershayim and
 * typographic quotes, maqaf and en/em dashes, NBSP, whitespace runs, case.
 * NOT unified: transliteration variants ("Sztejfman" vs "Shteifman"). Those
 * are separate aliases, and a lookup that matches several players is
 * ambiguous by design.
 *
 * Case folding matches PostgreSQL lower() for ASCII and Hebrew. For other
 * scripts lower() depends on the database collation, so lookups must use the
 * stored normalized_alias rather than re-normalizing in application code.
 */

const CHARACTER_MAP: Record<string, string> = {
  "׳": "'", // Hebrew geresh
  "״": '"', // Hebrew gershayim
  "’": "'",
  "‘": "'",
  "ʼ": "'",
  "`": "'",
  "־": "-", // Hebrew maqaf
  "–": "-",
  "—": "-",
  " ": " ",
};

const HEBREW_POINTS = /[֑-ׇֽֿׁׂׅׄ]/g;
// PostgreSQL [[:space:]] in the C/UTF-8 locales used by Supabase and PGlite.
const SPACE_RUN = /[ \t\n\v\f\r]+/g;

export function normalizeEntityAlias(alias: string): string {
  const mapped = Array.from(alias, (char) => CHARACTER_MAP[char] ?? char).join("");
  return mapped
    .replace(HEBREW_POINTS, "")
    .replace(SPACE_RUN, " ")
    .replace(/^ +| +$/g, "")
    .toLowerCase();
}
