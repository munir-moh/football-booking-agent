# Football Booking Agent

A small React/Vite chat website and Python/Flask service that uses the existing football booking backend. The agent has no direct database connection and does not collect card details. The backend still checks the slot when it creates a Paystack checkout and remains responsible for payment verification and booking confirmation.

## What the agent does

- Uses `POST /api/ai/chat` for availability checks.
- Uses `POST /api/book` to initialize checkout after the user gives a complete booking request. The agent uses the saved profile below, so it does not ask for name, email, or phone every time.
- Uses `GET /api/payment/verify/<reference>` through its payment-status endpoint after returning from checkout.
- Shows the payment confirmation inside the agent website when the backend returns the user to its `/payment-callback` page.

Agent bookings send `client: "agent"` to the backend. The backend returns those Paystack checkouts to the server-configured `AGENT_FRONTEND_URL/payment-callback`; normal website requests still use `FRONTEND_URL/payment-callback`.

The agent only displays checkout when the backend confirms `callback_client: "agent"`. This prevents an older backend deployment from silently sending an agent payment back to the normal website.

## Run locally

You need Python 3.10+ and Node.js with npm.

### 1. Configure the agent

Open PowerShell in this folder and run:

    Copy-Item .env.example .env
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt

If you created `.env` before this update, set `AGENT_ALLOWED_ORIGINS=http://localhost:5174` there to match the agent website's local port.

Edit the private `.env` file and add your booking details once:

    BOOKER_NAME=Your full name
    BOOKER_EMAIL=you@example.com
    BOOKER_PHONE=08031234567

Use the phone format expected by the existing booking site: 11 digits. These values are read by the agent service and sent to the existing backend only when you ask it to book. `.env` is excluded from Git; do not put personal details in `.env.example` or share the `.env` file. Restart the agent after editing it.

The example points to the documented deployed backend. To use a locally running backend instead, set this in `.env`:

    FOOTBALL_BACKEND_API_URL=http://127.0.0.1:5000

Do not copy the backend's Paystack secret, admin password, or database credentials into this project.

### 2. Start the agent API

In a PowerShell window in this folder:

    .\.venv\Scripts\python.exe app.py

The agent API listens at `http://127.0.0.1:5001`.

### 3. Start the chat website

Open a second PowerShell window:

    Set-Location .\frontend
    npm install
    npm run dev

Open `http://localhost:5174`.

For a deployed frontend, set `VITE_AGENT_API_URL` to the deployed agent API URL at build time, and set `AGENT_ALLOWED_ORIGINS` in the agent API environment to the deployed website origin. The deployment must serve the app for the `/payment-callback` path as well as `/`.

For local payment returns, point the agent's `FOOTBALL_BACKEND_API_URL` at your locally running backend, set `AGENT_FRONTEND_URL=http://localhost:5174` in the backend's `.env`, and restart the backend. For a deployment, deploy this backend change and set `AGENT_FRONTEND_URL` to the deployed agent website origin in the backend host's environment settings. Keep `FRONTEND_URL` set to the normal booking website origin.

This prototype has no user login. Keep the agent API local for now; CORS and rate limiting do not stop non-browser callers from using an exposed API. Add authentication before making the API publicly reachable, because it can create checkouts using the saved profile.

## Step-by-step tryout

1. Confirm `.env` has your name, email, and 11-digit phone number, and restart the agent API.
2. Open the agent chat and ask: `Is Elite Pitch available tomorrow at 6 PM for one hour?` This checks availability only.
3. To initialize a booking, ask for a complete slot, for example: `Book two hours for me tomorrow from 3 to 5 p.m.` The agent checks availability and, if available, immediately asks the backend to create the Paystack checkout. It should not ask for your name, email, or phone again.
4. Confirm the pitch, date, time, and price in the reply. The agent shows a Paystack link. Opening it starts the existing payment flow; card details are entered only on Paystack.
5. Complete payment on Paystack. The return should open the agent at `/payment-callback`; it then checks the reference with the backend and displays the confirmed status. Normal website bookings continue returning to the normal website.

Availability checks do not create bookings. Steps 3–4 do create a booking/payment initialization on the backend, even though the card payment is completed separately on Paystack. Use an available future slot and Paystack test credentials for a full checkout test.

## Current limits

- The backend has one pitch and no endpoint that lists every available time slot. The agent checks a specific requested time and does not invent a daily schedule.
- The backend's `/api/ai/chat` route is rate-limited, so this prototype is for low traffic.
- Conversation drafts are held in memory and expire after one hour. Restarting the agent clears them.
- The backend's payment verification flow can record a non-success response as `Failed`, and a later webhook may not update that record. If you completed payment but the agent reports `Failed`, do not pay again until the booking service has been checked.
- The backend accepts only the fixed `client` values `website` and `agent`; it never accepts an arbitrary callback URL from the agent. The existing frontend files are unchanged.
