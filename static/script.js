let companies = [];
let selectedSymbol = null;
let companySummaries = new Map();

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
  return source === "yfinance" ? "Live" : "Mock fallback";
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
  if (!summary?.["52_week_high"] || !summary?.latest_close) return 0;
  return ((summary["52_week_high"] - summary.latest_close) / summary["52_week_high"]) * 100;
}

function getDistanceFromLow(summary) {
  if (!summary?.["52_week_low"] || !summary?.latest_close) return 0;
  return ((summary.latest_close - summary["52_week_low"]) / summary["52_week_low"]) * 100;
}

function calculateCompositeConfidence(summary, records) {
  const lastRecord = records.at(-1);
  const sessionReturn = Number(lastRecord?.daily_return || 0) * 100;
  const momentum = Number(summary.momentum_score || 0);
  const volatilityPenalty = Math.min(Number(summary.volatility_score || 0) * 6, 30);
  const trendBonus = summary.trend_signal === "Bullish" ? 14 : 4;
  const sessionBonus = clamp(sessionReturn + 4, 0, 10);
  return clamp(45 + momentum * 4 + trendBonus + sessionBonus - volatilityPenalty, 8, 98);
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
  if (latest) {
    tags.push(Number(latest.daily_return) >= 0 ? "Latest session finished green" : "Latest session finished red");
  }
  return tags;
}

function buildSelectedNarrative(summary, records) {
  const firstClose = Number(records[0]?.close || 0);
  const lastClose = Number(records.at(-1)?.close || 0);
  const periodPerformance = firstClose ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const performanceLabel = periodPerformance >= 0 ? "advanced" : "slipped";
  return `Over the selected window, the stock has ${performanceLabel} ${formatPct(Math.abs(periodPerformance))} while maintaining a ${summary.risk_level.toLowerCase()} risk profile.`;
}

async function loadCompanies() {
  companies = await api("/companies");
  renderCompanies(companies);
  fillCompareSelects();
  await hydrateMarketPulse();
  if (companies.length) {
    await selectCompany(companies[0].symbol);
  }
}

async function hydrateMarketPulse() {
  const summaries = await Promise.all(
    companies.map((company) => api(`/summary/${company.symbol}`))
  );

  companySummaries = new Map(summaries.map((summary) => [summary.symbol, summary]));

  const bullishCount = summaries.filter((summary) => summary.trend_signal === "Bullish").length;
  const avgMomentum = summaries.reduce((sum, summary) => sum + Number(summary.momentum_score || 0), 0) / Math.max(1, summaries.length);
  const strongest = [...summaries].sort((a, b) => Number(b.momentum_score) - Number(a.momentum_score))[0];
  const liveCount = summaries.filter((summary) => summary.data_source === "yfinance").length;

  $("pulseBreadth").textContent = `${bullishCount}/${summaries.length} bullish`;
  $("pulseMomentum").textContent = formatPct(avgMomentum, 2);
  $("pulseLeader").textContent = strongest ? strongest.symbol.replace(".NS", "") : "--";
  $("pulseSource").textContent = liveCount > 0 ? `${liveCount} live / ${summaries.length - liveCount} mock` : "Full mock resilience";
}

