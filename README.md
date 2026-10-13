# Football Booking Agent

A small React/Vite chat website and Python/Flask API that works with the existing football booking backend. Users create an account with their name, email, phone number, and password. The agent saves the profile in Supabase Postgres and uses it when starting bookings, so it does not ask for those details in chat.

The agent calls the existing backend for availability, booking creation, and payment verification. It never connects to the football backend's database directly and never handles card numbers, CVV, PIN, or OTP. The user completes payment on the normal Paystack checkout page.

## Account behavior

- Registration requires a name, email, 11-digit phone number, and password of at least 8 characters.
- Passwords are stored as Werkzeug password hashes, not plain text.
- Login errors display `Incorrect email or password` for either a missing email or a wrong password.
- Successful login creates a 14-day bearer session. The browser holds the session token in `sessionStorage`; the database stores only its SHA-256 hash.
- Registration does not currently send email verification or provide password reset.
- The agent creates three tables (`booking_agent_users`, `booking_agent_sessions`, and `booking_agent_bookings`) in Supabase the first time account storage is used. The configured Postgres user must be allowed to create tables and indexes.
- Each Paystack reference is linked to the account that started the booking. Payment status checks only work for references owned by that account.

## Local setup

You need Python 3.10+ and Node.js with npm.

### 1. Create a Supabase database

1. Create a Supabase project.
2. In the Supabase project, choose **Connect** and copy a Postgres connection string. For a Render deployment, use the **Session pooler** connection if the service cannot connect to Supabase's direct endpoint over IPv6. The pooler string and database password come from the Supabase dashboard; percent-encode reserved characters in the password.
3. Keep this string private. It belongs only in the Flask agent's environment, never in the Vite frontend or GitHub.

Supabase's [database connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) explains the connection choices and where to copy each URI.

### 2. Configure and install the agent API

Open PowerShell in this project folder:

```powershell
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Set these values in the private `.env` file:

```dotenv
FOOTBALL_BACKEND_API_URL=https://football-booking-system.onrender.com
SUPABASE_DATABASE_URL=postgresql://...copied-from-supabase...
AGENT_ALLOWED_ORIGINS=http://localhost:5174
```

For a local football backend, use `FOOTBALL_BACKEND_API_URL=http://127.0.0.1:5000`. The former `BOOKER_NAME`, `BOOKER_EMAIL`, and `BOOKER_PHONE` settings are no longer used; remove any old copies from `.env`. The agent reads each profile from the account database instead.

Start the agent API in this PowerShell window:

```powershell
.\.venv\Scripts\python.exe app.py
```

It listens at `http://127.0.0.1:5001`.

### 3. Start the website

Open a second PowerShell window:

```powershell
Set-Location .\frontend
npm install
npm run dev
```

Open [http://localhost:5174](http://localhost:5174), create an account, then log in. If the backend returns `Incorrect email or password`, check both fields and try again.

## Deploy the agent

### Render: agent API

Deploy the `football-booking-agent` repository as a Python web service on Render. Use:

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app`

Add these Render environment variables:

| Variable | Value |
| --- | --- |
| `FOOTBALL_BACKEND_API_URL` | Public URL of the existing football backend, without a trailing slash |
| `SUPABASE_DATABASE_URL` | Supabase Postgres connection URI copied from **Connect**; use Session pooler if required by the Render network |
| `AGENT_ALLOWED_ORIGINS` | The exact deployed agent website origin, such as `https://your-agent.vercel.app` |

Render supplies `PORT`. Do not set `BOOKER_NAME`, `BOOKER_EMAIL`, or `BOOKER_PHONE`; user details are per-account in Postgres. Do not place `SUPABASE_DATABASE_URL` in Vercel or expose it to the browser.

### Vercel: agent website

1. Import the agent repository into Vercel.
2. Set the project Root Directory to `frontend`.
3. Use build command `npm run build` and output directory `dist`.
4. Set `VITE_AGENT_API_URL` to the public Render URL of the agent API, without `/api` or a trailing slash.
5. Deploy. If Vercel provides a different website origin, add that exact origin to `AGENT_ALLOWED_ORIGINS` on Render and redeploy the API.

The Vite app also has a local default for `VITE_AGENT_API_URL` (`http://127.0.0.1:5001`). No database URL or Supabase secret belongs in this frontend variable.

### Existing booking backend: Paystack return

The existing backend must already support agent checkout callbacks. On the existing backend's Render service, keep its normal `FRONTEND_URL` unchanged and set `AGENT_FRONTEND_URL` to the agent website origin. Agent bookings send `client: "agent"`; normal website bookings continue using the normal website callback. The agent only displays a checkout link when the backend response identifies the callback as `agent`.

## Step-by-step booking walkthrough

1. Confirm the agent API is running and connected to Supabase and the existing booking backend.
2. Open the agent site and choose **Create an account**. Enter your name, email, phone number as 11 digits, and a password of at least 8 characters.
3. Log in with that email and password. To check the login error behavior, try an incorrect password; the form should show `Incorrect email or password`.
4. Ask, for example, `Is Elite Pitch available tomorrow at 6 PM for one hour?` to check a slot without creating a booking.
5. To start a booking, ask `Book two hours for me tomorrow from 3 to 5 p.m.` The agent uses the profile saved for your account, checks availability, then asks the existing backend to create the booking and initialize Paystack checkout.
6. Review the pitch, time, and price shown by the booking backend. Open the Paystack checkout link and enter payment details only on Paystack.
7. After Paystack returns to `/payment-callback`, log in if asked. The agent submits the reference to the existing backend's verification endpoint and shows the resulting booking status in chat.

Availability checks do not create bookings. A complete booking request does create the backend booking/payment initialization before you pay. For a full payment test, use an available future slot and the existing backend's Paystack test configuration.

## Existing backend constraints

- The current backend exposes one pitch and does not provide an endpoint to list every available time slot. The agent checks a specific requested time and uses the backend's reply; it does not invent a daily schedule.
- The agent uses `POST /api/ai/chat`, `POST /api/book`, and `GET /api/payment/verify/<reference>` through the existing backend API.
- The backend's `/api/ai/chat` endpoint is rate-limited. This prototype is intended for low traffic.
- Conversation drafts are held in the Flask process memory and expire after one hour. A service restart clears draft context.
- Account registration and login are rate-limited in process memory. If deploying multiple agent instances, use shared rate limiting before opening registration to significant public traffic.
- The backend may report a payment as failed or incomplete while its webhook is still processing. If a paid checkout shows `Failed`, do not pay again until the booking service has been checked.

The existing booking backend and normal booking website are not changed by this agent account feature.
