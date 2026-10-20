# F6 audit (Southern Africa + western Indian Ocean)

## 1. Partition check
| ADM0 | Seats |
|---|---|
| South Africa | 340 (Gauteng, North West), 341 (KwaZulu-Natal), 342 (Western Cape, Eastern Cape, Free State), 343 (Limpopo, Mpumalanga, Northern Cape) - all 9 provinces, each once |
| Lesotho | 341 |
| Eswatini | 341 |
| Namibia | 343 |
| Botswana | 343 |
| Angola (18 provinces, pre-2024 layout) | 356 (Luanda, Bengo, Zaire, Cabinda); 357 (Cuanza Sul, Cuanza Norte, Uíge, Malanje, Bié, Lunda Norte, Lunda Sul, Moxico); 358 (Huíla, Benguela, Huambo, Cuando Cubango, Cunene, Namibe) |
| Mozambique (11 provinces) | 359 (Maputo City, Maputo, Gaza, Inhambane, Sofala, Manica, Tete); 360 (Zambezia, Nampula, Cabo Delgado, Niassa) |
| Zambia (10 provinces) | 377 (Central, Copperbelt, Eastern, Luapula, Lusaka, Muchinga, Northern, North-Western, Western); 379 (Southern) |
| Malawi | 378 |
| Zimbabwe | 379 |
| Madagascar (22 regions) | 363 (Analamanga, Vakinankaratra, Itasy, Bongolava, Haute Matsiatra, Amoron'i Mania, Vatovavy-Fitovinany, Alaotra-Mangoro, Atsinanana); 364 (Ihorombe, Atsimo-Atsinanana, Analanjirofo, Sava, Diana, Sofia, Boeny, Betsiboka, Melaky, Menabe, Atsimo-Andrefana, Androy, Anosy) |
| Comoros, Mayotte, Réunion, Mauritius, Seychelles | 364 |

Nothing is missing and nothing is double-counted: every ADM1 above appears in exactly one seat; only Zambia is split (Southern Province -> 379 with whole Zimbabwe). All units are ADM0/ADM1; no ADM2/ADM3 needed.

## 2. Population check
Sum of seats' K = 247.62m vs own scope estimate 247.63m (South Africa 64.0, Lesotho 2.40, Eswatini 1.25, Namibia 3.10, Botswana 2.65, Angola 39.0, Mozambique 36.6, Zambia 22.5, Malawi 22.8, Zimbabwe 17.2, Madagascar 32.6, Comoros 0.93, Mayotte 0.33, Réunion 0.88, Mauritius 1.26, Seychelles 0.13). Difference <0.01% (rounding). Mean 17.69m, min 12.7m (357), max 22.8m (378).

Provincial/regional splits are from memory of latest censuses (SA 2022, Zambia 2022, Mozambique 2017, Madagascar 2018, Angola 2014) scaled uniformly to country totals; Angola confidence Low (rounded to 100k), others Medium/High.

## 3. Flags
- Beyond ADM2: none.
- Out of band: 378 Malawi 22.8m (HIGH) - cannot be reblocked under rules (see notes).
- Near band edges: 357 (12.7m, Angola), 360 (19.9m), 377 (20.0m).
- Long sea links: 364 (Comoros/Mayotte ~300 km; Réunion/Mauritius ~800-900 km; Seychelles ~1,100 km from Madagascar). Seat 356: Cabinda exclave linked to Zaire province via short sea route / DRC strip.
- Reblocking: Zambia Southern Province + Zimbabwe (379); Angola's 3 seats redrawn (357/358 content swapped vs old names); Mozambique split at Zambezi with Sofala/Manica/Tete south; Mascarene/Comoros islands all in seat 364 per old sheet.
- Admin-layout caveats: Angola 18 provinces (21 since 2024), Madagascar 22 regions (Vatovavy-Fitovinany merged).
