# ME audit (seats 274-286)

## 1. Partition check
| ADM0 | Seat(s) |
|---|---|
| Iraq (19 governorates) | 274 Baghdad, Diyala, Anbar, Babylon; 275 Basra, Dhi Qar, Maysan, Muthanna, Qadisiyyah, Wasit, Najaf, Karbala; 276 Nineveh, Erbil, Duhok, Sulaymaniyah, Halabja, Kirkuk, Saladin |
| Saudi Arabia (13 regions) | 277 Makkah, Madinah, Asir, Jazan, Najran, Al Bahah; 278 Riyadh, Al-Qassim, Hail, Al Jawf, Northern Borders, Tabuk; 286 Eastern Province |
| Yemen (22 governorates) | 279 Amanat Al Asimah, Sana'a, Amran, Sa'dah, Hajjah, Al Mahwit, Al Jawf, Marib, Dhamar; 280 Raymah, Al Hudaydah, Ibb, Taiz, Al Bayda, Lahij, Aden, Abyan, Ad Dali', Shabwah, Hadramaut, Al Mahrah, Socotra |
| Syria (14 governorates) | 281 Aleppo, Idlib, Hama, Homs, Raqqa, Al-Hasakah, Deir ez-Zor; 282 Damascus, Rif Dimashq, Daraa, As-Suwayda, Quneitra, Latakia, Tartus |
| Lebanon | 282 (entire) |
| Jordan | 283 (entire) |
| Palestine | 283 West Bank (11 governorates incl. Jerusalem); 284 Gaza Strip (5 governorates) |
| Israel | 284 (entire, incl. Golan as in sheet) |
| Oman | 285 (entire) |
| UAE | 285 (entire) |
| Kuwait, Qatar, Bahrain | 286 (entire) |

Nothing is missing or double-counted (checked programmatically for Iraq, Saudi, Yemen, Syria: every ADM1 appears exactly once; all other ADM0 appear once or, for Palestine, West Bank vs Gaza once each).

## 2. Population check
Sum of seat K = 208.96m (rounded per seat to 10k/100k). Own estimate of scope total (unit-level, scaled to UN WPP 2026-type country totals) = 208.79m; difference +0.08%.
Country totals used (m): Iraq 47.4, Saudi 34.8, Yemen 41.7, Syria 25.4, Lebanon 5.8, Jordan 11.8, Israel 9.6, Palestine 5.6 (WB 3.45, Gaza 2.15), Oman 5.5, UAE 11.5, Qatar 3.1, Bahrain 1.6, Kuwait 5.0.
Mean seat 16.07m, min 11.8m (284), max 21.2m (280).

## 3. Flags
- Beyond ADM2: none (everything at ADM0/ADM1).
- 284 Israel-Gaza 11.8m LOW: Israel (~9.6m) + Gaza only; West Bank stays with Jordan per old sheet, no coherent addition.
- 280 South Yemen 21.2m HIGH (+2%): Yemen total 41.7m cannot be split into two seats <=20.8m.
- Long sea link: Socotra (seat 280) from the Yemen mainland, same country, accepted.
- 282: Latakia/Tartus connect to the rest of the seat only via the Lebanon border (Homs governorate is in seat 281).
- Low-confidence populations: Yemen, Syria, Lebanon, Gaza (no recent census / displacement / war).
- Admin level note: all splits at ADM1 (Iraq/Syria/Yemen governorate; Saudi region; Palestine governorate); ADM2 not needed.
- Restructure vs old sheet: Saudi Eastern Province moved into the Gulf seat (286) to lift it from 9.7m to 15.3m; Gaza moved from the Lebanon-Syria seat to Israel (land border).
