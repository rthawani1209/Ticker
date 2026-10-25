from .base import Bot, Context
from .market_maker import MarketMaker
from .momentum import Momentum
from .news_trader import NewsTrader
from .noise import Noise

KINDS = {cls.kind: cls for cls in (MarketMaker, Momentum, Noise, NewsTrader)}

__all__ = ["Bot", "Context", "KINDS", "MarketMaker", "Momentum", "NewsTrader", "Noise"]
