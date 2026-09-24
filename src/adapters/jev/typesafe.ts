import { TypeSafeClient, choice, type EntryType } from "@typesafe-ai/sdk";
import {
  parseConfidence,
  type FactsForJev,
  type Judge,
  type JudgeOpinion,
  type Side,
} from "../../domain.js";

function directionQuestion(facts: FactsForJev): string {
  const asset = facts.market.assetName ?? facts.asset.symbol;
  const tf = facts.market.timeframeId ?? facts.session.windowLengthSec + "s";
  const a = facts.analysis;
  return [
    `This is a Polymarket ${asset} Up/Down ${tf} contract.`,
    `Resolution is the exchange oracle reference (window open) vs close, not share odds.`,
    "UP wins if the close reference >= the open reference. DOWN otherwise. Winning shares pay $1, losers $0.",
    "Rules-based pre-analysis (momentum/volatility/drift) has ALREADY been run; treat it as a prior, not the answer.",
    `analysis: fairUP=${a.fairUp.toFixed(3)} bias=${a.bias} momentum=${a.momentumBps.toFixed(1)}bps windowMove=${a.windowMoveBps.toFixed(1)}bps vol=${a.volatilityPct.toFixed(3)}% held=${a.trendHeldSec}s skip=[${a.skip.join(",")}].`,
    "Return calibrated P(UP) and P(DOWN) for THIS window using seconds remaining, asset.moveVsWindowOpenPct and the analysis block.",
    "If session.position.kind is open, judge whether THAT side still resolves winner.",
    "Market mids are trader opinions, not the oracle. Prefer the price path vs the window open over 24h change.",
    "Treat UP and DOWN symmetrically. If there is no edge, say so with confidence near 0.5.",
  ].join(" ");
}

export function typeSafeJudge(opts: {
  apiKey: string;
  model: "jev-1.13.0";
}): Judge {
  if (!opts.apiKey) {
    throw new Error("TYPESAFE_API_KEY missing — refuse silent stub");
  }
  const client = new TypeSafeClient({ apiKey: opts.apiKey });

  return {
    async ask(facts: FactsForJev): Promise<JudgeOpinion> {
      const asset = facts.market.assetName ?? "the asset";
      const result = await client.systemOne({
        state: facts as unknown as EntryType,
        model: opts.model,
        questions: {
          direction: choice(directionQuestion(facts), {
            UP: `${asset} finishes UP vs the window open`,
            DOWN: `${asset} finishes DOWN vs the window open`,
          }),
        },
      });

      const answer = result.answers.direction;
      const side = answer.choice as Side;
      if (side !== "UP" && side !== "DOWN") {
        throw new Error(`unexpected Jev choice: ${String(answer.choice)}`);
      }
      const confidence = parseConfidence(answer.confidence);
      if (!confidence) {
        throw new Error(`invalid Jev confidence: ${answer.confidence}`);
      }
      const probs = {
        UP: Number(answer.probabilities.UP),
        DOWN: Number(answer.probabilities.DOWN),
      };
      return { side, confidence, probs };
    },
  };
}
