// Global state
let currentLocation = 'New York, NY';
let forecastDays = 7;
let savedEvents = [];
let compareLocations = [];
let weatherData = {};
let charts = {};
let tempUnit = 'fahrenheit'; // 'fahrenheit' or 'celsius'
let selectedCoords = null;   // {lat, lon}
let map, marker;

// ------------- Init -------------
document.addEventListener('DOMContentLoaded', () => {
  const savedUnit = localStorage.getItem('tempUnit') || 'fahrenheit';
  tempUnit = savedUnit;
  document.querySelectorAll('.temp-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === savedUnit);
  });

  initMap();
  loadSavedEvents();
  setMinDate();
  fetchWeatherData(); // initial (NYC)

  const eventLocationInput = document.getElementById('eventLocation');
  if (eventLocationInput) eventLocationInput.value = currentLocation;
});

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([40.7829, -73.9654], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  marker = L.marker([40.7829, -73.9654], { draggable: false }).addTo(map);
  selectedCoords = { lat: 40.7829, lon: -73.9654 };

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    selectedCoords = { lat, lon: lng };
    marker.setLatLng([lat, lng]);
    const place = await reverseGeocode(lat, lng);
    const label = place || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    document.getElementById('currentLocation').textContent = label;
    currentLocation = label;
    fetchWeatherData(); // updates forecast tab too
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const r = await fetch(url, { headers: { 'User-Agent': 'BackspaceWeather/1.0' } });
    const j = await r.json();
    return j.display_name;
  } catch { return null; }
}

async function useMyLocation() {
  if (!navigator.geolocation) return alert('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    selectedCoords = { lat: latitude, lon: longitude };
    map.setView([latitude, longitude], 12);
    marker.setLatLng([latitude, longitude]);
    const place = await reverseGeocode(latitude, longitude);
    const label = place || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    document.getElementById('currentLocation').textContent = label;
    currentLocation = label;
    fetchWeatherData();
  }, () => alert('Unable to get location'));
}

// ------------- Unit toggle -------------
function setTempUnit(unit, button) {
  tempUnit = unit;
  document.querySelectorAll('.temp-btn').forEach(btn => btn.classList.remove('active'));
  button.classList.add('active');
  localStorage.setItem('tempUnit', unit);

  const currentTab = document.querySelector('.tab-content.active')?.id;
  if (currentTab === 'forecast-tab') fetchWeatherData();
  else if (currentTab === 'analytics-tab') fetchHistoricalData();
  else if (currentTab === 'compare-tab' && compareLocations.length > 0) fetchCompareData();
}
function getTempSymbol() { return tempUnit === 'celsius' ? '°C' : '°F'; }

// ------------- Utilities -------------
function setMinDate() {
  const el = document.getElementById('advisorDate');
  if (!el) return;
  const today = new Date().toISOString().split('T')[0];
  el.setAttribute('min', today);
}
function showLoading() { document.getElementById('loadingOverlay')?.classList.add('active'); }
function hideLoading() { document.getElementById('loadingOverlay')?.classList.remove('active'); }
function showError(msg) {
  const html = `
    <div class="alert-card alert-warning">
      <div class="alert-header"><div class="alert-icon-small">⚠️</div>
      <div><div class="alert-title">Error</div><div class="alert-message">${msg}</div></div></div>
    </div>`;
  document.getElementById('weatherAlerts').innerHTML = html;
}

// ------------- Tabs -------------
function showTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`${tabName}-tab`).classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (event && event.target) event.target.classList.add('active');

  document.getElementById('mainNav')?.classList.remove('active');

  if (tabName === 'forecast') fetchWeatherData();
  else if (tabName === 'analytics') fetchHistoricalData();
  else if (tabName === 'compare' && compareLocations.length === 0) renderCompareEmpty();
}
function toggleMobileMenu() { document.getElementById('mainNav')?.classList.toggle('active'); }

// ------------- Search -------------
function searchLocation() {
  const input = document.getElementById('locationSearch');
  if (!input || !input.value.trim()) return;
  currentLocation = input.value.trim();
  document.getElementById('currentLocation').textContent = currentLocation;
  input.value = '';
  // If it's "lat,lon", set map & coords
  const m = currentLocation.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = parseFloat(m[1]); const lon = parseFloat(m[2]);
    selectedCoords = { lat, lon };
    map.setView([lat, lon], 12); marker.setLatLng([lat, lon]);
  }
  fetchWeatherData();
}
function handleSearchEnter(e) { if (e.key === 'Enter') searchLocation(); }

