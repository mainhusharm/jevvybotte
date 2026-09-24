import { composeFacts, assetDisplayName } from "./compose.js";
import {
  resolveWinner,
  secondsRemaining,
  shouldCloseWindow,
  windowHasEnded,
  effectiveEndsAt,
} from "./adapters/polymarket/wire.js";
import { appendPnL, markUnrealizedUsd, readSummary, settlePnLUsd } from "./pnl/ledger.js";
import { planTrade, planWindowEndExit } from "./policy.js";
import { rankCandidates, type MarketFeed, type ScanOpts } from "./scanner.js";
import {
  activeSlugForSpec,
  parseUpDownSlug,
  specForSlug,
  windowStartSec,
  type MarketSpec,
} from "./assets.js";
import {
  nowIso,
  type ActorHealth,
  type DomainMarket,
  type FactsForJev,
  type IntendedOrder,
  type JudgeOpinion,
  type PnLRecord,
  type Position,
  type Sample,
  type ScanCandidate,
  type SessionConfig,
  type SpotPulse,
  type StrategyAnalysis,
  type TickSnapshot,
  type TradeAction,
  type WindowPhase,
} from "./domain.js";
import { summarizeAction, TraceRing, voiceLine } from "./trace.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Multi-market session.
 *
 * Every tick it scans all enabled asset x timeframe windows, ranks them by the
 * rules-based analysis edge, and trades the single best opportunity (analyze →
 * JEV → policy). One position at a time; held to resolution or take-profit.
 */
export class WindowSession {
  private readonly cfg: SessionConfig;
  private readonly feeds: MarketFeed[];
  private readonly trace = new TraceRing();
  private tickId = 0;
  private phase: WindowPhase = "awaiting_window";
  private position: Position = { kind: "flat" };
  /** Slug of the window we are currently in (traded or being evaluated). */
  private activeSlug: string | null = null;
  private heldSpecKey: string | null = null;
  /** Last market sample for the window we are trading (settle after rollover). */
  private heldMarket: DomainMarket | null = null;
  /** Window-open reference captured when the traded window started. */
  private heldWindowOpen: number | null = null;
  private readonly windowOpenBySpec = new Map<string, number>();
  private readonly entersBySlug = new Map<string, number>();
  private lastOrder: IntendedOrder | null = null;
  private intentLog: IntendedOrder[] = [];
  private lastPnL: PnLRecord | null = null;
  /** Settled trades this session (newest last), for order-result lookup. */
  private readonly pnlHistory: PnLRecord[] = [];
  private cumulativePnLUsd = 0;
  /** cumulativePnLUsd at boot, so the UI can show session-only PnL. */
  private startCumulativePnLUsd = 0;
  private lastAnalysis: StrategyAnalysis | null = null;
  private lastCandidates: ScanCandidate[] = [];
  private lastFacts: FactsForJev | null = null;
  private lastOpinion: JudgeOpinion | null = null;
  private stopLoop: (() => void) | null = null;

  private constructor(cfg: SessionConfig) {
    this.cfg = cfg;
    this.feeds = cfg.specs.map((spec) => ({
      spec,
      market: null,
      spot: null,
      marketHealth: { ok: true },
      spotHealth: { ok: true },
    }));
  }

  static async open(cfg: SessionConfig): Promise<WindowSession> {
    const session = new WindowSession(cfg);
    const summary = await readSummary(cfg.pnlPath);
    session.cumulativePnLUsd = summary.cumulativeUsd;
    session.startCumulativePnLUsd = summary.cumulativeUsd;
    session.lastPnL = summary.last;
    session.trace.pushActivity({
      channel: "sys",
      op: "boot",
      detail: `live=${cfg.liveTrading} specs=${cfg.specs.map((s) => s.key).join(",")} threshold=${cfg.threshold} betUsd=${cfg.betUsd}`,
      ok: true,
    });
    return session;
  }

  /** Alias kept for callers that still import WatchSession. */
  static async openWatch(cfg: SessionConfig): Promise<WindowSession> {
    return WindowSession.open(cfg);
  }

