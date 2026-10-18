# SA1 audit (seats 175-190, 204-206; Pakistan + Afghanistan)

Admin levels used: geoBoundaries (gbOpen, current). Pakistan ADM1 = 7 provinces/territories, ADM2 = 126 districts (pre-2020 district set, so newer districts sit inside their parent polygon: Larkana in "Qambar Shahdadkot", Sujawal in "Thatta", Chiniot in "Jhang", Nankana Sahib in "Sheikhpura", Kot Addu in "Muzaffargarh", Taunsa in "Dera Ghazi Khan", Murree in "Rawalpindi", Wazirabad in "Gujranwala"; Azad Kashmir, Islamabad Capital Territory are single ADM2s; "Nawabshah" = Shaheed Benazirabad). Afghanistan ADM1 = 34 provinces (geoBoundaries spells Ghazni as "Ghanzi"). No division level used.

## 1. Partition check
Pakistan (checked programmatically against the 126 ADM2 list: every unit appears exactly once):
- Sindh (22 ADM2): Karachi -> 175; Hyderabad, Jamshoro, Matiari, Tando Allahyar, Tando Muhammad Khan, Badin, Thatta, Mirpurkhas, Umerkot, Tharparkar, Sanghar -> 176; Sukkur, Khairpur, Ghotki, Shikarpur, Jacobabad, Kashmore, Qambar Shahdadkot, Dadu, Naushehro Feroze, Nawabshah -> 177.
- Punjab (34 ADM2): Lahore -> 178; Kasur, Sheikhpura, Okara, Pakpattan -> 179; Faisalabad, Toba Tek Singh, Jhang -> 180; Gujranwala, Sialkot, Narowal, Gujrat -> 181; Rawalpindi, Attock, Chakwal, Jhelum -> 182; Multan, Khanewal, Vihari, Lodhran, Sahiwal -> 183; Bahawalpur, Bahawalnagar, Rahim Yar Khan -> 184; Sargodha, Khushab, Mianwali, Bhakkar, Mandi Bahauddin, Hafizabad -> 185; Dera Ghazi Khan, Rajanpur, Muzaffargarh, Layyah -> 186.
- Khyber Pakhtunkhwa (31 ADM2): Peshawar, Charsadda, Nowshera, Mardan, Swabi, Buner -> 187; Abbottabad, Mansehra, Haripur, Battagram, Kohistan, Shangla, Swat, Upper Dir, Lower Dir, Malakand, Chitral -> 188; Khyber, Mohmand, Bajaur, Kohat, Karak, Hangu, Kurram, Orakzai, Bannu, Lakki Marwat, Tank, Dera Ismail Khan, North Waziristan, South Waziristan -> 189.
- Balochistan [entire ADM1, 27 ADM2] -> 190.
- Islamabad Capital Territory [entire ADM1] -> 182. Azad Kashmir [entire ADM1] -> 182. Gilgit-Baltistan [entire ADM1, 10 ADM2] -> 188.

Afghanistan (34 ADM1, all entire; each in exactly one seat):
- 204: Kabul, Nangarhar, Laghman, Kunar, Nuristan, Kapisa, Parwan, Panjshir, Logar, Wardak, Bamyan.
- 205: Kandahar, Helmand, Uruzgan, Zabul, Nimruz, Farah, Ghazni, Daykundi, Paktika, Paktia, Khost, Herat.
- 206: Badghis, Ghor, Balkh, Faryab, Jowzjan, Sar-e Pol, Samangan, Kunduz, Baghlan, Takhar, Badakhshan.

Nothing is missing or double-counted. No territory outside Pakistan/Afghanistan is included, and no seat mixes the two countries.

## 2. Population totals
Seat K sum (19 seats) = 303.0m. Own scope estimate: Pakistan 259.0m (UN WPP 2026 assumption; 2023 census 241.5m for provinces + ICT, plus AJK ~4.5m and GB ~1.8m, scaled by ~1.045) + Afghanistan 44.0m = 303.0m. Pakistan seats sum 259.0m; Afghanistan seats sum 44.0m. Difference 0%.
Method: 2023 census district figures (from memory, normalised to provincial census totals) grown to 2026 by one national factor. Afghanistan has no census since 1979; provincial shares are NSIA-style estimates scaled to 44.0m, so those three seats are Low confidence (rounded to 100k).

## 3. Flags
- Beyond ADM2: none.
- Out of band: seat 175 Karachi = 21.31m (HIGH, +2.5% above the 20.8m cap): geoBoundaries has Karachi as one ADM2; splitting would need ADM3 and cascade rebalancing in Sindh. All other seats are 13.35-19.23m.
- Lower end (inside band): 185 Sargodha 13.35m, 178 Lahore 13.59m, 186 DG Khan 13.62m, 189 Waziristan 13.86m, 184 Bahawalpur 14.04m.
- Long sea links: none. Contiguity by land throughout; seat 189 is a long chain (Bajaur-Mohmand-Khyber-Orakzai-Kurram-Hangu-Kohat-Karak-Bannu-Lakki Marwat-Tank-Dera Ismail Khan plus Waziristans), seat 205 and 206 are long but contiguous provincial chains.
- Disputed areas: Azad Kashmir (182) and Gilgit-Baltistan (188) are assigned as Pakistan-administered areas; no sovereignty statement implied.
