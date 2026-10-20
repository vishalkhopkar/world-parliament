# IN1 audit (India: UP, Bihar, Punjab, Haryana, Delhi, Chandigarh, J&K, Ladakh, Uttarakhand, Himachal)

## 1. Partition check
Only ADM0 in scope: India (all 33 seats: 1-25, 79-82, 85-88).

| ADM1 | Seats | Units |
|---|---|---|
| Uttar Pradesh | 1-16 | all 75 districts, each in exactly one seat |
| Bihar | 17-25 | all 38 districts, each in exactly one seat |
| Punjab | 79 (10 districts), 80 (13 districts) | all 23 districts |
| Haryana | 79 (Panchkula only), 81 (11 districts), 82 (10 districts) | all 22 districts |
| Chandigarh | 79 | entire ADM1 |
| NCT of Delhi | 85 | entire ADM1 |
| Jammu and Kashmir | 86 | entire ADM1 |
| Ladakh | 86 | entire ADM1 |
| Uttarakhand | 87 | entire ADM1 |
| Himachal Pradesh | 88 | entire ADM1 |

Verified by script: district lists per state have no missing and no double-counted unit. Nothing outside scope is included.
District lists use current names/boundaries (Prayagraj, Ayodhya, Nuh, Shamli, Hapur, Sambhal, Amethi, Malerkotla, Charkhi Dadri etc.). Every district carved out after 2011 sits in the same seat as its parent, so the partition is also valid against 2011-era GIS district boundaries (Amethi/Rae Bareli sliver aside).

## 2. Population totals
Sum of 33 seats = 512.48m (mean 15.53m, min 7.80m, max 23.40m).
Method: 2011 census district populations (own knowledge, approximate; post-2011 districts split from parents), scaled within each state to the state totals implied by the old sheet's UN-WPP scaling: UP 251.2m, Bihar 136.8m, Punjab 32.4m + Chandigarh 1.4m (old 2 seats x 16.9m = 33.8m), Haryana 32.4m, Delhi 23.4m, J&K+Ladakh 14.7m, Uttarakhand 12.4m, Himachal 7.8m = 512.5m. Sum of seats matches this within 0.01%. As a sanity check, the 2011 census total of these units is about 404m; 512.5m implies ~1.27x overall growth, in line with other India-wide scaling to UN WPP 2026. These are state-level anchors taken from the old sheet, not independently re-derived; district splits are Medium confidence.

## 3. Flagged seats
- Beyond ADM2: none.
- Outside band: 85 Delhi 23.4m (HIGH, one ADM1/NCT kept whole); 87 Uttarakhand 12.4m (LOW, marginal, whole state); 88 Himachal 7.8m (LOW, whole state, no coherent partner).
- Long/hard links: 86 Ladakh to Kashmir Valley (Zoji La road, seasonal; as in old sheet).
- Structural change: UP has 6 (not 7) seats west of Kanpur and 10 (not 9) from Kanpur east; Bihar's old Nalanda seat became an Anga-Kosi seat; seat numbers 3, 5, 7, 13-14, 18 reassigned (see changes_vs_old).
