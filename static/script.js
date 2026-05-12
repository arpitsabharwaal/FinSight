let companies = [];
let selectedSymbol = null;
let scannerPayload = null;
let activeScannerTab = "breakout";

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "API request failed");
  }
  return response.json();
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return "Rs. " + Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(digits);
}

function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(digits)}%`;
}

function labelForSource(source) {
  if (!source) return "--";
  return source === "yfinance" ? "Live data" : "Mock fallback";
}

function toneClass(value, neutralBand = 0.1) {
  const numeric = Number(value);
  if (numeric > neutralBand) return "positive";
  if (numeric < -neutralBand) return "negative";
  return "neutral";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDistanceFromHigh(summary) {
  return summary?.["52_week_high"] ? ((summary["52_week_high"] - summary.latest_close) / summary["52_week_high"]) * 100 : 0;
}

function getDistanceFromLow(summary) {
  return summary?.["52_week_low"] ? ((summary.latest_close - summary["52_week_low"]) / summary["52_week_low"]) * 100 : 0;
}

function calculateCompositeConfidence(summary, records) {
  const latestRecord = records.at(-1);
  const sessionReturn = Number(latestRecord?.daily_return || 0) * 100;
  const momentum = Number(summary.momentum_score || 0);
  const volatilityPenalty = Math.min(Number(summary.volatility_score || 0) * 6, 30);
  const trendBonus = summary.trend_signal === "Bullish" ? 14 : 4;
  const sessionBonus = clamp(sessionReturn + 4, 0, 10);
  return clamp(45 + momentum * 4 + trendBonus + sessionBonus - volatilityPenalty, 8, 98);
}

function buildSelectedNarrative(summary, records) {
  const firstClose = Number(records[0]?.close || 0);
  const lastClose = Number(records.at(-1)?.close || 0);
  const periodPerformance = firstClose ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const performanceLabel = periodPerformance >= 0 ? "advanced" : "slipped";
  return `Over the selected window, the stock has ${performanceLabel} ${formatPct(Math.abs(periodPerformance))} while carrying a ${summary.risk_level.toLowerCase()} risk profile.`;
}

function buildThesisTags(summary, records) {
  const tags = [];
  const latest = records.at(-1);
  const periodPerformance = records.length > 1
    ? ((Number(records.at(-1).close) - Number(records[0].close)) / Number(records[0].close)) * 100
    : 0;

  tags.push(summary.trend_signal === "Bullish" ? "Trend above moving average" : "Trend below moving average");
  tags.push(Number(summary.volatility_score) >= 2 ? "High volatility regime" : "Controlled volatility");
  tags.push(Number(summary.momentum_score) >= 0 ? "Positive momentum bias" : "Momentum cooling");
  tags.push(periodPerformance >= 0 ? "Period performance positive" : "Period performance negative");
  if (latest) tags.push(Number(latest.daily_return) >= 0 ? "Latest session finished green" : "Latest session finished red");
  return tags;
}

async function loadCompanies() {
  companies = await api("/companies");
  renderCompanies(companies);
  fillCompareSelects();
  await Promise.allSettled([loadMarketPulse(), loadScanner()]);
  if (companies.length) await selectCompany(companies[0].symbol);
}

async function loadMarketPulse() {
  try {
    const pulse = await api(`/market-pulse?days=${Math.max(30, Number($("daysSelect").value))}`);
    $("pulseBreadth").textContent = `${pulse.bullish_count}/${pulse.bearish_count + pulse.bullish_count} bullish`;
    $("pulseMomentum").textContent = formatPct(pulse.avg_momentum_score);
    $("pulseLeader").textContent = pulse.high_conviction_idea.replace(".NS", "");
    $("pulseCompounder").textContent = pulse.quiet_compounder.replace(".NS", "");
  } catch (_) {
    $("pulseBreadth").textContent = "Unavailable";
    $("pulseMomentum").textContent = "--";
    $("pulseLeader").textContent = "Retry later";
    $("pulseCompounder").textContent = "Retry later";
  }
}

async function loadScanner() {
  try {
    scannerPayload = await api(`/scanner?days=${Math.max(30, Number($("daysSelect").value))}`);
    renderScannerTab(activeScannerTab);
  } catch (_) {
    scannerPayload = null;
    $("scannerList").innerHTML = `
      <div class="scanner-entry">
        <strong>Scanner temporarily unavailable</strong>
        <p class="scanner-thesis">The core dashboard is still live. Try refreshing to reload breakout, momentum, defensive, and reversal ideas.</p>
      </div>
    `;
  }
}

function renderCompanies(list) {
  const box = $("companyList");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="company-item">No companies match your search.</div>';
    return;
  }

  list.forEach((company) => {
    const item = document.createElement("div");
    item.className = `company-item ${company.symbol === selectedSymbol ? "active" : ""}`;
    item.innerHTML = `
      <strong>${company.name}</strong>
      <span>${company.symbol}</span>
      <small>${company.total_records} records | ${labelForSource(company.data_source)}</small>
    `;
    item.onclick = () => selectCompany(company.symbol);
    box.appendChild(item);
  });
}

function fillCompareSelects() {
  const firstSelect = $("compareA");
  const secondSelect = $("compareB");
  firstSelect.innerHTML = "";
  secondSelect.innerHTML = "";
  companies.forEach((company) => {
    const optionA = document.createElement("option");
    optionA.value = company.symbol;
    optionA.textContent = company.symbol;
    firstSelect.appendChild(optionA);
    const optionB = document.createElement("option");
    optionB.value = company.symbol;
    optionB.textContent = company.symbol;
    secondSelect.appendChild(optionB);
  });
  if (companies.length > 1) secondSelect.selectedIndex = 1;
}

async function selectCompany(symbol) {
  selectedSymbol = symbol;
  const company = companies.find((entry) => entry.symbol === symbol);
  $("selectedTitle").textContent = company ? company.name : symbol;
  renderCompanies(filterCompanies());

  const [summaryResult, chartResult, insightResult, forecastResult] = await Promise.allSettled([
    api(`/summary/${symbol}`),
    api(`/data/${symbol}?days=${$("daysSelect").value}`),
    api(`/insights/${symbol}`),
    api(`/forecast/${symbol}?horizon=5`),
  ]);

  if (summaryResult.status !== "fulfilled") {
    throw summaryResult.reason;
  }
  if (chartResult.status !== "fulfilled") {
    throw chartResult.reason;
  }
  if (insightResult.status !== "fulfilled") {
    throw insightResult.reason;
  }

  const summary = summaryResult.value;
  const chartData = chartResult.value;
  const insight = insightResult.value;

  updateSummary(summary, chartData.records);
  updateInsight(insight, summary, chartData.records);
  drawPriceChart(chartData.records);
  if (forecastResult.status === "fulfilled") {
    drawForecastChart(forecastResult.value);
  } else {
    drawForecastFallback();
  }
  $("selectedMeta").textContent = `${summary.symbol} | ${summary.records_analyzed} sessions analyzed | ${labelForSource(summary.data_source)} | latest print on ${summary.latest_date}`;
  await loadGainersLosers();
}

function setBar(id, value) {
  $(id).style.width = `${clamp(value, 0, 100)}%`;
}

function updateSummary(summary, records) {
  const latestRecord = records.at(-1);
  const sessionReturn = Number(latestRecord?.daily_return || 0) * 100;
  const distanceFromHigh = getDistanceFromHigh(summary);
  const distanceFromLow = getDistanceFromLow(summary);
  const composite = calculateCompositeConfidence(summary, records);
  const rangePosition = clamp(((summary.latest_close - summary["52_week_low"]) / Math.max(1, summary["52_week_high"] - summary["52_week_low"])) * 100, 0, 100);

  $("latestClose").textContent = formatMoney(summary.latest_close);
  $("closeNarrative").textContent = buildSelectedNarrative(summary, records);
  $("sessionReturn").textContent = formatPct(sessionReturn);
  $("sessionReturn").className = toneClass(sessionReturn);
  $("sessionNarrative").textContent = "Open-to-close movement for the latest trading session.";
  $("rangePosition").textContent = `${formatNumber(rangePosition, 0)}% of yearly band`;
  $("range52").textContent = `High ${formatMoney(summary["52_week_high"])} | Low ${formatMoney(summary["52_week_low"])}`;
  $("riskTrend").textContent = `${summary.trend_signal} / ${summary.risk_level}`;
  $("dataSource").textContent = `${labelForSource(summary.data_source)} | ${summary.company_name || summary.symbol}`;
  $("trendPill").textContent = summary.trend_signal;
  $("trendPill").className = `signal-pill ${summary.trend_signal === "Bullish" ? "positive" : "negative"}`;
  $("movingAverage").textContent = formatMoney(summary.moving_average_7);
  $("averageClose").textContent = formatMoney(summary.average_close);
  $("volatilityScore").textContent = formatNumber(summary.volatility_score);
  $("momentumScore").textContent = formatPct(summary.momentum_score);
  $("distanceHigh").textContent = formatPct(distanceFromHigh);
  $("distanceLow").textContent = formatPct(distanceFromLow);
  $("confidenceScore").textContent = `${formatNumber(composite, 0)}/100`;

  setBar("momentumBar", clamp((Number(summary.momentum_score) + 8) * 6.25, 4, 100));
  setBar("volatilityBar", clamp(Number(summary.volatility_score) * 22, 4, 100));
  setBar("distanceHighBar", clamp(100 - distanceFromHigh, 4, 100));
  setBar("distanceLowBar", clamp(distanceFromLow / 1.5, 4, 100));
}

function updateInsight(payload, summary, records) {
  $("insightText").textContent = payload.insight;
  $("thesisTags").innerHTML = buildThesisTags(summary, records).map((tag) => `<span>${tag}</span>`).join("");
}

function drawPriceChart(records) {
  const svg = $("priceChart");
  svg.innerHTML = "";
  if (!records.length) return;

  const width = 920;
  const height = 380;
  const pad = 54;
  const closeValues = records.map((row) => Number(row.close));
  const maValues = records.map((row) => Number(row.moving_avg_7));
  const allValues = [...closeValues, ...maValues];
  const min = Math.min(...allValues) * 0.98;
  const max = Math.max(...allValues) * 1.02;

  const x = (index) => pad + (index * (width - pad * 2)) / Math.max(1, records.length - 1);
  const y = (value) => height - pad - ((value - min) * (height - pad * 2)) / Math.max(1, max - min);
  const pathFor = (values) => values.map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`).join(" ");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="rgba(46,196,141,0.32)" /><stop offset="100%" stop-color="rgba(46,196,141,0.02)" /></linearGradient>`;
  svg.appendChild(defs);

  for (let index = 0; index <= 4; index += 1) {
    const gridY = pad + index * ((height - pad * 2) / 4);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", pad);
    line.setAttribute("x2", width - pad);
    line.setAttribute("y1", gridY);
    line.setAttribute("y2", gridY);
    line.setAttribute("stroke", "rgba(255,255,255,0.08)");
    svg.appendChild(line);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", 6);
    label.setAttribute("y", gridY + 4);
    label.setAttribute("fill", "rgba(156,167,181,0.9)");
    label.setAttribute("font-size", "11");
    label.textContent = formatMoney(max - ((max - min) * index) / 4).replace("Rs. ", "");
    svg.appendChild(label);
  }

  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  area.setAttribute("d", `${pathFor(closeValues)} L ${x(records.length - 1)} ${height - pad} L ${x(0)} ${height - pad} Z`);
  area.setAttribute("fill", "url(#chartArea)");
  svg.appendChild(area);

  const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  closePath.setAttribute("d", pathFor(closeValues));
  closePath.setAttribute("fill", "none");
  closePath.setAttribute("stroke", "#2ec48d");
  closePath.setAttribute("stroke-width", "4");
  closePath.setAttribute("stroke-linecap", "round");
  closePath.setAttribute("stroke-linejoin", "round");
  svg.appendChild(closePath);

  const maPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  maPath.setAttribute("d", pathFor(maValues));
  maPath.setAttribute("fill", "none");
  maPath.setAttribute("stroke", "#d8a545");
  maPath.setAttribute("stroke-width", "2.8");
  maPath.setAttribute("stroke-dasharray", "10 8");
  maPath.setAttribute("stroke-linecap", "round");
  maPath.setAttribute("stroke-linejoin", "round");
  svg.appendChild(maPath);
}

function drawForecastChart(forecast) {
  $("forecastConfidence").textContent = forecast.confidence_label;
  $("forecastCurrent").textContent = formatMoney(forecast.current_close);
  $("forecastBasis").textContent = forecast.forecast_basis;

  const svg = $("forecastChart");
  svg.innerHTML = "";
  const points = forecast.points || [];
  if (!points.length) return;

  const width = 520;
  const height = 260;
  const pad = 36;
  const allValues = [
    forecast.current_close,
    ...points.map((point) => point.projected_close),
    ...points.map((point) => point.bull_case),
    ...points.map((point) => point.bear_case),
  ];
  const min = Math.min(...allValues) * 0.98;
  const max = Math.max(...allValues) * 1.02;

  const fullSeries = [{ day: 0, projected_close: forecast.current_close, bull_case: forecast.current_close, bear_case: forecast.current_close }, ...points];
  const x = (index) => pad + (index * (width - pad * 2)) / Math.max(1, fullSeries.length - 1);
  const y = (value) => height - pad - ((value - min) * (height - pad * 2)) / Math.max(1, max - min);

  const areaPointsTop = fullSeries.map((point, index) => `${x(index)},${y(point.bull_case)}`).join(" ");
  const areaPointsBottom = [...fullSeries].reverse().map((point, index) => {
    const actualIndex = fullSeries.length - 1 - index;
    return `${x(actualIndex)},${y(point.bear_case)}`;
  }).join(" ");

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", `${areaPointsTop} ${areaPointsBottom}`);
  polygon.setAttribute("fill", "rgba(216,165,69,0.18)");
  svg.appendChild(polygon);

  const basePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  basePath.setAttribute("d", fullSeries.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.projected_close)}`).join(" "));
  basePath.setAttribute("fill", "none");
  basePath.setAttribute("stroke", "#2ec48d");
  basePath.setAttribute("stroke-width", "3.5");
  basePath.setAttribute("stroke-linecap", "round");
  svg.appendChild(basePath);

  fullSeries.forEach((point, index) => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", x(index));
    circle.setAttribute("cy", y(point.projected_close));
    circle.setAttribute("r", index === 0 ? "5" : "4");
    circle.setAttribute("fill", index === 0 ? "#f3efe7" : "#2ec48d");
    svg.appendChild(circle);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x(index) - 8);
    label.setAttribute("y", height - 8);
    label.setAttribute("fill", "rgba(156,167,181,0.9)");
    label.setAttribute("font-size", "11");
    label.textContent = `D${point.day}`;
    svg.appendChild(label);
  });
}

