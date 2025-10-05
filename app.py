from flask import Flask, render_template, jsonify, request
import requests
from datetime import datetime, timedelta
import re

# Initialize the Flask app
app = Flask(__name__)

# Base URL for NASA POWER API
NASA_BASE_URL = 'https://power.larc.nasa.gov/api/temporal'

# Set of values considered as missing data
MISSING = {-999, -9999, -99, None}

# Helper function to handle missing values
def mv(v, default=0):
    return default if v in MISSING else v

# ------------------------ Geocoding ------------------------
def get_coordinates(location):
    """
    Convert a location string to latitude and longitude.
    Accepts 'lat,lon' directly or uses OpenStreetMap Nominatim for geocoding.
    """
    try:
        # Check if input is already in 'lat,lon' format
        m = re.match(r'^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$', location or '')
        if m:
            lat = float(m.group(1)); lon = float(m.group(2))
            return lat, lon, f"{lat:.4f}, {lon:.4f}"
        
        # Use Nominatim API to geocode the location
        geocoding_url = 'https://nominatim.openstreetmap.org/search'
        headers = {'User-Agent': 'BackspaceWeather/1.0'}
        params = {'q': location, 'format': 'json', 'limit': 1, 'addressdetails': 1}
        r = requests.get(geocoding_url, headers=headers, params=params, timeout=15)
        data = r.json()
        if data:
            return float(data[0]['lat']), float(data[0]['lon']), data[0].get('display_name', location)
        return None, None, location
    except Exception as e:
        print('Geocoding error:', e)
        return None, None, location

# Convert Fahrenheit to Celsius if needed
def convert_temp(temp_f, to_celsius=False):
    if temp_f is None: return None
    if to_celsius: return round((temp_f - 32) * 5/9, 1)
    return round(temp_f, 1)

# Format weather data with proper units
def format_weather_response(data, unit='fahrenheit'):
    """
    Converts temperatures in the response to desired unit (°F or °C).
    """
    is_celsius = unit.lower() == 'celsius'
    
    # Convert current weather
    if 'current' in data:
        for k in ['temp','feelsLike','dewPoint','high','low']:
            if k in data['current'] and data['current'][k] is not None:
                data['current'][k] = convert_temp(data['current'][k], is_celsius)
    
    # Convert hourly weather
    if 'hourly' in data:
        for h in data['hourly']:
            for k in ['temp','feelsLike','dewPoint']:
                if k in h and h[k] is not None:
                    h[k] = convert_temp(h[k], is_celsius)
    
    # Convert daily forecast
    if 'forecast' in data:
        for d in data['forecast']:
            for k in ['high','low']:
                if k in d and d[k] is not None:
                    d[k] = convert_temp(d[k], is_celsius)
    
    # Add unit symbol
    data['unit'] = '°C' if is_celsius else '°F'
    return data

# ------------------------ NASA POWER hourly helpers ------------------------
def _flatten_hourly_series(series_dict):
    """
    Flatten NASA POWER hourly series data into a simple dict with key=YYYYMMDDHH.
    """
    out = {}
    if not series_dict: return out
    sample = next(iter(series_dict.values()))
    
    # If values are lists (hourly values per day)
    if isinstance(sample, list):
        for day_key, vals in series_dict.items():
            if isinstance(vals, list):
                for i, v in enumerate(vals):
                    out[f"{day_key}{i:02d}"] = v
    else:
        out = dict(series_dict)
    return out

