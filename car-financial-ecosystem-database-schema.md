# Car Financial Ecosystem — Database Schema (Firebase / Firestore)

This is the real database design behind the three surfaces already built:
**mobile app (detailed history)**, **in-car dashboard (summary only)**, and
**partner portal (cars attended / fixed / closed)**.

Everything below is Firestore-native — collections, documents, and the
Cloud Functions that keep derived numbers (spend summaries, partner stats)
up to date in real time.

---

## 1. Design Principle: One Source of Truth, Two Views

The mobile app and the in-car dashboard read the **same underlying data**,
just shaped differently:

| Surface | Reads from | Shape |
|---|---|---|
| Mobile app | `expenses` collection (full query, filterable, paginated) | Every transaction, every field, full history |
| In-car dashboard | `vehicles/{id}.summary` (one small pre-computed object) | Just 3 numbers: today / this month / cost-per-km |

The in-car screen never queries the full `expenses` collection directly —
that would be too slow and too much data for a glance screen. Instead, a
Cloud Function keeps a **rolled-up summary** on the vehicle document itself,
recalculated every time an expense is added. The dashboard reads one tiny
document instead of running an aggregation query while the driver is
looking at the screen.

---

## 2. Collections

### `users/{userId}`
```
{
  name: "Rohan Mehta",
  phone: "+91 98xxxxxxx",
  email: "rohan@email.com",
  createdAt: Timestamp,
  homeLocation: GeoPoint,
  subscriptionTier: "free" | "premium",
  activeVehicleId: "veh_001"        // for quick lookup, if multi-vehicle later
}
```

### `vehicles/{vehicleId}`
This is the document the **in-car dashboard reads directly** — its `summary`
sub-object is the entire payload for the glance screen.
```
{
  ownerId: "users/uid123",
  name: "Hyundai Creta SX",
  plate: "KA 05 MX 1234",
  make: "Hyundai", model: "Creta", variant: "SX", year: 2023,
  fuelType: "petrol",
  odometer: 34210,
  odometerUpdatedAt: Timestamp,
  odometerMonthStart: 33500,          // snapshot for cost/km, reset monthly by a scheduled function

  insurancePolicy: {
    insurer: "Bajaj Allianz", policyNumber: "OG-...", premium: 6200,
    expiryDate: Timestamp, documentUrl: "gs://.../policy.pdf"
  },
  lastService: { date: Timestamp, odometer: 33920, serviceCentreName: "Om Auto Care" },
  puc: { expiryDate: Timestamp, documentUrl: "gs://.../puc.pdf" },
  warranty: { expiryDate: Timestamp },
  batteryInstalledDate: Timestamp,
  tyreLastChangedOdometer: 28000,

  trustScore: 92,                     // recalculated by Cloud Function, see Section 5

  // ---- THIS is what the in-car dashboard actually reads ----
  summary: {
    todaySpend: 0,
    monthSpend: 4200,
    yearSpend: 50400,
    costPerKm: 6.80,
    distanceThisMonth: 618,
    lastUpdated: Timestamp
  }
}
```

### `expenses/{expenseId}`
This is what the **mobile app's detailed Expenses/Insights tabs** query —
full history, filterable by category/date/verified status.
```
{
  vehicleId: "vehicles/veh_001",
  ownerId: "users/uid123",             // denormalized for security-rule simplicity
  category: "fuel" | "service" | "insurance" | "tyres" | "battery" | "puc" | "other",
  amount: 1850,
  date: Timestamp,
  odometerAtEntry: 34180,
  notes: "",
  receiptUrl: "gs://.../receipt.jpg",  // optional, from OCR upload
  source: "manual" | "ocr" | "partner_confirmed",
  verified: false,                     // true ONLY if source == partner_confirmed
  partnerId: "partners/p_009",         // set only when verified
  leadId: "leads/lead_044",            // links back to the lead that created it, if any
  createdAt: Timestamp
}
```

