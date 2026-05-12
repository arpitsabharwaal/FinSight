from contextlib import asynccontextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from dataclasses import dataclass
import io
import logging
import os
from pathlib import Path
import sqlite3
from threading import RLock
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

try:
    import yfinance as yf
except Exception:
    yf = None


APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("FINSIGHT_APP_NAME", "FinSight - Stock Data Intelligence API")
    app_version: str = os.getenv("FINSIGHT_APP_VERSION", "1.2.0")
    database_path: Path = Path(os.getenv("FINSIGHT_DB_PATH", str(DATA_DIR / "stocks.db")))
    allowed_origins: List[str] = tuple(
        item.strip()
        for item in os.getenv("FINSIGHT_ALLOWED_ORIGINS", "*").split(",")
        if item.strip()
    )
    cache_ttl_seconds: int = int(os.getenv("FINSIGHT_CACHE_TTL_SECONDS", "120"))
    default_history_days: int = int(os.getenv("FINSIGHT_DEFAULT_HISTORY_DAYS", "420"))
    default_refresh_period: str = os.getenv("FINSIGHT_REFRESH_PERIOD", "18mo")
    log_level: str = os.getenv("FINSIGHT_LOG_LEVEL", "INFO").upper()


settings = Settings()
DB_PATH = settings.database_path

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("finsight")
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

DEFAULT_COMPANIES = {
    "RELIANCE.NS": "Reliance Industries",
    "TCS.NS": "Tata Consultancy Services",
    "INFY.NS": "Infosys",
    "HDFCBANK.NS": "HDFC Bank",
    "ICICIBANK.NS": "ICICI Bank",
    "SBIN.NS": "State Bank of India",
    "ITC.NS": "ITC Limited",
    "LT.NS": "Larsen & Toubro",
}


class ApiErrorResponse(BaseModel):
    detail: str


class CompanyRecord(BaseModel):
    symbol: str
    name: str
    total_records: int
    latest_date: Optional[str] = None
    data_source: str


class HealthResponse(BaseModel):
    status: Literal["ok"]
    app_name: str
    version: str
    database: str
    companies: int
    stock_rows: int
    cache_entries: int
    cache_ttl_seconds: int
    last_refresh_at: Optional[str] = None


class ReadyResponse(BaseModel):
    status: Literal["ready"]
    stock_rows: int
    companies: int


class RefreshResponse(BaseModel):
    message: str
    refreshed_at: str
    sources: Dict[str, int]
    symbols_processed: int


class StockDataPoint(BaseModel):
    symbol: str
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    daily_return: float
    moving_avg_7: float
    volatility_score: float
    momentum_score: float
    data_source: str


class StockDataResponse(BaseModel):
    symbol: str
    company_name: Optional[str] = None
    days: int
    data_source: str
    records: List[StockDataPoint]


class SummaryResponse(BaseModel):
    symbol: str
    company_name: Optional[str] = None
    latest_date: str
    latest_close: float
    average_close: float
    average_daily_return: float
    moving_average_7: float
    volatility_score: float
    momentum_score: float
    trend_signal: Literal["Bullish", "Bearish"]
    risk_level: Literal["Low", "Moderate", "High"]
    data_source: str
    records_analyzed: int
    high_52_week: float = Field(alias="52_week_high")
    low_52_week: float = Field(alias="52_week_low")

    model_config = {"populate_by_name": True}


class InsightResponse(BaseModel):
    symbol: str
    insight: str
    summary: SummaryResponse


class PerformanceSnapshot(BaseModel):
    start_price: float
    end_price: float
    performance_percent: float
    average_daily_return: float
    average_volume: int
    volatility_score: float
    momentum_score: float
    data_source: str
    data: List[StockDataPoint]


class CompareResponse(BaseModel):
    days: int
    symbol1: str
    symbol2: str
    winner: str
    return_correlation: float
    comparison: Dict[str, PerformanceSnapshot]


