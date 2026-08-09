"use client";

import { useEffect, useState } from "react";
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithCustomToken } from "firebase/auth";
import { getFirebaseAuth, getFirestoreClient } from "@/lib/firebase-client";

export type SocialLinks = {
  instagram?: string;
  x?: string;
  discord?: string;
};

// Explicit user-driven flow states; the idle/viewing/claimed states are
// derived from auth + the existing Firestore doc during render (no effects).
type Flow = "none" | "token" | "verifying" | "claimed";

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

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

  const isOwner = signedInAs === username;

  // Track the auth session (persists across visits, so re-editing later
  // doesn't need a new bio challenge).
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => {
      setSignedInAs(user?.uid ?? null);
    });
    return unsubscribe;
  }, []);

  // Load any existing claim for this username (public read).
  useEffect(() => {
    let cancelled = false;
    getDoc(docId(username))
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

  function startClaim() {
    setToken(generateToken());
    setError(null);
    setCopied(false);
    setFlow("token");
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

  async function verifyBio() {
    if (!token) return;
    setFlow("verifying");
    setError(null);
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
      // (a killed function) fall back to a readable message, never a
      // JSON.parse exception.
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // empty or non-JSON body
      }

      if (!res.ok) {
        const body = (data as { error?: unknown; code?: unknown } | null) ?? {};
        const raw = body.error;
        const code = body.code;
        if (typeof raw === "string") {
          throw new Error(raw);
        }
        // Unparseable body (killed function) or an unknown error shape:
        // surface the HTTP status + server error code so failures are
        // diagnosable.
        throw new Error(
          typeof code === "string"
            ? `Verification failed (HTTP ${res.status}, code: ${code}). Please try again in a moment.`
            : `Verification failed (HTTP ${res.status}). Please try again in a moment.`
        );
      }

      const customToken = (data as { token?: unknown } | null)?.token;
      if (typeof customToken !== "string") {
        throw new Error(
          "The server returned an unexpected response. Try again in a moment."
        );
      }

      await signInWithCustomToken(getFirebaseAuth(), customToken);
      setFlow("claimed");
    } catch (err) {
      console.error("[claim] verification failed:", err);
      setError(
        err instanceof Error ? err.message : "Verification failed. Please try again."
      );
      setFlow("token");
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
    } catch {
      setError("Couldn't remove your socials. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  // Still loading the existing claim — keep the header uncluttered.
  if (existing === undefined && flow === "none") return null;

  if (step === "idle") {
    return (
      <button
        type="button"
        onClick={startClaim}
        className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
      >
        + Claim socials
      </button>
    );
  }

  if (step === "viewing") {
    const any = existing?.instagram || existing?.x || existing?.discord;
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-full border border-amber/30 bg-amber-soft px-3 py-1 font-mono text-xs text-amber">
          socials {any ? "linked" : "claimed"}
        </span>
        <button
          type="button"
          onClick={startClaim}
          className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
        >
          Verify to manage
        </button>
      </div>
    );
  }

  if (step === "token" || step === "verifying") {
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
        <ol className="mt-3 space-y-1 font-mono text-xs leading-6 text-slate">
          <li>1. Open your Letterboxd profile and hit Edit.</li>
          <li>
            2. Paste this code at the start of your bio and save.
          </li>
          <li>3. Click &ldquo;Verify bio&rdquo; below.</li>
        </ol>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            disabled={step === "verifying"}
            onClick={verifyBio}
            className="h-9 rounded-full bg-amber px-5 font-mono text-xs font-medium tracking-wide text-ink transition-all hover:bg-bone disabled:cursor-wait disabled:opacity-60"
          >
            {step === "verifying" ? (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-ink" />
                Verifying bio\u2026
              </span>
            ) : (
              "Verify bio"
            )}
          </button>
          <button
            type="button"
            disabled={step === "verifying"}
            onClick={() => setFlow("none")}
            className="rounded-full px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:text-amber"
          >
            Cancel
          </button>
        </div>
        {error && <p className="mt-3 font-mono text-xs text-amber">{error}</p>}
      </div>
    );
  }

  // step === "claimed" — signed in as the owner; manage socials.
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
      <div className="mt-4 flex items-center gap-3">
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
      </div>
      {error && <p className="mt-3 font-mono text-xs text-amber">{error}</p>}
    </div>
  );
}
