"use client";

import { useEffect, useRef, useState } from "react";
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import {
  ensureAnonymousAuth,
  getFirebaseAuth,
  getFirestoreClient,
} from "@/lib/firebase-client";
import type { SocialLinks } from "@/components/social-icons";

// Explicit user-driven flow states; the idle/viewing/claimed states are
// derived from auth + the existing Firestore doc during render (no effects).
type Flow = "none" | "token" | "verifying" | "claimed";

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

// Hands-free bio detection cadence: poll every POLL_MS while the token step
// is active, slow to SLOW_POLL_MS after SLOW_AFTER_MS of waiting.
const POLL_MS = 5000;
const SLOW_POLL_MS = 30000;
const SLOW_AFTER_MS = 3 * 60 * 1000;
const MAX_POLL_INFRA_ERRORS = 3;

function generateToken(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]
  ).join("");
}

function docId(username: string) {
  return doc(getFirestoreClient(), "users", username);
}

/**
 * "Social Hand-Off": prove ownership of a Letterboxd username by placing a
 * 6-character token in the profile bio, then save public social handles to
 * `users/{username}` in Firestore. No passwords anywhere.
 */
export default function ClaimProfile({
  username,
  onClaimed,
}: {
  username: string;
  onClaimed: (username: string, socials: SocialLinks | null) => void;
}) {
  const [flow, setFlow] = useState<Flow>("none");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<SocialLinks | null | undefined>(
    undefined
  );
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<SocialLinks>>({});
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // Claimed but collapsed: the links live in the results stats line, so the
  // form only exists while the owner is actually editing.
  const [editing, setEditing] = useState(false);
  // Auto-detection state: a check is in flight, and how many consecutive
  // infrastructure failures the silent poll has hit (surfaced only past a
  // threshold — a 401 "not in bio yet" resets it, it's the expected state).
  const [checking, setChecking] = useState(false);
  const [infraErrors, setInfraErrors] = useState(0);
  const checkInFlight = useRef(false);

  const isOwner = signedInAs === username;

  // Track the auth session (persists across visits, so re-editing later
  // doesn't need a new bio challenge).
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => {
      setSignedInAs(user?.uid ?? null);
    });
    return unsubscribe;
  }, []);

  // Load any existing claim for this username (public read — but reads now
  // require a Firebase session, so ensure anonymous auth first).
  useEffect(() => {
    let cancelled = false;
    ensureAnonymousAuth()
      .then(() => getDoc(docId(username)))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          setExisting({
            instagram:
              typeof data.instagram === "string" ? data.instagram : undefined,
            x: typeof data.x === "string" ? data.x : undefined,
            discord:
              typeof data.discord === "string" ? data.discord : undefined,
          });
        } else {
          setExisting(null);
        }
      })
      .catch(() => {
        if (!cancelled) setExisting(null);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  // Derived display state (flow overrides; otherwise auth + existing claim).
  const step =
    flow !== "none"
      ? flow
      : isOwner && existing
        ? "claimed"
        : existing
          ? "viewing"
          : "idle";

  // Hands-free detection: while the token step is active, poll the bio every
  // few seconds (slowing after SLOW_AFTER_MS) and check immediately when the
  // tab regains focus. A 401 (token not there yet) is the expected mid-edit
  // state and stays silent; only repeated infra failures surface a note.
  useEffect(() => {
    if (step !== "token") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const pollMs = () =>
      Date.now() - startedAt > SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS;
    function schedule() {
      if (stopped) return;
      timer = setTimeout(() => {
        if (stopped) return;
        void checkBio(false);
        schedule();
      }, pollMs());
    }
    const checkNow = () => {
      if (stopped || document.visibilityState !== "visible") return;
      void checkBio(false);
    };
    document.addEventListener("visibilitychange", checkNow);
    window.addEventListener("focus", checkNow);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkNow);
      window.removeEventListener("focus", checkNow);
    };
    // Polling is scoped to the token step; checkBio stays stable within it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function startClaim() {
    const nextToken = generateToken();
    setToken(nextToken);
    setError(null);
    setCopied(false);
    setInfraErrors(0);
    setFlow("token");
    // Prime the clipboard so the flow is paste-first; the Copy button
    // remains as a fallback.
    navigator.clipboard
      ?.writeText(nextToken)
      .then(() => setCopied(true))
      .catch(() => {});
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; the token is still visible on screen
    }
  }

  /**
   * Check whether the token is in the bio and, if so, sign in as the owner.
   * Returns true on success. `manual` (the "Check now" button) surfaces
   * errors; background polls stay silent — a 401 just means "keep waiting",
   * and infra failures only count toward a gentle note after repeated hits.
   */
  async function checkBio(manual: boolean): Promise<boolean> {
    if (!token || checkInFlight.current) return false;
    checkInFlight.current = true;
    setChecking(true);
    if (manual) setError(null);
    try {
      let res: Response;
      try {
        res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, token }),
        });
      } catch {
        throw new Error("Could not reach the server. Try again in a moment.");
      }

      // Error payloads can be a string ({ error: "..." }) or an object
      // ({ error: { message } } — platform failures). Non-JSON/empty bodies
      // (a killed function) fall back to a readable message.
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // empty or non-JSON body
      }

      if (!res.ok) {
        if (res.status === 401) {
          // Token not in bio yet — expected while the user is still editing.
          setInfraErrors(0);
          if (manual) {
            setError(
              "Token not found in your Letterboxd bio yet. Save your bio, then try again."
            );
          }
          return false;
        }
        const body = (data as { error?: unknown; code?: unknown } | null) ?? {};
        const raw = body.error;
        const code = body.code;
        const message =
          typeof raw === "string"
            ? raw
            : typeof code === "string"
              ? `Verification failed (HTTP ${res.status}, code: ${code}). Please try again in a moment.`
              : `Verification failed (HTTP ${res.status}). Please try again in a moment.`;
        setInfraErrors((n) => n + 1);
        if (manual) setError(message);
        return false;
      }

      const customToken = (data as { token?: unknown } | null)?.token;
      if (typeof customToken !== "string") {
        setInfraErrors((n) => n + 1);
        if (manual) {
          setError(
            "The server returned an unexpected response. Try again in a moment."
          );
        }
        return false;
      }

      await signInWithCustomToken(getFirebaseAuth(), customToken);
      setFlow("claimed");
      // Straight into the form: fresh claims need handles, managing needs
      // access to the existing ones.
      setEditing(true);
      return true;
    } catch (err) {
      setInfraErrors((n) => n + 1);
      if (manual) {
        console.error("[claim] verification failed:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Verification failed. Please try again."
        );
      }
      return false;
    } finally {
      setChecking(false);
      checkInFlight.current = false;
    }
  }

  async function saveSocials() {
    setSaving(true);
    setError(null);
    const instagram = (form.instagram ?? existing?.instagram)?.trim() ?? "";
    const x = (form.x ?? existing?.x)?.trim() ?? "";
    const discord = (form.discord ?? existing?.discord)?.trim() ?? "";

    // Firestore rejects `undefined` values and the security rules only allow
    // the three known keys — so write exactly the fields that changed:
    // filled fields as strings, cleared fields as deletions.
    const updates: Record<string, unknown> = {};
    if (instagram) updates.instagram = instagram;
    else if (existing?.instagram) updates.instagram = deleteField();
    if (x) updates.x = x;
    else if (existing?.x) updates.x = deleteField();
    if (discord) updates.discord = discord;
    else if (existing?.discord) updates.discord = deleteField();

    if (Object.keys(updates).length === 0) {
      setError("Enter at least one social handle.");
      setSaving(false);
      return;
    }

    try {
      await setDoc(docId(username), updates, { merge: true });
      const values: SocialLinks = {};
      if (instagram) values.instagram = instagram;
      if (x) values.x = x;
      if (discord) values.discord = discord;
      setExisting(values);
      setForm({});
      onClaimed(username, values);
      // Collapse back to the one-line display; the links now sit in the
      // stats line next to the icon row.
      setEditing(false);
      setSavedNote("Saved \u2713");
      setTimeout(() => setSavedNote(null), 4000);
    } catch (err) {
      console.error("[claim] save failed:", err);
      setError(
        err instanceof Error && err.message
          ? `Couldn't save your socials — ${err.message}`
          : "Couldn't save your socials. Please try again."
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeClaim() {
    setSaving(true);
    try {
      await deleteDoc(docId(username));
      setExisting(null);
      setForm({});
      onClaimed(username, null);
      setEditing(false);
      setFlow("none");
      setSavedNote("Removed");
      setTimeout(() => setSavedNote(null), 3000);
    } catch (err) {
      console.error("[claim] remove failed:", err);
      setError(
        err instanceof Error && err.message
          ? `Couldn't remove your socials — ${err.message}`
          : "Couldn't remove your socials. Please try again."
      );
    } finally {
      setSaving(false);
    }
  }

  // Still loading the existing claim — keep the header uncluttered.
  if (existing === undefined && flow === "none") return null;

  if (step === "idle") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={startClaim}
          className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
        >
          + Claim socials
        </button>
        {savedNote && (
          <span className="font-mono text-xs text-amber">{savedNote}</span>
        )}
      </div>
    );
  }

  if (step === "viewing") {
    const any = existing?.instagram || existing?.x || existing?.discord;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-amber/30 bg-amber-soft px-3 py-1 font-mono text-xs text-amber">
          socials {any ? "linked" : "claimed"}
        </span>
        <button
          type="button"
          onClick={startClaim}
          className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
        >
          Verify to view
        </button>
      </div>
    );
  }

  if (step === "token" || step === "verifying") {
    const pollNote =
      infraErrors >= MAX_POLL_INFRA_ERRORS
        ? "Still checking \u2014 a hiccup on our side. Hang tight."
        : null;
    return (
      <div className="w-full max-w-md rounded-2xl border border-steel bg-surface p-4">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate">
          Verify your profile
        </p>
        <div className="mt-3 flex items-center gap-3">
          <code className="rounded-lg border border-amber/40 bg-raise px-3 py-2 font-mono text-xl tracking-[0.3em] text-amber">
            {token}
          </code>
          <button
            type="button"
            onClick={copyToken}
            className="rounded-full border border-steel px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
          >
            {copied ? "Copied\u2713" : "Copy"}
          </button>
        </div>
        <p className="mt-3 font-mono text-xs leading-6 text-slate">
          Paste this code into your Letterboxd bio and save &mdash;
          we&rsquo;ll notice automatically.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="https://letterboxd.com/settings/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center rounded-full bg-amber px-5 font-mono text-xs font-medium tracking-wide text-ink transition-all hover:bg-bone"
          >
            Open Letterboxd settings
          </a>
          <button
            type="button"
            disabled={checking}
            onClick={() => void checkBio(true)}
            className="rounded-full border border-steel bg-surface px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber disabled:cursor-wait disabled:opacity-60"
          >
            Check now
          </button>
          <button
            type="button"
            disabled={checking}
            onClick={() => setFlow("none")}
            className="rounded-full px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:text-amber"
          >
            Cancel
          </button>
        </div>
        <p className="mt-3 flex items-center gap-2 font-mono text-xs text-slate">
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-amber" />
          {pollNote ??
            (checking
              ? "Checking your bio\u2026"
              : "Listening for your bio\u2026")}
        </p>
        {error && <p className="mt-3 font-mono text-xs text-amber">{error}</p>}
      </div>
    );
  }

  // step === "claimed" — signed in as the owner. Collapsed by default: the
  // links themselves render in the results stats line; the form appears only
  // while editing.
  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
        >
          Manage socials
        </button>
        {savedNote && (
          <span className="font-mono text-xs text-amber">{savedNote}</span>
        )}
      </div>
    );
  }

  const inputClass =
    "h-9 w-full rounded-lg border border-steel bg-raise px-3 font-mono text-xs text-bone placeholder:text-slate outline-none transition-colors focus:border-amber";
  return (
    <div className="w-full max-w-md rounded-2xl border border-steel bg-surface p-4">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate">
        Your socials
      </p>
      <div className="mt-3 space-y-2">
        <label className="sr-only" htmlFor="claim-instagram">
          Instagram handle
        </label>
        <input
          id="claim-instagram"
          type="text"
          value={form.instagram ?? existing?.instagram ?? ""}
          onChange={(e) => setForm({ ...form, instagram: e.target.value })}
          placeholder="instagram handle"
          className={inputClass}
        />
        <label className="sr-only" htmlFor="claim-x">
          X (Twitter) handle
        </label>
        <input
          id="claim-x"
          type="text"
          value={form.x ?? existing?.x ?? ""}
          onChange={(e) => setForm({ ...form, x: e.target.value })}
          placeholder="x / twitter handle"
          className={inputClass}
        />
        <label className="sr-only" htmlFor="claim-discord">
          Discord username
        </label>
        <input
          id="claim-discord"
          type="text"
          value={form.discord ?? existing?.discord ?? ""}
          onChange={(e) => setForm({ ...form, discord: e.target.value })}
          placeholder="discord username"
          className={inputClass}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={saveSocials}
          className="h-9 rounded-full bg-amber px-5 font-mono text-xs font-medium tracking-wide text-ink transition-all hover:bg-bone disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? "Saving\u2026" : "Save socials"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={removeClaim}
          className="rounded-full px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:text-amber"
        >
          Remove
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => setEditing(false)}
          className="rounded-full px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:text-amber"
        >
          Done
        </button>
      </div>
      {error && <p className="mt-3 font-mono text-xs text-amber">{error}</p>}
    </div>
  );
}