def get_power_hourly(lat, lon, hours=24):
    """
    Fetch last 48 hours of hourly weather from NASA POWER API
    and return last 'hours' with valid values.
    """
    end = datetime.utcnow()
    start = end - timedelta(hours=47)
    
    url = f'{NASA_BASE_URL}/hourly/point'
    params = {
        'parameters': 'T2M,RH2M,WS2M,PS,PRECTOTCORR,ALLSKY_SFC_UV_INDEX,T2MDEW',
        'community': 'RE',
        'longitude': lon,
        'latitude': lat,
        'start': start.strftime('%Y%m%d'),
        'end': end.strftime('%Y%m%d'),
        'format': 'JSON',
        'time-standard': 'UTC'
    }
    r = requests.get(url, params=params, timeout=30)
    data = r.json()
    
    if 'properties' not in data or 'parameter' not in data['properties']:
        return []
    
    p = data['properties']['parameter']

    # Flatten all hourly series
    series = {k: _flatten_hourly_series(p.get(k, {})) for k in
              ['T2M','RH2M','WS2M','PS','PRECTOTCORR','ALLSKY_SFC_UV_INDEX','T2MDEW']}
    
    all_keys = sorted(set(series['T2M'].keys()) | set(series['PRECTOTCORR'].keys()))

    rows = []
    for key in all_keys:
        t2m = series['T2M'].get(key)
        if t2m in MISSING:
            continue
        
        # Parse datetime from key
        try:
            dt = datetime.strptime(key, '%Y%m%d%H')
            label = dt.strftime('%I %p').lstrip('0')
        except:
            label = key[-2:]

        # Extract and convert values
        temp_c = mv(t2m, 20)
        rh = max(0, min(100, mv(series['RH2M'].get(key), 60)))
        ws_ms = max(0, mv(series['WS2M'].get(key), 0))
        ps_kpa = series['PS'].get(key)
        precip_mmhr = max(0, mv(series['PRECTOTCORR'].get(key), 0))
        uvi = max(0, mv(series['ALLSKY_SFC_UV_INDEX'].get(key), 0))
        dew_c = mv(series['T2MDEW'].get(key), temp_c - 2)

        # Convert units
        temp_f = round((temp_c * 9/5) + 32)
        dew_f = round((dew_c * 9/5) + 32)
        wind_mph = round(ws_ms * 2.237)
        ps_inhg = round(mv(ps_kpa, 0) * 0.2953, 2) if ps_kpa not in MISSING else None

        # Determine weather condition and icon
        cond, icon = get_weather_condition(temp_c, rh, precip_mmhr, is_hourly=True)
        
        rows.append({
            'time': label,
            'temp': temp_f,
            'icon': icon,
            'precipitation': round(precip_mmhr, 2),
            'humidity': rh,
            'wind': wind_mph,
            'feelsLike': temp_f,
            'description': cond,
            'pressure': ps_inhg,
            'uvIndex': round(uvi),
            'dewPoint': dew_f
        })
    
    # Keep only the last 'hours'
    rows = rows[-hours:]
    if rows:
        rows[-1]['time'] = 'Now'  # Label the latest hour as 'Now'
    return rows

def get_weather_condition(temp_c, humidity, precip_amount, is_hourly=True):
    """
    Simple weather condition classifier based on precipitation and humidity.
    """
    if is_hourly:
        if precip_amount >= 2: return 'Rainy', '🌧️'
        if precip_amount >= 0.2: return 'Light Rain', '🌦️'
    else:
        if precip_amount >= 10: return 'Rainy', '🌧️'
        if precip_amount >= 1: return 'Light Rain', '🌦️'
    if humidity > 80: return 'Cloudy', '☁️'
    if humidity > 60: return 'Partly Cloudy', '⛅'
    return 'Clear', '☀️'

