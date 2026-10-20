import { __testOnly } from "../lib/kapiloto/source-retriever";

const CASES = [
  {
    label: "maccabi-haifa-official",
    url: "https://www.mhaifafc.com/news/37703",
    expectedText: "ברק בכר",
    requiresPublishedAt: true,
  },
  {
    label: "schalke-official",
    url: "https://schalke04.de/en/team/squad-update-071026/",
    expectedText: "Timo Becker",
    requiresPublishedAt: true,
  },
  {
    label: "sky-sports",
    url: "https://www.skysports.com/football/news/13567456/premier-league-injuries-latest-news-injury-table-suspension-tracker-and-fpl-updates-for-every-club",
    expectedText: "injuries",
    requiresPublishedAt: true,
  },
];

const results = [];

for (const item of CASES) {
  try {
    const document = await __testOnly.fetchSource(item.url);
    const textFound = document.text
      .toLocaleLowerCase()
      .includes(item.expectedText.toLocaleLowerCase());
    const publishedOk =
      !item.requiresPublishedAt || document.publishedAt != null;

    results.push({
      label: item.label,
      ok: textFound && publishedOk,
      finalUrl: document.finalUrl,
      publishedAt: document.publishedAt,
      textFound,
      contentBytesApprox: Buffer.byteLength(document.text, "utf8"),
      error: null,
    });
  } catch (error) {
    results.push({
      label: item.label,
      ok: false,
      finalUrl: null,
      publishedAt: null,
      textFound: false,
      contentBytesApprox: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2));

if (!results.every((item) => item.ok)) {
  process.exitCode = 1;
}
