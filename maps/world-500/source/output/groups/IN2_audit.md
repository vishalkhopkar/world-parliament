# IN2 audit - India west and central (Maharashtra, Goa, Gujarat, Rajasthan, Madhya Pradesh, Chhattisgarh, Dadra & Nagar Haveli and Daman & Diu)

## 1. Partition check
ADM0 in scope: India only (one ADM0). It appears in all 26 seats (26-34, 41-45, 51-56, 61-64, 83-84). ADM1 and ADM2 are taken from the geoBoundaries CGAZ ADM2 layer in D:\Projects\world-parliament\GEO (187 districts in scope: MH 36, Goa 2, Gujarat 33, Rajasthan 33, MP 52, Chhattisgarh 28, DNH&DD 3 - the 3 DNHDD sub-units are covered by the single ADM1).

- Maharashtra: seats [26, 27, 28, 29, 30, 31, 32, 33, 34]; 36 of 36 ADM2 units assigned.
- Goa: seats [29]; 2 of 2 ADM2 units assigned.
- Gujarat: seats [53, 61, 62, 63, 64]; 33 of 33 ADM2 units assigned.
- Rajasthan: seats [51, 52, 53, 54, 55, 56]; 33 of 33 ADM2 units assigned.
- Madhya Pradesh: seats [34, 41, 42, 43, 44, 45, 55]; 52 of 52 ADM2 units assigned.
- Chhattisgarh: seats [83, 84]; 28 of 28 ADM2 units assigned.
- Dadra and Nagar Haveli and Daman and Diu: seats [62]; 3 of 3 ADM2 units assigned.

Programmatic check (python): every one of the 187 ADM2 units appears in exactly one seat; no unit missing, none double-counted. No territory outside the scope is included. Contiguity checked on geoBoundaries polygons (adjacency within 0.02 degrees): all seats are single connected components except seat 62 (Diu, see section 3).

## 2. Population sum vs scope estimate
Sum of seat K = 420,850,000 ; own scope estimate = 420,830,000 (state targets: MH 132.3m, Goa 1.65m, GJ 74.5m, RJ 88.4m, MP 91.5m, CG 31.5m, DNHDD 0.98m). Difference arises only from rounding to 10,000/100,000 (<0.05%).
Method: Census 2011 district populations (new districts carved out since 2011 estimated from tehsil/parent totals), grown with district-specific factors, then scaled so each state total hits a 2026 state estimate consistent with a WPP-scaled India total of ~1.476bn. State totals are my estimate (RGI Technical Group-style projections scaled up), not an official figure.

Seat stats: mean 16.19m, min 13.25m (seat 26), max 19.72m (seat 61).

## 3. Flagged seats
- Beyond ADM2: none.
- Out of band (12.5-20.8m): none.
- Long sea link: seat 62 - Diu (part of the single ADM1 Dadra and Nagar Haveli and Daman and Diu) is an exclave off Gir Somnath (Saurashtra); the rest of the UT borders Valsad. The UT cannot be split at ADM1 level, so the whole UT sits in the Surat/South Gujarat seat; Diu is ~400 km from Daman by road via Saurashtra/Gujarat coast or a sea hop.
- Cross-state blocks (all India, culturally argued in notes): seat 34 (+Balaghat, Seoni, Chhindwara of MP), seat 53 (+Banas Kantha of Gujarat), seat 55 (+Neemuch, Mandsaur of MP).
- Low confidence (population rounded to 100k): seats 83, 84 (Chhattisgarh) - 2011 populations of newly carved districts (Baloda Bazar, Gariaband, Balod, Bemetra, Mungeli, GPM, Surajpur, Balrampur, Kondagaon, Sukma) estimated.
- District name caveat: geoBoundaries ADM2 reflects 2021 boundaries. MP lacks Mauganj/Pandhurna/Maihar (2023), Rajasthan has the 33 pre-2023 districts, Chhattisgarh 28 districts, Maharashtra 36 (incl. Palghar). Names follow the geoBoundaries spelling (Ahmadnagar, Bid, Buldana, Gondiya, Raigarh=Raigad, Batod=Botad, Ahmadabad, Kachchh, Dohad, Chittaurgarh, Dhaulpur, Jhunjhunun, Hoshangabad; Khargone and Khandwa are listed there as Khargone (West Nimar) and Khandwa (East Nimar)).
