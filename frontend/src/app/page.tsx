import { MarketBoard } from "@/components/landing/MarketBoard";
import { MarketFeed } from "@/components/landing/MarketFeed";
import { REPO, SiteHeader } from "@/components/landing/SiteHeader";
import { StatusPill } from "@/components/landing/StatusPill";
import { ButtonLink } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";

import styles from "./page.module.css";

export default function Landing() {
  return (
    <>
      <SiteHeader />

      <main>
        <MarketFeed>
          <section className={`${styles.wrap} ${styles.hero}`}>
            <div className={styles.heroText}>
              <StatusPill />
              <h1 className={styles.h1}>A real stock exchange for your class.</h1>
              <p className={styles.lede}>
                Most practice apps copy real prices, so your orders never move anything. Ticker runs
                its own exchange. Every price you see comes from students and bots trading with each
                other, so when news breaks, you&apos;re the one who moves the market.
              </p>
              <div className={styles.actions}>
                <ButtonLink href="#market" size="lg">
                  Watch the market
                </ButtonLink>
                <ButtonLink href="#leagues" variant="ghost" size="lg">
                  Start a league
                </ButtonLink>
              </div>
              <span className={`mono ${styles.fine}`}>
                Simulated market, no real money. Pick a stock on the board to see its book.
              </span>
            </div>
            <div id="market" className={styles.board}>
              <Panel label="Market · read only">
                <MarketBoard />
              </Panel>
            </div>
          </section>
        </MarketFeed>

        <section id="how" className={styles.band}>
          <div className={`${styles.wrap} ${styles.section}`}>
            <div className={styles.split}>
              <h2 className={styles.h2}>Your order goes into a real order book.</h2>
              <p className={styles.body}>
                The exchange is written in C++ and matches orders by price, then time, the way real
                stock exchanges do. It matches a typical order in about 143 nanoseconds.
              </p>
            </div>
            <ol className={styles.steps}>
              <li>
                <span className={`mono ${styles.step}`}>01 · You</span>
                <h3>Place an order</h3>
                <p>
                  Market, limit, stop or stop-limit. Ticker checks your buying power and the
                  league&apos;s rules before it goes out.
                </p>
              </li>
              <li>
                <span className={`mono ${styles.step}`}>02 · Exchange</span>
                <h3>It meets the other side</h3>
                <p>
                  Best price first, then whoever was there first. If nobody will sell at your price,
                  your order waits on the book.
                </p>
              </li>
              <li>
                <span className={`mono ${styles.step}`}>03 · Everyone</span>
                <h3>The price moves</h3>
                <p>
                  The trade prints on every screen watching that stock. Bots react, other students
                  react, and the leaderboard updates every second.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section id="leagues" className={`${styles.wrap} ${styles.section} ${styles.feature}`}>
          <div className={styles.featureText}>
            <span className="label">For clubs and classes</span>
            <h2 className={styles.h2}>Run a competition in five minutes.</h2>
            <p className={styles.body}>
              Create a league, share the invite code, and set the rules: start and end dates,
              starting cash, commissions, position limits, which order types are allowed, and
              whether short selling is on.
            </p>
            <ul className={styles.plus}>
              <li>Leaderboard by return or by Sharpe ratio, so steady beats lucky.</li>
              <li>Margin rules for shorts, like a real broker.</li>
              <li>Nobody can trade with themselves to move money between leagues.</li>
            </ul>
          </div>
          <Panel label="Example league rules" className={styles.rules}>
            <dl className={`mono ${styles.ruleList}`}>
              <div>
                <dt>Starting cash</dt>
                <dd>$100,000</dd>
              </div>
              <div>
                <dt>Runs</dt>
                <dd>Mon 9:30 → Fri 16:00</dd>
              </div>
              <div>
                <dt>Commission</dt>
                <dd>$1.00 + 10 bps</dd>
              </div>
              <div>
                <dt>Max position</dt>
                <dd>5,000 shares</dd>
              </div>
              <div>
                <dt>Short selling</dt>
                <dd>On · 150% margin</dd>
              </div>
              <div>
                <dt>Order types</dt>
                <dd>Limit, market, stop</dd>
              </div>
              <div>
                <dt>Ranked by</dt>
                <dd>Sharpe ratio</dd>
              </div>
            </dl>
          </Panel>
        </section>

        <section id="bots" className={styles.band}>
          <div className={`${styles.wrap} ${styles.section} ${styles.feature}`}>
            <Panel label="momentum.py" className={styles.code}>
              <pre className="mono">{`# Buy NOVA when it's up on the day
import requests

api = "https://ticker.example/v1"
auth = {"Authorization": f"Bearer {TOKEN}"}

nova = requests.get(f"{api}/market/NOVA").json()
if nova["last"] > nova["refPrice"]:
    requests.post(f"{api}/orders", headers=auth, json={
        "symbol": "NOVA", "side": "buy",
        "type": "market", "qty": 10,
    })`}</pre>
            </Panel>
            <div className={styles.featureText}>
              <span className="label">For people who code</span>
              <h2 className={styles.h2}>Trade with a script.</h2>
              <p className={styles.body}>
                The same API the app uses is open to you: REST for orders, WebSocket for live prices
                and your fills. Your bot plays by the same rules as everyone else and shows up on
                the same leaderboard.
              </p>
            </div>
          </div>
        </section>

        <section className={`${styles.wrap} ${styles.closer}`}>
          <h2 className={styles.big}>Run your own market.</h2>
          <p className={styles.body}>
            The exchange, the bots and the web app are open source. One clone and a few commands and
            your class has its own market.
          </p>
          <ButtonLink href={REPO} size="lg">
            Get the code
          </ButtonLink>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.wrap} mono ${styles.foot}`}>
          <span>Ticker · a simulated market for learning. No real money, no real companies.</span>
          <a href={REPO}>Source on GitHub</a>
        </div>
      </footer>
    </>
  );
}