// ------------- Fetch weather/trend (by point if available) -------------
async function fetchWeatherData() {
  showLoading();
  try {
    const qsPoint = selectedCoords ? `lat=${selectedCoords.lat}&lon=${selectedCoords.lon}` : `location=${encodeURIComponent(currentLocation)}`;
    const weatherResp = await fetch(`/api/weather?${qsPoint}&hours=24&unit=${tempUnit}`);
    if (!weatherResp.ok) throw new Error('Failed to fetch weather data');
    const weatherJson = await weatherResp.json();
    if (weatherJson.error) throw new Error(weatherJson.error);

    const forecastResp = await fetch(`/api/forecast?${qsPoint}&days=${forecastDays}&unit=${tempUnit}`);
    const forecastJson = await forecastResp.json();
    if (forecastJson.error) throw new Error(forecastJson.error);

    weatherData = {
      current: weatherJson.current,
      hourly: weatherJson.hourly,
      forecast: forecastJson.forecast,
      location: weatherJson.location,
      source: weatherJson.source,
      unit: weatherJson.unit
    };

    updateCurrentWeather(weatherJson);
    updateHourlyForecast(weatherJson.hourly || []);
    updateExtendedForecast(forecastJson.forecast || []);
    updateRecommendation(weatherJson.current, weatherJson.hourly || []);
    updatePrecipitationChart(weatherJson.hourly || []);
    updateTemperatureChart(forecastJson.forecast || []);
    updateLastUpdated();
  } catch (e) {
    console.error(e);
    showError(e.message || 'Unable to fetch weather data.');
  } finally {
    hideLoading();
  }
}

// ------------- UI Renderers (current/hourly/daily) -------------
function updateCurrentWeather(data) {
  const s = getTempSymbol();
  document.getElementById('forecastLocation').textContent = `Weather Forecast for ${data.location}`;
  document.getElementById('currentTemp').textContent = `${data.current.temp}${s}`;
  document.getElementById('currentCondition').textContent = data.current.description || data.current.condition;
  document.getElementById('feelsLike').textContent = `Feels like ${data.current.feelsLike}${s}`;
  document.getElementById('dataStatus').textContent = `${data.source} Active`;

  const detailsHTML = `
    <div class="weather-detail"><div class="detail-label">Humidity</div><div class="detail-value">${data.current.humidity}%</div></div>
    <div class="weather-detail"><div class="detail-label">Wind</div><div class="detail-value">${data.current.wind} mph</div></div>
    <div class="weather-detail"><div class="detail-label">Pressure</div><div class="detail-value">${data.current.pressure ?? '--'} inHg</div></div>
    <div class="weather-detail"><div class="detail-label">UV Index</div><div class="detail-value">${data.current.uvIndex}</div></div>
    <div class="weather-detail"><div class="detail-label">Precip (last hour)</div><div class="detail-value">${(data.current.precipitation ?? 0).toFixed(2)} mm/h</div></div>
    <div class="weather-detail"><div class="detail-label">Precip (24h)</div><div class="detail-value">${(data.current.precipLast24h ?? 0).toFixed(2)} mm</div></div>
    <div class="weather-detail"><div class="detail-label">Dew Point</div><div class="detail-value">${data.current.dewPoint}${s}</div></div>
  `;
  document.getElementById('weatherDetails').innerHTML = detailsHTML;
}

