import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
import sqlite3
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

# Load private API key from backend/.env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

DB_PATH = BASE_DIR / "flight_intelligence.db"
SERPAPI_KEY = os.getenv("SERPAPI_KEY")

# Common city-to-airport conversions.
# You can add more cities as needed.
AIRPORT_CODES = {
    "san francisco": "SFO",
    "sfo": "SFO",
    "new york": "JFK",
    "jfk": "JFK",
    "los angeles": "LAX",
    "lax": "LAX",
    "chicago": "ORD",
    "ord": "ORD",
    "seattle": "SEA",
    "sea": "SEA",
    "boston": "BOS",
    "bos": "BOS",
    "miami": "MIA",
    "mia": "MIA",
    "london": "LHR",
    "lhr": "LHR",
    "paris": "CDG",
    "cdg": "CDG",
    "madrid": "MAD",
    "mad": "MAD",
    "amsterdam": "AMS",
    "ams": "AMS",
    "tokyo": "HND",
    "hnd": "HND",
    "singapore": "SIN",
    "sin": "SIN",
    "toronto": "YYZ",
    "yyz": "YYZ",
    "rome": "FCO",
    "fco": "FCO",
    "dubai": "DXB",
    "dxb": "DXB",
    "vienna": "VIE",
    "vie": "VIE",
}


def connect_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    # return_date is stored as an empty string ("") for one-way trips,
    # so the existing NOT NULL columns keep working without a migration.
    with connect_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            departure_date TEXT NOT NULL,
            return_date TEXT NOT NULL,
            airline TEXT NOT NULL,
            price REAL NOT NULL,
            checked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS price_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            departure_date TEXT NOT NULL,
            return_date TEXT NOT NULL,
            target_price REAL NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        """)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Flight Intelligence API",
    version="2.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def parse_return_date(value: Optional[str]) -> Optional[date]:
    """Turn the return_date text into a date.

    An empty or missing value means a one-way trip and returns None.
    """
    if value is None or not value.strip():
        return None

    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Return date must be in YYYY-MM-DD format or left empty.",
        )


def return_date_text(return_date: Optional[date]) -> str:
    # Stored and returned as "" for one-way trips.
    return str(return_date) if return_date else ""


class AlertRequest(BaseModel):
    origin: str = Field(min_length=1, max_length=100)
    destination: str = Field(min_length=1, max_length=100)
    departure_date: date
    return_date: str = ""  # "" means one way
    target_price: float = Field(gt=0)

    @field_validator("return_date")
    @classmethod
    def check_return_date(cls, value: str) -> str:
        value = (value or "").strip()
        if not value:
            return ""
        try:
            date.fromisoformat(value)
        except ValueError:
            raise ValueError("Return date must be in YYYY-MM-DD format or empty.")
        return value


def validate_trip(departure_date: date, return_date: Optional[date]):
    # One-way trips have no return date, so there is nothing to compare.
    if return_date is not None and return_date < departure_date:
        raise HTTPException(
            status_code=422,
            detail="Return date must be on or after departure date.",
        )


def get_airport_code(city: str):
    # Also accepts an airport code such as SFO or LHR.
    cleaned = city.strip().lower()

    # Allow entries like "San Francisco, CA"
    cleaned = cleaned.split(",")[0].strip()

    airport_code = AIRPORT_CODES.get(cleaned)

    if airport_code:
        return airport_code

    raise HTTPException(
        status_code=400,
        detail=(
            f"Airport not configured for '{city}'. "
            "Try a supported city or a three-letter airport code."
        ),
    )


def search_live_flights(
    origin: str,
    destination: str,
    departure_date: date,
    return_date: Optional[date],
):
    if not SERPAPI_KEY:
        raise HTTPException(
            status_code=500,
            detail="SerpApi key not found. Check your backend .env file.",
        )

    departure_code = get_airport_code(origin)
    arrival_code = get_airport_code(destination)

    parameters = {
        "engine": "google_flights",
        "departure_id": departure_code,
        "arrival_id": arrival_code,
        "outbound_date": str(departure_date),
        # SerpApi Google Flights: type 1 = round trip, type 2 = one way.
        "type": "1" if return_date else "2",
        "currency": "USD",
        "hl": "en",
        "gl": "us",
        "api_key": SERPAPI_KEY,
    }

    # Only round trips send a return date to SerpApi.
    if return_date:
        parameters["return_date"] = str(return_date)

    try:
        response = requests.get(
            "https://serpapi.com/search.json",
            params=parameters,
            timeout=45,
        )
        response.raise_for_status()
        data = response.json()

    except requests.Timeout:
        raise HTTPException(
            status_code=504,
            detail="Flight search timed out. Please try again.",
        )

    except requests.RequestException:
        raise HTTPException(
            status_code=502,
            detail="Could not connect to the flight search provider.",
        )

    if data.get("error"):
        raise HTTPException(
            status_code=502,
            detail=f"Flight search provider error: {data['error']}",
        )

    # Google Flights separates results into best_flights
    # and other_flights.
    raw_flights = (
        data.get("best_flights", [])
        + data.get("other_flights", [])
    )

    flights = []

    for itinerary in raw_flights:
        segments = itinerary.get("flights", [])

        if not segments:
            continue

        airlines = list(dict.fromkeys(
            segment.get("airline", "Unknown airline")
            for segment in segments
        ))

        first_segment = segments[0]
        last_segment = segments[-1]

        price = itinerary.get("price")

        if price is None:
            continue

        flight = {
            "airline": ", ".join(airlines),
            "price": float(price),
            "departure_time": first_segment.get(
                "departure_airport", {}
            ).get("time"),
            "arrival_time": last_segment.get(
                "arrival_airport", {}
            ).get("time"),
            "duration": itinerary.get("total_duration"),
            "stops": max(0, len(segments) - 1),
            "departure_airport": departure_code,
            "arrival_airport": arrival_code,
            "booking_token": itinerary.get("booking_token"),
        }

        flights.append(flight)

    flights.sort(key=lambda flight: flight["price"])

    if not flights:
        raise HTTPException(
            status_code=404,
            detail=(
                "No flight offers were returned for these dates. "
                "Try different dates or airports."
            ),
        )

    return flights


@app.get("/")
def home():
    return {
        "message": "Flight Intelligence API is running!",
        "project": "Flight Intelligence Dashboard",
        "data_mode": "live Google Flights search through SerpApi",
    }


@app.get("/flights/destinations")
def destinations():
    return {
        "destinations": sorted({
            "San Francisco",
            "New York",
            "Los Angeles",
            "Chicago",
            "Seattle",
            "Boston",
            "Miami",
            "London",
            "Paris",
            "Madrid",
            "Amsterdam",
            "Tokyo",
            "Singapore",
            "Toronto",
            "Rome",
            "Dubai",
            "Vienna",
        })
    }


@app.get("/flights/search")
def search_flights(
    origin: str,
    destination: str,
    departure_date: date,
    return_date: str = "",
):
    parsed_return = parse_return_date(return_date)
    validate_trip(departure_date, parsed_return)

    results = search_live_flights(
        origin,
        destination,
        departure_date,
        parsed_return,
    )

    return {
        "origin": origin.strip(),
        "destination": destination.strip(),
        "departure_date": str(departure_date),
        "return_date": return_date_text(parsed_return),
        "data_mode": "live",
        "message": None,
        "cheapest_flight": results[0],
        "all_flights": results,
    }


@app.post("/flights/track")
def track_flight_price(
    origin: str,
    destination: str,
    departure_date: date,
    return_date: str = "",
):
    parsed_return = parse_return_date(return_date)
    validate_trip(departure_date, parsed_return)
    return_text = return_date_text(parsed_return)

    results = search_live_flights(
        origin,
        destination,
        departure_date,
        parsed_return,
    )

    cheapest = results[0]
    checked_at = datetime.now(timezone.utc).isoformat()

    with connect_db() as db:
        cursor = db.execute(
            """INSERT INTO price_history
            (origin, destination, departure_date, return_date,
             airline, price, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                origin.strip(),
                destination.strip(),
                str(departure_date),
                return_text,
                cheapest["airline"],
                cheapest["price"],
                checked_at,
            ),
        )

        record_id = cursor.lastrowid

        rows = db.execute(
            """SELECT target_price FROM price_alerts
            WHERE active = 1
            AND lower(origin) = lower(?)
            AND lower(destination) = lower(?)
            AND departure_date = ?
            AND return_date = ?""",
            (
                origin.strip(),
                destination.strip(),
                str(departure_date),
                return_text,
            ),
        ).fetchall()

    triggered = [
        row["target_price"]
        for row in rows
        if cheapest["price"] <= row["target_price"]
    ]

    return {
        "message": "Live flight price recorded successfully.",
        "record": {
            "id": record_id,
            "origin": origin.strip(),
            "destination": destination.strip(),
            "departure_date": str(departure_date),
            "return_date": return_text,
            "airline": cheapest["airline"],
            "price": cheapest["price"],
            "checked_at": checked_at,
        },
        "alerts_triggered": triggered,
        "note": "Price recorded from a live search at the time of this request.",
    }


