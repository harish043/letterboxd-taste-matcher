import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
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

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseClient());
}

export function getFirestoreClient(): Firestore {
  return getFirestore(getFirebaseClient());
}
