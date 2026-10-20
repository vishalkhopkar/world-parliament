# F4 audit (seats 318-324, 351-355, 385)

## 1. Partition check
- Egypt (all 27 governorates, every one whole ADM1): 318 Cairo, Suez, Ismailia, Port Said, North Sinai, South Sinai; 319 Giza, Qalyubia; 320 Alexandria, Beheira, Matrouh; 321 Dakahlia, Damietta, Sharqia; 322 Gharbia, Monufia, Kafr el-Sheikh; 323 Faiyum, Beni Suef, Minya; 324 Asyut, Sohag, Qena, Luxor, Aswan, Red Sea, New Valley.
- Algeria (48 wilayas, pre-2019 list, all whole ADM1): 351 Algiers, Blida, Boumerdès, Tipaza, Tizi Ouzou, Bouira, Médéa, Aïn Defla, Béjaïa, Jijel, M'Sila (11); 352 Chlef, Tissemsilt, Tiaret, Djelfa, Laghouat, Ghardaïa, Adrar, Béchar, Tindouf, Naâma, El Bayadh, Saïda, Mascara, Relizane, Mostaganem, Oran, Aïn Témouchent, Sidi Bel Abbès, Tlemcen (19); 353 Oum El Bouaghi, Batna, Biskra, Tamanrasset, Tébessa, Sétif, Skikda, Annaba, Guelma, Constantine, Ouargla, Illizi, Bordj Bou Arréridj, El Tarf, El Oued, Khenchela, Souk Ahras, Mila (18). 11+19+18 = 48.
- Morocco (10 ADM1 regions listed; its two Sahara regions Laâyoune-Sakia El Hamra and Dakhla-Oued Ed-Dahab are covered by Western Sahara [entire ADM0] in seat 355): 354 Tanger-Tétouan-Al Hoceïma, Oriental, Rabat-Salé-Kénitra, Casablanca-Settat; 355 Fès-Meknès, Béni Mellal-Khénifra, Marrakech-Safi, Drâa-Tafilalet, Souss-Massa, Guelmim-Oued Noun.
- Western Sahara: 355 (entire).
- Tunisia: 385 (entire). Libya: 385 (entire).
Nothing missing, nothing double-counted (checked programmatically: each unit assigned exactly once).

## 2. Population check
- Sum of K over the 13 seats = 223.65m; mean 17.20m, min 14.62m (320), max 19.95m (385).
- Scope estimate (WPP-style 2026): Egypt 118.0 + Algeria 47.4 + Morocco 37.7 + Western Sahara 0.6 + Tunisia 12.5 + Libya 7.45 = 223.65m. Match (within rounding; K per seat rounded to 10,000).
- Within-country splits use approximate governorate/wilaya/region shares (Egypt CAPMAS-type, Algeria 2008 census, Morocco 2024 census), scaled to the totals above: Medium confidence.

## 3. Flags
- No seat uses ADM3 (beyond_ADM2 = NO everywhere); no ADM2 needed.
- No seat outside 12.5-20.8m. Seat 385 (19.95m), 354 (19.84m), 324 (19.73m) are the highest but in band.
- Long sea links: none. Sinai (318) is connected to the mainland by Suez Canal bridges/tunnels.
- Algeria boundaries use the 48-wilaya list; newer wilayas (2019, 2021, 2025) are folded into their parents.