# ------------------------ NASA: current + trend ------------------------
def get_real_weather_data_by_point(lat, lon, display_name=None):
    """
    Get current weather and hourly trend for a specific lat/lon using NASA POWER.
    """
    try:
        name = display_name or f"{lat:.4f}, {lon:.4f}"
        today = datetime.utcnow()
        start = (today - timedelta(days=7)).strftime('%Y%m%d')
        end = today.strftime('%Y%m%d')
        url = f'{NASA_BASE_URL}/daily/point'
        params = {
            'parameters': 'T2M,T2M_MAX,T2M_MIN,RH2M,PRECTOTCORR,WS2M,PS,ALLSKY_SFC_UV_INDEX,T2MDEW',
            'community': 'RE',
            'longitude': lon,
            'latitude': lat,
            'start': start,
            'end': end,
            'format': 'JSON'
        }
        resp = requests.get(url, params=params, timeout=30).json()
        if 'properties' not in resp or 'parameter' not in resp['properties']:
            return None, None, name
        p = resp['properties']['parameter']

        # Helper to get latest valid value for a parameter
        def latest(param, default=None):
            values = p.get(param, {})
            for k in sorted(values.keys(), reverse=True):
                if values[k] not in MISSING:
                    return values[k]
            return default

        # Extract main weather parameters
        temp_c = mv(latest('T2M'), 20)
        rh = max(0, min(100, mv(latest('RH2M'), 60)))
        precip_24h_mm = max(0, mv(latest('PRECTOTCORR'), 0.0))
        tmax_c = mv(latest('T2M_MAX'), temp_c)
        tmin_c = mv(latest('T2M_MIN'), temp_c)
        dew_c = mv(latest('T2MDEW'), temp_c - 2)
        ws_ms = max(0, mv(latest('WS2M'), 0))
        ps_kpa = latest('PS')

        # Fetch hourly data for last 24 hours
        hourly = get_power_hourly(lat, lon, hours=24)
        last_hour_precip = hourly[-1]['precipitation'] if hourly else 0.0
        last_hour_uvi = hourly[-1]['uvIndex'] if hourly else max(0, mv(latest('ALLSKY_SFC_UV_INDEX'), 0))
        last_hour_pressure = hourly[-1].get('pressure') if hourly else (round(mv(ps_kpa, 0) * 0.2953, 2) if ps_kpa not in MISSING else None)
        last_hour_dew_f = hourly[-1].get('dewPoint') if hourly else round((dew_c * 9/5) + 32)

        # Convert units
        temp_f = round((temp_c * 9/5) + 32)
        tmax_f = round((tmax_c * 9/5) + 32)
        tmin_f = round((tmin_c * 9/5) + 32)
        wind_mph = round(ws_ms * 2.237)

        # Determine condition
        cond, icon = get_weather_condition(temp_c, rh, last_hour_precip, is_hourly=True)

        # Prepare current weather dictionary
        current_weather = {
            'temp': temp_f,
            'condition': cond,
            'description': cond,
            'precipitation': round(last_hour_precip, 2),
            'precipLast24h': round(precip_24h_mm, 2),
            'humidity': rh,
            'wind': wind_mph,
            'pressure': last_hour_pressure,
            'visibility': 10,
            'uvIndex': last_hour_uvi,
            'dewPoint': last_hour_dew_f,
            'feelsLike': temp_f,
            'icon': icon,
            'high': tmax_f,
            'low': tmin_f
        }
        return current_weather, hourly, name
    except Exception as e:
        print('NASA POWER error:', e)
        return None, None, display_name or 'Unknown'

# ------------------------ NASA POWER daily trend ------------------------
def get_real_forecast_trend(lat, lon, days=7):
    """
    Fetch recent daily trends (not future forecast) for a location.
    """
    try:
        end = datetime.utcnow()
        start = end - timedelta(days=days-1)
        url = f'{NASA_BASE_URL}/daily/point'
        params = {
            'parameters': 'T2M_MAX,T2M_MIN,RH2M,PRECTOTCORR,WS2M',
            'community': 'RE',
            'longitude': lon,
            'latitude': lat,
            'start': start.strftime('%Y%m%d'),
            'end': end.strftime('%Y%m%d'),
            'format': 'JSON'
        }
        resp = requests.get(url, params=params, timeout=30).json()
        if 'properties' not in resp or 'parameter' not in resp['properties']:
            return None
        p = resp['properties']['parameter']
        dates = sorted(p.get('T2M_MAX', {}).keys())
        out = []
        for dk in dates[-days:]:
            d = datetime.strptime(dk, '%Y%m%d')
            tmax_c = mv(p['T2M_MAX'].get(dk), 20)
            tmin_c = mv(p['T2M_MIN'].get(dk), 10)
            rh = max(0, min(100, mv(p.get('RH2M', {}).get(dk), 60)))
            precip_mm = max(0, mv(p.get('PRECTOTCORR', {}).get(dk), 0))
            wind_ms = max(0, mv(p.get('WS2M', {}).get(dk), 5))
            
            out.append({
                'date': d.strftime('%a, %b %d'),
                'high': round((tmax_c * 9/5) + 32),
                'low': round((tmin_c * 9/5) + 32),
                'precipitation': round(precip_mm, 2),
                'condition': get_weather_condition((tmax_c+tmin_c)/2, rh, precip_mm, is_hourly=False)[0],
                'description': get_weather_condition((tmax_c+tmin_c)/2, rh, precip_mm, is_hourly=False)[0],
                'icon': get_weather_condition((tmax_c+tmin_c)/2, rh, precip_mm, is_hourly=False)[1],
                'humidity': rh,
                'wind': round(wind_ms * 2.237),
            })
        return out
    except Exception as e:
        print('Trend error:', e)
        return None

