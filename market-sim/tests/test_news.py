import random

import pytest

from ticker_sim.news import BY_KIND, TEMPLATES, NewsEngine, impacts
from ticker_sim.symbols import BY_NAME, SYMBOLS


def test_rate_is_about_right():
    eng = NewsEngine(random.Random(5), per_minute=2.0)
    items = [i for t in range(36_000) for i in eng.tick(t * 0.05, 0.05)]  # 30 minutes
    assert 35 < len(items) < 90


def test_same_seed_same_news():
    a = NewsEngine(random.Random(9), per_minute=5.0)
    b = NewsEngine(random.Random(9), per_minute=5.0)
    run = lambda e: [(i.kind, i.symbol, i.impact_bps) for t in range(10_000) for i in e.tick(t * 0.05, 0.05)]
    assert run(a) == run(b)


def test_sector_specific_templates_only_hit_their_sector():
    eng = NewsEngine(random.Random(1), per_minute=600.0, macro_share=0.0)
    for t in range(5000):
        for item in eng.tick(t * 0.05, 0.05):
            tpl = BY_KIND[item.kind]
            assert not tpl.sectors or SYMBOLS[item.symbol].sector in tpl.sectors
            assert tpl.weight > 0  # scripted-only kinds never come up at random


@pytest.mark.parametrize("tpl", TEMPLATES, ids=lambda t: t.kind)
def test_impact_sign_matches_the_headline(tpl):
    lo, hi = tpl.impact_bps
    assert lo <= hi and (lo > 0) == (hi > 0)


def test_macro_news_moves_every_stock_by_sector():
    eng = NewsEngine(random.Random(1))
    item = eng.macro_news(0.0, "rate_hike")
    moves = impacts(item)
    assert len(moves) == len(SYMBOLS)
    assert moves[BY_NAME["BRKL"].id] > 0  # banks like higher rates
    assert moves[BY_NAME["NOVA"].id] < moves[BY_NAME["VYNE"].id] < 0  # tech hurt most


def test_scripted_company_news_uses_given_values():
    eng = NewsEngine(random.Random(1))
    item = eng.company_news(3.0, BY_NAME["ORBT"], BY_KIND["fraud"], -2800, scripted=True)
    assert item.impact_bps == -2800 and item.scripted
    assert "Orbit Launch Systems" in item.headline
    assert item.to_json()["ticker"] == "ORBT"
