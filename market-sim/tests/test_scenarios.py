import pytest

from ticker_sim.scenarios import ScenarioError, available, load, parse


@pytest.mark.parametrize("name", available())
def test_every_scenario_loads(name):
    sc = load(name)
    assert sc.description
    assert [e.at for e in sc.events] == sorted(e.at for e in sc.events)


def test_there_are_a_few_cases():
    assert {"calm", "flash-crash", "earnings-season"} <= set(available())


def test_bad_scenarios_are_rejected():
    with pytest.raises(ScenarioError):
        parse({"events": [{"at": 1, "type": "news", "symbol": "NOPE", "kind": "fraud"}]})
    with pytest.raises(ScenarioError):
        parse({"events": [{"at": 1, "type": "news", "symbol": "NOVA", "kind": "aliens"}]})
    with pytest.raises(ScenarioError):
        parse({"events": [{"at": 1, "type": "volcano"}]})
    with pytest.raises(TypeError):
        parse({"bots": {"wizards": 3}})
