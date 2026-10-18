# SA2 audit (seats 191-203, 207-208)

## 1. Partition check
- **Bangladesh** (ADM1 divisions -> seats): Dhaka -> 191, 192, 193, 194 (Dhaka 191; Narayanganj/Munshiganj/Faridpur/Gopalganj/Shariatpur/Madaripur/Rajbari 192; Gazipur/Narsingdi/Tangail/Manikganj 193; Kishoreganj 194). Mymensingh -> 194 (entire). Chittagong -> 195 (Chittagong, Cox's Bazar, Rangamati, Bandarban, Khagrachhari, Feni), 197 (Cumilla, Chandpur, Lakshmipur, Noakhali), 198 (Brahmanbaria). Sylhet -> 198 (entire). Rajshahi -> 196 (Pabna, Sirajganj), 199 (other 6). Rangpur -> 199 (Gaibandha), 200 (other 7). Khulna -> 192 (Magura, Narail), 196 (Jashore, Kushtia, Jhenaidah, Chuadanga, Meherpur), 201 (Khulna, Bagerhat, Satkhira). Barisal -> 201 (entire). All 64 districts assigned exactly once (checked programmatically).
- **Nepal**: Koshi -> 202; Bagmati -> 202; Madhesh -> 202 (Saptari, Siraha, Dhanusha, Mahottari, Sarlahi) and 203 (Parsa, Bara, Rautahat); Gandaki, Lumbini, Karnali, Sudurpashchim -> 203. All 77 districts assigned once.
- **Sri Lanka**: Western, North Western, Sabaragamuwa -> 207; Central, Southern, Uva, North Central, Northern, Eastern -> 208. All 9 provinces (25 districts) once.
- **Maldives**: entire ADM0 -> 208.
Nothing missing, nothing double-counted.

## 2. Population check
Seat sum 231.8m vs scope estimate 231.8m (Bangladesh 177.6m + Nepal 30.6m + Sri Lanka 23.1m + Maldives 0.53m = 231.83m; UN WPP 2024 extrapolated to 2026). Per-country sums of seats match to rounding. Bangladesh uses district populations from the 2022 census (Wikipedia table; sums to 165.9m, i.e. the preliminary count, vs ~169.8m final) scaled uniformly; Nepal 2021 census; Sri Lanka 2012 census (Low confidence; 2024 census total is 21.8m vs WPP ~23.1m).

## 3. Flags
- Beyond ADM2: none.
- Out of band: seat 207 (11.5m) and 208 (12.1m) are LOW - the scope has only 2 seats for ~23.6m people.
- Long sea link: Maldives to southern Sri Lanka (seat 208, ~700-900 km, inherited from old sheet).
- Structural changes: old Dhaka North/South replaced by Dhaka district + Padma basin; east Bangladesh reduced from 4 seats to 3 (seat 196 reused for Jashore-Kushtia-Pabna); Mymensingh division added (194).
