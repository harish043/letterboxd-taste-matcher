import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, signInAnonymously, type Auth } from "firebase/auth";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from "firebase/app-check";
import { getFirestore, type Firestore } from "firebase/firestore";

// Firebase web-app config — public values from the Firebase console (data is
// protected by Firestore security rules, not by these keys).
const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
};

let clientApp: FirebaseApp | null = null;
let appCheck: AppCheck | null = null;

/** Client Firebase app (browser only — these modules reference `window`). */
export function getFirebaseClient(): FirebaseApp {
  if (!clientApp) {
    if (getApps().length > 0) {
      clientApp = getApps()[0];
    } else {
      if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
        throw new Error(
          "Firebase web config is incomplete: NEXT_PUBLIC_FIREBASE_* env vars must be set."
        );
      }
      clientApp = initializeApp(firebaseConfig);
    }
  }
  return clientApp;
}

/**
 * App Check attestation (reCAPTCHA v3). Initializing it before Auth/Firestore
 * calls lets the platform reject scripted sessions — a real browser passes
 * attestation, an automated scraper doesn't. No-op (null) when the site key
 * isn't configured, so local dev without the key keeps working.
 */
export function getFirebaseAppCheck(): AppCheck | null {
  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY;
  if (!siteKey) return null;
  if (!appCheck) {
    appCheck = initializeAppCheck(getFirebaseClient(), {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return appCheck;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseClient());
}

export function getFirestoreClient(): Firestore {
  return getFirestore(getFirebaseClient());
}

let anonSignInPromise: Promise<void> | null = null;

/**
 * Ensure the visitor has a Firebase session before any Firestore read.
 * Anonymous auth lets the security rules require `request.auth != null`
 * (the database is no longer publicly readable) while staying invisible to
 * users — no UI, no consent, no credentials. App Check is initialized first
 * so the session is attested (blocks scripted sign-ins). Sessions persist
 * locally, so repeat visits usually resolve immediately. A custom-token
 * sign-in (profile claim) transparently replaces the anonymous session.
 */
export function ensureAnonymousAuth(): Promise<void> {
  getFirebaseAppCheck();
  const auth = getFirebaseAuth();
  if (auth.currentUser) return Promise.resolve();
  if (!anonSignInPromise) {
    anonSignInPromise = signInAnonymously(auth)
      .then(() => {})
      .catch((error) => {
        // Reset so the next call can retry (e.g. transient network failure).
        anonSignInPromise = null;
        throw error;
      });
  }
  return anonSignInPromise;
}
