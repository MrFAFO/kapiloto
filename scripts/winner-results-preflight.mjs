const endpoint = "https://www.winner.co.il/api/v2/publicapi/GetResults";

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const now = new Date();
const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

const body = {
  startDate: `${isoDate(start)}T00:00:00+02:00`,
  endDate: `${isoDate(now)}T23:59:59+02:00`,
  sports: [],
  leagues: [],
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    origin: "https://www.winner.co.il",
    referer: "https://www.winner.co.il/",
    "user-agent": "Kapiloto/0.1 GitHub Winner official results preflight",
    requestid: crypto.randomUUID().replaceAll("-", ""),
    deviceid: crypto.randomUUID().replaceAll("-", ""),
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20_000),
});

console.log(`HTTP ${response.status}`);
assert(response.ok, `Winner GetResults returned HTTP ${response.status}`);

const payload = await response.json();
assert(payload && typeof payload === "object", "Response must be an object");
assert(
  payload.results && typeof payload.results === "object",
  "Response missing results object",
);
assert(Array.isArray(payload.results.events), "Response missing results.events");

const events = payload.results.events;
const sample = events[0] ?? null;
if (sample) {
  for (const key of ["sportid", "date", "league", "teamA", "teamB"]) {
    assert(key in sample, `Sample event missing ${key}`);
  }
}

const football = events.filter((event) => Number(event?.sportid) === 240);
const scoredFootball = football.filter((event) => {
  const noScore = typeof event?.noScoreLabel === "string" && event.noScoreLabel.trim();
  return !noScore && Number.isFinite(Number(event?.scoreA)) && Number.isFinite(Number(event?.scoreB));
});

console.log(JSON.stringify({
  ok: true,
  endpoint,
  startDate: isoDate(start),
  endDate: isoDate(now),
  eventCount: events.length,
  footballEventCount: football.length,
  scoredFootballEventCount: scoredFootball.length,
  schemaValidated: true,
  databaseChanged: false,
}, null, 2));