function updateHourlyForecast(hourly) {
  const s = getTempSymbol();
  const el = document.getElementById('hourlyForecast');
  if (!el) return;

  const maxP = Math.max(0.1, ...hourly.map(h => h.precipitation ?? 0));
  el.innerHTML = hourly.map(h => {
    const mmhr = h.precipitation ?? 0;
    const pct = Math.min(100, Math.round((mmhr / maxP) * 100));
    return `
      <div class="hour-card">
        <div class="hour-time">${h.time}</div>
        <div class="hour-icon">${h.icon}</div>
        <div class="hour-temp">${h.temp}${s}</div>
        <div class="hour-precip">${mmhr.toFixed(2)} mm/h</div>
        <div class="precip-bar"><div class="precip-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');
}

function updateExtendedForecast(days) {
  const s = getTempSymbol();
  document.getElementById('extendedTitle').textContent = `Extended Forecast (${forecastDays} Days)`;
  const el = document.getElementById('extendedForecast');
  if (!el) return;
  el.innerHTML = (days || []).map(d => `
    <div class="day-card">
      <div class="day-main"><div class="day-icon">${d.icon}</div>
        <div><div class="day-date">${d.date}</div><div class="day-condition">${d.description || d.condition}</div></div>
      </div>
      <div class="day-details">
        <div class="day-stat"><div class="stat-label">High/Low</div><div class="stat-value">${d.high}${s} / ${d.low}${s}</div></div>
        <div class="day-stat"><div class="stat-label">Precip</div><div class="stat-value" style="color:#2563eb">${(d.precipitation ?? 0).toFixed(2)} mm</div></div>
        <div class="day-stat"><div class="stat-label">Wind</div><div class="stat-value">${d.wind} mph</div></div>
      </div>
    </div>`).join('');
}

function updateRecommendation(current, hourly) {
  const s = getTempSymbol();
  const heavy = (hourly || []).filter(h => (h.precipitation ?? 0) >= 2);
  const moderate = (hourly || []).filter(h => (h.precipitation ?? 0) >= 0.2 && (h.precipitation ?? 0) < 2);
  const hot = tempUnit === 'celsius' ? 29 : 85;
  const cold = tempUnit === 'celsius' ? 4 : 40;

  let rec = '';
  if (heavy.length > 0) rec = `⚠️ Heavy rain periods: ${heavy.map(h => h.time).join(', ')} (≥2 mm/h).`;
  else if (moderate.length > 0) rec = `🌦️ Showers likely: ${moderate.map(h => h.time).join(', ')} (0.2–2 mm/h).`;
  else if (current.temp > hot) rec = `☀️ Hot (${current.temp}${s}). Hydrate. UV: ${current.uvIndex}.`;
  else if (current.temp < cold) rec = `❄️ Cold (${current.temp}${s}). Dress warm.`;
  else if (current.wind > 20) rec = `💨 Windy (${current.wind} mph). Secure items.`;
  else rec = `✅ Good conditions. Low rain intensity and comfortable temps.`;
  document.getElementById('recommendationText').textContent = rec;
}

// ------------- Charts -------------
function updatePrecipitationChart(hourly) {
  const ctx = document.getElementById('precipitationChart'); if (!ctx) return;
  if (charts.precipitation) charts.precipitation.destroy();
  charts.precipitation = new Chart(ctx, {
    type: 'line',
    data: {
      labels: (hourly || []).map(h => h.time),
      datasets: [{ label: 'Precipitation (mm/h)', data: (hourly || []).map(h => h.precipitation ?? 0), borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.2)', fill:true, tension:0.4 }]
    },
    options: { responsive:true, maintainAspectRatio:true, scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>`${v} mm/h` } } } }
  });
}
function updateTemperatureChart(days) {
  const s = getTempSymbol();
  const ctx = document.getElementById('temperatureChart'); if (!ctx) return;
  if (charts.temperature) charts.temperature.destroy();
  charts.temperature = new Chart(ctx, {
    type: 'line',
    data: {
      labels: (days || []).map(d => d.date),
      datasets: [
        { label:`High Temp (${s})`, data:(days||[]).map(d => d.high), borderColor:'#ef4444', backgroundColor:'rgba(239,68,68,0.1)', tension:0.4 },
        { label:`Low Temp (${s})`, data:(days||[]).map(d => d.low), borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.1)', tension:0.4 }
      ]
    },
    options: { responsive:true, maintainAspectRatio:true, scales:{ y:{ ticks:{ callback:v=>`${v}${s}` } } } }
  });
}

// ------------- Historical -------------
async function fetchHistoricalData() {
  showLoading();
  try {
    const qsPoint = selectedCoords ? `lat=${selectedCoords.lat}&lon=${selectedCoords.lon}` : `location=${encodeURIComponent(currentLocation)}`;
    const resp = await fetch(`/api/historical?${qsPoint}&days=30&unit=${tempUnit}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    updateHistoricalCharts(data.historical || []);
    updateWeatherStats(data.historical || []);
  } catch (e) {
    console.error(e); showError('Unable to fetch historical data.');
  } finally { hideLoading(); }
}
function updateHistoricalCharts(hist) {
  const s = getTempSymbol();
  const tempCtx = document.getElementById('historicalTempChart');
  if (tempCtx) {
    if (charts.historicalTemp) charts.historicalTemp.destroy();
    charts.historicalTemp = new Chart(tempCtx, { type:'line',
      data:{ labels:(hist||[]).map(d=>d.date), datasets:[{ label:`Avg Temperature (${s})`, data:(hist||[]).map(d=>d.avgTemp), borderColor:'#f59e0b', backgroundColor:'rgba(245,158,11,0.1)', tension:0.4 }] },
      options:{ scales:{ y:{ ticks:{ callback:v=>`${v}${s}` } } } }
    });
  }
  const pCtx = document.getElementById('historicalPrecipChart');
  if (pCtx) {
    if (charts.historicalPrecip) charts.historicalPrecip.destroy();
    charts.historicalPrecip = new Chart(pCtx, { type:'bar',
      data:{ labels:(hist||[]).map(d=>d.date), datasets:[{ label:'Precipitation (mm)', data:(hist||[]).map(d=>d.precipitation), backgroundColor:'#3b82f6' }] },
      options:{ scales:{ y:{ beginAtZero:true, ticks:{ callback:v=>`${v} mm` } } } }
    });
  }
  const hCtx = document.getElementById('historicalHumidityChart');
  if (hCtx) {
    if (charts.historicalHumidity) charts.historicalHumidity.destroy();
    charts.historicalHumidity = new Chart(hCtx, { type:'line',
      data:{ labels:(hist||[]).map(d=>d.date), datasets:[{ label:'Humidity (%)', data:(hist||[]).map(d=>d.humidity), borderColor:'#10b981', backgroundColor:'rgba(16,185,129,0.2)', fill:true, tension:0.4 }] },
      options:{ scales:{ y:{ beginAtZero:true, max:100, ticks:{ callback:v=>`${v}%` } } } }
    });
  }
}
function updateWeatherStats(hist) {
  const s = getTempSymbol();
  const el = document.getElementById('weatherStats'); if (!el) return;
  if (!hist || !hist.length) { el.innerHTML='<p>No historical data available</p>'; return; }
  const avgTemp = Math.round(hist.reduce((a,d)=>a+d.avgTemp,0)/hist.length);
  const avgPrecip = (hist.reduce((a,d)=>a+(d.precipitation??0),0)/hist.length).toFixed(2);
  const avgHum = Math.round(hist.reduce((a,d)=>a+d.humidity,0)/hist.length);
  const maxTemp = Math.max(...hist.map(d=>d.avgTemp));
  const minTemp = Math.min(...hist.map(d=>d.avgTemp));
  el.innerHTML = `
    <div class="stat-card stat-card-blue"><div class="stat-number">${avgTemp}${s}</div><div class="stat-label-card">Average Temperature</div></div>
    <div class="stat-card stat-card-green"><div class="stat-number">${avgPrecip} mm/day</div><div class="stat-label-card">Avg Precipitation</div></div>
    <div class="stat-card stat-card-purple"><div class="stat-number">${Math.round(maxTemp)}${s}</div><div class="stat-label-card">Highest Temperature</div></div>
    <div class="stat-card stat-card-orange"><div class="stat-number">${Math.round(minTemp)}${s}</div><div class="stat-label-card">Lowest Temperature</div></div>
    <div class="stat-card stat-card-teal"><div class="stat-number">${avgHum}%</div><div class="stat-label-card">Average Humidity</div></div>
    <div class="stat-card stat-card-red"><div class="stat-number">${hist.length}</div><div class="stat-label-card">Days Analyzed</div></div>
  `;
}

// ------------- Forecast days toggle -------------
function setForecastDays(days, button) {
  forecastDays = days;
  document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
  button.classList.add('active');
  fetchWeatherData();
}

// ------------- Compare (unchanged beyond units) -------------
async function fetchCompareData() {
  showLoading();
  try {
    const params = compareLocations.map(loc => `locations[]=${encodeURIComponent(loc)}`).join('&');
    const resp = await fetch(`/api/compare?${params}&unit=${tempUnit}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    displayCompareData(data.comparison || []);
  } catch (e) {
    console.error(e); showError('Unable to fetch comparison data.');
  } finally { hideLoading(); }
}
function addCompareLocation() {
  const input = document.getElementById('compareSearch');
  const loc = input.value.trim();
  if (!loc) return alert('Please enter a location');
  if (compareLocations.includes(loc)) return alert('Already added');
  if (compareLocations.length >= 5) return alert('Max 5 locations');
  compareLocations.push(loc); input.value=''; fetchCompareData();
}
function handleCompareEnter(e){ if (e.key==='Enter') addCompareLocation(); }
function displayCompareData(comp) {
  const s = getTempSymbol(), el = document.getElementById('compareList'); if (!el) return;
  if (!comp || !comp.length) return renderCompareEmpty();
  el.innerHTML = comp.map(i => `
    <div class="compare-item">
      <div class="compare-header"><div class="compare-location">${i.location}</div>
      <button class="btn-remove" onclick="removeCompareLocation('${i.location.replace(/'/g,"\\'")}')">✕</button></div>
      <div class="compare-stats">
        <div class="compare-stat"><div class="compare-value">${i.weather.temp}${s}</div><div class="compare-label">Temperature</div></div>
        <div class="compare-stat"><div class="compare-value" style="color:#2563eb">${(i.weather.precipitation??0).toFixed(2)} mm/h</div><div class="compare-label">Precipitation</div></div>
        <div class="compare-stat"><div class="compare-value" style="color:#059669">${i.weather.humidity}%</div><div class="compare-label">Humidity</div></div>
        <div class="compare-stat"><div class="compare-value" style="color:#9333ea">${i.weather.wind} mph</div><div class="compare-label">Wind</div></div>
      </div>
      <div class="compare-condition"><span class="condition-icon">${i.weather.icon || '🌤️'}</span><span>${i.weather.description || i.weather.condition}</span></div>
    </div>`).join('');
}
function renderCompareEmpty(){ const el=document.getElementById('compareList'); if(!el)return; el.innerHTML=`<div class="compare-empty"><div class="compare-icon">📊</div><p>Add locations to compare weather conditions</p><p class="compare-hint">You can add up to 5 locations</p></div>`; }
function removeCompareLocation(loc){ compareLocations = compareLocations.filter(l => l !== loc); compareLocations.length ? fetchCompareData() : renderCompareEmpty(); }

// ------------- Download -------------
function downloadData(fmt) {
  if (!weatherData || !weatherData.current) return alert('No weather data available');
  const data = {
    location: weatherData.location || currentLocation,
    timestamp: new Date().toISOString(),
    source: weatherData.source || 'NASA POWER API',
    temperatureUnit: weatherData.unit || getTempSymbol(),
    weather: weatherData
  };
  let content, filename, mime;
  if (fmt === 'json') { content = JSON.stringify(data, null, 2); filename = `weather-${sanitizeFilename(currentLocation)}-${Date.now()}.json`; mime='application/json'; }
  else {
    content = generateCSV(data);
    filename = `weather-${sanitizeFilename(currentLocation)}-${Date.now()}.csv`; mime='text/csv';
  }
  downloadFile(content, filename, mime);
}
function generateCSV(data) {
  const s = data.temperatureUnit || getTempSymbol();
  let csv = 'Weather Forecast Data\n';
  csv += `Location,${data.location}\nTimestamp,${new Date(data.timestamp).toLocaleString()}\nSource,${data.source}\nTemperature Unit,${s}\n\n`;
  csv += 'CURRENT WEATHER\nParameter,Value\n';
  Object.entries(data.weather.current || {}).forEach(([k,v]) => csv += `${k},${v}\n`);
  csv += '\n';
  if (data.weather.hourly?.length) {
    csv += 'HOURLY FORECAST\n';
    csv += `Time,Temperature (${s}),Precipitation (mm/h),Humidity (%),Wind (mph),Feels Like (${s})\n`;
    data.weather.hourly.forEach(h => { csv += `${h.time},${h.temp},${h.precipitation ?? 0},${h.humidity},${h.wind},${h.feelsLike}\n`; });
    csv += '\n';
  }
  if (data.weather.forecast?.length) {
    csv += 'EXTENDED FORECAST\n';
    csv += `Date,High (${s}),Low (${s}),Precipitation (mm),Condition,Humidity (%),Wind (mph)\n`;
    data.weather.forecast.forEach(d => { csv += `${d.date},${d.high},${d.low},${d.precipitation ?? 0},${d.condition},${d.humidity},${d.wind}\n`; });
  }
  return csv;
}
function sanitizeFilename(fn){ return fn.replace(/[^a-z0-9]/gi,'-').toLowerCase(); }
function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ------------- Event Advisor -------------
async function checkEventWeather(e) {
  e.preventDefault();
  if (!selectedCoords) return alert('Select a location on the map first');
  const name = document.getElementById('advisorEventName').value.trim();
  const type = document.getElementById('advisorEventType').value;
  const date = document.getElementById('advisorDate').value;
  const start = document.getElementById('advisorStart').value;
  const end = document.getElementById('advisorEnd').value;
  if (!date || !start || !end) return alert('Please fill date, start, and end time');

  // Treat inputs as local time at the event location (matches Open-Meteo timezone=auto)
  const startLocal = `${date}T${start}`;
  const endLocal = `${date}T${end}`;
  if (endLocal <= startLocal) return alert('End time must be after start time');

  showLoading();
  try {
    const url = `/api/event-advice?lat=${selectedCoords.lat}&lon=${selectedCoords.lon}&start=${encodeURIComponent(startLocal)}&end=${encodeURIComponent(endLocal)}&eventType=${encodeURIComponent(type)}&unit=${tempUnit}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    renderEventAdvice(name, j);
  } catch (err) {
    console.error(err);
    alert(err.message || 'Unable to compute event advice');
  } finally { hideLoading(); }
}

function renderEventAdvice(eventName, data) {
  const card = document.getElementById('eventAdviceCard');
  const summaryEl = document.getElementById('eventAdviceSummary');
  const detailsEl = document.getElementById('eventAdviceDetails');
  const hourlyEl = document.getElementById('eventAdviceHourly');
  card.style.display = 'block';

  const badge = data.favorable ? '<span style="color:#10b981;font-weight:700;">Favorable</span>' : '<span style="color:#ef4444;font-weight:700;">Not Favorable</span>';
  summaryEl.innerHTML = `
    <p><strong>Event:</strong> ${eventName}</p>
    <p><strong>Window:</strong> ${data.window.start} - ${data.window.end}</p>
    <p><strong>Decision:</strong> ${badge}</p>
  `;

  const s = data.metrics.unit || getTempSymbol();
  detailsEl.innerHTML = `
    <div class="weather-details">
      <div class="weather-detail"><div class="detail-label">Max PoP</div><div class="detail-value">${data.metrics.max_pop_percent ?? '--'}%</div></div>
      <div class="weather-detail"><div class="detail-label">Max Precip</div><div class="detail-value">${data.metrics.max_precip_mm} mm/h</div></div>
      <div class="weather-detail"><div class="detail-label">Max Wind</div><div class="detail-value">${data.metrics.max_wind_mph} mph</div></div>
      <div class="weather-detail"><div class="detail-label">Avg Temp</div><div class="detail-value">${data.metrics.avg_temp}${s}</div></div>
      <div class="weather-detail"><div class="detail-label">Risks</div><div class="detail-value">Rain: ${data.risks.precip}, Wind: ${data.risks.wind}, Temp: ${data.risks.temperature}, UV: ${data.risks.uv}</div></div>
      <div class="weather-detail"><div class="detail-label">Suggestions</div><div class="detail-value">${(data.suggestions||[]).join('; ') || 'None'}</div></div>
    </div>
  `;

  hourlyEl.innerHTML = `
    <h4>Hourly in Window</h4>
    <div class="hourly-forecast">
      ${(data.hourly||[]).map(h => `
        <div class="hour-card">
          <div class="hour-time">${h.time.slice(11,16)}</div>
          <div class="hour-temp">${h.temp}${s}</div>
          <div class="hour-precip">${(h.precip_mm ?? 0).toFixed(2)} mm/h</div>
          <div class="hour-precip">${h.pop ?? '--'}% PoP</div>
          <div class="hour-precip">${h.wind_mph} mph</div>
        </div>`).join('')}
    </div>
  `;
}

// ------------- Misc -------------
function updateLastUpdated() {
  const now = new Date();
  const ts = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  const el = document.getElementById('lastUpdated'); if (el) el.textContent = ts;
}