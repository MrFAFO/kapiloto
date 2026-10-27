const endpoint = "https://www.winner.co.il/api/v2/publicapi/GetResults";

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jerusalemOffset(date) {
  const probe = new Date(`${date}T12:00:00.000Z`);
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "longOffset",
  })
    .formatToParts(probe)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = value?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  assert(match, "Could not resolve Asia/Jerusalem UTC offset");
  return `${match[1]}${match[2]}:${match[3]}`;
}

const now = new Date();
const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

const startDate = isoDate(start);
const endDate = isoDate(now);
const body = {
  startDate: `${startDate}T00:00:00${jerusalemOffset(startDate)}`,
  endDate: `${endDate}T23:59:59${jerusalemOffset(endDate)}`,
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
    "user-agent": "Mozilla/5.0",
    "x-requested-with": "XMLHttpRequest",
    requestid: crypto.randomUUID(),
    deviceid: crypto.randomUUID(),
    useragentdata: JSON.stringify({
      devicemodel: "",
      deviceos: "windows",
      deviceosversion: "10",
      appversion: "2.6.1",
      apptype: "desktop",
      originId: 15,
      isAccessibility: false,
    }),
    appversion: "2.6.1",
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
