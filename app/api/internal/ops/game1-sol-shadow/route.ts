import OpenAI from "openai";

import { buildKapilotoFixtureCard } from "@/lib/kapiloto/fixture-card";
import { loadRoundFixtureCardInputs } from "@/lib/kapiloto/fixture-input-store";
import {
  getKapilotoOpenAIModel,
  getKapilotoReasoningEffort,
} from "@/lib/kapiloto/research-config";
import {
  KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
  researchFixtureWithSol,
} from "@/lib/kapiloto/openai-research";
import { groundResearchOutput } from "@/lib/kapiloto/source-grounding-runtime";
import {
  createOpenAIEntailmentJudge,
  verifyRequiredEntailment,
} from "@/lib/kapiloto/entailment-verifier";
import {
  KAPILOTO_ENTAILMENT_MAX_OUTPUT_TOKENS,
} from "@/lib/kapiloto/worker-runtime";
import {
  materializeKapilotoResearchRun,
  type MaterializableFixture,
} from "@/lib/kapiloto/run-materialization";
import { estimateSolUsageCostMicros } from "@/lib/kapiloto/research-cost";
import { aggregateMarketPrior } from "@/lib/providers/market";
import { SportmonksClient } from "@/lib/providers/sportmonks";
import { SupabaseSportmonksSyncStore } from "@/lib/providers/sportmonks-supabase-store";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return Response.json({ ok: false, error: "preview_only" }, { status: 403 });
  }

  const sportmonksToken = process.env.SPORTMONKS_API_TOKEN?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!sportmonksToken || !openAiKey) {
    return Response.json({
      ok: false,
      error: "missing_runtime_secret",
      sportmonks: Boolean(sportmonksToken),
      openai: Boolean(openAiKey),
    }, { status: 503 });
  }

  const admin = createAdminClient();
  const { data: round, error: roundError } = await admin
    .from("rounds")
    .select("id,external_round_number")
    .eq("external_round_number", "264301")
    .maybeSingle();

  if (roundError) throw new Error(roundError.message);
  if (!round) {
    return Response.json({ ok: false, error: "round_not_found" }, { status: 404 });
  }

  const sportmonksStore = new SupabaseSportmonksSyncStore(admin);
  const sportmonksGames = await sportmonksStore.loadRoundGames(String(round.id));
  const smGame = sportmonksGames.find((game) => game.gameNumber === 1);
  if (!smGame) {
    return Response.json({ ok: false, error: "game_1_not_found" }, { status: 404 });
  }
  if (smGame.providerFixtureId == null) {
    return Response.json({
      ok: false,
      error: "sportmonks_fixture_mapping_missing",
    }, { status: 409 });
  }

  const sportmonks = new SportmonksClient(sportmonksToken);
  const resolved = await sportmonks.getFixtureById(smGame.providerFixtureId);
  if (!resolved.fixture) {
    return Response.json({
      ok: false,
      error: "sportmonks_fixture_not_found",
      providerFixtureId: smGame.providerFixtureId,
    }, { status: 404 });
  }

  const quotes = await sportmonks.getThreeWayQuotes(resolved.fixture);
  const marketPrior = aggregateMarketPrior(quotes);
  if (!marketPrior) {
    return Response.json({
      ok: false,
      error: "sportmonks_no_market",
      providerFixtureId: resolved.fixture.providerFixtureId,
      quotes: quotes.length,
    }, { status: 207 });
  }

  const capturedAt = new Date().toISOString();
  const researchCutoffAt = new Date(Date.now() + 100).toISOString();
  const inputs = await loadRoundFixtureCardInputs(
    admin,
    String(round.id),
    researchCutoffAt,
    "api-football",
  );
  const baseInput = inputs.find((input) => input.gameNumber === 1);
  if (!baseInput) {
    return Response.json({ ok: false, error: "fixture_input_missing" }, { status: 500 });
  }

  const marketSnapshotId =
    `shadow:sportmonks:${resolved.fixture.providerFixtureId}:${capturedAt}`;
  const input = {
    ...baseInput,
    prior: {
      type: "market" as const,
      snapshotId: marketSnapshotId,
      capturedAt,
      probabilitiesBp: marketPrior.probabilitiesBp,
    },
  };
  const card = buildKapilotoFixtureCard(input, researchCutoffAt);

  const openai = new OpenAI({ apiKey: openAiKey, maxRetries: 0 });
  const model = getKapilotoOpenAIModel();
  const reasoningEffort = getKapilotoReasoningEffort();

  const research = await researchFixtureWithSol(openai, card, {
    model,
    reasoningEffort,
    searchContextSize: "high",
    maxOutputTokens: KAPILOTO_SOL_DEFAULT_MAX_OUTPUT_TOKENS,
  });

  const groundingRuntime = await groundResearchOutput(
    admin,
    card,
    research.output,
    research.provenance.sourceUrls,
  );

  const judge = createOpenAIEntailmentJudge(openai, {
    model,
    reasoningEffort: "medium",
    maxOutputTokens: KAPILOTO_ENTAILMENT_MAX_OUTPUT_TOKENS,
  });

  const entailment = await verifyRequiredEntailment(
    [{
      fixtureId: baseInput.fixtureId,
      grounding: groundingRuntime.grounding,
    }],
    judge,
  );
  const finalGrounding = entailment.fixtures[0]?.grounding ?? groundingRuntime.grounding;
  const unsupported = entailment.unsupported.filter(
    (item) => item.fixtureId === baseInput.fixtureId,
  );

  const fixtures: MaterializableFixture[] = inputs.map((other) => {
    if (other.gameNumber === 1) {
      return {
        mode: "research" as const,
        gameNumber: 1,
        roundGameId: baseInput.roundGameId,
        fixtureId: baseInput.fixtureId,
        card,
        output: research.output,
        grounding: finalGrounding,
        ...(unsupported.length > 0
          ? { entailment: { unsupported, calls: entailment.calls } }
          : {}),
      };
    }

    return {
      mode: "research_unavailable" as const,
      gameNumber: other.gameNumber,
      roundGameId: other.roundGameId,
      fixtureId: other.fixtureId,
      reason: "missing_prior" as const,
      context: {
        kickoffAt: other.kickoffAt,
        settlementRule: other.settlementRule ?? "90m_plus_stoppage_excludes_extra_time_penalties",
        neutralVenue: other.neutralVenue === true,
      },
      researchCutoffAt,
    };
  });

  const materialized = materializeKapilotoResearchRun(fixtures);
  const finalAnalysis = materialized.analyses.find(
    (analysis) => analysis.fixture_id === baseInput.fixtureId,
  );

  const researchCostMicros = estimateSolUsageCostMicros({
    inputTokens: research.provenance.usage.inputTokens,
    cachedInputTokens: research.provenance.usage.cachedInputTokens,
    outputTokens: research.provenance.usage.outputTokens,
    webSearchCalls: research.provenance.webSearchCalls,
  });

  return Response.json({
    ok: true,
    shadow: true,
    persistedResearchRun: false,
    round: round.external_round_number,
    fixture: {
      gameNumber: 1,
      fixtureId: baseInput.fixtureId,
      roundGameId: baseInput.roundGameId,
      home: baseInput.home.canonicalName,
      away: baseInput.away.canonicalName,
      kickoffAt: baseInput.kickoffAt,
    },
    market: {
      provider: "sportmonks",
      providerFixtureId: resolved.fixture.providerFixtureId,
      bookmakerCount: marketPrior.bookmakerCount,
      method: marketPrior.method,
      degraded: marketPrior.degraded,
      capturedAt,
      probabilitiesBp: marketPrior.probabilitiesBp,
      quoteBookmakers: quotes.map((quote) => quote.bookmakerName),
    },
    fixtureCard: card,
    sol: {
      model: research.provenance.model,
      responseId: research.provenance.responseId,
      usage: research.provenance.usage,
      webSearchCalls: research.provenance.webSearchCalls,
      sourceUrls: research.provenance.sourceUrls,
      estimatedCostMicros: researchCostMicros,
      rawOutput: research.output,
    },
    grounding: {
      accepted: finalGrounding.accepted,
      rejected: finalGrounding.rejected,
      policyFailures: finalGrounding.policyFailures,
      requiresEntailmentVerification: finalGrounding.requiresEntailmentVerification,
      retrievalFailures: groundingRuntime.retrieval.failures,
    },
    entailment: {
      checkedEvidenceCount: entailment.checkedEvidenceCount,
      unsupported: entailment.unsupported,
      downgradedFixtureIds: entailment.downgradedFixtureIds,
      calls: entailment.calls,
    },
    finalAnalysis,
  });
}