# ------------------------ Open-Meteo Event Advice (forecast) ------------------------
def get_event_advice(lat, lon, start_local_iso, end_local_iso, unit='fahrenheit', event_type='General'):
    """
    Returns weather forecast for an event window and advice summary.
    Uses Open-Meteo API for forecast.
    """
    try:
        url = 'https://api.open-meteo.com/v1/forecast'
        params = {
            'latitude': lat,
            'longitude': lon,
            'hourly': 'temperature_2m,precipitation,precipitation_probability,cloudcover,windspeed_10m,uv_index',
            'forecast_days': 14,
            'timezone': 'auto'
        }
        resp = requests.get(url, params=params, timeout=30).json()
        hourly = resp.get('hourly', {})
        times = hourly.get('time', [])
        temp_c = hourly.get('temperature_2m', [])
        precip = hourly.get('precipitation', [])
        pop = hourly.get('precipitation_probability', [])
        wind = hourly.get('windspeed_10m', [])
        cloud = hourly.get('cloudcover', [])
        uvi = hourly.get('uv_index', [])

        # Filter hourly data within event window
        def in_window(t):
            return start_local_iso <= t <= end_local_iso

        window = []
        for i, t in enumerate(times):
            if in_window(t):
                entry = {
                    'time': t,
                    'temp_c': temp_c[i] if i < len(temp_c) else None,
                    'precip_mm': precip[i] if i < len(precip) else 0,
                    'pop': pop[i] if i < len(pop) else None,
                    'wind_mph': round((wind[i] if i < len(wind) else 0) * 0.621371, 1),
                    'cloud': cloud[i] if i < len(cloud) else None,
                    'uv': uvi[i] if i < len(uvi) else None
                }
                window.append(entry)

        if not window:
            return {'error': 'No forecast data for the selected window'}, 200

        # Compute metrics
        temps = [x['temp_c'] for x in window if x['temp_c'] is not None]
        max_wind = max([x['wind_mph'] for x in window]) if window else 0
        max_precip = max([x['precip_mm'] for x in window]) if window else 0
        max_pop = max([x['pop'] for x in window if x['pop'] is not None], default=None)
        avg_temp_c = sum(temps)/len(temps) if temps else None

        # Risk scoring
        precip_risk = 'low'
        if (max_pop is not None and max_pop >= 60) or max_precip >= 2:
            precip_risk = 'high'
        elif (max_pop is not None and 30 <= max_pop < 60) or (0.2 <= max_precip < 2):
            precip_risk = 'moderate'

        wind_risk = 'low'
        if max_wind >= 30: wind_risk = 'high'
        elif max_wind >= 15: wind_risk = 'moderate'

        # Temperature comfort thresholds
        comfort_min_c = 10
        comfort_max_c = 30
        if event_type.lower() in ['wedding','outdoor gathering','concert','festival','parade','picnic']:
            comfort_min_c, comfort_max_c = 12, 30
        elif event_type.lower() in ['sports event','hiking trip']:
            comfort_min_c, comfort_max_c = 8, 32

        temp_risk = 'low'
        if avg_temp_c is not None:
            if avg_temp_c < comfort_min_c-2 or avg_temp_c > comfort_max_c+2:
                temp_risk = 'high'
            elif avg_temp_c < comfort_min_c or avg_temp_c > comfort_max_c:
                temp_risk = 'moderate'

        # UV risk
        max_uvi = max([x['uv'] for x in window if x['uv'] is not None], default=0)
        uv_risk = 'low' if max_uvi < 6 else ('moderate' if max_uvi < 8 else 'high')

        favorable = (precip_risk == 'low') and (wind_risk == 'low') and (temp_risk != 'high')

        # Generate suggestions based on risks
        suggestions = []
        if precip_risk == 'high':
            suggestions += ['High rain risk: arrange shelter/tents', 'Consider shifting time to a drier hour']
        elif precip_risk == 'moderate':
            suggestions += ['Showers possible: bring umbrellas/ponchos']

        if wind_risk == 'high':
            suggestions += ['Strong winds: secure structures, avoid lightweight canopies']
        elif wind_risk == 'moderate':
            suggestions += ['Breezy: secure signage/balloons']

        if temp_risk != 'low':
            suggestions += ['Adjust dress code and hydration plan']

        if uv_risk != 'low':
            suggestions += ['Provide sunscreen and shaded areas (UV elevated)']

        # Convert temperatures to user unit
        def to_unit_c(val_c):
            if val_c is None: return None
            return round(val_c, 1)

        def to_unit_f(val_c):
            if val_c is None: return None
            return round((val_c * 9/5) + 32, 1)

        is_c = unit.lower() == 'celsius'
        window_out = []
        for x in window:
            out_temp = to_unit_c(x['temp_c']) if is_c else to_unit_f(x['temp_c'])
            window_out.append({
                'time': x['time'],
                'temp': out_temp,
                'precip_mm': round(x['precip_mm'] or 0, 2),
                'pop': x['pop'],
                'wind_mph': x['wind_mph'],
                'cloud': x['cloud'],
                'uv': x['uv']
            })

        summary = 'Favorable' if favorable else 'Not favorable'

        return {
            'location': {'lat': lat, 'lon': lon},
            'window': {'start': start_local_iso, 'end': end_local_iso},
            'favorable': favorable,
            'summary': summary,
            'risks': {
                'precip': precip_risk,
                'wind': wind_risk,
                'temperature': temp_risk,
                'uv': uv_risk
            },
            'metrics': {
                'max_precip_mm': round(max_precip, 2),
                'max_pop_percent': max_pop,
                'max_wind_mph': max_wind,
                'avg_temp': to_unit_c(avg_temp_c) if is_c else to_unit_f(avg_temp_c),
                'unit': '°C' if is_c else '°F'
            },
            'hourly': window_out,
            'suggestions': suggestions,
            'source': 'Open-Meteo (forecast) + NASA POWER (current/historical)'
        }, 200
    except Exception as e:
        print('Event advice error:', e)
        return {'error': 'Failed to compute event advice'}, 500

