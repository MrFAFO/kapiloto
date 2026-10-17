import {
  OUTCOMES,
  outcomesToPick,
  pickToOutcomes,
  type Outcome,
  type Pick,
} from "@/lib/toto";

export type VoteVector = Record<Outcome, number>;

export interface ConsensusGameInput {
  gameNumber: number;
  picks: Pick[];
}

export interface ConsensusGameResult {
  gameNumber: number;
  pick: Pick;
  support: VoteVector;
  doubleGain: number;
}

function emptyVotes(): VoteVector {
  return { "1": 0, X: 0, "2": 0 };
}

function normalizedSupport(picks: Pick[]): VoteVector {
  if (picks.length === 0) {
    throw new Error("Consensus requires at least one submitted pick per game.");
  }

  const votes = emptyVotes();

  for (const pick of picks) {
    const outcomes = pickToOutcomes(pick);
    const weight = 1 / outcomes.length;

    for (const outcome of outcomes) {
      votes[outcome] += weight;
    }
  }

  return {
    "1": votes["1"] / picks.length,
    X: votes.X / picks.length,
    "2": votes["2"] / picks.length,
  };
}

function rankedOutcomes(
  support: VoteVector,
  gameNumber: number,
): Outcome[] {
  return [...OUTCOMES].sort((a, b) => {
    const supportDelta = support[b] - support[a];
    if (supportDelta !== 0) return supportDelta;

    // Stable semantic order for exact ties. gameNumber is deliberately
    // referenced so the final allocation can use it as its last tie breaker.
    void gameNumber;
    return OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b);
  });
}

export function buildDemocraticConsensus(
  games: ConsensusGameInput[],
  maxDoubles: number,
): ConsensusGameResult[] {
  if (!Number.isInteger(maxDoubles) || maxDoubles < 0) {
    throw new Error("maxDoubles must be a non-negative integer.");
  }

  const evaluated = games.map((game) => {
    const support = normalizedSupport(game.picks);
    const ranked = rankedOutcomes(support, game.gameNumber);
    const top = ranked[0];
    const second = ranked[1];
    const singleCoverage = support[top];
    const doubleCoverage = support[top] + support[second];
    const doubleGain =
      singleCoverage > 0 ? Math.log(doubleCoverage / singleCoverage) : 0;

    return {
      gameNumber: game.gameNumber,
      support,
      ranked,
      doubleGain,
      secondSupport: support[second],
      topSecondGap: support[top] - support[second],
      submissionCount: game.picks.length,
    };
  });

  const doubleGameNumbers = new Set(
    [...evaluated]
      .sort((a, b) => {
        if (b.doubleGain !== a.doubleGain) return b.doubleGain - a.doubleGain;
        if (b.secondSupport !== a.secondSupport) {
          return b.secondSupport - a.secondSupport;
        }
        if (a.topSecondGap !== b.topSecondGap) {
          return a.topSecondGap - b.topSecondGap;
        }
        if (b.submissionCount !== a.submissionCount) {
          return b.submissionCount - a.submissionCount;
        }
        return a.gameNumber - b.gameNumber;
      })
      .slice(0, Math.min(maxDoubles, evaluated.length))
      .map((game) => game.gameNumber),
  );

  return evaluated
    .sort((a, b) => a.gameNumber - b.gameNumber)
    .map((game) => {
      const selected = doubleGameNumbers.has(game.gameNumber)
        ? game.ranked.slice(0, 2)
        : game.ranked.slice(0, 1);

      return {
        gameNumber: game.gameNumber,
        pick: outcomesToPick(selected),
        support: game.support,
        doubleGain: game.doubleGain,
      };
    });
}
