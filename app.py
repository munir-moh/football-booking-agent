"""Small chat/booking orchestrator for the existing football booking API.

The agent does not connect to the booking database. Availability and payment
status are read through the backend's existing controlled API routes. Booking
creation always goes through POST /api/book, which performs the final check.
"""

from datetime import date, datetime, timedelta
from threading import Lock
from time import time
from zoneinfo import ZoneInfo
import os
import re
import uuid
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

BACKEND_API_URL = os.getenv(
    "FOOTBALL_BACKEND_API_URL",
    "https://football-booking-system.onrender.com",
).rstrip("/")
PORT = int(os.getenv("PORT", "5001"))
LAGOS = ZoneInfo("Africa/Lagos")
BOOKER_NAME = os.getenv("BOOKER_NAME", "").strip()
BOOKER_EMAIL = os.getenv("BOOKER_EMAIL", "").strip()
BOOKER_PHONE = re.sub(r"\D", "", os.getenv("BOOKER_PHONE", ""))

app = Flask(__name__)
allowed_origins = [
    origin.strip()
    for origin in os.getenv("AGENT_ALLOWED_ORIGINS", "http://localhost:5174").split(",")
    if origin.strip()
]
CORS(app, resources={r"/api/*": {"origins": allowed_origins}})

# Prototype conversation state is kept in memory. It contains a booking draft
# until checkout starts, then retains the reference for payment-status checks.
sessions = {}
sessions_lock = Lock()
rate_windows = {}
rate_lock = Lock()
SESSION_TTL_SECONDS = 60 * 60
MAX_LLM_HISTORY = 10

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REFERENCE_RE = re.compile(r"^FP-\d{8}-\d{4}-[A-Z0-9]{4}$", re.IGNORECASE)
NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}


@app.before_request
def limit_agent_requests():
    limits = {"/api/chat": 5, "/api/payment-status": 10}
    limit = limits.get(request.path)
    if limit is None or request.method != "POST":
        return None

    now = time()
    key = (request.remote_addr or "unknown", request.path)
    with rate_lock:
        requests_in_window = [
            sent_at for sent_at in rate_windows.get(key, [])
            if now - sent_at < 60
        ]
        if len(requests_in_window) >= limit:
            return jsonify({"error": "Please wait a minute before trying again."}), 429
        requests_in_window.append(now)
        rate_windows[key] = requests_in_window
    return None


class BackendError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def backend_request(method, path, **kwargs):
    """Call a fixed backend route; callers never supply an arbitrary URL."""
    try:
        response = requests.request(
            method,
            BACKEND_API_URL + path,
            timeout=25,
            **kwargs,
        )
    except requests.RequestException as exc:
        raise BackendError(
            "I could not reach the football booking backend. Please try again shortly."
        ) from exc

    try:
        payload = response.json()
    except ValueError:
        payload = {}

    if not response.ok:
        message = payload.get("error") if isinstance(payload, dict) else None
        if response.status_code == 429:
            message = "The booking service is busy. Please wait a minute and try again."
        raise BackendError(
            message or "The booking backend could not complete that request.",
            response.status_code if response.status_code < 500 else 502,
        )
    return payload


def get_session(session_id):
    now = time()
    with sessions_lock:
        expired = [
            key
            for key, value in sessions.items()
            if now - value["updated_at"] > SESSION_TTL_SECONDS
        ]
        for key in expired:
            sessions.pop(key, None)

        if not session_id or len(session_id) > 80:
            session_id = str(uuid.uuid4())
        state = sessions.setdefault(
            session_id,
            {
                "draft": None,
                "stage": None,
                "llm_history": [],
                "last_booking": None,
                "updated_at": now,
            },
        )
        state["updated_at"] = now
    return session_id, state


def backend_chat(message, history=None):
    payload = {"message": message}
    if history:
        payload["history"] = history[-MAX_LLM_HISTORY:]
    result = backend_request("POST", "/api/ai/chat", json=payload)
    reply = result.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        raise BackendError("The booking assistant returned an empty reply.")
    return reply.strip()


def add_history(state, role, content):
    state["llm_history"].append({"role": role, "content": content[:500]})
    state["llm_history"] = state["llm_history"][-MAX_LLM_HISTORY:]


def parse_date(text):
    """Resolve common explicit dates and relative days in Africa/Lagos time."""
    today = datetime.now(LAGOS).date()
    lowered = text.lower()

    iso_match = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", text)
    if iso_match:
        try:
            return date.fromisoformat(iso_match.group(1)).isoformat()
        except ValueError:
            return None

    if re.search(r"\btomorrow\b", lowered):
        return (today + timedelta(days=1)).isoformat()
    if re.search(r"\btoday\b", lowered):
        return today.isoformat()

    weekday_names = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    match = re.search(
        r"\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lowered,
    )
    if match:
        target = weekday_names[match.group(2)]
        days_ahead = (target - today.weekday()) % 7
        if match.group(1) or days_ahead == 0:
            days_ahead += 7
        return (today + timedelta(days=days_ahead)).isoformat()
    return None


