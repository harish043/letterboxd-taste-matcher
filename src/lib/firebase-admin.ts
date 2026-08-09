import "server-only";
import { cert, getApps, initializeApp } from "firebase-admin/app";

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

let adminApp: ReturnType<typeof initializeApp> | null = null;

/**
 * Lazy singleton for the Firebase Admin SDK. Server-only (guarded by
 * `server-only`); never import from a client component. Env vars use the
 * service-account JSON values; the private key's escaped newlines (`\n`) are
 * unescaped so the value works whether pasted flat or with real line breaks.
 */
export function getFirebaseAdmin() {
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "Firebase Admin is not configured: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY must be set."
    );
  }
  if (!adminApp) {
    adminApp =
      getApps().length > 0
        ? getApps()[0]
        : initializeApp({
            credential: cert({
              projectId: FIREBASE_PROJECT_ID,
              clientEmail: FIREBASE_CLIENT_EMAIL,
              privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            }),
          });
  }
  return adminApp;
}