@app.get("/flights/history")
def get_flight_history(
    origin: str,
    destination: str,
    departure_date: date,
    return_date: str = "",
):
    parsed_return = parse_return_date(return_date)
    return_text = return_date_text(parsed_return)

    with connect_db() as db:
        rows = db.execute(
            """SELECT id, origin, destination, departure_date,
            return_date, airline, price, checked_at
            FROM price_history
            WHERE lower(origin) = lower(?)
            AND lower(destination) = lower(?)
            AND departure_date = ?
            AND return_date = ?
            ORDER BY checked_at ASC""",
            (
                origin.strip(),
                destination.strip(),
                str(departure_date),
                return_text,
            ),
        ).fetchall()

    return {
        "origin": origin.strip(),
        "destination": destination.strip(),
        "departure_date": str(departure_date),
        "return_date": return_text,
        "history": [dict(row) for row in rows],
    }


@app.post("/flights/alerts")
def create_price_alert(alert: AlertRequest):
    parsed_return = parse_return_date(alert.return_date)
    validate_trip(alert.departure_date, parsed_return)

    with connect_db() as db:
        cursor = db.execute(
            """INSERT INTO price_alerts
            (origin, destination, departure_date, return_date,
             target_price, active, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)""",
            (
                alert.origin.strip(),
                alert.destination.strip(),
                str(alert.departure_date),
                return_date_text(parsed_return),
                alert.target_price,
                datetime.now(timezone.utc).isoformat(),
            ),
        )

        alert_id = cursor.lastrowid

    return {
        "message": "Price alert created.",
        "id": alert_id,
        **alert.model_dump(mode="json"),
        "active": True,
    }


@app.get("/flights/alerts")
def list_price_alerts():
    with connect_db() as db:
        rows = db.execute(
            "SELECT * FROM price_alerts ORDER BY created_at DESC"
        ).fetchall()

    return {"alerts": [dict(row) for row in rows]}


@app.delete("/flights/alerts/{alert_id}")
def delete_price_alert(alert_id: int):
    with connect_db() as db:
        cursor = db.execute(
            "DELETE FROM price_alerts WHERE id = ?",
            (alert_id,),
        )

    if cursor.rowcount == 0:
        raise HTTPException(
            status_code=404,
            detail="Alert not found.",
        )

    return {"message": "Alert deleted.", "id": alert_id}