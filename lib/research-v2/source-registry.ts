import type { SourceRegistryV2Entry } from "./sources";
import type { VersionedConfig } from "./provenance";

/**
 * Versioned source registry seed for Research v2 discovery (candidate; gate A).
 * Covers the competitions and clubs of the current live-dev fixtures only;
 * full-round coverage is a gate C item.
 *
 * Grades follow source-quality-v2: an official club or competition domain is
 * A; a local outlet with a dedicated club desk or section is specialist
 * (primary) reporting for those clubs only, whatever its size; national
 * outlets are established reporting; aggregators and data sites are D and can
 * never move a forecast or corroborate. Occasional coverage never earns
 * specialist status. Every entry records the evidence behind it.
 */

export const SOURCE_REGISTRY_VERSION = "source-registry-v2" as const;

/** Provider-scoped team keys (as in league history) and competitions the registry covers. */
export const REGISTRY_TEAMS = {
  hull: "sportmonks:22",
  brentford: "sportmonks:236",
  crystalPalace: "sportmonks:51",
  newcastle: "sportmonks:20",
  sunderland: "sportmonks:3",
  leeds: "sportmonks:71",
  celta: "sportmonks:36",
  betis: "sportmonks:485",
  maccabiHaifa: "sportmonks:571",
  hapoelBeerSheva: "sportmonks:516",
} as const;

export const REGISTRY_COMPETITIONS = {
  premierLeague: "sportmonks:8",
  laLiga: "sportmonks:564",
  ligatHaAl: "sportmonks:372",
} as const;

type TeamKey = (typeof REGISTRY_TEAMS)[keyof typeof REGISTRY_TEAMS];
type CompetitionKey = (typeof REGISTRY_COMPETITIONS)[keyof typeof REGISTRY_COMPETITIONS];

/** `verified`: researched with recorded evidence; `approved` is reserved for human sign-off. */
export type RegistryReviewStatus = "verified" | "needs_verification" | "approved";

export type RegistryEvidenceMethod =
  | "official_self_identification"
  | "http_title"
  | "third_party_listing"
  | "dedicated_section"
  | "dedicated_reporter"
  | "redirect"
  | "dns";

export type RegistryEvidence = {
  checkedOn: string;
  methods: RegistryEvidenceMethod[];
  sources: string[];
  finding: string;
};

export type SourceRegistrySeedEntry = SourceRegistryV2Entry & {
  /** Languages the source publishes in (ISO 639-1). */
  languages: string[];
  competitions: CompetitionKey[];
  /** Clubs this source reports on as a specialist (primary reporting for these clubs only). */
  specialistFor?: TeamKey[];
  /** Official source of exactly this club. */
  officialFor?: TeamKey;
  /** Named reporters with a documented club beat; applied per club by source-quality-v2, not outlet-wide. */
  reporterScopes?: Record<string, TeamKey[]>;
  /** News agency whose copy is syndicated (counts once across outlets). */
  agency?: boolean;
  reviewStatus: RegistryReviewStatus;
  evidence: RegistryEvidence;
};

export type SourceRegistrySeed = VersionedConfig & { entries: SourceRegistrySeedEntry[] };

const { premierLeague: PL, laLiga: LL, ligatHaAl: IL } = REGISTRY_COMPETITIONS;
const T = REGISTRY_TEAMS;
const CHECKED = "2026-10-25";

const ev = (methods: RegistryEvidenceMethod[], sources: string[], finding: string): RegistryEvidence => ({ checkedOn: CHECKED, methods, sources, finding });

const official = (domain: string, organization: string, team: TeamKey, competition: CompetitionKey, languages: string[], evidence: RegistryEvidence): SourceRegistrySeedEntry => ({
  domain, organization, defaultType: "official_club", officialFor: team, competitions: [competition], languages, reviewStatus: "verified", evidence,
});
const specialist = (domain: string, organization: string, teams: TeamKey[], competition: CompetitionKey, languages: string[], evidence: RegistryEvidence, reviewStatus: RegistryReviewStatus = "verified"): SourceRegistrySeedEntry => ({
  domain, organization, defaultType: "major_outlet", specialistFor: teams, competitions: [competition], languages, reviewStatus, evidence,
});
const outlet = (domain: string, organization: string, competitions: CompetitionKey[], languages: string[], evidence: RegistryEvidence, extra: Partial<SourceRegistrySeedEntry> = {}): SourceRegistrySeedEntry => ({
  domain, organization, defaultType: "major_outlet", competitions, languages, reviewStatus: "verified", evidence, ...extra,
});
const aggregator = (domain: string, organization: string, competitions: CompetitionKey[], evidence: RegistryEvidence): SourceRegistrySeedEntry => ({
  domain, organization, defaultType: "aggregator", competitions, languages: ["en"], reviewStatus: "verified", evidence,
});
const live = (url: string, title: string) => ev(["http_title"], [url], `HTTP 200; page title "${title}"`);

