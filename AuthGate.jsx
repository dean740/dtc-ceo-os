import React, { useState, useEffect } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

/* Email + password login screen. Wraps the whole app: if you're not signed in
   you see this; once signed in, the real operating system renders. */
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured) { setReady(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) return <ConfigNotice />;
  if (!ready) return <Centered>Loading…</Centered>;
  if (!session) return <LoginScreen />;
  return children;
}

export function SignOutButton({ style }) {
  if (!supabaseConfigured) return null;
  return (
    <button onClick={() => supabase.auth.signOut()}
      style={{ border: "1px solid #e4e5e8", background: "#fff", color: "#3a3c42",
        borderRadius: 8, padding: "6px 11px", fontSize: 12.5, cursor: "pointer", ...style }}>
      Sign out
    </button>
  );
}

function LoginScreen() {
  const [mode, setMode] = useState("signin");      // 'signin' | 'signup'
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null); setMsg(null); setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password: pw });
        if (error) throw error;
        setMsg("Account created. If email confirmation is on, check your inbox — otherwise just sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      }
    } catch (e2) { setErr(e2.message || "Something went wrong"); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!email) { setErr("Enter your email first, then click reset."); return; }
    setErr(null); setMsg(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) setErr(error.message); else setMsg("Password reset email sent.");
  };

  const inS = { width: "100%", padding: "11px 12px", border: "1px solid #e4e5e8",
    borderRadius: 9, fontSize: 14, boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f5f6f8",
      fontFamily: "'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380, background: "#fff", border: "1px solid #e4e5e8",
        borderRadius: 18, padding: 28, boxShadow: "0 8px 18px rgba(16,18,22,.08), 0 18px 44px rgba(16,18,22,.12)" }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: "#0a0a0b", color: "#fff",
          display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14, marginBottom: 16 }}>OS</div>
        <h1 style={{ margin: "0 0 4px", fontSize: 21, fontWeight: 700, letterSpacing: "-.02em" }}>
          {mode === "signup" ? "Create your account" : "CEO Operating System"}
        </h1>
        <p style={{ margin: "0 0 20px", color: "#6b6e76", fontSize: 13.5 }}>
          {mode === "signup" ? "Set the email and password you'll log in with." : "Sign in to your command center."}
        </p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <input type="email" placeholder="Email" value={email} autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} required style={inS} />
          <input type="password" placeholder="Password" value={pw}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            onChange={(e) => setPw(e.target.value)} required minLength={6} style={inS} />
          {err && <div style={{ color: "#c0362c", fontSize: 12.5, background: "#fbebe9", padding: "8px 10px", borderRadius: 8 }}>{err}</div>}
          {msg && <div style={{ color: "#1f9d57", fontSize: 12.5, background: "#e8f6ee", padding: "8px 10px", borderRadius: 8 }}>{msg}</div>}
          <button type="submit" disabled={busy}
            style={{ background: "#0a0a0b", color: "#fff", border: "none", borderRadius: 9,
              padding: "12px", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: busy ? .6 : 1 }}>
            {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 12.5 }}>
          <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setErr(null); setMsg(null); }}
            style={{ border: "none", background: "none", color: "#2563c9", cursor: "pointer", padding: 0 }}>
            {mode === "signup" ? "Have an account? Sign in" : "First time? Create account"}
          </button>
          {mode === "signin" && (
            <button onClick={reset} style={{ border: "none", background: "none", color: "#6b6e76", cursor: "pointer", padding: 0 }}>
              Forgot password?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center",
    fontFamily: "'Geist',sans-serif", color: "#6b6e76" }}>{children}</div>;
}

function ConfigNotice() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f5f6f8", padding: 20,
      fontFamily: "'Geist',-apple-system,sans-serif" }}>
      <div style={{ maxWidth: 460, background: "#fff", border: "1px solid #e4e5e8", borderRadius: 16, padding: 26 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>Almost there — add your Supabase keys</h2>
        <p style={{ color: "#6b6e76", fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
          The app is running but isn't connected to your database yet. Add a <code>.env</code> file (locally)
          or environment variables (on Vercel) with <code>VITE_SUPABASE_URL</code> and
          <code> VITE_SUPABASE_ANON_KEY</code>, then reload. The deploy guide walks you through it.
        </p>
      </div>
    </div>
  );
}