  async tick(): Promise<TickSnapshot> {
    this.tickId += 1;
    const at = nowIso();
    const nowMs = Date.now();
    this.trace.pushActivity({
      channel: "sys",
      op: "tick",
      detail: `#${this.tickId} phase=${this.phase}`,
      ok: true,
      at,
    });

    await this.refreshAll(nowMs);

    const scanOpts = this.scanOpts();
    const candidates = rankCandidates(this.feeds, nowMs, scanOpts);
    this.lastCandidates = candidates;

    if (this.position.kind === "open") {
      return this.tickOpen(at, nowMs, candidates);
    }

    const best = candidates.find((c) => c.eligible);
    if (!best) {
      this.phase = "awaiting_window";
      this.lastAnalysis = candidates[0]?.analysis ?? null;
      this.lastFacts = null;
      this.lastOpinion = null;
      const detail =
        candidates.length === 0
          ? "no live windows scanned yet"
          : `no eligible window · best ${candidates[0]!.specKey} ${(candidates[0]!.edge * 100).toFixed(1)}c edge [${candidates[0]!.reasons.join(",")}]`;
      return this.snapshot(
        at,
        null,
        null,
        { kind: "ABSTAIN", reason: { code: "AWAITING_WINDOW", detail } },
        null,
      );
    }
    return this.tickEntry(at, nowMs, best);
  }