TIME_RE = re.compile(
    r"\b(?:(?P<h24>[01]?\d|2[0-3]):(?P<m24>[0-5]\d)|"
    r"(?P<h12>0?[1-9]|1[0-2])(?::(?P<m12>[0-5]\d))?\s*"
    r"(?P<ampm>a\.?m\.?|p\.?m\.?))\b",
    re.IGNORECASE,
)
TIME_RANGE_RE = re.compile(
    r"\b(?P<sh>\d{1,2})(?::(?P<sm>[0-5]\d))?\s*"
    r"(?P<sa>a\.?m\.?|p\.?m\.?)?\s*(?:to|until|[-–])\s*"
    r"(?P<eh>\d{1,2})(?::(?P<em>[0-5]\d))?\s*"
    r"(?P<ea>a\.?m\.?|p\.?m\.?)?\b",
    re.IGNORECASE,
)


def parse_times(text):
    range_match = TIME_RANGE_RE.search(text)
    if range_match:
        start_hour = int(range_match.group("sh"))
        start_minute = int(range_match.group("sm") or 0)
        end_hour = int(range_match.group("eh"))
        end_minute = int(range_match.group("em") or 0)
        start_ampm = range_match.group("sa")
        end_ampm = range_match.group("ea")

        # If only the end has AM/PM, use it for the start unless the range
        # crosses noon or midnight (for example, 11 to 1 p.m.).
        if not start_ampm and end_ampm and start_hour <= 12 and end_hour <= 12:
            end_is_pm = end_ampm.lower().startswith("p")
            if end_hour == 12:
                start_is_pm = not end_is_pm
            else:
                start_is_pm = end_is_pm if start_hour <= end_hour else not end_is_pm
            start_ampm = "pm" if start_is_pm else "am"
        if start_ampm:
            if start_hour == 12:
                start_hour = 12 if start_ampm.lower().startswith("p") else 0
            elif start_ampm.lower().startswith("p"):
                start_hour += 12
        if end_ampm:
            if end_hour == 12:
                end_hour = 12 if end_ampm.lower().startswith("p") else 0
            elif end_ampm.lower().startswith("p"):
                end_hour += 12
        if start_hour < 24 and end_hour < 24:
            return [
                f"{start_hour:02d}:{start_minute:02d}",
                f"{end_hour:02d}:{end_minute:02d}",
            ]

    found = []
    for match in TIME_RE.finditer(text):
        if match.group("h24") is not None:
            hour = int(match.group("h24"))
            minute = int(match.group("m24"))
        else:
            hour = int(match.group("h12"))
            minute = int(match.group("m12") or 0)
            is_pm = match.group("ampm").lower().startswith("p")
            if hour == 12:
                hour = 12 if is_pm else 0
            elif is_pm:
                hour += 12
        found.append((match.start(), f"{hour:02d}:{minute:02d}"))
    return [value for _, value in found]