export const SOURCE_REGISTRY_SEED: SourceRegistrySeed = {
  id: "research-v2-source-registry",
  version: SOURCE_REGISTRY_VERSION,
  status: "candidate",
  entries: [
    // ---- Official competition bodies --------------------------------------
    { domain: "premierleague.com", organization: "Premier League", defaultType: "official_competition", competitions: [PL], languages: ["en"], reviewStatus: "verified",
      evidence: ev(["official_self_identification", "http_title"], ["https://www.premierleague.com/"], 'title "Premier League Football News, Fixtures, Scores & Results"; footer "© PREMIER LEAGUE 2026"') },
    { domain: "laliga.com", organization: "LALIGA", defaultType: "official_competition", competitions: [LL], languages: ["es", "en"], reviewStatus: "verified",
      evidence: ev(["official_self_identification", "http_title"], ["https://www.laliga.com/"], 'title "LALIGA official website | LALIGA"; footer "© 2026 - LALIGA"') },
    { domain: "football.co.il", organization: "Israel Football League Administration (מנהלת הליגות לכדורגל)", defaultType: "official_competition", competitions: [IL], languages: ["he"], reviewStatus: "verified",
      evidence: ev(["official_self_identification", "http_title"], ["https://www.football.co.il/"], 'title "מנהלת הליגות לכדורגל | אתר מנהלת הליגות לכדורגל"; links itself as the official site; social handles IsraelProFootball / ipfl_football; runs the top division (currently branded Ligat Winner), separate from the Israel FA') },
    { domain: "football.org.il", organization: "Israel Football Association (ההתאחדות לכדורגל בישראל)", defaultType: "official_competition", competitions: [IL], languages: ["he"], reviewStatus: "verified",
      evidence: ev(["third_party_listing"], ["https://inside.fifa.com/associations/ISR/organisation", "https://en.wikipedia.org/wiki/Israel_Football_Association"], "FIFA member-association listing gives www.football.org.il; the site itself answers 403 (Cloudflare) to automated requests") },

    // ---- Official clubs -----------------------------------------------------
    official("wearehullcity.co.uk", "Hull City AFC", T.hull, PL, ["en"],
      ev(["third_party_listing", "dns", "http_title"], ["https://en.wikipedia.org/wiki/Hull_City_A.F.C.", "https://www.wearehullcity.co.uk/"], "Wikipedia infobox lists wearehullcity.co.uk; the domain answers HTTP 200 and club team news is credited to it; the former hullcitytigers.com no longer resolves (DNS SERVFAIL)")),
    official("brentfordfc.com", "Brentford FC", T.brentford, PL, ["en"],
      ev(["official_self_identification", "http_title"], ["https://www.brentfordfc.com/"], 'title "Brentford FC | Official Website, News, Fixtures & Tickets"; footer "Brentford FC 2026. All rights reserved."')),
    official("cpfc.co.uk", "Crystal Palace FC", T.crystalPalace, PL, ["en"],
      ev(["http_title", "third_party_listing"], ["https://www.cpfc.co.uk/", "https://planetsport.com/soccer/england/Crystal-palace/video"], 'HTTP 200, title "Crystal Palace F.C."; the club\'s official YouTube channel links "Visit our official website: https://www.cpfc.co.uk"')),
    official("newcastleunited.com", "Newcastle United FC", T.newcastle, PL, ["en"],
      ev(["official_self_identification", "http_title"], ["https://www.newcastleunited.com/"], 'heading "Newcastle United Official Homepage"; footer "© Copyright Newcastle United 2026"')),
    official("safc.com", "Sunderland AFC", T.sunderland, PL, ["en"],
      ev(["official_self_identification", "third_party_listing"], ["https://www.safc.com/news/club-news/2016/june/new-website-launched", "https://m.premierleague.com/clubs/29/Sunderland/overview"], "club news: \"launched a brand-new official website, located at www.safc.com\"; Premier League club page points to safc.com")),
    official("leedsunited.com", "Leeds United FC", T.leeds, PL, ["en"],
      ev(["official_self_identification", "http_title"], ["https://www.leedsunited.com/"], 'title "Leeds United | Official Website - Leeds United"; footer "© Leeds United Football Club 2025"')),
    official("rccelta.es", "RC Celta de Vigo", T.celta, LL, ["es", "gl"],
      ev(["official_self_identification", "http_title"], ["https://www.rccelta.es/"], 'title "Celta | Web oficial del club"; footer "Copyright ®2026 Derechos reservados RC Celta"')),
    official("realbetisbalompie.es", "Real Betis Balompié", T.betis, LL, ["es"],
      ev(["official_self_identification", "http_title"], ["https://www.realbetisbalompie.es/"], 'title "Real Betis Balompié - Web Oficial"; footer "Esta página web es la única oficial del Real Betis Balompie"')),
    official("mhaifafc.com", "Maccabi Haifa FC", T.maccabiHaifa, IL, ["he", "en"],
      ev(["official_self_identification", "http_title", "third_party_listing"], ["https://www.mhaifafc.com/", "https://en.wikipedia.org/wiki/2024%E2%80%9325_Maccabi_Haifa_F.C._season"], 'title "מכבי חיפה - האתר הרשמי" (the official website); Wikipedia season pages link it as the official site')),
    official("hbsfc.co.il", "Hapoel Beer Sheva FC", T.hapoelBeerSheva, IL, ["he", "en"],
      ev(["official_self_identification", "http_title", "third_party_listing"], ["https://www.hbsfc.co.il/", "https://en.wikipedia.org/wiki/Hapoel_Be%27er_Sheva_F.C."], 'header label "אתר המועדון הרשמי" (the club\'s official site); footer "© Copyright 2025 Hapoel Beer Sheva Football"; Wikipedia lists hbsfc.co.il (hb7.co.il is the separate basketball club)')),

    // ---- Club-specialist reporting (dedicated desk or section; primary for those clubs only) ----
    specialist("hulldailymail.co.uk", "Hull Live / Hull Daily Mail", [T.hull], PL, ["en"],
      ev(["dedicated_section"], ["https://www.hulldailymail.co.uk/all-about/hull-city"], 'dedicated club section "Hull City latest news - Hull Daily Mail"')),
    specialist("football.london", "football.london (Reach)", [T.crystalPalace], PL, ["en"],
      ev(["dedicated_section", "dedicated_reporter", "redirect"], ["https://www.football.london/crystal-palace-fc/", "https://www.holdthefrontpage.co.uk/?p=1721150"], "dedicated Crystal Palace section (the Croydon Advertiser and MyLondon Palace/Brentford club pages redirect here); dedicated Palace writer documented (2018); Brentford has a section but no documented dedicated writer, so Brentford is out of scope"),
      "needs_verification"),
    specialist("chroniclelive.co.uk", "Chronicle Live", [T.newcastle, T.sunderland], PL, ["en"],
      ev(["dedicated_section"], ["https://www.chroniclelive.co.uk/all-about/newcastle-united-fc", "https://www.chroniclelive.co.uk/all-about/sunderland-afc"], 'dedicated sections "Newcastle United - NUFC news…" and "Sunderland AFC - SAFC news…"')),
    specialist("sunderlandecho.com", "Sunderland Echo", [T.sunderland], PL, ["en"],
      ev(["dedicated_section"], ["https://www.sunderlandecho.com/sport/football/sunderland-afc"], 'dedicated section "Sunderland AFC Latest News | Sunderland Echo"')),
    specialist("yorkshireeveningpost.co.uk", "Yorkshire Evening Post", [T.leeds], PL, ["en"],
      ev(["dedicated_section", "dedicated_reporter"], ["https://www.yorkshireeveningpost.co.uk/sport/football/leeds-united", "https://journalist.net/kyle.newbould"], "dedicated Leeds United section; Kyle Newbould listed as YEP Leeds United reporter (2026/27 preview, Aug 2026)")),
    specialist("leeds-live.co.uk", "Leeds Live", [T.leeds], PL, ["en"],
      ev(["dedicated_section", "dedicated_reporter"], ["https://www.leeds-live.co.uk/all-about/leeds-united-fc", "https://www.gazettelive.co.uk/authors/isaac-johnson"], 'dedicated section "Leeds United FC - Leeds Live"; Isaac Johnson described as the Leeds United reporter for LeedsLive (bylines Sep 2026)')),
    specialist("farodevigo.es", "Faro de Vigo", [T.celta], LL, ["es", "gl"],
      ev(["dedicated_section"], ["https://www.farodevigo.es/celta-de-vigo/"], 'dedicated section "Celta de Vigo: resultados, noticias y actualidad del Celta | Faro de Vigo"')),
    specialist("estadiodeportivo.com", "Estadio Deportivo", [T.betis], LL, ["es"],
      ev(["dedicated_section"], ["https://www.estadiodeportivo.com/futbol/betis/"], 'Seville sports daily with dedicated section "Noticias del Real Betis en EstadioDeportivo.com"')),
    specialist("diariodesevilla.es", "Diario de Sevilla", [T.betis], LL, ["es"],
      ev(["dedicated_section"], ["https://www.diariodesevilla.es/realbetis/"], 'dedicated section "Betis Noticias, Partidos, Resultados y Fichajes del Real Betis Balompié"')),

    // ---- Regional outlets without a documented club desk (not specialists) ----
    outlet("mylondon.news", "MyLondon (Reach)", [PL], ["en"],
      ev(["redirect", "http_title"], ["https://www.mylondon.news/all-about/brentford-fc", "https://www.mylondon.news/all-about/crystal-palace-fc"], "Brentford club page redirects to football.london; a Palace tag page exists but no dedicated desk was found; the Croydon Advertiser domain now redirects into MyLondon")),
    outlet("atlantico.net", "Atlántico Diario", [LL], ["es"],
      ev(["http_title"], ["https://www.atlantico.net/", "https://www.atlantico.net/deportes/"], 'regional daily ("Diario de Vigo y su área metropolitana"); no dedicated Celta section found (/celta/ and /deportes/celta/ are 404)')),

    // ---- Established national reporting ------------------------------------
    outlet("bbc.co.uk", "BBC Sport", [PL], ["en"], ev(["http_title"], ["https://www.bbc.co.uk/sport/football"], "HTTP 200 football section")),
    outlet("bbc.com", "BBC Sport", [PL], ["en"], ev(["third_party_listing"], ["https://www.bbc.com/sport/football"], "international mirror of BBC Sport")),
    outlet("skysports.com", "Sky Sports", [PL], ["en"], live("https://www.skysports.com/football", "Football Games, Results, Scores, Transfers, News | Sky Sports")),
    outlet("theguardian.com", "The Guardian", [PL], ["en"], live("https://www.theguardian.com/football", "Football | The Guardian")),
    outlet("nytimes.com", "The Athletic (New York Times)", [PL, LL], ["en"], live("https://www.nytimes.com/athletic/football/", "Soccer News - Results, Fixtures, Scores, Stats, and Rumors - The Athletic")),
    outlet("telegraph.co.uk", "The Telegraph", [PL], ["en"], ev(["http_title"], ["https://www.telegraph.co.uk/football/"], "domain live (HTTP 402 paywall for automated requests)")),
    outlet("independent.co.uk", "The Independent", [PL], ["en"], ev(["http_title"], ["https://www.independent.co.uk/sport/football"], "HTTP 200 football section")),
    outlet("standard.co.uk", "Evening Standard", [PL], ["en"],
      ev(["http_title", "dedicated_reporter"], ["https://www.standard.co.uk/sport/football", "https://www.homesandproperty.co.uk/author/dom-smith"], "HTTP 200 football section; author profile: Dom Smith covers Crystal Palace, Fulham and Brentford particularly closely"),
      { reporterScopes: { "Dom Smith": [T.crystalPalace, T.brentford] } }),
    outlet("marca.com", "Marca", [LL], ["es"], ev(["http_title"], ["https://www.marca.com/"], "HTTP 200; national sports daily")),
    outlet("as.com", "AS", [LL], ["es"], live("https://as.com/", "AS.com - Diario online deportivo. Fútbol, motor y mucho más")),
    outlet("mundodeportivo.com", "Mundo Deportivo", [LL], ["es"], live("https://www.mundodeportivo.com/", "Mundo Deportivo | Noticias deportivas: Fútbol, motor, tenis y más")),
    outlet("sport.es", "Sport", [LL], ["es"], live("https://www.sport.es/es/", "SPORT | Noticias del Barça, La Liga, fútbol y otros deportes")),
    outlet("relevo.com", "Relevo", [LL], ["es"], live("https://www.relevo.com/", "RELEVO | Diario deportivo online: noticias y análisis")),
    outlet("sport5.co.il", "Sport 5", [IL], ["he"], ev(["http_title"], ["https://www.sport5.co.il/"], "HTTP 200; national sports channel site with club tag pages")),
    outlet("one.co.il", "ONE", [IL], ["he"], live("https://www.one.co.il/", "ONE - מספר 1 בספורט | חדשות ספורט, תוצאות LIVE וסטטיסטיקה")),
    outlet("ynet.co.il", "Ynet", [IL], ["he"], live("https://www.ynet.co.il/sport", "ynet - חדשות ספורט")),
    outlet("walla.co.il", "Walla! Sport", [IL], ["he"], ev(["http_title"], ["https://sports.walla.co.il/"], "HTTP 200 (sports.walla.co.il subdomain)")),
    outlet("haaretz.co.il", "Haaretz", [IL], ["he"], live("https://www.haaretz.co.il/sport", "ספורט - הארץ")),
    outlet("israelhayom.co.il", "Israel Hayom", [IL], ["he"], live("https://www.israelhayom.co.il/sport", "חדשות הספורט - תוצאות ועדכונים בזמן אמת | היום")),

    // ---- News agencies (syndicated copy counts once) ------------------------
    outlet("reuters.com", "Reuters", [PL, LL, IL], ["en"], ev(["http_title"], ["https://www.reuters.com/sports/soccer/"], "domain live (HTTP 401 to automated requests)"), { agency: true }),
    outlet("apnews.com", "Associated Press", [PL, LL], ["en"], live("https://apnews.com/hub/soccer", "Soccer | AP News"), { agency: true }),
    outlet("efe.com", "Agencia EFE", [LL], ["es"], live("https://efe.com/deportes/", "Deportes, por Agencia EFE"), { agency: true }),

    // ---- Aggregators and data sites: never move a forecast, never corroborate ----
    aggregator("sportsmole.co.uk", "Sports Mole", [PL, LL], live("https://www.sportsmole.co.uk/", "Football News, Previews, Predictions, Transfers")),
    aggregator("transfermarkt.com", "Transfermarkt", [PL, LL, IL], live("https://www.transfermarkt.com/", "Football transfers, rumours, market values and news | Transfermarkt")),
    aggregator("fotmob.com", "FotMob", [PL, LL, IL], ev(["http_title"], ["https://www.fotmob.com/"], "HTTP 200; data aggregator")),
    aggregator("sofascore.com", "Sofascore", [PL, LL, IL], ev(["http_title"], ["https://www.sofascore.com/"], "domain live (HTTP 403 to automated requests); data aggregator")),
    aggregator("footballtransfers.com", "FootballTransfers", [PL, LL], live("https://www.footballtransfers.com/en", "Football Transfer News, Rumours and Player Values (ETV)")),
    aggregator("teamtalk.com", "TEAMtalk", [PL], live("https://www.teamtalk.com/", "TEAMtalk | Football transfers, transfer news, rumours and stats")),
    aggregator("givemesport.com", "GiveMeSport", [PL], live("https://www.givemesport.com/", "GiveMeSport – Sports news including results, video and analysis")),
    aggregator("caughtoffside.com", "CaughtOffside", [PL], live("https://www.caughtoffside.com/", "Football News | CaughtOffside")),
  ],
};

