import type { DomainMarket, MarketSource, Sample } from "../../domain.js";
import type { MarketSpec } from "../../assets.js";
import { fixtureMarketSource } from "./fixture.js";
import { liveMarketSource } from "./live.js";
import { isTransportFailure } from "./wire.js";

export function autoMarketSource(opts: {
  slugOverride?: string;
  fixturePath: string;
}): MarketSource {
  const live = liveMarketSource({ slugOverride: opts.slugOverride });
  const fixture = fixtureMarketSource(opts.fixturePath);
  let useFixture = false;

  return {
    async pullActive(spec: MarketSpec): Promise<Sample<DomainMarket>> {
      if (useFixture) return fixture.pullActive(spec);
      try {
        return await live.pullActive(spec);
      } catch (err) {
        if (!isTransportFailure(err)) throw err;
        useFixture = true;
        return fixture.pullActive(spec);
      }
    },
    async pullBySlug(slug: string): Promise<Sample<DomainMarket>> {
      if (useFixture) return fixture.pullActive(fixtureSpec(slug));
      try {
        return await live.pullBySlug!(slug);
      } catch (err) {
        if (!isTransportFailure(err)) throw err;
        useFixture = true;
        return fixture.pullActive(fixtureSpec(slug));
      }
    },
  };
}

/** The fixture source ignores the spec, but still needs one for the call. */
function fixtureSpec(_slug: string): MarketSpec {
  return {
    asset: { id: "btc", symbol: "BTCUSDT", name: "Bitcoin", ticker: "BTC" },
    timeframe: { id: "5m", label: "5m", windowSec: 300, observeSec: 45 },
    key: "btc-5m",
  };
}