def parse_duration(text):
    match = re.search(
        r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*"
        r"(?:hours?|hrs?)\b",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    value = match.group(1).lower()
    return int(value) if value.isdigit() else NUMBER_WORDS.get(value)


def parse_booking_details(text, draft):
    parsed_date = parse_date(text)
    if parsed_date:
        draft["date"] = parsed_date

    times = parse_times(text)
    if times:
        draft["start_time"] = times[0]
    if len(times) >= 2:
        start = datetime.strptime(times[0], "%H:%M")
        end = datetime.strptime(times[1], "%H:%M")
        minutes = int((end - start).total_seconds() // 60)
        if minutes > 0 and minutes % 60 == 0:
            draft["hours"] = minutes // 60

    duration = parse_duration(text)
    if duration:
        draft["hours"] = duration

    if re.search(r"\b(elite\s+football\s+pitch|elite\s+pitch)\b", text, re.I):
        draft["pitch_name"] = "Elite Football Pitch"


def missing_booking_field(draft):
    if not draft.get("date"):
        return "date"
    if not draft.get("start_time"):
        return "time"
    if not draft.get("hours"):
        return "duration"
    return None


def availability_prompt(draft):
    return (
        "Check whether Elite Football Pitch is available on "
        f"{draft['date']} at {draft['start_time']} for {draft['hours']} hour(s). "
        "Use the availability and pricing tools. If available, include the exact "
        "end time and total price. If unavailable, say that clearly."
    )


def availability_is_yes(reply):
    lowered = reply.lower()
    if re.search(
        r"\b(not available|unavailable|already booked|overlaps|cannot be booked|"
        r"can't be booked|does not fit|doesn't fit|too soon|in the past)\b",
        lowered,
    ):
        return False
    return bool(re.search(r"\bavailable\b", lowered))


def booking_summary(draft):
    start = datetime.strptime(draft["start_time"], "%H:%M")
    end = start + timedelta(hours=draft["hours"])
    return (
        f"Elite Football Pitch on {draft['date']} from "
        f"{start.strftime('%I:%M %p').lstrip('0')} to "
        f"{end.strftime('%I:%M %p').lstrip('0')} "
        f"({draft['hours']} hour(s))."
    )


def configured_booker():
    if not (BOOKER_NAME and BOOKER_EMAIL and BOOKER_PHONE):
        return None
    if not 2 <= len(BOOKER_NAME) <= 100:
        return None
    if not EMAIL_RE.fullmatch(BOOKER_EMAIL) or len(BOOKER_PHONE) != 11:
        return None
    return {"name": BOOKER_NAME, "email": BOOKER_EMAIL, "phone": BOOKER_PHONE}


def response(session_id, reply, **extra):
    return jsonify({"session_id": session_id, "reply": reply, **extra})


def ask_for_next_booking_field(session_id, state):
    draft = state["draft"]
    missing = missing_booking_field(draft)
    if missing == "date":
        state["stage"] = "slot"
        return response(
            session_id,
            "Which date would you like? You can say a date such as 2026-10-03, today, or tomorrow.",
        )
    if missing == "time":
        state["stage"] = "slot"
        return response(
            session_id,
            "What start time and duration should I check? You can say “6 PM for one hour” or “6 PM to 7 PM.”",
        )
    if missing == "duration":
        state["stage"] = "slot"
        return response(
            session_id,
            "How many hours should I check? The backend accepts whole-hour durations.",
        )
    return None


def begin_or_continue_booking(session_id, state, text):
    if state["draft"] is None:
        state["draft"] = {"pitch_name": "Elite Football Pitch"}
    draft = state["draft"]
    parse_booking_details(text, draft)

    requested_other_pitch = re.search(
        r"\b(?:book|reserve)\s+(?!elite\b)([a-z][a-z0-9 ]{2,30}?)\s+(?:pitch|field)\b",
        text,
        re.I,
    )
    if requested_other_pitch:
        state["draft"] = None
        state["stage"] = None
        return response(
            session_id,
            "The backend currently has one pitch: Elite Football Pitch. I can only check or book that pitch.",
        )

    prompt_response = ask_for_next_booking_field(session_id, state)
    if prompt_response:
        return prompt_response

    booker = configured_booker()
    if not booker:
        state["draft"] = None
        state["stage"] = None
        return response(
            session_id,
            "Your saved booking profile is not set up yet. Add BOOKER_NAME, BOOKER_EMAIL, and BOOKER_PHONE to the agent folder’s private .env file, then restart the agent. After that, a complete booking request will go straight to checkout without asking for those details each time.",
            profile_required=True,
        )

    try:
        quote = backend_chat(availability_prompt(draft))
    except BackendError as exc:
        return response(
            session_id,
            f"I could not check availability: {exc}. Your booking request is still saved in this chat. Please try again.",
            error=True,
        ), exc.status

    if not availability_is_yes(quote):
        state["stage"] = "slot"
        return response(
            session_id,
            f"{quote}\n\nPlease give me another start time or date and I’ll check it.",
        )

    draft["availability_reply"] = quote
    draft.update(booker)
    return start_checkout(session_id, state, draft, quote)


def start_checkout(session_id, state, draft, quote):
    payload = {
        "name": draft["name"],
        "phone": draft["phone"],
        "email": draft["email"],
        "date": draft["date"],
        "start_time": draft["start_time"],
        "hours": draft["hours"],
        "client": "agent",
    }
    try:
        result = backend_request("POST", "/api/book", json=payload)
    except BackendError as exc:
        if "booked" in str(exc).lower() or "available" in str(exc).lower():
            state["stage"] = "slot"
            return response(
                session_id,
                f"The backend could not start checkout: {exc}. The slot may have changed. Please give me another time to check.",
                error=True,
            )
        return response(
            session_id,
            f"The backend could not start checkout: {exc}. Please try again; no card details were entered in this chat.",
            error=True,
        ), exc.status

    if result.get("callback_client") != "agent":
        return response(
            session_id,
            "The booking backend has not confirmed the agent return setting yet, so I did not show the checkout link. Deploy the updated backend and set AGENT_FRONTEND_URL, then try again.",
            error=True,
        ), 503

    payment = result.get("payment") or {}
    checkout_url = payment.get("authorization_url")
    reference = result.get("reference")
    if not checkout_url or not reference:
        return response(
            session_id,
            "The backend did not return a Paystack checkout link. No payment was started.",
            error=True,
        ), 502
    checkout_host = urlparse(checkout_url).hostname or ""
    if urlparse(checkout_url).scheme != "https" or not (
        checkout_host == "paystack.com" or checkout_host.endswith(".paystack.com")
    ):
        return response(
            session_id,
            "The backend returned a checkout link that is not on Paystack, so I did not open it.",
            error=True,
        ), 502

    summary = booking_summary(draft)
    state["last_booking"] = {"reference": reference, "summary": summary}
    state["draft"] = None
    state["stage"] = None
    return response(
        session_id,
        f"{quote}\n\nYour Paystack checkout is ready for {summary} Complete payment on Paystack. I’ll verify it with the booking service and show your confirmation here. I will never ask for your card number, CVV, PIN, or OTP in this chat.",
        checkout_url=checkout_url,
        booking_reference=reference,
        payment_status="Awaiting payment",
    )


def handle_booking_stage(session_id, state, text):
    lowered = text.strip().lower()
    if lowered in {"cancel", "cancel booking", "start over"}:
        state["draft"] = None
        state["stage"] = None
        return response(session_id, "I cancelled that booking draft. What would you like to check?")

    if state["stage"] == "slot":
        return begin_or_continue_booking(session_id, state, text)

    state["draft"] = None
    state["stage"] = None
    return response(session_id, "That booking draft expired. Tell me the pitch, date, time, and duration to start again.")


def get_session_id_and_state(session_id):
    if not isinstance(session_id, str):
        session_id = None
    return get_session(session_id)


def payment_status_for_session(session_id, state, reference):
    if not REFERENCE_RE.fullmatch(reference):
        return response(session_id, "That booking reference does not look valid.", error=True), 400
    try:
        result = backend_request("GET", f"/api/payment/verify/{reference}")
    except BackendError as exc:
        return response(
            session_id,
            f"I could not verify payment with the backend: {exc}",
            error=True,
        ), exc.status

    status = result.get("status", "Unknown")
    if status == "Confirmed":
        last_booking = state.get("last_booking")
        details = f" {last_booking['summary']}" if last_booking else ""
        reply = f"Payment successful. Your booking is confirmed.{details} Reference: {reference}."
    elif status == "Failed":
        reply = (
            f"The backend reports a failed or incomplete payment for reference {reference}. "
            "If you just completed payment, do not pay again yet. The booking service should be checked before retrying."
        )
    else:
        reply = f"The current booking status is {status} for reference {reference}."
    return response(session_id, reply, booking_reference=reference, payment_status=status)


@app.get("/api/health")
def health():
    try:
        backend = backend_request("GET", "/")
        return jsonify({"agent": "running", "backend": backend.get("status", "online")})
    except BackendError as exc:
        return jsonify({"agent": "running", "backend": "unavailable", "error": str(exc)}), 503


@app.post("/api/chat")
def chat():
    data = request.get_json(silent=True) or {}
    text = data.get("message")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Please enter a message."}), 400
    text = text.strip()
    if len(text) > 500:
        return jsonify({"error": "Please keep messages under 500 characters."}), 400

    session_id, state = get_session_id_and_state(data.get("session_id"))
    reference_match = REFERENCE_RE.search(text)
    if reference_match and re.search(r"\b(payment|status|paid|booking)\b", text, re.I):
        return payment_status_for_session(session_id, state, reference_match.group(0))

    if state["stage"]:
        return handle_booking_stage(session_id, state, text)

    booking_intent = bool(re.search(r"\b(book|reserve)\b", text, re.I))
    if booking_intent:
        return begin_or_continue_booking(session_id, state, text)

    try:
        history = state["llm_history"][-MAX_LLM_HISTORY:]
        reply = backend_chat(text, history)
        add_history(state, "user", text)
        add_history(state, "assistant", reply)
        return response(session_id, reply)
    except BackendError as exc:
        return jsonify({"session_id": session_id, "error": str(exc)}), exc.status


@app.post("/api/payment-status")
def payment_status():
    data = request.get_json(silent=True) or {}
    reference = data.get("reference")
    if not isinstance(reference, str) or not REFERENCE_RE.fullmatch(reference):
        return jsonify({"error": "Please provide a valid booking reference."}), 400
    session_id, state = get_session_id_and_state(data.get("session_id"))
    result = payment_status_for_session(session_id, state, reference)
    if isinstance(result, tuple):
        return result
    return result


@app.get("/")
def index():
    return jsonify({"agent": "Football Booking Agent", "status": "running"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=os.getenv("FLASK_DEBUG") == "1")