function drawForecastFallback() {
  $("forecastConfidence").textContent = "Unavailable";
  $("forecastCurrent").textContent = "--";
  $("forecastBasis").textContent = "Forecast service is temporarily unavailable. Core stock analytics are still available.";
  $("forecastChart").innerHTML = "";
}

function renderScannerTab(tabName) {
  activeScannerTab = tabName;
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });

  if (!scannerPayload) {
    $("scannerList").innerHTML = "";
    return;
  }

  const mapping = {
    breakout: scannerPayload.breakout_candidates,
    momentum: scannerPayload.momentum_leaders,
    defensive: scannerPayload.defensive_compounders,
    reversal: scannerPayload.reversal_watchlist,
  };

  const rows = mapping[tabName] || [];
  $("scannerList").innerHTML = rows.map((row) => `
    <div class="scanner-entry">
      <div class="scanner-topline">
        <div>
          <span>${row.company_name}</span>
          <strong>${row.symbol}</strong>
        </div>
        <strong class="${toneClass(row.period_return_percent)}">${formatPct(row.period_return_percent)}</strong>
      </div>
      <div class="scanner-metrics">
        <span>Momentum ${formatPct(row.momentum_score)}</span>
        <span>Volatility ${formatNumber(row.volatility_score)}</span>
        <span>Risk ${row.risk_level}</span>
        <span>Score ${formatNumber(row.composite_score, 0)}</span>
      </div>
      <p class="scanner-thesis">${row.thesis}</p>
    </div>
  `).join("");
}