function renderCompanies(list) {
  const box = $("companyList");
  box.innerHTML = "";

  if (!list.length) {
    box.innerHTML = '<div class="company-item">No companies match your search.</div>';
    return;
  }

  list.forEach((company) => {
    const summary = companySummaries.get(company.symbol);
    const momentum = summary ? formatPct(summary.momentum_score, 2) : "Loading";
    const item = document.createElement("div");
    item.className = `company-item ${company.symbol === selectedSymbol ? "active" : ""}`;
    item.innerHTML = `
      <strong>${company.name}</strong>
      <span>${company.symbol}</span>
      <small>${company.total_records} records | ${labelForSource(company.data_source)} | Momentum ${momentum}</small>
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
    const firstOption = document.createElement("option");
    firstOption.value = company.symbol;
    firstOption.textContent = company.symbol;
    firstSelect.appendChild(firstOption);

    const secondOption = document.createElement("option");
    secondOption.value = company.symbol;
    secondOption.textContent = company.symbol;
    secondSelect.appendChild(secondOption);
  });

  if (companies.length > 1) secondSelect.selectedIndex = 1;
}

async function selectCompany(symbol) {
  selectedSymbol = symbol;
  const company = companies.find((entry) => entry.symbol === symbol);
  $("selectedTitle").textContent = company ? `${company.name}` : symbol;
  renderCompanies(filterCompanies());

  const [summary, chartData, insight] = await Promise.all([
    api(`/summary/${symbol}`),
    api(`/data/${symbol}?days=${$("daysSelect").value}`),
    api(`/insights/${symbol}`),
  ]);

  companySummaries.set(summary.symbol, summary);
  updateSummary(summary, chartData.records);
  updateInsight(insight, summary, chartData.records);
  drawSvgChart(chartData.records);
  $("selectedMeta").textContent = `${summary.symbol} | ${summary.records_analyzed} trading sessions analyzed | ${labelForSource(summary.data_source)} data | latest print on ${summary.latest_date}`;
  await loadGainersLosers();
  renderCompanies(filterCompanies());
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

  $("sessionReturn").textContent = formatPct(sessionReturn, 2);
  $("sessionReturn").className = toneClass(sessionReturn);
  $("sessionNarrative").textContent = `Open-to-close movement for the latest trading session.`;

  $("rangePosition").textContent = `${formatNumber(rangePosition, 0)}% of yearly band`;
  $("range52").textContent = `High ${formatMoney(summary["52_week_high"])} | Low ${formatMoney(summary["52_week_low"])}`;

  $("riskTrend").textContent = `${summary.trend_signal} / ${summary.risk_level}`;
  $("dataSource").textContent = `${labelForSource(summary.data_source)} | ${summary.company_name || summary.symbol}`;

  $("trendPill").textContent = summary.trend_signal;
  $("trendPill").className = `signal-pill ${summary.trend_signal === "Bullish" ? "positive" : "negative"}`;

  $("movingAverage").textContent = formatMoney(summary.moving_average_7);
  $("averageClose").textContent = formatMoney(summary.average_close);
  $("volatilityScore").textContent = formatNumber(summary.volatility_score, 2);
  $("momentumScore").textContent = formatPct(summary.momentum_score, 2);
  $("distanceHigh").textContent = formatPct(distanceFromHigh, 2);
  $("distanceLow").textContent = formatPct(distanceFromLow, 2);
  $("confidenceScore").textContent = `${formatNumber(composite, 0)}/100`;

  setBar("momentumBar", clamp((Number(summary.momentum_score) + 8) * 6.25, 4, 100));
  setBar("volatilityBar", clamp(Number(summary.volatility_score) * 22, 4, 100));
  setBar("distanceHighBar", clamp(100 - distanceFromHigh, 4, 100));
  setBar("distanceLowBar", clamp(distanceFromLow / 1.5, 4, 100));
}

function updateInsight(payload, summary, records) {
  $("insightText").textContent = payload.insight;
  $("thesisTags").innerHTML = buildThesisTags(summary, records)
    .map((tag) => `<span>${tag}</span>`)
    .join("");
}

function drawSvgChart(records) {
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
  const pathFor = (values) =>
    values.map((value, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`).join(" ");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <linearGradient id="chartArea" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="rgba(46,196,141,0.32)" />
      <stop offset="100%" stop-color="rgba(46,196,141,0.02)" />
    </linearGradient>
  `;
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

  const latestCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  latestCircle.setAttribute("cx", x(records.length - 1));
  latestCircle.setAttribute("cy", y(closeValues.at(-1)));
  latestCircle.setAttribute("r", "6");
  latestCircle.setAttribute("fill", "#f3efe7");
  latestCircle.setAttribute("stroke", "#2ec48d");
  latestCircle.setAttribute("stroke-width", "3");
  svg.appendChild(latestCircle);

  const startLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  startLabel.setAttribute("x", pad);
  startLabel.setAttribute("y", height - 14);
  startLabel.setAttribute("fill", "rgba(156,167,181,0.9)");
  startLabel.setAttribute("font-size", "11");
  startLabel.textContent = records[0].date;
  svg.appendChild(startLabel);

  const endLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  endLabel.setAttribute("x", width - pad - 76);
  endLabel.setAttribute("y", height - 14);
  endLabel.setAttribute("fill", "rgba(156,167,181,0.9)");
  endLabel.setAttribute("font-size", "11");
  endLabel.textContent = records.at(-1).date;
  svg.appendChild(endLabel);

  const legend = document.createElementNS("http://www.w3.org/2000/svg", "text");
  legend.setAttribute("x", pad);
  legend.setAttribute("y", 24);
  legend.setAttribute("fill", "rgba(156,167,181,0.9)");
  legend.setAttribute("font-size", "12");
  legend.textContent = "Emerald: close price | Gold dashed: 7-day moving average";
  svg.appendChild(legend);
}

async function compareStocks() {
  const first = $("compareA").value;
  const second = $("compareB").value;

  if (!first || !second || first === second) {
    $("compareResult").textContent = "Please choose two different stocks.";
    return;
  }

  const days = $("daysSelect").value;
  const payload = await api(`/compare?symbol1=${first}&symbol2=${second}&days=${days}`);
  const firstResult = payload.comparison[first];
  const secondResult = payload.comparison[second];

  $("compareResult").innerHTML = `
    <div class="duel-grid">
      <div class="duel-card">
        <span>${first}</span>
        <strong class="${toneClass(firstResult.performance_percent)}">${formatPct(firstResult.performance_percent)}</strong>
        <small>Momentum ${formatPct(firstResult.momentum_score)} | Volatility ${formatNumber(firstResult.volatility_score)}</small>
      </div>
      <div class="duel-card">
        <span>${second}</span>
        <strong class="${toneClass(secondResult.performance_percent)}">${formatPct(secondResult.performance_percent)}</strong>
        <small>Momentum ${formatPct(secondResult.momentum_score)} | Volatility ${formatNumber(secondResult.volatility_score)}</small>
      </div>
    </div>
    <div class="duel-badge">
      <span>Winner over ${days} days</span>
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

$("searchInput").addEventListener("input", () => renderCompanies(filterCompanies()));
$("daysSelect").addEventListener("change", () => selectedSymbol && selectCompany(selectedSymbol));
$("compareBtn").addEventListener("click", compareStocks);
$("refreshBtn").addEventListener("click", async () => {
  $("refreshBtn").textContent = "Refreshing...";
  $("refreshBtn").disabled = true;
  try {
    await api("/refresh", { method: "POST" });
    companySummaries = new Map();
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