class LeaderboardEntry(BaseModel):
    symbol: str
    name: str
    start_price: float
    end_price: float
    change_percent: float
    data_source: str


class GainersLosersResponse(BaseModel):
    days: int
    top_gainers: List[LeaderboardEntry]
    top_losers: List[LeaderboardEntry]


class SimpleTTLCache:
    def __init__(self, ttl_seconds: int):
        self.ttl_seconds = ttl_seconds
        self._store: Dict[str, tuple[float, Any]] = {}
        self._lock = RLock()

    def get(self, key: str) -> Any:
        with self._lock:
            cached = self._store.get(key)
            if cached is None:
                return None
            expires_at, value = cached
            if expires_at < time.time():
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> Any:
        with self._lock:
            self._store[key] = (time.time() + self.ttl_seconds, value)
        return value

    def clear(self) -> None:
        with self._lock:
            self._store.clear()

    def stats(self) -> int:
        with self._lock:
            now = time.time()
            expired = [key for key, (expires_at, _) in self._store.items() if expires_at < now]
            for key in expired:
                self._store.pop(key, None)
            return len(self._store)


cache = SimpleTTLCache(settings.cache_ttl_seconds)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS companies (
                symbol TEXT PRIMARY KEY,
                name TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                date TEXT NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume INTEGER NOT NULL,
                daily_return REAL,
                moving_avg_7 REAL,
                volatility_score REAL,
                momentum_score REAL,
                data_source TEXT NOT NULL DEFAULT 'unknown',
                UNIQUE(symbol, date)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS app_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_stock_prices_symbol_date ON stock_prices(symbol, date DESC)"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date DESC)"
        )

        existing_columns = {
            row["name"] for row in cur.execute("PRAGMA table_info(stock_prices)").fetchall()
        }
        if "momentum_score" not in existing_columns:
            cur.execute("ALTER TABLE stock_prices ADD COLUMN momentum_score REAL DEFAULT 0")
        if "data_source" not in existing_columns:
            cur.execute(
                "ALTER TABLE stock_prices ADD COLUMN data_source TEXT NOT NULL DEFAULT 'unknown'"
            )


def set_metadata(key: str, value: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO app_metadata(key, value) VALUES (?, ?)",
            (key, value),
        )