async function compareStocks() {
  const first = $("compareA").value;
  const second = $("compareB").value;
  if (!first || !second || first === second) {
    $("compareResult").textContent = "Please choose two different stocks.";
    return;
  }

  const payload = await api(`/compare?symbol1=${first}&symbol2=${second}&days=${$("daysSelect").value}`);
  const a = payload.comparison[first];
  const b = payload.comparison[second];

  $("compareResult").innerHTML = `
    <div class="duel-grid">
      <div class="duel-card">
        <span>${first}</span>
        <strong class="${toneClass(a.performance_percent)}">${formatPct(a.performance_percent)}</strong>
        <small>Momentum ${formatPct(a.momentum_score)} | Volatility ${formatNumber(a.volatility_score)}</small>
      </div>
      <div class="duel-card">
        <span>${second}</span>
        <strong class="${toneClass(b.performance_percent)}">${formatPct(b.performance_percent)}</strong>
        <small>Momentum ${formatPct(b.momentum_score)} | Volatility ${formatNumber(b.volatility_score)}</small>
      </div>
    </div>
    <div class="duel-badge">
      <span>Winner over ${$("daysSelect").value} days</span>
      <strong>${payload.winner}</strong>
      <small>Return correlation: <span class="${toneClass(payload.return_correlation, 0.05)}">${formatNumber(payload.return_correlation, 4)}</span></small>
    </div>
  `;
}

