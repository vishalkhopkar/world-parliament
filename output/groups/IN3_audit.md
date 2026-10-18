# IN3 audit

## 1. Partition check

ADM0 India (19 states/UTs in scope): appears in all 30 seats (35-40, 46-50, 57-60, 65-78, 89).
ADM0 Bhutan [entire ADM0]: seat 40 only.

India ADM1 units and the seats they appear in:

- West Bengal: seat(s) 35, 36, 37, 38, 39, 40 (split by ADM2)
- Odisha: seat(s) 70, 71, 72 (split by ADM2)
- Jharkhand: seat(s) 71, 75, 76 (split by ADM2)
- Tamil Nadu: seat(s) 46, 47, 48, 49, 50 (split by ADM2)
- Karnataka: seat(s) 57, 58, 59, 60 (split by ADM2)
- Andhra Pradesh: seat(s) 65, 66, 67 (split by ADM2)
- Telangana: seat(s) 68, 69 (split by ADM2)
- Kerala: seat(s) 73, 74 (split by ADM2)
- Assam: seat(s) 40, 77, 78 (split by ADM2)
- Meghalaya: seat(s) 77
- Arunachal Pradesh: seat(s) 89
- Nagaland: seat(s) 89
- Manipur: seat(s) 89
- Mizoram: seat(s) 89
- Tripura: seat(s) 89
- Sikkim: seat(s) 40
- Puducherry: seat(s) 47
- Lakshadweep: seat(s) 73
- Andaman and Nicobar Islands: seat(s) 35

Every ADM2 district of the split states (West Bengal 23, Odisha 30, Jharkhand 24, Tamil Nadu 38, Karnataka 31, Andhra Pradesh 26, Telangana 33, Kerala 14, Assam 33 = 252) was checked programmatically to be in exactly one seat. All other ADM1 units are whole and appear in exactly one seat. Nothing is missing or double-counted; no territory outside the scope is included.

District sets used: West Bengal 23 (post-2017); Assam 33 (2011 units + Hojai, Biswanath, Charaideo, Majuli, West Karbi Anglong, South Salmara-Mankachar; Bajali/Tamulpur lie in Barpeta/Baksa, both seat 77; Karimganj = Sribhumi); Andhra Pradesh 26 (2022 map); Telangana 33; Tamil Nadu 38; Karnataka 31 (incl. Vijayanagara); Odisha 30; Jharkhand 24; Kerala 14. Puducherry, Lakshadweep, Andaman & Nicobar, Sikkim, Meghalaya, Arunachal, Nagaland, Manipur, Mizoram, Tripura are whole ADM1 units. District names follow the current official lists; if the GIS layer predates 2020-22 reorganisations, match new districts to their parents.

## 2. Population

- Sum of seat K = 538,500,000 (538.50m); own scope estimate (state Census-2011 x growth factors + Bhutan 0.79m) = 538.40m; difference +0.02% (rounding only).
- Seat mean 17.95m, min 12.84m, max 20.30m.
- Method: Census 2011 district populations (reconstructed for post-2011 districts) normalised to the state census total, grown to 2026 with state factors (WB 1.13, OD 1.165, JH 1.285, TN 1.137, KA 1.167, AP 1.124, TG 1.143, KL 1.126, AS 1.19, small states 1.12-1.33) calibrated to the UN-WPP-scaled state totals implied by the old sheet for the southern states; Bhutan 0.79m.
- Confidence: Medium, except Andhra Pradesh and Telangana seats (65-69) Low (reconstructed 2011 baselines of new districts; K rounded to 0.1m).

## 3. Flags

- No seat uses ADM3 (beyond_ADM2 = NO everywhere).
- No seat is outside the 12.5-20.8m band; closest to the edges: seat 89 (12.8m), seat 68 (20.3m), seat 35 (20.2m), seat 73 (20.1m).
- Long sea links: seat 35 (Andaman & Nicobar, ~1,250 km from Kolkata); seat 73 (Lakshadweep, 200-440 km from Kozhikode/Kochi).
- Detached exclaves: Puducherry UT enclaves Mahe and Yanam sit in seat 47 with the rest of the UT.
- Cross-state redraws within India: Kolhan (3 Jharkhand districts) in seat 71 with Odisha; seat 40 = Bhutan + Sikkim + north Bengal + 6 western Assam districts.
- Seat 89: Tripura joins the rest of the seat only via its Mizoram border.
