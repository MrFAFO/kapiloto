function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function israelDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function ddmmyyyy(dateKey) {
  const [year, month, day] = dateKey.split("-");
  return `${day}/${month}/${year}`;
}

const dateKey = israelDate(-1);
const day = ddmmyyyy(dateKey);
const params = new URLSearchParams({
  langId: "2",
  timezoneName: "Asia/Jerusalem",
  userCountryId: "6",
  appTypeId: "5",
  sports: "1",
  startDate: day,
  endDate: day,
});

const endpoint = `https://webws.365scores.com/web/games/?${params}`;
const response = await fetch(endpoint, {
  headers: {
    "user-agent": "Mozilla/5.0",
    origin: "https://www.365scores.com",
    referer: "https://www.365scores.com/he/football/match-results",
    accept: "application/json",
  },
  signal: AbortSignal.timeout(20_000),
});

console.log(`HTTP ${response.status}`);
assert(response.ok, `365Scores games endpoint returned HTTP ${response.status}`);

const payload = await response.json();
assert(payload && typeof payload === "object", "365Scores response must be an object");
assert(Array.isArray(payload.games), "365Scores response is missing games");

const games = payload.games;
const finals = games.filter(
  (game) =>
    Number(game?.statusGroup) === 4 ||
    /final|ended|הסתיים/i.test(String(game?.statusText ?? "")),
);
const scoredFinals = finals.filter((game) => {
  const home = Number(game?.homeCompetitor?.score);
  const away = Number(game?.awayCompetitor?.score);
  return Number.isFinite(home) && Number.isFinite(away);
});

const sample = games[0] ?? null;
if (sample) {
  assert(sample.homeCompetitor, "365Scores sample is missing homeCompetitor");
  assert(sample.awayCompetitor, "365Scores sample is missing awayCompetitor");
}

console.log(JSON.stringify({
  ok: true,
  date: dateKey,
  gameCount: games.length,
  finalCount: finals.length,
  scoredFinalCount: scoredFinals.length,
  schemaValidated: true,
  databaseChanged: false,
}, null, 2));


const roundPairs = [
  ["מכבי חיפה","הפועל באר שבע"],
  ["הפועל ירושלים","הפועל תל אביב"],
  ["הפועל קרית שמונה","בני סכנין"],
  ["הפועל רמת גן","מכבי פתח תקווה"],
  ["עירוני טבריה","מכבי נתניה"],
  ["קובנטרי","פולהאם"],
  ["האל","ברנטפורד"],
  ["קריסטל פאלאס","ניוקאסל"],
  ["סנדרלנד","לידס"],
  ["ראסינג סנטאנדר","אספניול"],
  ["ולנסיה","ויאריאל"],
  ["סלטה ויגו","בטיס"],
  ["קליארי","בולוניה"],
  ["נאפולי","רומא"],
  ["פ.צ. קלן","שאלקה 04"],
  ["פאדרבורן","המבורג"],
];

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !new Set(["fc","cf","afc","sc","club","football","f","c"]).has(token))
    .join(" ");
}

const roundCoverage = [];
for (const dateKey of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
  const day = ddmmyyyy(dateKey);
  const p = new URLSearchParams({
    langId: "2",
    timezoneName: "Asia/Jerusalem",
    userCountryId: "6",
    appTypeId: "5",
    sports: "1",
    startDate: day,
    endDate: day,
  });
  const res = await fetch(`https://webws.365scores.com/web/games/?${p}`, {
    headers: {
      "user-agent": "Mozilla/5.0",
      origin: "https://www.365scores.com",
      referer: "https://www.365scores.com/he/football/match-results",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  assert(res.ok, `365Scores round coverage returned HTTP ${res.status}`);
  const data = await res.json();
  for (const game of data.games ?? []) {
    const home = String(game?.homeCompetitor?.name ?? "").trim();
    const away = String(game?.awayCompetitor?.name ?? "").trim();
    if (!home || !away) continue;
    const pairIndex = roundPairs.findIndex(
      ([h,a]) => normalizeName(h) === normalizeName(home) && normalizeName(a) === normalizeName(away),
    );
    if (pairIndex >= 0) {
      roundCoverage.push({
        toto: pairIndex + 1,
        date: dateKey,
        home,
        away,
        exactNormalized: true,
      });
    }
  }
}

console.log("ROUND_264201_COVERAGE");
console.log(JSON.stringify({
  matched: roundCoverage.length,
  matches: roundCoverage.sort((a,b)=>a.toto-b.toto),
}, null, 2));