/** Only researched or human-approved entries may grant specialist or reporter trust. */
export function grantsTrustPrivileges(entry: SourceRegistrySeedEntry): boolean {
  return entry.reviewStatus === "verified" || entry.reviewStatus === "approved";
}

/**
 * The registry as source assessment must see it: an entry still marked
 * `needs_verification` keeps its plain outlet type but loses every trust
 * privilege (specialist scope, reporter scopes, accredited reporters), so a
 * draft scope can never lift it to grade B. Source quality reads the registry
 * only through this function.
 */
export function effectiveRegistryEntries(seed: SourceRegistrySeed = SOURCE_REGISTRY_SEED): SourceRegistrySeedEntry[] {
  return seed.entries.map((entry) => {
    if (grantsTrustPrivileges(entry)) return entry;
    const { specialistFor: _specialist, reporterScopes: _reporters, accreditedReporters: _accredited, ...plain } = entry;
    return plain;
  });
}

/** Where research found no qualifying specialist source (recorded, not invented). */
export const REGISTRY_KNOWN_GAPS: readonly { team: TeamKey; reason: string }[] = [
  { team: T.brentford, reason: "no outlet with a documented dedicated Brentford desk; reporter-level scope only (Evening Standard, Dom Smith)" },
  { team: T.maccabiHaifa, reason: "no local outlet with a dedicated club desk found; national outlets only" },
  { team: T.hapoelBeerSheva, reason: "no local outlet with a dedicated club desk found; national outlets only" },
];

/** Domains researched and deliberately left out, with the reason. */
export const REGISTRY_EXCLUDED: readonly { domain: string; reason: string }[] = [
  { domain: "hullcitytigers.com", reason: "former Hull City domain; no longer resolves (DNS SERVFAIL, 2026-10-25)" },
  { domain: "croydonadvertiser.co.uk", reason: "domain redirects into mylondon.news; its Crystal Palace page redirects to football.london" },
  { domain: "hb7.co.il", reason: "Hapoel Be'er Sheva basketball club, not the football club" },
];
