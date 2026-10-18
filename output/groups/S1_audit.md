# S1 audit (seats 471-484)

## 1. Partition check
Scope ADM0s: Brazil, Paraguay, Guyana, Suriname, French Guiana (France ADM1). Nothing missing, nothing double-counted (checked in code: all 5,571 IBGE municipalities assigned to exactly one seat; unsplit states assigned whole).

| ADM0 / ADM1 | Seat(s) |
|---|---|
| Paraguay [entire ADM0] | 481 |
| Guyana [entire ADM0] | 484 |
| Suriname [entire ADM0] | 484 |
| French Guiana (France ADM1) | 484 |
| Brazil - São Paulo (split by municipality) | 471 (SP city + 16 W/SW RM municipalities), 472 (rest of RM, Baixada Santista, Vale do Paraíba, Sorocaba, Jundiaí regions), 473 (interior) |
| Brazil - Minas Gerais (split by municipality) | 475, 476 |
| Rio de Janeiro | 474 |
| Espírito Santo | 476 |
| Bahia, Sergipe | 477 |
| Ceará, Piauí, Rio Grande do Norte | 478 |
| Pernambuco, Paraíba, Alagoas | 479 |
| Maranhão, Pará, Tocantins | 480 |
| Paraná | 481 |
| Santa Catarina, Rio Grande do Sul | 482 |
| Goiás, Distrito Federal, Mato Grosso do Sul | 483 |
| Amazonas, Roraima, Acre, Rondônia, Mato Grosso, Amapá | 484 |

All 26 states + DF = 27 UFs covered. Only SP (645 municipalities) and MG (853) are split, at ADM2 (municipality) level; the split uses IBGE intermediate/immediate geographic regions as grouping aids, but the CSV lists municipality names (IBGE spelling; geoBoundaries ADM2 spelling may differ slightly). Boa Esperança do Norte (new MT municipality, 5,571st) is inside Mato Grosso (seat 484).

## 2. Population
Method: IBGE 2026 municipal estimates (sum 214.21m) scaled uniformly to an assumed UN WPP 2026 Brazil total of 213.0m; Paraguay 6.93m, Guyana 0.83m, Suriname 0.64m, French Guiana 0.30m (knowledge-based WPP-like values, Medium confidence).
- Sum of seat K: 221,710,000. Own scope estimate: 213.0 + 8.70 = 221.7m. Match (<0.01%).
- Mean 15.84m; min 12.73m (seat 475); max 19.44m (seat 482). All seats inside 12.5-20.8m.

## 3. Flags
- No seat beyond ADM2; no out-of-band seats; no UNAVOIDABLE seats.
- Near-low seats: 475 (12.73m), 476 (12.74m), 483 (13.38m). Minas Gerais + Espírito Santo (25.5m) has only two seats.
- Long/odd links: Fernando de Noronha (in Pernambuco, seat 479) is an island district, part of the state. Amapá joins seat 484 by land only through French Guiana (Oiapoque border); the Pará-Amapá river link is not used because Pará is in seat 480.
- Rule 3 cross-country block kept from old sheet: whole Paraguay + whole Paraná (481). Guianas whole with northern Brazil (484).
- Old-sheet fixes: Maranhão-Rio Grande do Norte was not contiguous (replaced by Maranhão-Pará-Tocantins); several states (ES, SE, AL, RN, RR, AC, RO, TO) had no seat in the old sheet.
