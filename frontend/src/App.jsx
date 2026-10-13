import { useEffect, useRef, useState } from "react";

const API_URL = (import.meta.env.VITE_AGENT_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const AUTH_TOKEN_KEY = "football-agent-token";
const WELCOME = {
  id: "welcome",
  role: "assistant",
  text: "How can I help with your booking?",
};

function newSessionId() {
  return window.crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(36).slice(2);
}

export default function App() {
  const [authToken, setAuthToken] = useState(() => sessionStorage.getItem(AUTH_TOKEN_KEY) || "");
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(() => Boolean(sessionStorage.getItem(AUTH_TOKEN_KEY)));
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [sessionId, setSessionId] = useState(
    () => sessionStorage.getItem("football-agent-session") || newSessionId(),
  );
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState("checking");
  const [lastReference, setLastReference] = useState(
    () => sessionStorage.getItem("football-agent-reference") || "",
  );
  const [checkingPayment, setCheckingPayment] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const callbackProcessed = useRef(false);

  useEffect(() => {
    let active = true;
    if (!authToken) {
      setAuthLoading(false);
      return () => { active = false; };
    }

    fetch(API_URL + "/api/auth/me", {
      headers: { Authorization: "Bearer " + authToken },
    })
      .then(async (result) => {
        const data = await result.json().catch(() => ({}));
        if (!result.ok) throw new Error(data.error || "Please log in again.");
        if (active) setAuthUser(data.user);
      })
      .catch(() => {
        if (!active) return;
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
        sessionStorage.removeItem("football-agent-reference");
        setAuthToken("");
        setLastReference("");
      })
      .finally(() => active && setAuthLoading(false));

    return () => { active = false; };
  }, []);

  useEffect(() => {
    sessionStorage.setItem("football-agent-session", sessionId);
  }, [sessionId]);

  async function verifyPayment(reference) {
    if (!reference || checkingPayment || !authToken) return;
    setCheckingPayment(true);
    setLastReference(reference);
    sessionStorage.setItem("football-agent-reference", reference);
    try {
      const result = await fetch(API_URL + "/api/payment-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + authToken,
        },
        body: JSON.stringify({ session_id: sessionId, reference }),
      });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(data.error || "Could not check payment status.");
      if (data.session_id && data.session_id !== sessionId) setSessionId(data.session_id);
      setMessages((current) => [
        ...current,
        {
          id: newSessionId(),
          role: "assistant",
          text: data.reply,
          reference: data.booking_reference,
          paymentStatus: data.payment_status,
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: newSessionId(), role: "error", text: error.message || "Could not check payment status." },
      ]);
    } finally {
      setCheckingPayment(false);
    }
  }

  useEffect(() => {
    if (authLoading || !authToken) return;
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference") || params.get("trxref") || "";
    if (!reference || callbackProcessed.current) return;
    callbackProcessed.current = true;
    if (!/^FP-\d{8}-\d{4}-[A-Z0-9]{4}$/i.test(reference)) {
      setMessages((current) => [
        ...current,
        { id: newSessionId(), role: "error", text: "The payment return did not include a valid booking reference." },
      ]);
      return;
    }
    const remainingParams = new URLSearchParams(window.location.search);
    remainingParams.delete("reference");
    remainingParams.delete("trxref");
    const query = remainingParams.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? "?" + query : "") + window.location.hash,
    );
    setMessages((current) => [
      ...current,
      { id: newSessionId(), role: "assistant", text: "You’ve returned from Paystack. I’m checking the payment with the booking service…" },
    ]);
    verifyPayment(reference);
  }, [authLoading, authToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    let active = true;
    fetch(API_URL + "/api/health")
      .then((result) => {
        if (!active) return;
        setConnection(result.ok ? "online" : "unavailable");
      })
      .catch(() => active && setConnection("unavailable"));
    return () => {
      active = false;
    };
  }, []);

  async function submitAuth(event) {
    event.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      const registering = authMode === "register";
      const result = await fetch(API_URL + (registering ? "/api/auth/register" : "/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          registering
            ? authForm
            : { email: authForm.email, password: authForm.password },
        ),
      });
      const data = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(data.error || "Could not complete that request. Please try again.");

      if (registering) {
        setAuthMode("login");
        setAuthForm((current) => ({ ...current, password: "" }));
        setAuthNotice("Account created. Log in with your email and password.");
        return;
      }

      sessionStorage.setItem(AUTH_TOKEN_KEY, data.access_token);
      setAuthToken(data.access_token);
      setAuthUser(data.user);
      setSessionId(newSessionId());
      setMessages([WELCOME]);
      const callbackReference = new URLSearchParams(window.location.search).get("reference")
        || new URLSearchParams(window.location.search).get("trxref");
      if (callbackReference) {
        setLastReference(callbackReference);
      } else {
        sessionStorage.removeItem("football-agent-reference");
        setLastReference("");
      }
    } catch (error) {
      setAuthError(error.message || "Could not connect to the booking agent.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    try {
      await fetch(API_URL + "/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + authToken },
      });
    } catch {
      // Local sign-out still clears this browser session if the API is offline.
    }
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem("football-agent-reference");
    setAuthToken("");
    setAuthUser(null);
    setLastReference("");
    setMessages([WELCOME]);
    setAuthMode("login");
    setAuthForm({ name: "", email: "", phone: "", password: "" });
  }

  async function sendMessage(value = input) {
    const message = value.trim();
    if (!message || busy || !authToken) return;

    setMessages((current) => [...current, { id: newSessionId(), role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const result = await fetch(API_URL + "/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + authToken,
        },
        body: JSON.stringify({ session_id: sessionId, message }),
      });
      const data = await result.json().catch(() => ({}));
      if (data.session_id && data.session_id !== sessionId) setSessionId(data.session_id);
      if (!result.ok) throw new Error(data.error || "The assistant could not answer. Please try again.");

      const reference = data.booking_reference || "";
      if (reference) {
        setLastReference(reference);
        sessionStorage.setItem("football-agent-reference", reference);
      }
      setMessages((current) => [
        ...current,
        {
          id: newSessionId(),
          role: data.error ? "error" : "assistant",
          text: data.reply || data.error || "The assistant returned no reply.",
          checkoutUrl: data.checkout_url || "",
          reference,
          paymentStatus: data.payment_status || "",
          requiresConfirmation: Boolean(data.requires_confirmation),
        },
      ]);
      if (result.ok) setConnection("online");
    } catch (error) {
      setMessages((current) => [
        ...current,
        { id: newSessionId(), role: "error", text: error.message || "Could not connect to the booking agent." },
      ]);
      setConnection("unavailable");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function checkPayment() {
    if (!lastReference || checkingPayment) return;
    await verifyPayment(lastReference);
  }

  function startNewChat() {
    const nextSession = newSessionId();
    setSessionId(nextSession);
    sessionStorage.setItem("football-agent-session", nextSession);
    setMessages([WELCOME]);
    setInput("");
    inputRef.current?.focus();
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  const paymentReturnPending = Boolean(
    new URLSearchParams(window.location.search).get("reference")
      || new URLSearchParams(window.location.search).get("trxref"),
  );

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="Pitchside home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span className="brand-name">MM's Booking Agent<span>.</span></span>
        </a>
        <div className="topbar-right">
          {authUser && (
            <>
              <div className={"connection connection-" + connection} role="status">
                <span className="connection-dot" />
                {connection === "online" ? "Booking service connected" : connection === "checking" ? "Connecting…" : "Service unavailable"}
              </div>
              <span className="account-name">{authUser.name}</span>
              <button className="new-chat-button" onClick={startNewChat} type="button">
                <span aria-hidden="true">＋</span>
                <span className="new-chat-label">New chat</span>
              </button>
              <button className="sign-out-button" onClick={signOut} type="button">Sign out</button>
            </>
          )}
        </div>
      </header>

      {authLoading ? (
        <section className="auth-layout" aria-live="polite">
          <div className="auth-card auth-loading">Checking your account…</div>
        </section>
      ) : !authUser ? (
        <section className="auth-layout" aria-label="Booking agent account">
          <section className="auth-card" aria-labelledby="auth-title">
            <h2 id="auth-title">{authMode === "register" ? "Create account" : "Log in"}</h2>
            {paymentReturnPending && (
              <div className="auth-notice" role="status">Log in to check your payment.</div>
            )}
            {authNotice && <div className="auth-notice" role="status">{authNotice}</div>}
            {authError && <div className="auth-error" role="alert">{authError}</div>}
            <form className="auth-form" onSubmit={submitAuth}>
              {authMode === "register" && (
                <label>
                  Name
                  <input
                    type="text"
                    autoComplete="name"
                    value={authForm.name}
                    onChange={(event) => setAuthForm((current) => ({ ...current, name: event.target.value }))}
                    minLength="2"
                    maxLength="100"
                    required
                  />
                </label>
              )}
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  value={authForm.email}
                  onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
                  maxLength="254"
                  required
                />
              </label>
              {authMode === "register" && (
                <label>
                  Phone
                  <input
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="08031234567"
                    value={authForm.phone}
                    onChange={(event) => setAuthForm((current) => ({ ...current, phone: event.target.value }))}
                    required
                  />
                </label>
              )}
              <label>
                Password
                <input
                  type="password"
                  autoComplete={authMode === "register" ? "new-password" : "current-password"}
                  value={authForm.password}
                  onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                  minLength="8"
                  maxLength="128"
                  required
                />
              </label>
              <button className="auth-submit" type="submit" disabled={authBusy}>
                {authBusy
                  ? (authMode === "register" ? "Creating account…" : "Logging in…")
                  : (authMode === "register" ? "Create account" : "Log in")}
              </button>
            </form>
            <p className="auth-switch">
              {authMode === "register" ? "Already have an account?" : "New to the booking agent?"}
              <button
                type="button"
                onClick={() => {
                  setAuthMode((current) => current === "register" ? "login" : "register");
                  setAuthError("");
                  setAuthNotice("");
                }}
              >
                {authMode === "register" ? "Log in" : "Create an account"}
              </button>
            </p>
          </section>
        </section>
      ) : (
        <section className="chat-layout" aria-label="Football booking assistant">
          <section className="chat-card" aria-label="Chat">
            <div className="chat-heading">
              <div className="agent-avatar"><span>⚽</span><i /></div>
              <div className="chat-heading-copy">
                <strong>Booking Agent</strong>
              </div>
            </div>

            <div className="message-list" aria-live="polite" aria-relevant="additions text">
              {messages.map((message) => (
                <article className={"message-row message-" + message.role} key={message.id}>
                  {message.role !== "user" && (
                    <div className="message-avatar" aria-hidden="true">{message.role === "error" ? "!" : "⚽"}</div>
                  )}
                  <div className="message-content">
                    <div className="bubble">{message.text}</div>
                    {message.checkoutUrl && (
                      <div className="checkout-card">
                        <div className="checkout-icon" aria-hidden="true">↗</div>
                        <div className="checkout-copy">
                          <strong>Paystack checkout</strong>
                        </div>
                        <a className="checkout-button" href={message.checkoutUrl}>
                          Continue <span aria-hidden="true">↗</span>
                        </a>
                      </div>
                    )}
                    {message.paymentStatus && (
                      <div className={"status-chip status-" + String(message.paymentStatus).toLowerCase().replaceAll(" ", "-")}>
                        <span /> {message.paymentStatus}
                      </div>
                    )}
                    {message.requiresConfirmation && (
                      <div className="quick-actions">
                        <button type="button" onClick={() => sendMessage("Yes, proceed to Paystack")} disabled={busy}>Yes, proceed</button>
                        <button type="button" className="quiet-action" onClick={() => sendMessage("No, cancel")} disabled={busy}>Not now</button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              {busy && (
                <div className="message-row message-assistant">
                  <div className="message-avatar" aria-hidden="true">⚽</div>
                  <div className="bubble typing-bubble" aria-label="Assistant is typing"><i /><i /><i /></div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {lastReference && (
              <div className="payment-followup">
                <div><span className="followup-dot" /><b>{lastReference}</b></div>
                <button type="button" onClick={checkPayment} disabled={checkingPayment}>
                  {checkingPayment ? "Checking…" : "Check payment status"}
                </button>
              </div>
            )}

            <div className="composer-wrap">
              <div className="composer">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about availability or start a booking…"
                  rows="1"
                  maxLength="500"
                  disabled={busy}
                  aria-label="Your message"
                />
                <button className="send-button" type="button" onClick={() => sendMessage()} disabled={busy || !input.trim()} aria-label="Send message">
                  {busy ? <span className="send-spinner" /> : <span aria-hidden="true">↑</span>}
                </button>
              </div>
            </div>
          </section>
        </section>
      )}
    </main>
  );
}
