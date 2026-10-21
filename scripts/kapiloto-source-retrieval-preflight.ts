import { __testOnly } from "../lib/kapiloto/source-retriever";

const CASES = [
  {
    label: "maccabi-haifa-official",
    url: "https://www.mhaifafc.com/news/37703",
    expectedText: "ברק בכר",
    requiresPublishedAt: true,
    sourceClass: "official",
  },
  {
    label: "schalke-official",
    url: "https://schalke04.de/en/team/squad-update-071026/",
    expectedText: "Timo Becker",
    requiresPublishedAt: true,
    sourceClass: "official",
  },
  {
    label: "sky-sports",
    url: "https://www.skysports.com/football/news/13567456/premier-league-injuries-latest-news-injury-table-suspension-tracker-and-fpl-updates-for-every-club",
    expectedText: "injuries",
    requiresPublishedAt: true,
    sourceClass: "independent",
  },
];

async function main() {
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
      sourceClass: item.sourceClass,
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
      sourceClass: item.sourceClass,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  }

  const successful = results.filter((item) => item.ok);
  const officialSuccesses = successful.filter(
    (item) => item.sourceClass === "official",
  ).length;
  const independentSuccesses = successful.filter(
    (item) => item.sourceClass === "independent",
  ).length;
  const ok =
    successful.length >= 2 &&
    officialSuccesses >= 1 &&
    independentSuccesses >= 1;

  console.log(
    JSON.stringify(
      {
        ok,
        degraded: results.some((item) => !item.ok),
        successfulSources: successful.length,
        officialSuccesses,
        independentSuccesses,
        failures: results
          .filter((item) => !item.ok)
          .map((item) => ({ label: item.label, error: item.error })),
        results,
      },
      null,
      2,
    ),
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
