import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { TelesportWinner16Provider } from "../lib/rounds/telesport";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const out = option("--out");
  const provider = new TelesportWinner16Provider();
  const discovery = await provider.discoverCurrent();
  const json = JSON.stringify(discovery, null, 2) + "\n";

  if (out) {
    const path = resolve(out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, "utf8");
  }

  process.stdout.write(json);

  if (!discovery.completeKickoffs) {
    const unresolved = discovery.games
      .filter((game) => !game.kickoffAt)
      .map((game) => game.gameNumber);

    process.stderr.write(
      `Discovery is valid but not importable yet; unresolved kickoff games: ${unresolved.join(", ")}.\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
