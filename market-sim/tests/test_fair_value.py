import random

import numpy as np
import pytest

from ticker_sim.fair_value import FairValue
from ticker_sim.symbols import SYMBOLS


def returns(fv: FairValue, steps: int, dt: float) -> np.ndarray:
    out = np.empty((steps, len(SYMBOLS)))
    for i in range(steps):
        before = fv.values.copy()
        fv.step(dt)
        out[i] = np.log(fv.values / before)
    return out


def test_same_seed_same_path():
    a, b = FairValue(random.Random(7)), FairValue(random.Random(7))
    for _ in range(100):
        a.step(1.0)
        b.step(1.0)
    assert np.array_equal(a.values, b.values)


def test_volatility_and_correlation_match_the_settings():
    fv = FairValue(random.Random(3), vol_bps_per_min=30.0, market_corr=0.3)
    r = returns(fv, 20_000, dt=1.0)
    expected_sigma = 30 / 10_000 * np.sqrt(1 / 60)
    assert r.std(axis=0) == pytest.approx(np.full(len(SYMBOLS), expected_sigma), rel=0.05)
    corr = np.corrcoef(r.T)
    off_diagonal = corr[~np.eye(len(SYMBOLS), dtype=bool)]
    assert off_diagonal.mean() == pytest.approx(0.3, abs=0.03)


def test_zero_correlation_means_independent_walks():
    r = returns(FairValue(random.Random(4), market_corr=0.0), 20_000, dt=1.0)
    off_diagonal = np.corrcoef(r.T)[~np.eye(len(SYMBOLS), dtype=bool)]
    assert abs(off_diagonal.mean()) < 0.03


def test_jumps_and_steps_stay_inside_the_bounds():
    fv = FairValue(random.Random(5), vol_bps_per_min=5_000.0)
    fv.jump(0, -99_999)
    assert fv[0] == pytest.approx(SYMBOLS[0].ref_price * 0.1)
    fv.jump(1, 1_000_000)
    assert fv[1] == pytest.approx(min(SYMBOLS[1].ref_price * 10.0, 60_000.0))
    for _ in range(500):
        fv.step(60.0)
    assert np.all(fv.values >= fv.floor) and np.all(fv.values <= fv.cap)


def test_rejects_bad_correlation():
    with pytest.raises(ValueError):
        FairValue(random.Random(1), market_corr=1.0)
