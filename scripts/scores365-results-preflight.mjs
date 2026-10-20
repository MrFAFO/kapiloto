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
