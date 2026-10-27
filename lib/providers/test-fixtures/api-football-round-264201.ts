/**
 * Winner 16 round 264201 as observed on 2026-10-24 (read-only probe).
 *
 * Kapiloto ids, Hebrew canonical names and Sportmonks names come from
 * production; API-Football ids and names come from the provider's fixture
 * list for each date, verified by kickoff, league, both team names and a
 * complete 1X2 market on the same fixture. Game 1 (2026-10-26) was outside
 * the Free plan's date window, so it has no verified API-Football ids.
 *
 * The seed migration 20261024130000_api_football_verified_mappings_round_264201_v1
 * must contain exactly these mappings; a test enforces it.
 */

export type VerifiedTeam = {
  teamId: string;
  hebrew: string;
  sportmonksName: string;
  apiFootball: { id: string; name: string } | null;
};

export type VerifiedGame = {
  gameNumber: number;
  kickoffAt: string;
  competitionId: string;
  competitionName: string;
  apiFootballFixtureId: string | null;
  home: VerifiedTeam;
  away: VerifiedTeam;
};

export const API_FOOTBALL_COMPETITIONS: Record<string, { id: string; name: string; country: string }> = {
  "06b70ffa-847c-44d2-a346-3683ac9115c3": { id: "383", name: "Ligat Ha'al", country: "Israel" },
  "ccdbb89d-e575-4e15-820d-f5d1ecdc3a85": { id: "39", name: "Premier League", country: "England" },
  "2116127b-f4f6-40d5-bdbc-bc60cb70dc0d": { id: "140", name: "La Liga", country: "Spain" },
  "a2b7daf8-1d1d-4b79-8801-b47ad6cde38c": { id: "135", name: "Serie A", country: "Italy" },
  "11ef12f9-86cf-4634-9ed7-cf9f7113e214": { id: "78", name: "Bundesliga", country: "Germany" },
};

const LIGAT = "06b70ffa-847c-44d2-a346-3683ac9115c3";
const EPL = "ccdbb89d-e575-4e15-820d-f5d1ecdc3a85";
const LALIGA = "2116127b-f4f6-40d5-bdbc-bc60cb70dc0d";
const SERIEA = "a2b7daf8-1d1d-4b79-8801-b47ad6cde38c";
const BUNDES = "11ef12f9-86cf-4634-9ed7-cf9f7113e214";

function team(teamId: string, hebrew: string, sportmonksName: string, api?: [string, string]): VerifiedTeam {
  return { teamId, hebrew, sportmonksName, apiFootball: api ? { id: api[0], name: api[1] } : null };
}

