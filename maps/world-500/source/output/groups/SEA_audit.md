# SEA audit

## 1. Partition check (ADM0 -> seats)

- Philippines: seats 226, 227, 228, 229, 230, 231, 232
- Vietnam: seats 233, 234, 235, 236, 237, 238
- Thailand: seats 239, 240, 241, 242, 243
- Laos: seats 243
- Myanmar: seats 244, 245, 246
- Cambodia: seats 247
- Malaysia: seats 248, 249, 250
- Singapore: seats 249
- Brunei: seats 250

Split-country ADM1 / ADM2 allocation:

- Philippines: NCR split at city level (226: Quezon City, Caloocan, Valenzuela, Malabon, Navotas, Manila; 227: the other 11 cities/municipality). Central Luzon (III) split: 226 Bulacan/Pampanga/Bataan, 229 Aurora/Nueva Ecija/Tarlac/Zambales. Calabarzon split: 227 Cavite/Laguna/Rizal, 230 Batangas/Quezon. CAR, Ilocos, Cagayan Valley -> 229; Bicol, Mimaropa -> 230; Western+Central Visayas -> 231; Eastern Visayas, Zamboanga Pen., Northern Mindanao, Caraga -> 228; Davao, Soccsksargen, BARMM -> 232.
- Vietnam seat 233: Hanoi, Vinh Phuc, Bac Ninh, Ha Giang, Bac Kan, Tuyen Quang, Lao Cai, Yen Bai, Thai Nguyen
- Vietnam seat 234: Hai Phong, Hai Duong, Thai Binh, Nam Dinh, Ninh Binh, Quang Ninh, Hung Yen, Ha Nam, Bac Giang, Lang Son, Cao Bang
- Vietnam seat 235: Thanh Hoa, Nghe An, Ha Tinh, Quang Binh, Quang Tri, Thua Thien Hue, Son La, Hoa Binh, Dien Bien, Lai Chau, Phu Tho
- Vietnam seat 236: Da Nang, Quang Nam, Quang Ngai, Binh Dinh, Phu Yen, Khanh Hoa, Ninh Thuan, Binh Thuan, Kon Tum, Gia Lai, Dak Lak, Dak Nong, Lam Dong, Binh Phuoc
- Vietnam seat 237: Ho Chi Minh City, Binh Duong, Dong Nai, Ba Ria-Vung Tau, Tay Ninh
- Vietnam seat 238: Long An, Tien Giang, Ben Tre, Tra Vinh, Vinh Long, Dong Thap, An Giang, Kien Giang, Can Tho, Hau Giang, Soc Trang, Bac Lieu, Ca Mau
- Thailand: 239 (Bangkok, Samut Prakan, Nonthaburi, Pathum Thani, Samut Sakhon, Nakhon Pathom, Samut Songkhram, Phra Nakhon Si Ayutthaya, Ang Thong, Saraburi, Nakhon Nayok, Chachoengsao); 240 (Chiang Mai, Chiang Rai, Lampang, Lamphun, Mae Hong Son, Nan, Phayao, Phrae, Uttaradit, Tak, Kamphaeng Phet, Phitsanulok, Phichit, Phetchabun, Sukhothai, Nakhon Sawan, Uthai Thani, Lop Buri, Sing Buri, Chai Nat, Suphan Buri); 241 (Chon Buri, Rayong, Prachin Buri, Sa Kaeo, Chanthaburi, Trat, Nakhon Ratchasima, Buri Ram, Surin, Si Sa Ket, Ubon Ratchathani, Roi Et, Chaiyaphum, Maha Sarakham, Yasothon, Amnat Charoen); 242 (Nakhon Si Thammarat, Songkhla, Surat Thani, Phatthalung, Trang, Krabi, Phang Nga, Phuket, Ranong, Chumphon, Satun, Pattani, Yala, Narathiwat, Kanchanaburi, Ratchaburi, Phetchaburi, Prachuap Khiri Khan); 243 (Khon Kaen, Kalasin, Loei, Nong Khai, Bueng Kan, Nong Bua Lam Phu, Udon Thani, Sakon Nakhon, Nakhon Phanom, Mukdahan)
- Myanmar: 244 Yangon, Bago, Mon, Kayin, Tanintharyi; 245 Mandalay, Magway, Nay Pyi Taw, Ayeyarwady; 246 Sagaing, Kachin, Chin, Shan, Kayah, Rakhine
- Malaysia: 248 Perlis, Kedah, Penang, Perak, Selangor, Kuala Lumpur, Putrajaya; 249 Johor, Melaka, Negeri Sembilan, Pahang, Terengganu, Kelantan; 250 Sabah, Sarawak, Labuan

Programmatic check: every unit in the unit table (17 NCR cities, 7 Central Luzon provinces, 5 Calabarzon provinces, 14 other Philippine regions, 63 Vietnamese provinces, 77 Thai provinces, 15 Myanmar units, 16 Malaysian ADM1, plus Laos, Cambodia, Singapore, Brunei) is used exactly once. Nothing missing, nothing double-counted.

## 2. Population sum

Sum of seat K = 415,270,000 vs scope total (WPP-2026-style country totals: Philippines 117.6m, Vietnam 102.1m, Thailand 71.7m, Laos 7.9m, Myanmar 55.2m, Cambodia 18.1m, Malaysia 36.1m, Singapore 6.12m, Brunei 0.46m) = 415,280,000. Difference -0.00% (rounding only). Country totals match the totals implied by the old sheet.

## 3. Flagged seats

- beyond ADM2: none.
- Out of band: seat 250 (7.17m, LOW): Borneo Malaysia + Brunei, no valid in-scope partner.
- Highest: seat 241 (18.9m), 244/245 (18.5/18.7m) all within band. Lowest in-band: 242 (13.3m).
- Long sea links / caveats: seat 230 Palawan (Mimaropa kept whole) is a long sea link; seat 232 BARMM islands; seat 228 Eastern Visayas-Caraga via Surigao Strait ferry; seat 249 Singapore-Johor by causeway; seat 250 is split by Brunei enclave geography (land border chain).
- Vietnam uses the 63 pre-2025 provinces; Philippines ADM2 NCR cities used as ADM2 units.