async function loadGainersLosers() {
  const days = Math.min(Number($("daysSelect").value), 90);
  const payload = await api(`/gainers-losers?days=${days}`);

  const renderRows = (id, rows) => {
    $(id).innerHTML = rows.map((row, index) => `
      <div class="rank-row">
        <div>
          <strong>#${index + 1} ${row.symbol}</strong>
          <small>${row.name}</small>
        </div>
        <strong class="${toneClass(row.change_percent)}">${formatPct(row.change_percent)}</strong>
      </div>
    `).join("");
  };

  renderRows("gainersList", payload.top_gainers);
  renderRows("losersList", payload.top_losers);
}

function filterCompanies() {
  const query = $("searchInput").value.toLowerCase().trim();
  if (!query) return companies;
  return companies.filter((company) =>
    company.symbol.toLowerCase().includes(query) ||
    company.name.toLowerCase().includes(query)
  );
}

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => renderScannerTab(button.dataset.tab));
});

$("searchInput").addEventListener("input", () => renderCompanies(filterCompanies()));
$("daysSelect").addEventListener("change", async () => {
  await Promise.allSettled([loadMarketPulse(), loadScanner()]);
  if (selectedSymbol) await selectCompany(selectedSymbol);
});
$("compareBtn").addEventListener("click", compareStocks);
$("refreshBtn").addEventListener("click", async () => {
  $("refreshBtn").textContent = "Refreshing...";
  $("refreshBtn").disabled = true;
  try {
    await api("/refresh", { method: "POST" });
    await loadCompanies();
  } catch (error) {
    alert(error.message);
  } finally {
    $("refreshBtn").textContent = "Refresh Data";
    $("refreshBtn").disabled = false;
  }
});

loadCompanies().catch((error) => {
  console.error(error);
  $("companyList").innerHTML = `<div class="company-item">Error loading data: ${error.message}</div>`;
});
