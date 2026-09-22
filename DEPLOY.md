# Deploying This — Two Different Things

There are two separate "deploy" questions here, and they need different answers.

---

## 1. Deploying the prototype you already have (fastest — ~10 minutes)

The HTML prototype is a complete static web app already. You can put it on
the public internet right now using Firebase Hosting, which gives you a
real, shareable `https://your-project.web.app` URL — good enough to open
on any phone without going through Claude at all.

```bash
npm install -g firebase-tools
firebase login

mkdir car-fin-eco && cd car-fin-eco
mkdir public
# copy car-financial-ecosystem-prototype.html into public/ and rename it index.html

firebase init hosting
# – select "Create a new project" (or use an existing one)
# – public directory: public
# – configure as single-page app: No
# – set up automatic builds: No

firebase deploy
```

You'll get a live URL at the end. That's a real deployed app — but it's
still the same window.storage-backed version, so data stays on whichever
device/browser opened it (see the honesty note in the schema doc).

---

## 2. Deploying the real backend (Firestore + Cloud Functions)

This is the actual multi-device, real-time version — it needs your own
Firebase project with billing enabled (Cloud Functions require the Blaze
pay-as-you-go plan; Firestore itself has a generous free tier).

```bash
firebase init firestore functions
# – use the firestore.rules and firestore.indexes.json already provided
# – choose JavaScript or TypeScript for functions

firebase deploy --only firestore:rules,firestore:indexes
```

Then implement the six Cloud Functions listed in Section 4 of the schema
doc (`computeVehicleSummary`, `resetMonthlyOdometerSnapshot`, `computeAlerts`,
`matchPartners`, `createLead`, `onLeadStatusChange`, `onLeadCreate`,
`ocrProcessDocument`) and deploy:

```bash
firebase deploy --only functions
```

Finally, swap the prototype's `window.storage` calls for the real calls in
`firebase-integration.js` — that file already has the exact functions
(`listenToVehicleSummary`, `listenToExpenses`, `advanceLeadStatus`, etc.)
mapped 1:1 to what the UI needs.

---

## What I can't do for you

I don't have the ability to create a Google/Firebase account, enable
billing, or push code to a live cloud project on your behalf — those steps
need your own credentials and require you to run the commands above
yourself. Everything I've handed you (rules, indexes, schema, integration
code) is real and ready to deploy the moment you run them.