  run(onSnap: (s: TickSnapshot) => void): { stop: () => void } {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const snap = await this.tick();
          if (!stopped) onSnap(snap);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.trace.pushActivity({
            channel: "sys",
            op: "tick_error",
            detail: message.slice(0, 80),
            ok: false,
          });
          onSnap(
            this.snapshot(
              nowIso(),
              null,
              null,
              {
                kind: "ABSTAIN",
                reason: { code: "JUDGE_FAILED", message },
              },
              null,
            ),
          );
        }
        if (stopped) break;
        await sleep(this.cfg.tickMs);
      }
    };
    void loop();
    const stop = () => {
      stopped = true;
    };
    this.stopLoop = stop;
    return { stop };
  }

  async close(): Promise<void> {
    this.stopLoop?.();
    this.stopLoop = null;
    this.trace.pushActivity({
      channel: "sys",
      op: "shutdown",
      detail: "operator quit",
      ok: true,
    });
  }

  private scanOpts(): ScanOpts {
    return {
      analysis: {
        observeSec: 0,
        minVolPct: this.cfg.minVolPct,
        requireTrendHeldSec: this.cfg.requireTrendHeldSec,
        chopBps: 5,
      },
      maxAsk: this.cfg.maxAsk,
      maxSpread: this.cfg.maxSpread,
      minEdge: this.cfg.minEdge,
      enforceStrategy: this.cfg.enforceStrategy,
    };
  }

  private feedByKey(key: string): MarketFeed | null {
    return this.feeds.find((f) => f.spec.key === key) ?? null;
  }

  private feedForSlug(slug: string): MarketFeed | null {
    const spec = specForSlug(this.cfg.specs, slug);
    if (spec) {
      const byKey = this.feedByKey(spec.key);
      if (byKey) return byKey;
    }
    return (
      this.feeds.find((f) => f.market?.value.eventSlug === slug) ?? null
    );
  }

  private async tickEntry(
    at: ReturnType<typeof nowIso>,
    nowMs: number,
    best: ScanCandidate,
  ): Promise<TickSnapshot> {
    const feed = this.feedByKey(best.specKey);
    if (!feed?.market || !feed.spot) {
      return this.snapshot(
        at,
        null,
        null,
        {
          kind: "ABSTAIN",
          reason: {
            code: "WORLD_INCOMPLETE",
            missing: ["market", "spot"],
          },
        },
        null,
      );
    }

    const marketSample = feed.market;
    const market = marketSample.value;
    const fallbackOpen =
      this.windowOpenBySpec.get(feed.spec.key) ??
      feed.spot.value.windowOpen ??
      feed.spot.value.last;
    this.windowOpenBySpec.set(feed.spec.key, fallbackOpen);

    this.lastAnalysis = best.analysis;
    this.lastOpinion = null;

    const composed = composeFacts(
      marketSample,
      feed.spot,
      at,
      this.cfg.staleAfterMs,
      this.position,
      feed.spec.timeframe.windowSec,
      best.analysis,
      fallbackOpen,
    );
    if (!composed.ok) {
      this.lastFacts = null;
      return this.snapshot(
        at,
        null,
        null,
        {
          kind: "ABSTAIN",
          reason: { code: "STALE_INPUTS", detail: composed.detail },
        },
        secondsRemaining(effectiveEndsAt(market), at),
      );
    }
    this.lastFacts = composed.facts;

    let opinion: JudgeOpinion;
    try {
      opinion = await this.trace.timed(
        "jev",
        "ask",
        () => this.cfg.judge.ask(composed.facts),
        (o) => `${o.side} conf=${o.confidence.toFixed(3)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastOpinion = null;
      return this.snapshot(
        at,
        composed.facts,
        null,
        {
          kind: "ABSTAIN",
          reason: { code: "JUDGE_FAILED", message },
        },
        secondsRemaining(effectiveEndsAt(market), at),
      );
    }
    this.lastOpinion = opinion;

    const rem = secondsRemaining(effectiveEndsAt(market), at);
    const entersThisWindow = this.entersBySlug.get(market.eventSlug) ?? 0;
    const action = planTrade(this.position, opinion, market, at, {
      threshold: this.cfg.threshold,
      betUsd: this.cfg.betUsd,
      maxAsk: this.cfg.maxAsk,
      maxSpread: this.cfg.maxSpread,
      minEdge: this.cfg.minEdge,
      minSecondsToEnter: this.cfg.minSecondsToEnter,
      secondsRemaining: rem,
      maxEntersPerWindow: this.cfg.maxEntersPerWindow,
      entersThisWindow,
      analysis: best.analysis,
      enforceStrategy: this.cfg.enforceStrategy,
      requireBiasAgreement: this.cfg.requireBiasAgreement,
      bankrollUsd: this.cfg.bankrollUsd,
      kellyFraction: this.cfg.kellyFraction,
      takeProfitPrice: this.cfg.takeProfitPrice,
    });
    this.trace.pushActivity({
      channel: "policy",
      op: "planTrade",
      detail: `${feed.spec.key} ${summarizeAction(action).summary}`,
      ok: true,
    });

    this.activeSlug = market.eventSlug;
    this.heldSpecKey = feed.spec.key;
    this.heldMarket = market;
    this.phase = "trading";

    await this.execute(action, market, at);
    if (this.position.kind === "open") {
      this.heldWindowOpen = fallbackOpen;
      this.entersBySlug.set(
        market.eventSlug,
        (this.entersBySlug.get(market.eventSlug) ?? 0) + 1,
      );
    }
    this.trace.pushActivity({
      channel: "sys",
      op: "window_open",
      detail: `${feed.spec.key} ${market.eventSlug} open=${fallbackOpen}`,
      ok: true,
    });
    return this.snapshot(at, composed.facts, opinion, action, rem);
  }

  private async tickOpen(
    at: ReturnType<typeof nowIso>,
    nowMs: number,
    candidates: ScanCandidate[],
  ): Promise<TickSnapshot> {
    const openPosition = this.position;
    if (openPosition.kind !== "open") {
      return this.snapshot(
        at,
        null,
        this.lastOpinion,
        { kind: "ABSTAIN", reason: { code: "AWAITING_WINDOW", detail: "flat" } },
        null,
      );
    }
    void candidates;

    const feed = this.feedForSlug(openPosition.slug);
    const expectedSlug = feed ? activeSlugForSpec(feed.spec, nowMs) : null;
    const market = feed?.market?.value ?? null;

    if (market && shouldCloseWindow({
      activeSlug: openPosition.slug,
      expectedSlug,
      position: this.position,
      market,
      now: at,
    })) {
      this.trace.pushActivity({
        channel: "sys",
        op: "window_close",
        detail: `held=${openPosition.slug} feed=${market.eventSlug}`,
        ok: true,
      });
      this.phase = "settling";
      return this.settle(at);
    }

    // Still inside the window: ask JEV on the held side, hold or take profit.
    if (feed?.market && feed.spot) {
      const analysis =
        candidates.find((c) => c.slug === openPosition.slug)?.analysis ??
        this.lastAnalysis;
      const composed = composeFacts(
        feed.market,
        feed.spot,
        at,
        this.cfg.staleAfterMs,
        this.position,
        feed.spec.timeframe.windowSec,
        analysis ?? emptyAnalysis(feed.spec),
        this.heldWindowOpen,
      );
      if (composed.ok) {
        this.lastFacts = composed.facts;
        let opinion: JudgeOpinion | null = null;
        try {
          opinion = await this.trace.timed(
            "jev",
            "ask",
            () => this.cfg.judge.ask(composed.facts),
            (o) => `${o.side} conf=${o.confidence.toFixed(3)}`,
          );
        } catch {
          opinion = null;
        }
        if (opinion) {
          this.lastOpinion = opinion;
          const rem = secondsRemaining(effectiveEndsAt(feed.market.value), at);
          const action = planTrade(this.position, opinion, feed.market.value, at, {
            threshold: this.cfg.threshold,
            betUsd: this.cfg.betUsd,
            maxAsk: this.cfg.maxAsk,
            maxSpread: this.cfg.maxSpread,
            minEdge: this.cfg.minEdge,
            minSecondsToEnter: this.cfg.minSecondsToEnter,
            secondsRemaining: rem,
            maxEntersPerWindow: this.cfg.maxEntersPerWindow,
            entersThisWindow: this.entersBySlug.get(openPosition.slug) ?? 0,
            analysis: analysis ?? undefined,
            enforceStrategy: false,
            requireBiasAgreement: false,
            bankrollUsd: this.cfg.bankrollUsd,
            kellyFraction: this.cfg.kellyFraction,
            takeProfitPrice: this.cfg.takeProfitPrice,
          });
          if (action.kind === "EXIT") {
            this.trace.pushActivity({
              channel: "policy",
              op: "take_profit",
              detail: `${feed.spec.key} ${summarizeAction(action).summary}`,
              ok: true,
            });
            const mkt = feed.market.value;
            // execute() books the realized take-profit when it flattens us.
            await this.execute(action, mkt, at);
            return this.snapshot(at, composed.facts, opinion, action, rem);
          }
          this.lastAnalysis = analysis ?? this.lastAnalysis;
          return this.snapshot(at, composed.facts, opinion, action, rem);
        }
      }
    }

    // Missing feed (rolled off the active slug list): hold until the clock ends.
    const action: TradeAction = {
      kind: "HOLD",
      side: openPosition.side,
      confidence: (this.lastOpinion?.confidence ?? 0.5) as JudgeOpinion["confidence"],
      why: `HOLD ${openPosition.side} · ${openPosition.slug} (awaiting settle)`,
    };
    return this.snapshot(at, null, this.lastOpinion, action, null);
  }

  /** Resolve the DomainMarket that matches an open position's slug. */
  private async marketForSettle(
    openSlug: string,
    feed: DomainMarket | null,
  ): Promise<DomainMarket | null> {
    if (feed && feed.eventSlug === openSlug) return feed;
    if (this.heldMarket?.eventSlug === openSlug) {
      if (this.cfg.polymarket.pullBySlug) {
        try {
          const sample = await this.trace.timed(
            "gamma",
            "pullBySlug",
            () => this.cfg.polymarket.pullBySlug!(openSlug),
            (s) =>
              `${s.value.closed ? "closed" : "open"} winner? prices=${JSON.stringify(s.value.outcomePrices)}`,
          );
          this.heldMarket = sample.value;
          return sample.value;
        } catch {
          return this.heldMarket;
        }
      }
      return this.heldMarket;
    }
    if (this.cfg.polymarket.pullBySlug) {
      try {
        const sample = await this.cfg.polymarket.pullBySlug(openSlug);
        this.heldMarket = sample.value;
        return sample.value;
      } catch {
        /* fall through */
      }
    }
    return this.heldMarket ?? feed;
  }

  private async settle(at: ReturnType<typeof nowIso>): Promise<TickSnapshot> {
    const openBefore = this.position;
    let action: TradeAction = {
      kind: "ABSTAIN",
      reason: { code: "SETTLING", detail: "flat — nothing to settle" },
    };

    if (openBefore.kind === "open") {
      const feedMarket =
        this.feedForSlug(openBefore.slug)?.market?.value ?? null;
      const settleMkt = await this.marketForSettle(openBefore.slug, feedMarket);
      if (settleMkt) {
        const winner = resolveWinner(settleMkt);
        this.trace.pushActivity({
          channel: "sys",
          op: "settle",
          detail: `slug=${openBefore.slug} winner=${winner ?? "unknown"} closed=${settleMkt.closed}`,
          ok: true,
        });

        if (winner != null) {
          const exitPrice = openBefore.side === winner ? 1 : 0;
          await this.bookRealized({
            slug: openBefore.slug,
            at,
            side: openBefore.side,
            entryPrice: openBefore.entryPrice,
            exitPrice,
            size: openBefore.size,
            winner,
            reason: "settle",
          });
          this.position = { kind: "flat" };
          action = {
            kind: "ABSTAIN",
            reason: {
              code: "SETTLING",
              detail: `settled ${openBefore.side} → winner ${winner} @$${exitPrice}`,
            },
          };
        } else {
          action = planWindowEndExit(openBefore, settleMkt, at);
          const bookDead = settleMkt.closed || windowHasEnded(settleMkt, at);
          if (bookDead && action.kind === "EXIT") {
            await this.bookRealized({
              slug: openBefore.slug,
              at,
              side: openBefore.side,
              entryPrice: openBefore.entryPrice,
              exitPrice: action.order.price,
              size: openBefore.size,
              winner: null,
              reason: "window_end",
            });
            this.position = { kind: "flat" };
            this.trace.pushActivity({
              channel: "sys",
              op: "force_flat",
              detail: `closed book — marked exit @${action.order.price}`,
              ok: true,
            });
          } else {
            await this.execute(action, settleMkt, at);
          }
        }
      }
    }

    this.phase = "recorded";
    this.position = { kind: "flat" };
    this.activeSlug = null;
    this.heldSpecKey = null;
    this.heldMarket = null;
    this.heldWindowOpen = null;
    this.phase = "awaiting_window";
    return this.snapshot(at, null, this.lastOpinion, action, null);
  }

  private async bookRealized(args: {
    slug: string;
    at: ReturnType<typeof nowIso>;
    side: import("./domain.js").Side;
    entryPrice: number;
    exitPrice: number;
    size: number;
    winner: import("./domain.js").Side | null;
    reason: PnLRecord["reason"];
  }): Promise<void> {
    const pnlUsd = settlePnLUsd({
      positionSide: args.side,
      winner: args.winner,
      entryPrice: args.entryPrice,
      size: args.size,
      exitPrice: args.exitPrice,
    });
    const spec = specForSlug(this.cfg.specs, args.slug);
    const record: PnLRecord = {
      slug: args.slug,
      settledAt: args.at,
      winner: args.winner,
      positionSide: args.side,
      entryPrice: args.entryPrice,
      exitPrice: args.exitPrice,
      size: args.size,
      pnlUsd,
      mode: this.cfg.liveTrading ? "live" : "dry-run",
      reason: args.reason,
      ...(spec
        ? { assetId: spec.asset.id, timeframeId: spec.timeframe.id }
        : {}),
    };
    await this.trace.timed(
      "pnl",
      "append",
      async () => {
        await appendPnL(record, this.cfg.pnlPath);
      },
      () => `${args.reason} pnl=$${pnlUsd.toFixed(2)}`,
    );
    this.lastPnL = record;
    this.pnlHistory.push(record);
    if (this.pnlHistory.length > 40) this.pnlHistory.shift();
    this.cumulativePnLUsd += pnlUsd;
  }

  private async execute(
    action: TradeAction,
    market: DomainMarket,
    at: ReturnType<typeof nowIso>,
  ): Promise<void> {
    const openBefore = this.position;

    const channel = this.cfg.liveTrading ? "clob" : "policy";
    const result = await this.trace.timed(
      channel,
      this.cfg.liveTrading ? "live.apply" : "dry.apply",
      () => this.cfg.executor.apply(this.position, action, market, at),
      (r) =>
        r.orders.length === 0
          ? "no-op"
          : r.orders.map((o) => `${o.side} ${o.outcome}`).join(","),
    );

    if (openBefore.kind === "open" && result.position.kind === "flat") {
      const exitOrder =
        action.kind === "EXIT"
          ? result.orders[0]
          : action.kind === "SWITCH"
            ? result.orders[0]
            : null;
      if (exitOrder) {
        await this.bookRealized({
          slug: market.eventSlug,
          at,
          side: openBefore.side,
          entryPrice: openBefore.entryPrice,
          exitPrice: exitOrder.price,
          size: openBefore.size,
          winner: null,
          reason:
            action.kind === "SWITCH"
              ? "switch"
              : action.kind === "EXIT" && action.reason === "window_end"
                ? "window_end"
                : action.kind === "EXIT" && action.reason === "confidence_floor"
                  ? "confidence_floor"
                  : action.kind === "EXIT" && action.reason === "take_profit"
                    ? "take_profit"
                    : "exit",
        });
      }
    }

    this.position = result.position;
    for (const order of result.orders) {
      await this.cfg.pen.record(order);
      this.lastOrder = order;
      this.intentLog.push(order);
      if (this.intentLog.length > 50) this.intentLog.shift();
    }
  }

  private async refreshAll(nowMs: number): Promise<void> {
    await Promise.all(this.feeds.map((feed) => this.refreshFeed(feed, nowMs)));
  }

  private async refreshFeed(feed: MarketFeed, nowMs: number): Promise<void> {
    const windowStart = windowStartSec(nowMs, feed.spec.timeframe.windowSec);
    const [marketR, spotR] = await Promise.allSettled([
      this.trace.timed(
        "gamma",
        "pullActive",
        () => this.cfg.polymarket.pullActive(feed.spec),
        (s) => `${s.source} ${s.value.eventSlug}`,
      ),
      this.trace.timed(
        "binance",
        "pullPulse",
        () =>
          this.cfg.spot.pullPulse(feed.spec.asset.symbol, {
            windowStartSec: windowStart,
          }),
        (s) => `${s.source} ${s.value.symbol} $${s.value.last}`,
      ),
    ]);

    if (marketR.status === "fulfilled") {
      feed.market = marketR.value;
      feed.marketHealth = { ok: true };
      const open =
        feed.spot?.value.windowOpen ??
        feed.spot?.value.last ??
        null;
      if (open != null && !this.windowOpenBySpec.has(feed.spec.key)) {
        this.windowOpenBySpec.set(feed.spec.key, open);
      }
    } else {
      feed.market = null;
      feed.marketHealth = {
        ok: false,
        code: "transport",
        detail:
          marketR.reason instanceof Error
            ? marketR.reason.message
            : String(marketR.reason),
      };
    }

    if (spotR.status === "fulfilled") {
      feed.spot = spotR.value;
      feed.spotHealth = { ok: true };
      if (
        spotR.value.value.windowOpen != null &&
        spotR.value.value.windowOpen > 0
      ) {
        this.windowOpenBySpec.set(
          feed.spec.key,
          spotR.value.value.windowOpen,
        );
      }
    } else {
      feed.spot = null;
      feed.spotHealth = {
        ok: false,
        code: "transport",
        detail:
          spotR.reason instanceof Error
            ? spotR.reason.message
            : String(spotR.reason),
      };
    }
  }

  private intentTail(): ReadonlyArray<IntendedOrder> {
    if (this.cfg.pen.tail) return this.cfg.pen.tail(12);
    return this.intentLog.slice(-12);
  }

  private focusFeed(): MarketFeed | null {
    if (this.position.kind === "open") {
      const bySlug = this.feedForSlug(this.position.slug);
      if (bySlug) return bySlug;
    }
    const bestKey = this.lastCandidates[0]?.specKey ?? null;
    if (bestKey) {
      const f = this.feedByKey(bestKey);
      if (f) return f;
    }
    return this.feeds.find((f) => f.spec.key === this.heldSpecKey) ?? this.feeds[0] ?? null;
  }

  private snapshot(
    at: ReturnType<typeof nowIso>,
    facts: FactsForJev | null,
    opinion: JudgeOpinion | null,
    action: TradeAction,
    secondsRem: number | null | undefined,
  ): TickSnapshot {
    const feed = this.focusFeed();
    const m = feed?.market ?? null;
    const s = feed?.spot ?? null;
    const rem =
      secondsRem !== undefined
        ? secondsRem
        : m
          ? secondsRemaining(effectiveEndsAt(m.value), at)
          : null;

    const sum = summarizeAction(action);
    this.trace.pushDecision({
      at,
      tickId: this.tickId,
      kind: sum.kind,
      summary: sum.summary,
      conf: sum.conf,
      side: sum.side,
      marketSlug: m?.value.eventSlug,
      assetId: m?.value.assetId ?? feed?.spec.asset.id ?? undefined,
      timeframeId: m?.value.timeframeId ?? feed?.spec.timeframe.id ?? undefined,
    });

    const voice = voiceLine(action, opinion, this.cfg.threshold);

    return {
      tickId: this.tickId,
      at,
      phase: this.phase,
      secondsRemaining: rem,
      position: this.position,
      action,
      market: m
        ? {
            slug: m.value.eventSlug,
            question: m.value.question,
            assetId: m.value.assetId,
            assetName: assetDisplayName(m.value.assetId),
            ticker: feed?.spec.asset.ticker ?? null,
            timeframeId: m.value.timeframeId,
            windowSec: m.value.windowSec,
            upMid: m.value.bySide.UP.mid,
            downMid: m.value.bySide.DOWN.mid,
            upBid: m.value.bySide.UP.bestBid,
            upAsk: m.value.bySide.UP.bestAsk,
            downBid: m.value.bySide.DOWN.bestBid,
            downAsk: m.value.bySide.DOWN.bestAsk,
            upSpread: m.value.bySide.UP.spread,
            downSpread: m.value.bySide.DOWN.spread,
            volume24hUsd: m.value.volume24hUsd,
            closed: m.value.closed,
            active: m.value.active,
            source: m.source,
            conditionId: m.value.conditionId,
          }
        : null,
      btc: s
        ? {
            last: s.value.last,
            change24hPct: s.value.change24hPct,
            high24h: s.value.high24h,
            low24h: s.value.low24h,
            volume24hQuote: s.value.volume24hQuote,
            moveVsWindowOpenPct: s.value.moveVsWindowOpenPct,
            source: s.source,
          }
        : null,
      health: {
        market: feed?.marketHealth ?? { ok: false, code: "empty", detail: "no feed" },
        spot: feed?.spotHealth ?? { ok: false, code: "empty", detail: "no feed" },
      },
      factsPreview: facts,
      analysis: this.lastAnalysis ?? this.lastCandidates[0]?.analysis ?? null,
      candidates: this.lastCandidates.slice(0, 12),
      opinion,
      lastOrder: this.lastOrder,
      intentLogTail: this.intentTail(),
      lastPnL: this.lastPnL,
      recentPnL: this.pnlHistory.slice(),
      sessionPnLUsd: this.cumulativePnLUsd - this.startCumulativePnLUsd,
      cumulativePnLUsd: this.cumulativePnLUsd,
      unrealizedPnLUsd: markUnrealizedUsd(this.position, m?.value ?? null),
      decisionLog: this.trace.decisions.slice(),
      activityLog: this.trace.activity.slice(),
      tickMs: this.cfg.tickMs,
      voice,
    };
  }
}

function emptyAnalysis(spec: MarketSpec): StrategyAnalysis {
  return {
    assetId: spec.asset.id,
    timeframeId: spec.timeframe.id,
    elapsedSec: 0,
    momentumBps: 0,
    windowMoveBps: 0,
    volatilityPct: 0,
    trendHeldSec: 0,
    fairUp: 0.5,
    bias: "NEUTRAL",
    biasStrength: 0,
    skip: [],
    notes: "no analysis",
  };
}

/** @deprecated Use WindowSession */
export const WatchSession = WindowSession;