def get_metadata(key: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute("SELECT value FROM app_metadata WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def normalize_symbol(symbol: str) -> str:
    normalized = symbol.upper().strip()
    if "." not in normalized:
        return f"{normalized}.NS"
    return normalized


def add_metrics(frame: pd.DataFrame, source: str) -> pd.DataFrame:
    cleaned = frame.copy()
    cleaned["date"] = pd.to_datetime(cleaned["date"], errors="coerce")

    for column in ["open", "high", "low", "close", "volume"]:
        cleaned[column] = pd.to_numeric(cleaned[column], errors="coerce")

    cleaned = cleaned.dropna(subset=["date", "open", "high", "low", "close"])
    cleaned["volume"] = cleaned["volume"].fillna(0).astype(int)
    cleaned = cleaned.sort_values(["symbol", "date"]).reset_index(drop=True)

    cleaned["daily_return"] = (
        (cleaned["close"] - cleaned["open"]) / cleaned["open"]
    ).replace([np.inf, -np.inf], np.nan)
    cleaned["moving_avg_7"] = cleaned.groupby("symbol")["close"].transform(
        lambda series: series.rolling(window=7, min_periods=1).mean()
    )
    rolling_volatility = cleaned.groupby("symbol")["daily_return"].transform(
        lambda series: series.rolling(window=30, min_periods=7).std()
    )
    cleaned["volatility_score"] = (rolling_volatility * 100).fillna(0)
    cleaned["momentum_score"] = (
        ((cleaned["close"] / cleaned["moving_avg_7"]) - 1) * 100
    ).replace([np.inf, -np.inf], 0)
    cleaned["data_source"] = source
    cleaned["date"] = cleaned["date"].dt.strftime("%Y-%m-%d")

    for column in ["daily_return", "moving_avg_7", "volatility_score", "momentum_score"]:
        cleaned[column] = cleaned[column].fillna(0).round(6)

    for column in ["open", "high", "low", "close"]:
        cleaned[column] = cleaned[column].round(2)

    return cleaned[
        [
            "symbol",
            "date",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "daily_return",
            "moving_avg_7",
            "volatility_score",
            "momentum_score",
            "data_source",
        ]
    ]


def generate_mock_data(symbol: str, days: Optional[int] = None) -> pd.DataFrame:
    seed = abs(hash(symbol)) % (2**32)
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(end=datetime.now().date(), periods=days or settings.default_history_days)

    base_price = rng.uniform(350, 3500)
    trend = rng.normal(0.00045, 0.0002)
    daily_noise = rng.normal(0, 0.018, len(dates))

    prices = [base_price]
    for index in range(1, len(dates)):
        prices.append(max(20, prices[-1] * (1 + trend + daily_noise[index])))

    close_prices = np.array(prices)
    open_prices = close_prices * (1 + rng.normal(0, 0.008, len(close_prices)))
    highs = np.maximum(open_prices, close_prices) * (1 + rng.uniform(0.002, 0.018, len(close_prices)))
    lows = np.minimum(open_prices, close_prices) * (1 - rng.uniform(0.002, 0.018, len(close_prices)))
    volumes = rng.integers(500000, 15000000, len(close_prices))

    frame = pd.DataFrame(
        {
            "symbol": symbol,
            "date": dates,
            "open": open_prices,
            "high": highs,
            "low": lows,
            "close": close_prices,
            "volume": volumes,
        }
    )
    return add_metrics(frame, source="mock")


def fetch_yfinance_data(symbol: str, period: Optional[str] = None) -> Optional[pd.DataFrame]:
    if yf is None:
        return None

    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            history = yf.Ticker(symbol).history(
                period=period or settings.default_refresh_period,
                interval="1d",
            )
        if history.empty:
            return None

        history = history.reset_index().rename(
            columns={
                "Date": "date",
                "Open": "open",
                "High": "high",
                "Low": "low",
                "Close": "close",
                "Volume": "volume",
            }
        )
        history["symbol"] = symbol
        history = history[["symbol", "date", "open", "high", "low", "close", "volume"]]
        return add_metrics(history, source="yfinance")
    except Exception as exc:
        logger.warning("Live fetch failed for %s: %s", symbol, exc)
        return None


def save_company(symbol: str, name: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO companies(symbol, name) VALUES (?, ?)",
            (symbol, name),
        )


def save_prices(frame: pd.DataFrame) -> None:
    rows = [
        (
            row["symbol"],
            row["date"],
            float(row["open"]),
            float(row["high"]),
            float(row["low"]),
            float(row["close"]),
            int(row["volume"]),
            float(row["daily_return"]),
            float(row["moving_avg_7"]),
            float(row["volatility_score"]),
            float(row["momentum_score"]),
            row["data_source"],
        )
        for row in frame.to_dict("records")
    ]
    with get_connection() as conn:
        conn.executemany(
            """
            INSERT OR REPLACE INTO stock_prices
            (symbol, date, open, high, low, close, volume, daily_return, moving_avg_7,
             volatility_score, momentum_score, data_source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def query_df(sql: str, params: tuple = ()) -> pd.DataFrame:
    ensure_seeded()
    with get_connection() as conn:
        return pd.read_sql_query(sql, conn, params=params)


def dataframe_to_records(frame: pd.DataFrame) -> List[Dict[str, Any]]:
    return frame.replace({np.nan: None}).to_dict(orient="records")


def get_company_name(symbol: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute("SELECT name FROM companies WHERE symbol = ?", (symbol,)).fetchone()
    return row["name"] if row else None


def get_stock_row_count() -> int:
    with get_connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS count FROM stock_prices").fetchone()
    return int(row["count"])


def set_cached(key: str, value: Any) -> Any:
    return cache.set(key, value)


def get_symbol_history(symbol: str, limit: int = 260) -> pd.DataFrame:
    cache_key = f"history:{symbol}:{limit}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached.copy()

    frame = query_df(
        """
        SELECT symbol, date, open, high, low, close, volume, daily_return, moving_avg_7,
               volatility_score, momentum_score, data_source
        FROM stock_prices
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        (symbol, limit),
    )
    if frame.empty:
        raise HTTPException(status_code=404, detail=f"No data found for symbol: {symbol}")

    sorted_frame = frame.sort_values("date").reset_index(drop=True)
    return set_cached(cache_key, sorted_frame).copy()


def build_summary(symbol: str) -> Dict[str, Any]:
    cache_key = f"summary:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    history = get_symbol_history(symbol, limit=260)
    latest = history.iloc[-1]

    latest_close = float(latest["close"])
    latest_ma7 = float(latest["moving_avg_7"])
    latest_volatility = float(latest["volatility_score"])
    latest_momentum = float(latest["momentum_score"])

    summary = {
        "symbol": symbol,
        "company_name": get_company_name(symbol),
        "latest_date": latest["date"],
        "latest_close": round(latest_close, 2),
        "average_close": round(float(history["close"].mean()), 2),
        "52_week_high": round(float(history["high"].max()), 2),
        "52_week_low": round(float(history["low"].min()), 2),
        "average_daily_return": round(float(history["daily_return"].mean()), 6),
        "moving_average_7": round(latest_ma7, 2),
        "volatility_score": round(latest_volatility, 4),
        "momentum_score": round(latest_momentum, 4),
        "trend_signal": "Bullish" if latest_close >= latest_ma7 else "Bearish",
        "risk_level": (
            "High" if latest_volatility >= 2.5 else "Moderate" if latest_volatility >= 1.2 else "Low"
        ),
        "data_source": latest["data_source"],
        "records_analyzed": int(len(history)),
    }
    return set_cached(cache_key, summary)


def ensure_seeded(force_refresh: bool = False) -> Dict[str, Any]:
    init_db()

    with get_connection() as conn:
        stock_count = conn.execute("SELECT COUNT(*) AS count FROM stock_prices").fetchone()["count"]
        unknown_source_count = conn.execute(
            "SELECT COUNT(*) AS count FROM stock_prices WHERE data_source = 'unknown'"
        ).fetchone()["count"]

    if stock_count > 0 and unknown_source_count == 0 and not force_refresh:
        if get_metadata("last_refresh_at") is None:
            set_metadata("last_refresh_at", utc_now_iso())
        return {
            "refreshed": False,
            "sources": {},
            "symbols_processed": len(DEFAULT_COMPANIES),
        }

    logger.info("Seeding stock data. force_refresh=%s", force_refresh)
    source_counts = {"yfinance": 0, "mock": 0}

    for symbol, name in DEFAULT_COMPANIES.items():
        save_company(symbol, name)
        frame = fetch_yfinance_data(symbol)
        if frame is None or frame.empty:
            frame = generate_mock_data(symbol)
        source_counts[frame.iloc[-1]["data_source"]] += 1
        save_prices(frame)

    refreshed_at = utc_now_iso()
    set_metadata("last_refresh_at", refreshed_at)
    set_metadata("last_refresh_sources", str(source_counts))
    cache.clear()

    return {
        "refreshed": True,
        "sources": source_counts,
        "symbols_processed": len(DEFAULT_COMPANIES),
        "refreshed_at": refreshed_at,
    }


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_seeded()
    yield


app = FastAPI(
    title=settings.app_name,
    description=(
        "Production-minded mini financial data platform with stock ingestion, analytics, "
        "REST APIs, dashboard visualization, and fallback resilience."
    ),
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception):
    logger.exception("Unhandled application error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(APP_DIR / "static" / "index.html")


@app.get(
    "/health",
    response_model=HealthResponse,
    responses={500: {"model": ApiErrorResponse}},
    tags=["Operations"],
)
def health_check():
    ensure_seeded()
    return {
        "status": "ok",
        "app_name": settings.app_name,
        "version": settings.app_version,
        "database": str(DB_PATH),
        "companies": len(DEFAULT_COMPANIES),
        "stock_rows": get_stock_row_count(),
        "cache_entries": cache.stats(),
        "cache_ttl_seconds": settings.cache_ttl_seconds,
        "last_refresh_at": get_metadata("last_refresh_at"),
    }


@app.get("/ready", response_model=ReadyResponse, tags=["Operations"])
def readiness_check():
    ensure_seeded()
    stock_rows = get_stock_row_count()
    if stock_rows == 0:
        raise HTTPException(status_code=503, detail="Application is not ready yet.")
    return {
        "status": "ready",
        "stock_rows": stock_rows,
        "companies": len(DEFAULT_COMPANIES),
    }


@app.get("/companies", response_model=List[CompanyRecord], tags=["Market Data"])
def get_companies():
    cache_key = "companies"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    frame = query_df(
        """
        SELECT c.symbol,
               c.name,
               COUNT(p.id) AS total_records,
               MAX(p.date) AS latest_date,
               COALESCE(MAX(p.data_source), 'unknown') AS data_source
        FROM companies c
        LEFT JOIN stock_prices p ON c.symbol = p.symbol
        GROUP BY c.symbol, c.name
        ORDER BY c.name
        """
    )
    return set_cached(cache_key, dataframe_to_records(frame))


@app.post("/refresh", response_model=RefreshResponse, tags=["Operations"])
def refresh_data():
    refresh_result = ensure_seeded(force_refresh=True)
    return {
        "message": "Stock data refreshed successfully.",
        "refreshed_at": refresh_result.get("refreshed_at", utc_now_iso()),
        "sources": refresh_result["sources"],
        "symbols_processed": refresh_result["symbols_processed"],
    }


@app.get("/data/{symbol}", response_model=StockDataResponse, tags=["Market Data"])
def get_stock_data(symbol: str, days: int = Query(30, ge=7, le=420)):
    normalized_symbol = normalize_symbol(symbol)
    frame = get_symbol_history(normalized_symbol, limit=days)

    return {
        "symbol": normalized_symbol,
        "company_name": get_company_name(normalized_symbol),
        "days": days,
        "data_source": frame.iloc[-1]["data_source"],
        "records": dataframe_to_records(frame),
    }


@app.get("/summary/{symbol}", response_model=SummaryResponse, tags=["Analytics"])
def get_summary(symbol: str):
    return build_summary(normalize_symbol(symbol))


@app.get("/compare", response_model=CompareResponse, tags=["Analytics"])
def compare_stocks(
    symbol1: str = Query(..., description="First stock symbol, e.g. INFY or INFY.NS"),
    symbol2: str = Query(..., description="Second stock symbol, e.g. TCS or TCS.NS"),
    days: int = Query(30, ge=7, le=260),
):
    first_symbol = normalize_symbol(symbol1)
    second_symbol = normalize_symbol(symbol2)
    cache_key = f"compare:{first_symbol}:{second_symbol}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    first_history = get_symbol_history(first_symbol, limit=days)
    second_history = get_symbol_history(second_symbol, limit=days)

    def summarize_performance(frame: pd.DataFrame) -> Dict[str, Any]:
        start_price = float(frame.iloc[0]["close"])
        end_price = float(frame.iloc[-1]["close"])
        performance = ((end_price - start_price) / start_price) * 100
        return {
            "start_price": round(start_price, 2),
            "end_price": round(end_price, 2),
            "performance_percent": round(performance, 2),
            "average_daily_return": round(float(frame["daily_return"].mean()), 6),
            "average_volume": int(frame["volume"].mean()),
            "volatility_score": round(float(frame["volatility_score"].iloc[-1]), 4),
            "momentum_score": round(float(frame["momentum_score"].iloc[-1]), 4),
            "data_source": frame.iloc[-1]["data_source"],
            "data": dataframe_to_records(frame),
        }

    merged = first_history[["date", "daily_return"]].merge(
        second_history[["date", "daily_return"]],
        on="date",
        suffixes=("_1", "_2"),
    )

    correlation = 0.0
    if len(merged) >= 2:
        value = merged["daily_return_1"].corr(merged["daily_return_2"])
        if pd.notna(value):
            correlation = float(value)

    comparison = {
        first_symbol: summarize_performance(first_history),
        second_symbol: summarize_performance(second_history),
    }
    winner = (
        first_symbol
        if comparison[first_symbol]["performance_percent"] >= comparison[second_symbol]["performance_percent"]
        else second_symbol
    )

    payload = {
        "days": days,
        "symbol1": first_symbol,
        "symbol2": second_symbol,
        "winner": winner,
        "return_correlation": round(correlation, 4),
        "comparison": comparison,
    }
    return set_cached(cache_key, payload)


@app.get("/insights/{symbol}", response_model=InsightResponse, tags=["Analytics"])
def generate_insight(symbol: str):
    normalized_symbol = normalize_symbol(symbol)
    cache_key = f"insight:{normalized_symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    summary = build_summary(normalized_symbol)

    latest_close = summary["latest_close"]
    high_52 = summary["52_week_high"]
    low_52 = summary["52_week_low"]
    volatility = summary["volatility_score"]
    momentum = summary["momentum_score"]

    distance_from_high = ((high_52 - latest_close) / high_52) * 100 if high_52 else 0
    distance_from_low = ((latest_close - low_52) / low_52) * 100 if low_52 else 0

    trend_text = (
        "short-term momentum remains constructive because price is holding above the 7-day average"
        if summary["trend_signal"] == "Bullish"
        else "near-term momentum is soft because price is trading below the 7-day average"
    )

    if momentum >= 2:
        momentum_text = "The momentum score suggests buyers have been in control recently."
    elif momentum <= -2:
        momentum_text = "The momentum score suggests recent selling pressure."
    else:
        momentum_text = "The momentum score is close to neutral, so the move is not overstretched."

    payload = {
        "symbol": summary["symbol"],
        "insight": (
            f"{summary['symbol']} is showing a {summary['trend_signal'].lower()} setup with a "
            f"{summary['risk_level'].lower()} risk profile. The latest close sits "
            f"{round(distance_from_high, 2)}% below the 52-week high and "
            f"{round(distance_from_low, 2)}% above the 52-week low. Recent volatility is "
            f"{round(volatility, 2)}, and {trend_text}. {momentum_text}"
        ),
        "summary": summary,
    }
    return set_cached(cache_key, payload)


@app.get("/gainers-losers", response_model=GainersLosersResponse, tags=["Analytics"])
def get_gainers_losers(days: int = Query(30, ge=7, le=90)):
    cache_key = f"gainers-losers:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    companies = query_df("SELECT symbol, name FROM companies ORDER BY name")
    rows = []

    for _, company in companies.iterrows():
        history = get_symbol_history(company["symbol"], limit=days)
        if len(history) < 2:
            continue

        start_price = float(history.iloc[0]["close"])
        end_price = float(history.iloc[-1]["close"])
        change_percent = ((end_price - start_price) / start_price) * 100
        rows.append(
            {
                "symbol": company["symbol"],
                "name": company["name"],
                "start_price": round(start_price, 2),
                "end_price": round(end_price, 2),
                "change_percent": round(change_percent, 2),
                "data_source": history.iloc[-1]["data_source"],
            }
        )

    rows.sort(key=lambda row: row["change_percent"], reverse=True)
    payload = {
        "days": days,
        "top_gainers": rows[:3],
        "top_losers": rows[-3:][::-1],
    }
    return set_cached(cache_key, payload)


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
