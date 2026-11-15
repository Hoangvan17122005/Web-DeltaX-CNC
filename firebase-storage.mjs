import { applicationDefault, cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let firebaseApp = null;

export async function initializeFirestore() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let serviceAccount;
  if (serviceAccountJson) {
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.");
    }
  }

  const credential = serviceAccount ? cert(serviceAccount) : applicationDefault();
  firebaseApp = initializeApp({
    credential,
    ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {})
  }, "forge-cnc");
  return getFirestore(firebaseApp);
}

export async function closeFirestore() {
  if (!firebaseApp) return;
  await deleteApp(firebaseApp);
  firebaseApp = null;
}