# ------------------------ Routes ------------------------
@app.route('/')
def index():
    """Render the main HTML page."""
    return render_template('index.html')

@app.route('/api/weather')
def api_weather():
    """
    API endpoint to fetch current weather and hourly data.
    Query params: lat, lon, location, unit (fahrenheit/celsius), hours
    """
    unit = request.args.get('unit', 'fahrenheit')
    hours = int(request.args.get('hours', 24))
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    location = request.args.get('location', None)

    # Get coordinates if lat/lon not provided
    if lat is None or lon is None:
        lat, lon, display = get_coordinates(location or 'New York, NY')
    else:
        display = f"{lat:.4f}, {lon:.4f}"

    current, hourly, name = get_real_weather_data_by_point(lat, lon, display)
    if current is None:
        return jsonify({'error': 'Unable to fetch weather data'}), 400
    if hourly and hours < len(hourly):
        hourly = hourly[-hours:]

    data = {
        'location': name,
        'current': current,
        'hourly': hourly or [],
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'source': 'NASA POWER API'
    }
    return jsonify(format_weather_response(data, unit))

@app.route('/api/forecast')
def api_forecast():
    """
    API endpoint to fetch recent daily trend forecast (up to 14 days).
    Query params: lat, lon, location, unit, days
    """
    unit = request.args.get('unit', 'fahrenheit')
    days = min(int(request.args.get('days', 7)), 14)
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    location = request.args.get('location', None)

    if lat is None or lon is None:
        lat, lon, display = get_coordinates(location or 'New York, NY')
    else:
        display = f"{lat:.4f}, {lon:.4f}"

    trend = get_real_forecast_trend(lat, lon, days=days)
    if trend is None:
        return jsonify({'error': 'Unable to fetch trend data'}), 400

    data = {
        'location': display,
        'forecast': trend,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'source': 'NASA POWER API'
    }
    return jsonify(format_weather_response(data, unit))

