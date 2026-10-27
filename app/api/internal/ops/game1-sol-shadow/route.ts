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
import type { BookmakerThreeWayQuote } from "@/lib/providers/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  if (process.env.VERCEL_ENV !== "preview") {
    return Response.json({ ok: false, error: "preview_only" }, { status: 403 });
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openAiKey) {
    return Response.json({
      ok: false,
      error: "OPENAI_API_KEY_missing",
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

  const capturedAt = new Date().toISOString();
  const quotes: BookmakerThreeWayQuote[] = [
    {
      provider: "sportmonks",
      providerFixtureId: "manual-web-264301-1",
      bookmakerId: "sportsbet",
      bookmakerName: "Sportsbet",
      capturedAt,
      odds: { home: 1.99, draw: 3.60, away: 2.85 },
    },
    {
      provider: "sportmonks",
      providerFixtureId: "manual-web-264301-1",
      bookmakerId: "meridian",
      bookmakerName: "Meridian",
      capturedAt,
      odds: { home: 2.00, draw: 3.35, away: 3.05 },
    },
  ];
  const marketPrior = aggregateMarketPrior(quotes);
  if (!marketPrior) {
    throw new Error("Manual live market quotes did not produce a market prior.");
  }


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
    `shadow:live-web-market:264301:1:${capturedAt}`;
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
      provider: "manual_live_web_quotes",
      bookmakerCount: marketPrior.bookmakerCount,
      method: marketPrior.method,
      degraded: marketPrior.degraded,
      capturedAt,
      probabilitiesBp: marketPrior.probabilitiesBp,
      quotes: quotes.map((quote) => ({
        bookmaker: quote.bookmakerName,
        odds: quote.odds,
      })),
      sourceUrls: [
        "https://www.sportsbet.com.au/betting/soccer/rest-of-europe/israeli-premier-league/hapoel-tel-aviv-v-maccabi-haifa-11102665",
        "https://meridianbet.rs/sr/kladjenje/fudbal/izrael/liga-haal/hapoel-tel-aviv-fc-maccabi-haifa-fc/19964352",
      ],
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
