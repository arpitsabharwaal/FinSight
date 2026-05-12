# Interview Notes — FinSight Stock Data Intelligence Dashboard

## 1. Tell me about this project.

FinSight is a mini stock data intelligence platform. It collects stock price data, cleans it using Pandas, stores it in SQLite, exposes REST APIs using FastAPI, and visualizes insights in a simple dashboard.

I built APIs for companies, recent stock data, stock summary, stock comparison, top gainers and losers, and AI-style insights.

---

## 2. Why did you use FastAPI?

I used FastAPI because it is modern, fast, easy to structure, and automatically provides Swagger API documentation. This makes it easier for evaluators to test endpoints directly from `/docs`.

---

## 3. Why did you use SQLite?

SQLite is lightweight and simple for a mini assignment. It does not require server setup like PostgreSQL, so the evaluator can run the project quickly on any system.

---

## 4. How did you collect stock data?

The project uses `yfinance` to fetch stock market data for Indian NSE symbols like `INFY.NS`, `TCS.NS`, and `RELIANCE.NS`.

If live data fetching fails, the project generates realistic mock data so the project still works.

---

## 5. What data cleaning did you perform?

I converted date columns into proper date format, handled missing values, converted numeric columns like open, high, low, close and volume, sorted records date-wise, and calculated additional metrics using Pandas.

---

## 6. What is Daily Return?

Daily Return measures intraday stock movement.

Formula:

```txt
Daily Return = (Close - Open) / Open
```

If daily return is positive, the stock closed higher than it opened. If it is negative, the stock closed lower than it opened.

---

## 7. What is a Moving Average?

A moving average smooths price movement over a fixed period.

In this project, I used 7-day moving average to show short-term trend direction.

If latest close is above the 7-day moving average, I mark it as bullish. If below, I mark it as bearish.

---

## 8. What is 52-week high and low?

52-week high is the highest price reached by a stock in approximately the last one trading year. 52-week low is the lowest price in the same period.

It helps understand whether a stock is near its yearly peak or bottom.

---

## 9. What is Volatility Score?

Volatility score is my custom metric. It is based on the rolling standard deviation of daily returns.

Higher volatility means the stock price is moving more aggressively and risk is higher.

---

## 10. How does the compare API work?

The compare API accepts two stock symbols and a time period. It calculates start price and end price for both stocks and then calculates performance percentage.

Formula:

```txt
Performance = ((End Price - Start Price) / Start Price) * 100
```

The stock with higher performance is returned as the winner.

---

## 11. How does the AI-style insight work?

It is rule-based. It checks trend signal, volatility score, distance from 52-week high and low, and generates a human-readable insight.

I called it AI-style because it summarizes analytics like an assistant, but it is deterministic and explainable.

---

## 12. Did you use AI tools?

Yes, I used AI tools for guidance, productivity and debugging support. But I understood the code, customized the logic, tested APIs, improved the UI, and documented the project myself.

The assignment itself allowed tools like ChatGPT or Copilot, so I focused on building a clean, working and well-explained solution.

---

## 13. What would you improve next?

I would add:
- Candlestick charts
- News sentiment analysis
- Portfolio tracking
- ML-based prediction
- Docker deployment
- Authentication
- More advanced caching
