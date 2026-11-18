# ✈️ Flight Intelligence Dashboard

A full-stack flight search and price comparison application that helps travelers discover affordable flights, compare airlines, and explore travel options through an intuitive dashboard.

## Overview

Flight Intelligence Dashboard is a web application designed to simplify flight research by bringing flight search and price comparison into one place. Users can search for flights between destinations, compare available airlines and prices, and explore both one-way and round-trip travel options.

The project combines a modern React frontend with a Python backend to process flight search requests and present results in an organized interface.

## Features

- **Flight Search:** Search for flights by origin, destination, and travel dates.
- **One-Way and Round-Trip Search:** Switch between different trip types.
- **Flight Price Comparison:** Compare available flight prices across airlines.
- **Airline Information:** View departure and arrival times, flight duration, and number of stops.
- **Cheapest Flight Tracking:** Identify the lowest-priced available flight options.
- **Interactive Dashboard:** Explore flight results through a clean, user-friendly interface.
- **Flight Search History:** Store previous searches using SQLite.

## Tech Stack

**Frontend**
- React
- TypeScript
- Vite
- CSS

**Backend**
- Python
- FastAPI
- SQLite
- REST APIs

## Architecture

The application uses a full-stack architecture:

1. The React frontend collects user search information and displays flight results.
2. The FastAPI backend processes requests and communicates with external flight data services.
3. Flight information is processed and returned to the frontend through REST API endpoints.
4. SQLite stores local application data, including search history.

## Getting Started

### Prerequisites

- Python 3
- Node.js and npm
- Git

### 1. Clone the repository

```bash
git clone https://github.com/pavithrarajan26/flight-intelligence-dashboard.git
cd flight-intelligence-dashboard
```

### 2. Set up the backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Start the backend:

```bash
fastapi dev main.py
```

### 3. Set up the frontend

Open a second terminal window:

```bash
cd flight-intelligence-dashboard/frontend
npm install
npm run dev
```

Open the local URL displayed by Vite in your browser.

## Future Improvements

- Real-time flight price tracking and notifications
- Advanced filtering by airline, price, duration, and number of stops
- Interactive flight price trends and analytics
- User accounts and saved flight searches
- Cloud deployment

## Author

**Pavithra Rajan**  
Computer Science and Engineering Student

[GitHub](https://github.com/pavithrarajan26)
