# F1 audit - Nigeria (seats 293-308)

## 1. Partition check
Scope: Nigeria (ADM0). Every one of the 36 states + FCT (ADM1) is included whole as [entire ADM1] in exactly one seat. No ADM2 (LGA) or ADM3 split is used, so all 774 LGAs are implicitly assigned with their parent state.

| Seat | Short name | ADM1 units |
|---|---|---|
| 293 | Lagos | Lagos |
| 294 | Ogun-Ondo-Ekiti | Ogun, Ondo, Ekiti |
| 295 | Oyo-Osun | Oyo, Osun |
| 296 | Kwara-Niger-Kogi | Kwara, Niger, Kogi |
| 297 | Benue-Taraba-Nasarawa | Benue, Taraba, Nasarawa |
| 298 | Edo-Delta-Bayelsa | Edo, Delta, Bayelsa |
| 299 | Rivers-Akwa Ibom | Rivers, Akwa Ibom |
| 300 | Imo-Abia-Cross River | Imo, Abia, Cross River |
| 301 | Enugu-Ebonyi-Anambra | Enugu, Ebonyi, Anambra |
| 302 | Plateau-Bauchi | Plateau, Bauchi |
| 303 | Adamawa-Borno | Adamawa, Borno |
| 304 | Abuja-Kaduna | Federal Capital Territory, Kaduna |
| 305 | Kano | Kano |
| 306 | Katsina-Zamfara | Katsina, Zamfara |
| 307 | Sokoto-Kebbi | Sokoto, Kebbi |
| 308 | Jigawa-Yobe-Gombe | Jigawa, Yobe, Gombe |

Count: 37 units (36 states + FCT), each exactly once. Nothing missing, nothing double-counted (checked programmatically).

## 2. Population
Method: 2006 census state totals, grown with zone-specific growth weights (North-East/North-West x1.06, Lagos x1.12, FCT x1.35, South x0.93, North-Central x1.0), then scaled to a Nigeria 2026 total of 238.5m (UN WPP-style estimate). Sum of seat K = 238.36m (diff vs 238.5m = 0.06%; rounding). Mean seat 14.90m, min 12.44m (Sokoto-Kebbi), max 17.20m (Lagos).
State-level splits are my own estimate from the 2006 census plus growth assumptions (no reliable post-2006 census); confidence Medium/Low throughout, never High.

## 3. Flags
- Beyond ADM2: none.
- Out-of-band: seat 307 Sokoto-Kebbi 12.44m (marginally under 12.5m; within estimate error).
- Long sea links: none; all seats are land-contiguous (Lagos and Ogun-Ondo-Ekiti are not combined; no ferry links used).
- Redrawn: the old sheet implied ~75m for 5 Yoruba seats and Lagos 13.2m + 15.2m; actual Yoruba states (~47m) support 3 seats, so seats were re-partitioned by state. Lagos (~17m) stays one seat and needs no LGA split.
