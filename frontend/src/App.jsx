import { useEffect, useRef, useState } from "react";

const API_URL = (import.meta.env.VITE_AGENT_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const WELCOME = {
  id: "welcome",
  role: "assistant",
  text: "Hi, I’m your booking agent. Tell me when you’d like to play.",
};

function newSessionId() {
  return window.crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(36).slice(2);
}

export default function App() {
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
    sessionStorage.setItem("football-agent-session", sessionId);
  }, [sessionId]);

  async function verifyPayment(reference) {
    if (!reference || checkingPayment) return;
    setCheckingPayment(true);
    setLastReference(reference);
    sessionStorage.setItem("football-agent-reference", reference);
    try {
      const result = await fetch(API_URL + "/api/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  }, []);

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

  async function sendMessage(value = input) {
    const message = value.trim();
    if (!message || busy) return;

    setMessages((current) => [...current, { id: newSessionId(), role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const result = await fetch(API_URL + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          <div className={"connection connection-" + connection} role="status">
            <span className="connection-dot" />
            {connection === "online" ? "Booking service connected" : connection === "checking" ? "Connecting…" : "Service unavailable"}
          </div>
          <button className="new-chat-button" onClick={startNewChat} type="button">
            <span aria-hidden="true">＋</span>
            <span className="new-chat-label">New chat</span>
          </button>
        </div>
      </header>

      <section className="chat-layout" aria-label="Football booking assistant">
        <div className="welcome-panel">
          <div className="pitch-badge"><span /> ELITE FOOTBALL PITCH</div>
          <h1>Tell me when you <br />want to <em>play.</em></h1>
          <p>Your pitch. Your time. I'll handle the rest</p>
          <div className="pitch-facts" aria-label="Booking information">
            <div><span className="fact-icon">◷</span><span><b>Live slot checks</b><small>Checked with the booking service</small></span></div>
            <div><span className="fact-icon">◉</span><span><b>Price before checkout</b><small>Confirmed for your selected time</small></span></div>
          </div>
          <div className="field-lines" aria-hidden="true">
            <div className="field-center" />
            <div className="field-box field-box-left" />
            <div className="field-box field-box-right" />
          </div>
        </div>

        <section className="chat-card" aria-label="Chat">
          <div className="chat-heading">
            <div className="agent-avatar"><span>⚽</span><i /></div>
            <div className="chat-heading-copy">
              <strong>Booking Agent</strong>
              <span>Here to get you on the pitch</span>
            </div>
          </div>

          <div className="message-list" aria-live="polite" aria-relevant="additions text">
            <div className="date-divider"><span>TODAY</span></div>
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
                        <strong>Paystack secure checkout</strong>
                        <span>Your card details stay on Paystack.</span>
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
              <div><span className="followup-dot" /><span>Payment reference <b>{lastReference}</b></span></div>
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
            <div className="composer-foot">
              <span>Enter to send · Shift + Enter for a new line</span>
              <span>{input.length}/500</span>
            </div>
          </div>
        </section>

        <p className="privacy-note"><span aria-hidden="true"></span> Payments happen on Paystack. Never share card details in chat.</p>
      </section>
      <footer className="footer-note">Made for the love of the game <span>·</span></footer>
    </main>
  );
}