### `alerts/{alertId}`
```
{
  vehicleId: "vehicles/veh_001",
  category: "insurance" | "service" | "puc" | "tyres" | "battery" | "warranty",
  urgencyLevel: "high" | "medium" | "low",
  dueDate: Timestamp,
  status: "active" | "snoozed" | "resolved" | "dismissed",
  snoozedUntil: Timestamp,
  createdAt: Timestamp
}
```

### `leads/{leadId}`
The single most important collection for revenue — and the one the
**Partner Portal is entirely built from**.
```
{
  userId: "users/uid123",
  vehicleId: "vehicles/veh_001",
  category: "insurance" | "service" | "tyres" | "battery" | "accessories" | "roadside",
  partnerId: "partners/p_009",
  status: "new" | "contacted" | "quoted" | "converted" | "lost",
  contextSnapshot: { odometer: 34210, lastServiceDate: Timestamp, currentPolicy: "..." },
  quotedAmount: 2200,
  createdAt: Timestamp,
  statusUpdatedAt: Timestamp,
  commissionAmount: 150,
  commissionStatus: "pending" | "invoiced" | "paid"
}
```

### `partners/{partnerId}`
```
{
  businessName: "Om Auto Care",
  category: ["service", "battery"],
  serviceRadius: 8,              // km
  location: GeoPoint,
  contactPhone: "+91 98xxxxxxx",
  contactEmail: "contact@omauto.in",
  rating: 4.6,
  verified: true,
  pricingBand: "mid",
  featuredUntil: Timestamp,      // null if not a paid featured listing
  active: true,

  // ---- THIS is what the Partner Portal dashboard reads ----
  stats: {
    carsAttended: 214,           // total leads ever assigned to this partner
    carsFixed: 187,              // leads with status == "converted"
    closedWorks: 201,            // converted + lost (i.e. no longer open)
    openLeads: 13,               // new + contacted + quoted
    conversionRate: 0.874,       // carsFixed / carsAttended
    commissionOwed: 4500,
    commissionPaid: 38200,
    lastUpdated: Timestamp
  }
}
```

### `partner_users/{partnerUserId}`
```
{ partnerId: "partners/p_009", role: "owner" | "staff", phone: "...", name: "..." }
```

---

## 3. Where Each Screen Reads From

### Mobile app (detailed)
| Screen | Query |
|---|---|
| Expenses tab | `expenses.where('vehicleId','==',vid).orderBy('date','desc')` — paginated |
| Insights tab | Same query, grouped client-side (or via a Cloud Function for large histories) by `category`, filtered to current month |
| Passport tab | `expenses.where('vehicleId','==',vid).where('verified','==',true).orderBy('date','desc')` + `vehicles/{vid}.trustScore` |
| Home tab | `vehicles/{vid}` (for the hero card + the same `summary` object the car uses) + `alerts.where('vehicleId','==',vid).where('status','==','active')` |

### In-car dashboard (summary only)
| Screen | Query |
|---|---|
| Home | **Single document read**: `vehicles/{vid}` → use `.name`, `.plate`, `.trustScore`, `.summary.*` only. No expense query ever runs on this screen. |
| Alert card | `alerts.where('vehicleId','==',vid).where('status','==','active').orderBy('priorityScore','desc').limit(1)` |
| Partner selection | `partners.where('category','array-contains',cat).where('active','==',true).orderBy('rating','desc').limit(3)` |

### Partner Portal
| Screen | Query |
|---|---|
| Leads inbox | `leads.where('partnerId','==',pid).orderBy('createdAt','desc')` |
| Dashboard stats | **Single document read**: `partners/{pid}.stats` — never a live aggregation query while the partner is looking at the screen |

---

## 4. Cloud Functions (what keeps the summaries "real-time")

