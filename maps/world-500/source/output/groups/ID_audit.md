# ID audit (seats 209-225, Indonesia + Timor-Leste)

## 1. Partition check
ADM0 in scope: Indonesia (38 provinces; current post-2022 Papua division, mapping 1:1 to the old 34-province layout), Timor-Leste.

**Timor-Leste**: [entire ADM0] in seat 224 only.

**Indonesia ADM1 -> seat(s)**
- Aceh: 218
- North Sumatra: 218 (28 ADM2) + 219 (5 ADM2: Mandailing Natal, South Tapanuli, Padang Lawas, North Padang Lawas, Padang Sidempuan City) = 33 ADM2, no overlap
- West Sumatra, Riau, Riau Islands: 219
- Jambi, Bengkulu, South Sumatra, Bangka Belitung Islands: 220
- Lampung: 221
- Jakarta: 209
- Banten: 209 (Tangerang Regency, Tangerang City, South Tangerang City) + 221 (Serang Reg., Serang City, Cilegon, Pandeglang, Lebak) = 8 ADM2
- West Java (27 ADM2): 210 (6: Bogor Reg/City, Depok, Sukabumi Reg/City, Cianjur), 211 (11), 212 (6), 213 (4: Cirebon Reg/City, Kuningan, Majalengka) = 27
- Central Java (35 ADM2): 213 (9), 214 (19), 215 (7) = 35
- Yogyakarta: 215 (entire)
- East Java (38 ADM2): 215 (8: Ponorogo, Magetan, Ngawi, Madiun Reg/City, Nganjuk, Kediri Reg/City), 216 (13), 217 (17) = 38
- Bali, West Nusa Tenggara, East Nusa Tenggara: 224
- West, Central, South, East, North Kalimantan: 222
- South, Southeast, Central, West Sulawesi: 223
- North Sulawesi, Gorontalo: 225
- Maluku, North Maluku: 225
- Papua, South Papua, Central Papua, Highland Papua, West Papua, Southwest Papua: 225

Nothing is missing or double-counted: ADM2 assignment for North Sumatra, Banten, West/Central/East Java was done by script with duplicate/missing checks; all other provinces are whole ADM1 units used once.

## 2. Population totals
Sum of seat K (rounded) = 287.16m. My scope estimate: Indonesia 285.7m (UN WPP 2026-type figure) + Timor-Leste 1.42m = 287.12m. Difference 0.01% (rounding). Method: SP2020 census by province / regency (ADM2 values from memory, rescaled to province totals), province-specific growth factors, normalised so the Indonesia total equals 285.7m. Timor-Leste from 2022 census. Mean 16.89m, min 13.36m (seat 212), max 19.71m (seat 218).

## 3. Flags
- No ADM3 splits (beyond_ADM2 = NO everywhere).
- No seat outside 12.5-20.8m. Lowest: 212 Bekasi (13.4m), 225 Papua-Maluku (13.5m, Low confidence). Highest: 218 Aceh-Medan (19.7m).
- Long sea links: 225 (North Sulawesi/Gorontalo to North Maluku ~400 km; Maluku to Papua), 221 (Sunda Strait Merak-Bakauheni ferry ~30 km, short), 219 (Riau Islands), 220 (Bangka Belitung), 218 (Nias), 224 (island chain).
- Redraws that cross provincial lines: 213 (Cirebon + western Central Java Ngapak belt), 215 (Surakarta + Mataraman East Java), 218/219 (Mandailing cluster of North Sumatra to Riau-Minangkabau seat), 221 (Lampung with Banten), 225 (North Sulawesi + Gorontalo with Maluku-Papua).
