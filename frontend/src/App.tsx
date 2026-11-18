import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";

type TripType = "one-way" | "round-trip";

type Flight = {
  airline: string;
  price: number;
  departure_time: string | null;
  arrival_time: string | null;
  duration: number | null;
  stops: number;
  departure_airport: string;
  arrival_airport: string;
  booking_token?: string | null;
};

type SearchResults = {
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  data_mode: string;
  message: string | null;
  cheapest_flight: Flight;
  all_flights: Flight[];
};

type PriceRecord = {
  id: number;
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  airline: string;
  price: number;
  checked_at: string;
};

type PriceAlert = {
  id: number;
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  target_price: number;
  active: number | boolean;
};

function dateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const today = new Date();
const defaultDeparture = new Date(today);
defaultDeparture.setDate(today.getDate() + 14);
const defaultReturn = new Date(defaultDeparture);
defaultReturn.setDate(defaultDeparture.getDate() + 7);

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDuration(minutes: number | null): string {
  if (minutes === null || Number.isNaN(minutes)) return "Duration unavailable";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatClock(value: string | null): string {
  if (!value) return "—";
  // SerpApi times look like "2026-12-01 14:35"; also accept ISO "T" format.
  const match = value.match(/[T ](\d{2}):(\d{2})/);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function formatDate(value: string): string {
  if (!value) return "";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function stopsLabel(stops: number): string {
  if (stops === 0) return "Nonstop";
  return stops === 1 ? "1 stop" : `${stops} stops`;
}

async function readError(response: Response): Promise<string> {
  try {
    const data: { detail?: string | { msg?: string }[]; message?: string } =
      await response.json();
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail.map((item) => item.msg ?? "Invalid input").join(", ");
    }
    return data.message ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function App() {
  const [origin, setOrigin] = useState("San Francisco");
  const [destination, setDestination] = useState("London");
  const [departureDate, setDepartureDate] = useState(dateString(defaultDeparture));
  const [returnDate, setReturnDate] = useState(dateString(defaultReturn));
  const [tripType, setTripType] = useState<TripType>("round-trip");

  const [results, setResults] = useState<SearchResults | null>(null);
  const [history, setHistory] = useState<PriceRecord[]>([]);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [maxPrice, setMaxPrice] = useState("");
  const [stopFilter, setStopFilter] = useState("any");
  const [airlineFilter, setAirlineFilter] = useState("all");
  const [sortBy, setSortBy] = useState("price");
  const [targetPrice, setTargetPrice] = useState("");
  const [loading, setLoading] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // The label shown in results comes from the search that was actually run,
  // not from the toggle, so results stay correct if you flip the toggle later.
  const resultsAreRoundTrip = Boolean(results && results.return_date);
  const resultsTripLabel = resultsAreRoundTrip ? "Round trip" : "One way";

  const airlines = useMemo(
    () => [...new Set((results?.all_flights ?? []).map((flight) => flight.airline))].sort(),
    [results],
  );

  const visibleFlights = useMemo(() => {
    if (!results) return [];
    let flights = [...results.all_flights];

    if (maxPrice.trim()) {
      const ceiling = Number(maxPrice);
      if (Number.isFinite(ceiling)) {
        flights = flights.filter((flight) => flight.price <= ceiling);
      }
    }

    if (stopFilter === "nonstop") {
      flights = flights.filter((flight) => flight.stops === 0);
    } else if (stopFilter === "1stop") {
      flights = flights.filter((flight) => flight.stops === 1);
    } else if (stopFilter === "2plus") {
      flights = flights.filter((flight) => flight.stops >= 2);
    }

    if (airlineFilter !== "all") {
      flights = flights.filter((flight) => flight.airline === airlineFilter);
    }

    if (sortBy === "duration") {
      flights.sort((a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity));
    } else if (sortBy === "stops") {
      flights.sort((a, b) => a.stops - b.stops || a.price - b.price);
    } else {
      flights.sort((a, b) => a.price - b.price);
    }
    return flights;
  }, [results, maxPrice, stopFilter, airlineFilter, sortBy]);

  const lowestHistory = history.length
    ? Math.min(...history.map((record) => record.price))
    : null;
  const highestHistory = history.length
    ? Math.max(...history.map((record) => record.price))
    : 0;
  const historyRange =
    lowestHistory !== null ? highestHistory - lowestHistory : null;

  async function loadAlerts(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/flights/alerts`);
      if (!response.ok) throw new Error(await readError(response));
      const data: { alerts: PriceAlert[] } = await response.json();
      setAlerts(data.alerts ?? []);
    } catch (loadError) {
      console.error("Could not load price alerts:", loadError);
    }
  }

  async function loadHistory(
    tripOrigin: string,
    tripDestination: string,
    tripDeparture: string,
    tripReturn: string,
  ): Promise<void> {
    const query = new URLSearchParams({
      origin: tripOrigin,
      destination: tripDestination,
      departure_date: tripDeparture,
      return_date: tripReturn, // "" means one way
    });
    const response = await fetch(`${API_BASE}/flights/history?${query.toString()}`);
    if (!response.ok) throw new Error(await readError(response));
    const data: { history: PriceRecord[] } = await response.json();
    setHistory(data.history ?? []);
  }

  useEffect(() => {
    void loadAlerts();
  }, []);

  function handleDepartureChange(value: string): void {
    setDepartureDate(value);
    // Keep the return date from ending up before the departure date.
    if (value && returnDate && returnDate < value) {
      setReturnDate(value);
    }
  }

  async function searchFlights(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setNotice("");

    const isRoundTrip = tripType === "round-trip";
    const returnValue = isRoundTrip ? returnDate : "";

    if (isRoundTrip && !returnDate) {
      setError("Please choose a return date for a round trip.");
      return;
    }
    if (isRoundTrip && returnDate < departureDate) {
      setError("Return date must be on or after the departure date.");
      return;
    }

    setLoading(true);
    setResults(null);
    setHistory([]);

    const query = new URLSearchParams({
      origin: origin.trim(),
      destination: destination.trim(),
      departure_date: departureDate,
      return_date: returnValue,
    });

    try {
      const response = await fetch(`${API_BASE}/flights/search?${query.toString()}`);
      if (!response.ok) throw new Error(await readError(response));
      const data: SearchResults = await response.json();
      setResults(data);

      // History and alerts are extras; a failure here should not hide the results.
      try {
        await loadHistory(
          data.origin,
          data.destination,
          data.departure_date,
          data.return_date ?? "",
        );
      } catch (historyError) {
        console.error("Could not load price history:", historyError);
      }
      await loadAlerts();
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Unable to search flights.");
    } finally {
      setLoading(false);
    }
  }

  async function trackPrice(): Promise<void> {
    if (!results) return;
    setTracking(true);
    setError("");
    setNotice("");

    const query = new URLSearchParams({
      origin: results.origin,
      destination: results.destination,
      departure_date: results.departure_date,
      return_date: results.return_date ?? "",
    });

    try {
      const response = await fetch(`${API_BASE}/flights/track?${query.toString()}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response));
      const data: { message: string; alerts_triggered: number[] } = await response.json();
      await loadHistory(
        results.origin,
        results.destination,
        results.departure_date,
        results.return_date ?? "",
      );
      await loadAlerts();
      setNotice(
        data.alerts_triggered.length
          ? `Price recorded. Your target was reached for ${data.alerts_triggered.map((price) => `$${formatPrice(price)}`).join(", ")}.`
          : "Current live price saved to your price history.",
      );
    } catch (trackError) {
      setError(trackError instanceof Error ? trackError.message : "Could not record this price.");
    } finally {
      setTracking(false);
    }
  }

  async function createAlert(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!results || !targetPrice) return;
    setSavingAlert(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`${API_BASE}/flights/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: results.origin,
          destination: results.destination,
          departure_date: results.departure_date,
          return_date: results.return_date ?? "",
          target_price: Number(targetPrice),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadAlerts();
      setTargetPrice("");
      setNotice("Your price alert has been created.");
    } catch (alertError) {
      setError(alertError instanceof Error ? alertError.message : "Could not create the alert.");
    } finally {
      setSavingAlert(false);
    }
  }

  async function deleteAlert(alertId: number): Promise<void> {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${API_BASE}/flights/alerts/${alertId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      await loadAlerts();
      setNotice("Price alert removed.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not remove the alert.");
    }
  }

  function resetFilters(): void {
    setMaxPrice("");
    setStopFilter("any");
    setAirlineFilter("all");
    setSortBy("price");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Flight Intelligence home">
          <span className="brand-mark">✈</span>
          <span>Flight<span className="brand-light">Intelligence</span></span>
        </a>
        <span className="connection-pill">
          <span className="connection-dot" />
          Live search connected
        </span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">FLIGHT INTELLIGENCE · SMARTER TRAVEL</p>
          <h1>Find the flight.<br /><span>Not just the fare.</span></h1>
          <p className="hero-description">
            Compare live flight options, spot the best value, and keep an eye on prices for your next trip.
          </p>
          <div className="hero-trust"><span>✦ Live fares</span><span>↗ Price insights</span><span>⌖ Custom alerts</span></div>
        </div>

        <form className="search-panel" onSubmit={searchFlights}>
          <div className="search-panel-heading">
            <div><span className="panel-icon">✈</span><strong>Where do you want to go?</strong></div>
          </div>

          <div className="trip-toggle" role="group" aria-label="Trip type">
            <button
              type="button"
              className={`trip-toggle-button ${tripType === "one-way" ? "active" : ""}`}
              aria-pressed={tripType === "one-way"}
              onClick={() => setTripType("one-way")}
            >
              One Way
            </button>
            <button
              type="button"
              className={`trip-toggle-button ${tripType === "round-trip" ? "active" : ""}`}
              aria-pressed={tripType === "round-trip"}
              onClick={() => setTripType("round-trip")}
            >
              Round Trip
            </button>
          </div>

          <div className={`search-fields ${tripType === "one-way" ? "one-way" : ""}`}>
            <div className="field">
              <label htmlFor="origin">FROM</label>
              <input
                id="origin"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="Departure city"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="destination">TO</label>
              <input
                id="destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="Destination city"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="departure">DEPARTURE</label>
              <input
                id="departure"
                type="date"
                value={departureDate}
                min={dateString(today)}
                onChange={(event) => handleDepartureChange(event.target.value)}
                required
              />
            </div>
            {tripType === "round-trip" && (
              <div className="field">
                <label htmlFor="return">RETURN</label>
                <input
                  id="return"
                  type="date"
                  value={returnDate}
                  min={departureDate}
                  onChange={(event) => setReturnDate(event.target.value)}
                  required
                />
              </div>
            )}
          </div>

          <button className="primary-button search-button" type="submit" disabled={loading}>
            {loading ? <><span className="spinner" /> Searching live flights...</> : "Search flights  →"}
          </button>
          <p className="search-footnote">Searches live Google Flights data through SerpApi.</p>
        </form>
      </section>

      {error && (
        <div className="alert-message error-message">
          <strong>Something went wrong</strong>
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="alert-message success-message">
          <strong>Update</strong>
          <span>{notice}</span>
        </div>
      )}

      {results && (
        <section className="results-section">
          <div className="results-title-row">
            <div>
              <p className="eyebrow">YOUR SEARCH RESULTS</p>
              <h2>{results.origin} <span className="route-arrow">→</span> {results.destination}</h2>
              <p className="results-dates">
                {formatDate(results.departure_date)}
                {resultsAreRoundTrip ? (
                  <> <span>→</span> {formatDate(results.return_date)}</>
                ) : null}
                {" "}<span>·</span> {resultsTripLabel}
              </p>
            </div>
            <span className="live-badge"><span /> LIVE FLIGHT DATA</span>
          </div>

          {results.cheapest_flight && (
            <div className="best-deal-card">
              <div className="best-deal-main">
                <div className="best-deal-label"><span>✦</span> LOWEST AVAILABLE FARE</div>
                <h3>{results.cheapest_flight.airline}</h3>
                <p>
                  {results.cheapest_flight.departure_airport} <span>→</span> {results.cheapest_flight.arrival_airport}
                  {" · "}{stopsLabel(results.cheapest_flight.stops)}
                  {" · "}{formatDuration(results.cheapest_flight.duration)}
                </p>
              </div>
              <div className="best-deal-price">
                <span>{resultsTripLabel} from</span>
                <strong>${formatPrice(results.cheapest_flight.price)}</strong>
                <small>per traveler · USD</small>
              </div>
            </div>
          )}

          <div className="flight-section-heading">
            <div>
              <h3>Available flights</h3>
              <p>{visibleFlights.length} of {results.all_flights.length} options · Prices in USD</p>
            </div>
            <button className="text-button" type="button" onClick={resetFilters}>Reset filters</button>
          </div>

          <div className="filter-panel">
            <div className="filter-control">
              <label htmlFor="maxPrice">MAXIMUM PRICE</label>
              <div className="input-with-prefix">
                <span>$</span>
                <input
                  id="maxPrice"
                  type="number"
                  min="1"
                  placeholder="Any price"
                  value={maxPrice}
                  onChange={(event) => setMaxPrice(event.target.value)}
                />
              </div>
            </div>
            <div className="filter-control">
              <label htmlFor="stopFilter">STOPS</label>
              <select id="stopFilter" value={stopFilter} onChange={(event) => setStopFilter(event.target.value)}>
                <option value="any">Any stops</option>
                <option value="nonstop">Nonstop only</option>
                <option value="1stop">1 stop</option>
                <option value="2plus">2+ stops</option>
              </select>
            </div>
            <div className="filter-control">
              <label htmlFor="airlineFilter">AIRLINE</label>
              <select id="airlineFilter" value={airlineFilter} onChange={(event) => setAirlineFilter(event.target.value)}>
                <option value="all">All airlines</option>
                {airlines.map((airline) => (
                  <option value={airline} key={airline}>{airline}</option>
                ))}
              </select>
            </div>
            <div className="filter-control">
              <label htmlFor="sortBy">SORT BY</label>
              <select id="sortBy" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="price">Lowest price</option>
                <option value="duration">Shortest duration</option>
                <option value="stops">Fewest stops</option>
              </select>
            </div>
          </div>

          <div className="flight-cards">
            {visibleFlights.map((flight, index) => (
              <article
                className={`flight-card ${index === 0 && sortBy === "price" ? "top-flight" : ""}`}
                key={`${flight.airline}-${flight.departure_time}-${index}`}
              >
                <div className="flight-airline">
                  <span className="airline-avatar">
                    {flight.airline.split(/[\s,]+/).map((word) => word[0]).slice(0, 2).join("").toUpperCase()}
                  </span>
                  <div>
                    <strong>{flight.airline}</strong>
                    <span>{flight.stops === 0 ? "Nonstop flight" : stopsLabel(flight.stops)}</span>
                  </div>
                </div>
                <div className="flight-route">
                  <div className="flight-time">
                    <strong>{formatClock(flight.departure_time)}</strong>
                    <span>{flight.departure_airport}</span>
                  </div>
                  <div className="route-visual">
                    <span>{formatDuration(flight.duration)}</span>
                    <div className="route-line"><i /></div>
                    <small>{stopsLabel(flight.stops)}</small>
                  </div>
                  <div className="flight-time arrival-time">
                    <strong>{formatClock(flight.arrival_time)}</strong>
                    <span>{flight.arrival_airport}</span>
                  </div>
                </div>
                <div className="flight-card-price">
                  <strong>${formatPrice(flight.price)}</strong>
                  <span>{resultsTripLabel}</span>
                  {index === 0 && sortBy === "price" && <em>Lowest price</em>}
                </div>
              </article>
            ))}
            {visibleFlights.length === 0 && (
              <div className="empty-filter">
                <strong>No flights match those filters.</strong>
                <span>Try increasing your price limit or changing the stops or airline filters.</span>
              </div>
            )}
          </div>

          <section className="tracking-grid">
            <article className="tool-card">
              <div className="tool-card-heading">
                <span className="tool-icon">↗</span>
                <div><p className="eyebrow">PRICE TRACKER</p><h3>Track this route</h3></div>
              </div>
              <p className="tool-description">Save the current lowest live fare to build a price history for this trip.</p>
              <button
                className="primary-button full-button"
                type="button"
                onClick={() => void trackPrice()}
                disabled={tracking || !results.cheapest_flight}
              >
                {tracking ? "Recording price..." : "＋ Record current price"}
              </button>
              {history.length > 0 && (
                <p className="inline-note">{history.length} price snapshot(s) saved for this trip.</p>
              )}
            </article>

            <article className="tool-card">
              <div className="tool-card-heading">
                <span className="tool-icon">⌖</span>
                <div><p className="eyebrow">PRICE ALERT</p><h3>Set a target</h3></div>
              </div>
              <p className="tool-description">Create a price target. It is checked whenever you record a new price.</p>
              <form className="target-form" onSubmit={createAlert}>
                <div className="input-with-prefix">
                  <span>$</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={targetPrice}
                    onChange={(event) => setTargetPrice(event.target.value)}
                    aria-label="Target price in dollars"
                    placeholder="Target price"
                    required
                  />
                </div>
                <button className="secondary-button" type="submit" disabled={savingAlert}>
                  {savingAlert ? "Saving..." : "Create alert"}
                </button>
              </form>
            </article>
          </section>

          <section className="history-section">
            <div className="section-heading-inline">
              <div><p className="eyebrow">YOUR SAVED DATA</p><h3>Price history</h3></div>
              {lowestHistory !== null && (
                <span className="history-low">Lowest recorded · ${formatPrice(lowestHistory)}</span>
              )}
            </div>
            {history.length > 0 ? (
              <div className="history-card">
                <div className="history-summary">
                  <div><span>Saved snapshots</span><strong>{history.length}</strong></div>
                  <div>
                    <span>Lowest recorded</span>
                    <strong>{lowestHistory === null ? "—" : `$${formatPrice(lowestHistory)}`}</strong>
                  </div>
                  {historyRange !== null && (
                    <div><span>High-to-low range</span><strong>${formatPrice(historyRange)}</strong></div>
                  )}
                </div>
                <div className="history-bars">
                  {history.map((item, index) => (
                    <div className="history-bar-column" key={item.id}>
                      <strong>${formatPrice(item.price)}</strong>
                      <div className="history-bar-track">
                        <i style={{ height: `${Math.max(8, (item.price / Math.max(highestHistory, 1)) * 100)}%` }} />
                      </div>
                      <span>{index + 1}</span>
                    </div>
                  ))}
                </div>
                <div className="history-records">
                  {[...history].reverse().map((item) => (
                    <div className="history-record" key={item.id}>
                      <div><strong>{item.airline}</strong><span>{formatTimestamp(item.checked_at)}</span></div>
                      <strong>${formatPrice(item.price)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-state">No saved prices yet. Record the current price to start building your history.</p>
            )}
          </section>

          <section className="history-section alerts-section">
            <div className="section-heading-inline">
              <div><p className="eyebrow">PRICE TARGETS</p><h3>Your alerts</h3></div>
              <span className="alert-count">{alerts.filter((alert) => Boolean(alert.active)).length} active</span>
            </div>
            {alerts.length > 0 ? (
              <div className="alert-list">
                {alerts.map((alert) => (
                  <div className="saved-alert" key={alert.id}>
                    <div className="alert-symbol">⌖</div>
                    <div className="saved-alert-info">
                      <strong>Price at or below ${formatPrice(alert.target_price)}</strong>
                      <span>
                        {alert.origin} → {alert.destination} · {formatDate(alert.departure_date)}
                        {" · "}{alert.return_date ? "Round trip" : "One way"}
                      </span>
                    </div>
                    <button className="delete-button" type="button" onClick={() => void deleteAlert(alert.id)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">No price alerts yet. Set a target above after searching for a trip.</p>
            )}
          </section>
        </section>
      )}

      {!results && !loading && (
        <section className="empty-welcome">
          <div className="welcome-icon">✈</div>
          <h2>Your next trip starts here.</h2>
          <p>Enter your route and dates above to compare live flight options and find the right balance of price, time, and convenience.</p>
          <div className="welcome-features"><span>✦ Live flight prices</span><span>↗ Price tracking</span><span>⌖ Custom alerts</span></div>
        </section>
      )}

      <footer className="footer">
        <strong>Flight Intelligence</strong>
        <span>Live flight search powered by SerpApi · Prices and availability can change.</span>
      </footer>
    </main>
  );
}

export default App;