# F3 audit — Kenya, Tanzania, Uganda, Rwanda, Burundi (seats 332-339, 348-350, 382-383)

## 1. Partition check
Admin levels (geoBoundaries / CGAZ files in `GEO/`): Kenya ADM1 = 47 counties; Tanzania ADM1 = 30 regions (Songwe sits inside Mbeya; Zanzibar = 5 regions); Uganda ADM1 = 4 regions, ADM2 = 151 old counties (not districts); Rwanda and Burundi used as whole ADM0.

| ADM0 | Seats | Detail |
|---|---|---|
| Tanzania | 332, 333, 334, 335 | 332: Dar es Salaam, Pwani, Tanga, Lindi, Mtwara + 5 Zanzibar regions (10). 333: Arusha, Kilimanjaro, Manyara, Mara, Mwanza, Simiyu (6). 334: Dodoma, Morogoro, Iringa, Njombe, Mbeya, Rukwa, Katavi, Ruvuma (8). 335: Singida, Tabora, Shinyanga, Geita, Kagera, Kigoma (6). Total 30 of 30 ADM1. |
| Kenya | 336, 337, 338, 339 | 336: 9 counties (Nairobi, Kiambu, Murang'a, Nyandarua, Nyeri, Kirinyaga, Embu, Tharaka, Meru). 337: 14 (Mombasa, Kwale, Kilifi, Tana River, Lamu, Taita Taveta, Garissa, Wajir, Mandera, Marsabit, Isiolo, Kitui, Machakos, Makueni). 338: 14 (Nakuru, Uasin Gishu, Trans Nzoia, Elgeyo-Marakwet, Nandi, Baringo, Kericho, Bomet, Narok, West Pokot, Turkana, Samburu, Laikipia, Kajiado). 339: 10 (Kakamega, Vihiga, Bungoma, Busia, Siaya, Kisumu, Homa Bay, Migori, Kisii, Nyamira). Total 47 of 47 ADM1. |
| Uganda | 348, 349, 350 | Central Region (33 ADM2): all in 348. Eastern Region (39 ADM2): 12 Busoga counties in 348, 27 in 349. Northern Region (38 ADM2): 25 in 349 (Lango, Acholi, Karamoja), 13 in 350 (West Nile/Madi). Western Region (41 ADM2): all in 350. 33+39+38+41 = 151 ADM2. |
| Rwanda | 382 | entire ADM0 |
| Burundi | 383 | entire ADM0 |

Nothing is missing or double-counted. Checked programmatically: Kenya and Tanzania unit lists equal the full geoBoundaries ADM1 name sets; the 151 Uganda ADM2 units are each assigned exactly once. Mukono and Soroti each exist twice as separate ADM2 units; both are within the same seat/region so listing the name once covers both. Lamwo's representative point falls outside the ADM1 polygons (boundary mismatch) but it is Acholi, so counted in Northern Region / seat 349.

## 2. Population check
Seat sums: Tanzania 72.40m, Kenya 58.80m, Uganda 52.81m (rounding), Rwanda 14.90m, Burundi 14.70m = 213.61m. Bases are the old-sheet WPP 2026 country totals (72.4 / 58.8 / 52.8 / 14.9 / 14.7). Mean seat 16.43m, min 13.71m (seat 337), max 19.94m (seat 348). Within-country split: Tanzania 2022 census by region, Kenya 2019 census by county (both reproduce the official national totals exactly), Uganda 2024 census sub-region totals (sum 45,905,417) mapped to ADM2 counties by sub-region. Scope sum matches own estimate (sheet totals) within rounding (<0.1%).

## 3. Flags
- beyond ADM2: none.
- Outside 12.5-20.8m: none. Highest seats: 348 Kampala-Buganda-Busoga 19.94m, 334 Dodoma-Southern Highlands 19.46m, 335 Western Tanzania 18.85m (inside band; Tanzania averages 18.1m per seat). Lowest: 337 13.71m.
- Sea links: seat 332 links Zanzibar/Pemba to the mainland coast by established Dar es Salaam-Zanzibar ferry routes (short crossing). Seat 348 includes Lake Victoria islands (Buvuma, Kalangala, Kyamuswa) as part of Central Region.
- Cultural caveats: seat 337 (Coast + Lower Eastern + North Eastern Kenya) is heterogeneous but forced by the 4-seat constraint and contiguity. Seat 350 joins Western Uganda and West Nile across the Nile at Pakwach. The Rwanda/Burundi seats were not re-blocked with parts of Tanzania/Uganda (both within band).
- Uganda county-level population is a sub-region proxy (Medium confidence).