```
computeVehicleSummary   — Firestore trigger on expenses/{id} write (create/update/delete)
                           Recomputes vehicles/{vid}.summary.{todaySpend, monthSpend,
                           yearSpend, costPerKm, distanceThisMonth} and writes it back.
                           This is why the in-car screen can do a single cheap document
                           read instead of aggregating on the glance screen.

resetMonthlyOdometerSnapshot — Scheduled, runs 00:00 on the 1st of each month.
                           Sets vehicles/{vid}.odometerMonthStart = current odometer,
                           so next month's cost/km starts counting distance fresh.

computeAlerts            — Scheduled, daily. Reads vehicle due-dates (insurance/PUC/
                           service), writes/updates alerts/{id} docs.

matchPartners             — Callable, when a user starts a lead flow. Queries eligible
                           partners by category + geo + rating, returns top 3.

createLead                 — Callable, on user "confirm" action inside the lead flow.
                            Writes leads/{id}, marks the matching alert "resolved",
                            triggers partner FCM push.

onLeadStatusChange         — Firestore trigger on leads/{id} update.
                            • On "converted": writes an expenses/{id} doc (source:
                              "partner_confirmed", verified: true), bumps
                              vehicles/{vid}.trustScore, recalculates
                              partners/{pid}.stats (carsAttended/carsFixed/
                              closedWorks/conversionRate), sets commissionAmount.
                            • On "lost": updates partners/{pid}.stats.closedWorks
                              and .openLeads only — no trustScore or expense change.

onLeadCreate                — Firestore trigger on leads/{id} create.
                             Increments partners/{pid}.stats.carsAttended and
                             .openLeads by 1.

ocrProcessDocument          — Storage trigger on document upload. Runs OCR, extracts
                             structured fields, updates vehicles/{vid} doc.
```

This is the exact mechanism that makes "cars attended / fixed / closed" on
the Partner Portal a **single fast document read** instead of a live COUNT
query across potentially thousands of lead documents — the count is kept
current incrementally, every time a lead is created or its status changes.

---

## 5. Trust Score Recalculation (ties to Section 14 of the product doc)

Runs inside `onLeadStatusChange`, triggered only when `status` becomes
`"converted"`:

```
newScore = min(99, currentScore + 2)
vehicles/{vid}.trustScore = newScore
```

A more complete version (Phase 2) would recompute the full weighted formula
from Section 14.3 of the product design doc, rather than a flat +2 — that
requires reading the full verified-expense history, which is why it's a
background recompute, not something calculated on every dashboard load.

---

## 6. Indexes Required

Composite indexes Firestore will ask you to create (also included as a
ready-to-deploy `firestore.indexes.json` file):

```
expenses:  (vehicleId ASC, date DESC)
expenses:  (vehicleId ASC, verified ASC, date DESC)
alerts:    (vehicleId ASC, status ASC, priorityScore DESC)
leads:     (partnerId ASC, createdAt DESC)
leads:     (partnerId ASC, status ASC)
partners:  (category ARRAY, active ASC, rating DESC)
```

---

## 7. Security Rules Summary

Full rules are in the accompanying `firestore.rules` file. The core logic:

- A user can only read/write `expenses`, `alerts`, and `vehicles` docs where
  `ownerId == request.auth.uid` (checked via the denormalized `ownerId`
  field on `expenses`, and via `vehicles.ownerId` for the vehicle doc).
- A user can create a `leads` doc but can never set `status`, `commissionAmount`,
  or `commissionStatus` directly — those are Cloud-Function-only writes.
- A partner (`partner_users`) can only read/update `leads` docs where
  `partnerId` matches their own `partners` doc, and can only move `status`
  forward through the fixed flow (`new → contacted → quoted → converted`,
  or `→ lost` from any open state) — never backward, never to arbitrary values.
- `partners/{id}.stats` is **read-only from the client, write-only from
  Cloud Functions** — this is what stops a partner from editing their own
  "cars fixed" number.