export const ROUND_264201: VerifiedGame[] = [
  { gameNumber: 1, kickoffAt: "2026-10-26T17:00:00Z", competitionId: LIGAT, competitionName: "Ligat Ha'al", apiFootballFixtureId: null,
    home: team("40b796e4-b939-4160-a24a-044e8bc703fb", "מכבי חיפה", "Maccabi Haifa"),
    away: team("8430f0cd-e215-4ba9-858e-ae1707b9d37c", "הפועל באר שבע", "Hapoel Be'er Sheva") },
  { gameNumber: 2, kickoffAt: "2026-10-24T15:45:00Z", competitionId: LIGAT, competitionName: "Ligat Ha'al", apiFootballFixtureId: "1555528",
    home: team("449dd8ed-10e5-4e55-a095-bb2202c6c9ce", "הפועל ירושלים", "Hapoel Jerusalem", ["4486", "Hapoel Katamon"]),
    away: team("6fc76117-e2fa-483b-9fb0-bc52ed86c430", "הפועל תל אביב", "Hapoel Tel Aviv", ["4501", "Hapoel Tel Aviv"]) },
  { gameNumber: 3, kickoffAt: "2026-10-24T15:45:00Z", competitionId: LIGAT, competitionName: "Ligat Ha'al", apiFootballFixtureId: "1555532",
    home: team("3d7484fa-4442-4cde-9576-6c7981b6dfeb", "הפועל קרית שמונה", "Ironi Kiryat Shmona", ["4510", "Ironi Kiryat Shmona"]),
    away: team("8be54030-7c8e-4da6-9c2e-38cf75a56c34", "בני סכנין", "Bnei Sakhnin", ["4481", "Bnei Sakhnin"]) },
  { gameNumber: 4, kickoffAt: "2026-10-24T16:00:00Z", competitionId: LIGAT, competitionName: "Ligat Ha'al", apiFootballFixtureId: "1555530",
    home: team("09eddd2a-ee47-4d3b-b34d-5d8b2268c50e", "הפועל רמת גן", "Hapoel Ramat Gan", ["4489", "Hapoel Ramat Gan"]),
    away: team("21c0daeb-9fdb-4152-9592-1ded8d71f2cb", "מכבי פתח תקווה", "Maccabi Petah Tikva", ["4495", "Maccabi Petah Tikva"]) },
  { gameNumber: 5, kickoffAt: "2026-10-24T16:00:00Z", competitionId: LIGAT, competitionName: "Ligat Ha'al", apiFootballFixtureId: "1555531",
    home: team("8d466213-7a7c-48bc-b5c5-4a18b47c2f72", "עירוני טבריה", "Ironi Tiberias", ["6181", "Ironi Tiberias"]),
    away: team("51b59030-1607-4150-81c4-17553e2fbbb9", "מכבי נתניה", "Maccabi Netanya", ["4505", "Maccabi Netanya"]) },
  { gameNumber: 6, kickoffAt: "2026-10-24T14:00:00Z", competitionId: EPL, competitionName: "Premier League", apiFootballFixtureId: "1557440",
    home: team("8d6e84ab-c024-4c1c-ba51-3d7f2ec22644", "קובנטרי", "Coventry City", ["1346", "Coventry"]),
    away: team("2fd9c93c-2739-4c14-bfee-9381fb72f8ed", "פולהאם", "Fulham", ["36", "Fulham"]) },
  { gameNumber: 7, kickoffAt: "2026-10-25T14:00:00Z", competitionId: EPL, competitionName: "Premier League", apiFootballFixtureId: "1557442",
    home: team("b08fed73-5dec-48d4-a78d-492941015068", "האל", "Hull City", ["64", "Hull City"]),
    away: team("eb5c6625-7b8e-4027-a688-36568f372b3d", "ברנטפורד", "Brentford", ["55", "Brentford"]) },
  { gameNumber: 8, kickoffAt: "2026-10-25T14:00:00Z", competitionId: EPL, competitionName: "Premier League", apiFootballFixtureId: "1557441",
    home: team("240f0dd8-0199-4975-aa8d-95233d305a4c", "קריסטל פאלאס", "Crystal Palace", ["52", "Crystal Palace"]),
    away: team("873939e0-cf0b-4151-9526-d754629fc7f5", "ניוקאסל", "Newcastle United", ["34", "Newcastle"]) },
  { gameNumber: 9, kickoffAt: "2026-10-25T16:30:00Z", competitionId: EPL, competitionName: "Premier League", apiFootballFixtureId: "1557446",
    home: team("60b20670-8dcd-4091-85b2-1053446cab54", "סנדרלנד", "Sunderland", ["746", "Sunderland"]),
    away: team("72bfd482-213d-4b7f-8939-544eb4329682", "לידס", "Leeds United", ["63", "Leeds"]) },
  { gameNumber: 10, kickoffAt: "2026-10-24T14:15:00Z", competitionId: LALIGA, competitionName: "La Liga", apiFootballFixtureId: "1570428",
    home: team("b008ba96-b096-45ca-a930-deec7689f426", "ראסינג סנטאנדר", "Racing Santander", ["4665", "Racing Santander"]),
    away: team("5b8439d3-fb01-41ba-9327-630c41e1f9a1", "אספניול", "Espanyol", ["540", "Espanyol"]) },
  { gameNumber: 11, kickoffAt: "2026-10-24T16:30:00Z", competitionId: LALIGA, competitionName: "La Liga", apiFootballFixtureId: "1570432",
    home: team("ff45ce48-2995-4a37-9ba1-af4ec246de9c", "ולנסיה", "Valencia", ["532", "Valencia"]),
    away: team("d90b8f8e-cfa8-4705-90eb-532e3a7b468e", "ויאריאל", "Villarreal", ["533", "Villarreal"]) },
  { gameNumber: 12, kickoffAt: "2026-10-25T15:15:00Z", competitionId: LALIGA, competitionName: "La Liga", apiFootballFixtureId: "1570427",
    home: team("4b5cdb73-d019-46dc-9c1f-4bbe1ac23146", "סלטה ויגו", "Celta de Vigo", ["538", "Celta Vigo"]),
    away: team("1a9506b5-7100-4d4c-85cc-91e4a8ee1bcd", "בטיס", "Real Betis", ["543", "Real Betis"]) },
  { gameNumber: 13, kickoffAt: "2026-10-24T13:00:00Z", competitionId: SERIEA, competitionName: "Serie A", apiFootballFixtureId: "1550158",
    home: team("e19b9268-6dc7-426b-adb8-d7aae9e4b8d8", "קליארי", "Cagliari", ["490", "Cagliari"]),
    away: team("73fa1424-c69d-4f08-85f2-f0e2f59315f1", "בולוניה", "Bologna", ["500", "Bologna"]) },
  { gameNumber: 14, kickoffAt: "2026-10-24T16:00:00Z", competitionId: SERIEA, competitionName: "Serie A", apiFootballFixtureId: "1550164",
    home: team("05061cae-b526-499c-88a5-1c4a9f2ce86b", "נאפולי", "Napoli", ["492", "Napoli"]),
    away: team("968f1153-ffb4-4d64-838a-d1ce6b397aee", "רומא", "Roma", ["497", "AS Roma"]) },
  { gameNumber: 15, kickoffAt: "2026-10-24T13:30:00Z", competitionId: BUNDES, competitionName: "Bundesliga", apiFootballFixtureId: "1575201",
    home: team("f68ab2f0-cd3d-4c80-84bd-8c9079bcfb8b", "פ.צ. קלן", "FC Köln", ["192", "1. FC Köln"]),
    away: team("8ab93093-dafb-419a-9cd3-d9c91485f3d6", "שאלקה 04", "Schalke 04", ["174", "FC Schalke 04"]) },
  { gameNumber: 16, kickoffAt: "2026-10-24T13:30:00Z", competitionId: BUNDES, competitionName: "Bundesliga", apiFootballFixtureId: "1575202",
    home: team("927dc08d-87f1-4638-8b68-fe941ac88c1f", "פאדרבורן", "Paderborn", ["185", "SC Paderborn 07"]),
    away: team("36cf42d3-a61e-45ad-9243-6343ad189c47", "המבורג", "Hamburger SV", ["175", "Hamburger SV"]) },
];
