/* =========================================================================
   FIREBASE INTEGRATION LAYER — Car Financial Ecosystem
   =========================================================================
   This is real, working Firebase v9+ (modular SDK) code that maps directly
   onto the schema in car-financial-ecosystem-database-schema.md.

   It is NOT wired into the HTML prototype — the prototype uses the
   artifact's built-in window.storage (per-device, not real-time across
   devices). This file is what you'd actually use once you create a real
   Firebase project and want genuine multi-device real-time sync.

   Setup before this file will run:
     npm install firebase
     Create a Firebase project at https://console.firebase.google.com
     Enable: Authentication (phone), Firestore, Storage, Cloud Messaging
     Paste your project's config into firebaseConfig below
     Deploy firestore.rules and firestore.indexes.json (see DEPLOY.md)
   ========================================================================= */

import { initializeApp } from "firebase/app";
import {
  getFirestore, doc, collection, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp, increment
} from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);


/* =========================================================================
   IN-CAR DASHBOARD — single cheap document read, real-time
   Mirrors: vehicles/{vehicleId}.summary
   ========================================================================= */
export function listenToVehicleSummary(vehicleId, onUpdate){
  const ref = doc(db, "vehicles", vehicleId);
  // onSnapshot = true real-time: every device with this listener open updates
  // instantly when the Cloud Function rewrites `summary` after a new expense.
  return onSnapshot(ref, (snap) => {
    if(!snap.exists()) return;
    const data = snap.data();
    onUpdate({
      name: data.name,
      plate: data.plate,
      trustScore: data.trustScore,
      todaySpend: data.summary?.todaySpend ?? 0,
      monthSpend: data.summary?.monthSpend ?? 0,
      costPerKm: data.summary?.costPerKm ?? null,
    });
  });
}

export function listenToTopAlert(vehicleId, onUpdate){
  const q = query(
    collection(db, "alerts"),
    where("vehicleId", "==", vehicleId),
    where("status", "==", "active"),
    orderBy("priorityScore", "desc"),
    limit(1)
  );
  return onSnapshot(q, (snap) => {
    if(snap.empty){ onUpdate(null); return; }
    const d = snap.docs[0];
    onUpdate({ id: d.id, ...d.data() });
  });
}


/* =========================================================================
   MOBILE APP — full detailed history, real-time
   Mirrors: expenses collection, filtered/ordered
   ========================================================================= */
export function listenToExpenses(vehicleId, onUpdate){
  const q = query(
    collection(db, "expenses"),
    where("vehicleId", "==", vehicleId),
    orderBy("date", "desc"),
    limit(100)
  );
  return onSnapshot(q, (snap) => {
    onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export function listenToVerifiedHistory(vehicleId, onUpdate){
  const q = query(
    collection(db, "expenses"),
    where("vehicleId", "==", vehicleId),
    where("verified", "==", true),
    orderBy("date", "desc")
  );
  return onSnapshot(q, (snap) => {
    onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// A manually-logged expense — Cloud Function never marks these "verified".
export async function addManualExpense(vehicleId, ownerId, { category, amount, date, odometer }){
  return addDoc(collection(db, "expenses"), {
    vehicleId, ownerId,
    category, amount, date,
    odometerAtEntry: odometer ?? null,
    source: "manual",
    verified: false,
    createdAt: serverTimestamp(),
  });
}

export async function updateOdometer(vehicleId, newOdometer){
  const ref = doc(db, "vehicles", vehicleId);
  return updateDoc(ref, {
    odometer: newOdometer,
    odometerUpdatedAt: serverTimestamp(),
  });
}


/* =========================================================================
   LEAD FLOW — a user tapping "Renew Now" / "Book Service" in the car or app
   Creating this doc is what the onLeadCreate / onLeadStatusChange Cloud
   Functions react to — they're what actually writes the verified expense,
   bumps the Trust Score, and updates partner stats. Nothing below writes
   those directly; the client is not trusted to set commission or verified
   status (see firestore.rules).
   ========================================================================= */
export async function createLead(userId, vehicleId, category, partnerId, contextSnapshot){
  return addDoc(collection(db, "leads"), {
    userId, vehicleId, category, partnerId,
    status: "new",
    contextSnapshot,
    createdAt: serverTimestamp(),
    statusUpdatedAt: serverTimestamp(),
  });
}


/* =========================================================================
   PARTNER PORTAL — "cars attended / fixed / closed", real-time
   Mirrors: partners/{partnerId}.stats  — pre-aggregated, not a live COUNT()
   ========================================================================= */
export function listenToPartnerStats(partnerId, onUpdate){
  const ref = doc(db, "partners", partnerId);
  return onSnapshot(ref, (snap) => {
    if(!snap.exists()) return;
    const s = snap.data().stats || {};
    onUpdate({
      carsAttended: s.carsAttended ?? 0,
      carsFixed: s.carsFixed ?? 0,
      closedWorks: s.closedWorks ?? 0,
      openLeads: s.openLeads ?? 0,
      conversionRate: s.conversionRate ?? 0,
      commissionOwed: s.commissionOwed ?? 0,
    });
  });
}

export function listenToPartnerLeads(partnerId, onUpdate){
  const q = query(
    collection(db, "leads"),
    where("partnerId", "==", partnerId),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// Partner-side status update — rules only allow forward moves along the
// fixed flow (new -> contacted -> quoted -> converted, or -> lost).
// carsAttended / carsFixed / closedWorks are bumped by the
// onLeadStatusChange Cloud Function, never by this client call.
export async function advanceLeadStatus(leadId, nextStatus){
  const ref = doc(db, "leads", leadId);
  return updateDoc(ref, {
    status: nextStatus,
    statusUpdatedAt: serverTimestamp(),
  });
}


/* =========================================================================
   Example: wiring this into the existing prototype's render functions
   would look like this (pseudocode — replace the window.storage calls):

   listenToVehicleSummary(vehicleId, (summary) => {
     STATE.vehicle = { ...STATE.vehicle, ...summary };
     renderCar();      // re-render whenever Firestore pushes an update
     renderMobile();
   });

   listenToExpenses(vehicleId, (expenses) => {
     STATE.expenses = expenses;
     renderMobile();
   });

   listenToPartnerStats(partnerId, (stats) => {
     renderPortalStats(stats);
   });

   No manual "save then reload" step needed — onSnapshot pushes changes
   the moment any device (or Cloud Function) writes them. This is what
   makes it real multi-device real-time, unlike the single-device
   window.storage version in the prototype.
   ========================================================================= */
