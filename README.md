# FinSight - Stock Data Intelligence Dashboard

FinSight is a production-minded mini financial data platform built for the Jarnox internship assignment.

It collects Indian stock market data, cleans and enriches it with Pandas, stores it in SQLite, exposes REST APIs through FastAPI, and renders a dashboard for quick visual analysis.

## Highlights

- FastAPI backend with Swagger docs
- SQLite persistence with indexed stock-history queries
- Cleaned stock dataset with:
  - daily return
  - 7-day moving average
  - 52-week high and low
- Extra analytics:
  - volatility score
  - momentum score
  - return correlation between two stocks
- Deterministic mock-data fallback when live Yahoo Finance fetches fail
- Lightweight in-memory response caching
- Health and readiness endpoints
- Docker support with container health check
- Basic API regression tests

## Tech Stack

- Python
- FastAPI
- Pandas
- NumPy
- SQLite
- yfinance
- HTML, CSS, JavaScript

## Project Structure

```text
FinSight_Stock_Data_Intelligence_Dashboard/
|
+-- main.py
+-- requirements.txt
+-- README.md
+-- INTERVIEW_NOTES.md
+-- Dockerfile
+-- .dockerignore
+-- .env.example
|
+-- data/
|   +-- stocks.db
|
+-- static/
|   +-- index.html
|   +-- style.css
|   +-- script.js
|
+-- tests/
|   +-- test_api.py
|
+-- screenshots/
```

## Setup

1. Create and activate a virtual environment.

```bash
python -m venv .venv
.venv\Scripts\activate
```

2. Install dependencies.

```bash
pip install -r requirements.txt
```

3. Run the app.

```bash
uvicorn main:app --reload
```

4. Open:

- Dashboard: `http://127.0.0.1:8000`
- Swagger docs: `http://127.0.0.1:8000/docs`

## Environment Configuration

Copy `.env.example` values into your environment if needed.

Supported environment variables:

- `FINSIGHT_APP_NAME`
- `FINSIGHT_APP_VERSION`
- `FINSIGHT_DB_PATH`
- `FINSIGHT_ALLOWED_ORIGINS`
- `FINSIGHT_CACHE_TTL_SECONDS`
- `FINSIGHT_DEFAULT_HISTORY_DAYS`
- `FINSIGHT_REFRESH_PERIOD`
- `FINSIGHT_LOG_LEVEL`

## API Endpoints

### `GET /companies`

Returns available companies, record counts, latest trading date, and source type.

### `GET /data/{symbol}?days=30`

Returns recent stock history. Supports both short and exchange-qualified symbols:

- `INFY`
- `INFY.NS`

### `GET /summary/{symbol}`

Returns:

- latest close
- average close
- 52-week high
- 52-week low
- 7-day moving average
- average daily return
- volatility score
- momentum score
- trend signal
- risk level

### `GET /compare?symbol1=INFY&symbol2=TCS&days=30`

Returns:

- performance percentage for both stocks
- average daily return
- average volume
- volatility and momentum
- aligned return correlation
- winner over the selected period

### `GET /insights/{symbol}`

Returns a natural-language summary built from trend, volatility, and 52-week positioning.

### `GET /gainers-losers?days=30`

Returns top 3 gainers and top 3 losers across tracked companies.

### `POST /refresh`

Refreshes all company data and returns refresh metadata:

- refresh timestamp
- source split between `yfinance` and `mock`
- number of processed symbols

### `GET /health`

Operational health endpoint with:

- app version
- DB path
- cache stats
- stock row count
- last refresh timestamp

### `GET /ready`

Readiness endpoint to verify the app has stock rows loaded.

## Data Preparation Logic

The ingestion pipeline:

- converts dates to `YYYY-MM-DD`
- coerces price and volume fields to numeric values
- drops invalid rows
- sorts rows symbol-wise by date
- computes daily return
- computes the 7-day moving average
- computes rolling volatility
- computes momentum relative to the moving average

## Production-Style Improvements

This version goes beyond a basic assignment submission:

- typed API response models for cleaner Swagger docs
- indexed SQLite queries for faster reads
- metadata table to track refresh timing
- response caching to reduce repeated computation
- graceful fallback from live fetches to mock data
- health and readiness endpoints for deployment checks
- Docker health check
- automated API smoke tests

## Running Tests

```bash
python -m unittest tests/test_api.py
```

## Docker

Build:

```bash
docker build -t finsight-dashboard .
```

Run:

```bash
docker run -p 8000:8000 finsight-dashboard
```

## Important Note on Live Data

The app first tries to fetch real stock data using `yfinance`.

If Yahoo Finance is unavailable because of SSL, connectivity, or rate limits, FinSight automatically falls back to deterministic mock data. This keeps the dashboard, APIs, and evaluator experience fully functional.

## Suggested Submission Checklist

- Ensure the app opens locally on `http://127.0.0.1:8000`
- Verify `/docs` loads
- Run the test file once
- Add dashboard screenshots if you want a stronger GitHub presentation
- Push the final folder to GitHub with clean file structure
