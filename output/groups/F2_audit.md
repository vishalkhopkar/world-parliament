# F2 audit (Horn of Africa / Sudan)

## 1. Partition check
Scope total (UN WPP 2026 via Worldometers): Ethiopia 138,902,185; Eritrea 3,682,669; Djibouti 1,199,459; Sudan 53,282,719; South Sudan 12,436,037; Somalia 20,305,907.

| ADM0 | Seats |
|---|---|
| Ethiopia | 309, 310, 311, 312, 313, 314, 315, 316, 317 (split) |
| Eritrea | 315 (entire) |
| Djibouti | 315 (entire) |
| Sudan | 344, 345, 346, 347 (split) |
| South Sudan | 384 (entire) |
| Somalia (incl. Somaliland) | 375 (entire) |

Ethiopia ADM1 (11, geoBoundaries): Addis Ababa 309; Afar 315; Tigray 315; Dire Dawa 311; Hareri 311; Somali 311; Beneshangul Gumu 316; Gambela 316; Amhara split 309 / 313 / 314; Oromia split 309 / 310 / 311 / 312 / 316; SNNPR split 312 / 317.
Ethiopia ADM2 (74 units) all assigned exactly once (checked by script):
- Amhara (11 ADM2): 309 North Shewa(R3), Oromia Zone, Special Woreda; 313 North Gonder, Wag Himra, North Wollo, South Wollo; 314 Awi/Agew, East Gojam, West Gojam, South Gonder.
- Oromia (17): 309 North Shewa(R4), South West Shewa; 310 Arsi, West Arsi, Bale, Guji, Borena, East Shewa; 311 East Harerge, West Harerge; 312 Jimma; 316 West Shewa, East/West/Kelem Wellega, Horo Guduru, Ilubabor.
- SNNPR (18): 312 Gurage, Hadiya, KT, Selti, Yem, Alaba, Keffa, Sheka, Bench Maji, Dawro, Konta; 317 Sidama, Wolayita, Gamo Gofa, Gedio, South Omo, Segen Peoples', Basketo.
Sudan ADM1 (19): Khartoum, River Nile, Northern 344; North, South, West, Central Darfur 345; North, South, West Kordofan, East Darfur, Abyei PCA, White Nile, Sennar, Blue Nile 346; Gezira, Red Sea, Kassala, Gedaref 347.
Nothing is missing or double-counted. Every seat checked contiguous by polygon adjacency (geoBoundaries CGAZ).

## 2. Population
Sum of 15 seats = 229.80m vs scope total 229.81m (difference <0.01%; rounding to 100k). Mean 15.32m, min 12.1m (344), max 20.3m (375).
Method: Ethiopia regional totals from Adugna (Jan 2025) shares scaled to WPP 2026; zone shares within Oromia from CSA zone projections, within Amhara and SNNPR from CSA/2007 census weights; Sudan state shares from CBS 2018 projections; Finfinne special zone (~1.3m) spread across Shewa polygons. All seats Low confidence (Ethiopia no census since 2007, Sudan 2008, Somalia 1975, South Sudan 2008, Eritrea none).

## 3. Flags
- Beyond ADM2: none.
- Out of band: 344 Khartoum 12.1m (LOW, 3% under; Gezira not split to fix it); 384 South Sudan 12.4m (LOW, whole country).
- Long sea links: none.
- Notes: Abyei PCA placed with 346 (no sovereignty implied); Tigray ADM1 includes disputed areas; Bahir Dar and Finfinne special zones are not separate ADM2 in the dataset.