@app.route('/api/historical')
def api_historical():
    """
    API endpoint to fetch historical weather data (up to 365 days).
    Query params: lat, lon, location, unit, days
    """
    unit = request.args.get('unit', 'fahrenheit')
    days = min(int(request.args.get('days', 30)), 365)
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    location = request.args.get('location', None)

    if lat is None or lon is None:
        lat, lon, display = get_coordinates(location or 'New York, NY')
    else:
        display = f"{lat:.4f}, {lon:.4f}"

    # Fetch historical daily data from NASA POWER
    try:
        end = datetime.utcnow()
        start = end - timedelta(days=days)
        url = f'{NASA_BASE_URL}/daily/point'
        params = {
            'parameters': 'T2M,PRECTOTCORR,RH2M',
            'community': 'RE',
            'longitude': lon,
            'latitude': lat,
            'start': start.strftime('%Y%m%d'),
            'end': end.strftime('%Y%m%d'),
            'format': 'JSON'
        }
        resp = requests.get(url, params=params, timeout=30).json()
        if 'properties' not in resp or 'parameter' not in resp['properties']:
            return jsonify({'error': 'Unable to fetch historical data'}), 400
        p = resp['properties']['parameter']

        hist = []
        for dk in sorted(p.get('T2M', {}).keys()):
            d = datetime.strptime(dk, '%Y%m%d')
            t_c = mv(p['T2M'].get(dk), 20)
            t_f = round((t_c * 9/5) + 32)
            precip_mm = max(0, mv(p.get('PRECTOTCORR', {}).get(dk), 0))
            rh = max(0, min(100, mv(p.get('RH2M', {}).get(dk), 60)))
            hist.append({
                'date': d.strftime('%b %d'),
                'avgTemp': t_f,
                'precipitation': round(precip_mm, 2),
                'humidity': rh
            })
        is_c = unit.lower() == 'celsius'
        for h in hist:
            h['avgTemp'] = convert_temp(h['avgTemp'], is_c)
        return jsonify({
            'location': display,
            'historical': hist,
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'source': 'NASA POWER API',
            'unit': '°C' if is_c else '°F'
        })
    except Exception as e:
        print('Historical error:', e)
        return jsonify({'error': 'Unable to fetch historical data'}), 400

@app.route('/api/event-advice')
def api_event_advice():
    """
    API endpoint to get advice for an event based on forecasted weather.
    Query params: lat, lon, location, start, end, unit, eventType
    """
    lat = request.args.get('lat', type=float)
    lon = request.args.get('lon', type=float)
    location = request.args.get('location', None)
    start_local = request.args.get('start')  # 'YYYY-MM-DDTHH:MM'
    end_local = request.args.get('end')
    unit = request.args.get('unit', 'fahrenheit')
    event_type = request.args.get('eventType', 'General')

    # Resolve coordinates if location name provided
    if (lat is None or lon is None) and location:
        lat, lon, _ = get_coordinates(location)
    if lat is None or lon is None or not start_local or not end_local:
        return jsonify({'error': 'lat, lon, start, end are required'}), 400

    advice, status = get_event_advice(lat, lon, start_local, end_local, unit=unit, event_type=event_type)
    return jsonify(advice), status

@app.route('/api/compare')
def api_compare():
    """
    API endpoint to compare weather across multiple locations.
    Query params: locations[], unit
    """
    unit = request.args.get('unit', 'fahrenheit')
    locations = request.args.getlist('locations[]')
    comparison = []
    for loc in locations:
        lat, lon, display = get_coordinates(loc)
        if lat is None or lon is None:
            continue
        current, _, _ = get_real_weather_data_by_point(lat, lon, display)
        if not current:
            continue
        is_c = unit.lower() == 'celsius'
        for k in ['temp','feelsLike','dewPoint','high','low']:
            if k in current and current[k] is not None:
                current[k] = convert_temp(current[k], is_c)
        comparison.append({'location': display, 'weather': current})
    return jsonify({
        'comparison': comparison,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'source': 'NASA POWER API',
        'unit': '°C' if unit.lower() == 'celsius' else '°F'
    })

if __name__ == '__main__':
    # Run Flask app in debug mode on port 5000
    app.run(debug=True, port=5000)
