# TR_IR audit (seats 264-273, 292)

## 1. Partition check
Scope ADM0s and the seats they appear in:
- Turkey: seats 264, 265, 266, 267, 268 (all 81 provinces assigned; Istanbul split at ADM2 between 264 and 265).
- Iran: seats 269, 270, 271, 272, 273 (all 31 provinces, each whole ADM1 in exactly one seat).
- Azerbaijan (incl. Nakhchivan, Nagorno-Karabakh area): seat 292 [entire ADM0].
- Armenia: seat 292 [entire ADM0].
- Georgia (incl. Abkhazia, South Ossetia): seat 292 [entire ADM0].

Turkey ADM1 -> seat:
- 264: Edirne, Kirklareli, Tekirdag, Canakkale, Balikesir, Bursa + Istanbul (25 European-side districts: Arnavutkoy, Avcilar, Bagcilar, Bahcelievler, Bakirkoy, Basaksehir, Bayrampasa, Besiktas, Beylikduzu, Beyoglu, Buyukcekmece, Catalca, Esenler, Esenyurt, Eyupsultan, Fatih, Gaziosmanpasa, Gungoren, Kagithane, Kucukcekmece, Sariyer, Silivri, Sultangazi, Sisli, Zeytinburnu)
- 265: Kocaeli, Sakarya, Yalova, Bilecik, Duzce, Bolu, Eskisehir, Ankara, Zonguldak, Bartin, Karabuk + Istanbul (14 Anatolian-side districts: Adalar, Atasehir, Beykoz, Cekmekoy, Kadikoy, Kartal, Maltepe, Pendik, Sancaktepe, Sultanbeyli, Sile, Tuzla, Umraniye, Uskudar)
- 266: Izmir, Manisa, Aydin, Mugla, Denizli, Usak, Afyonkarahisar, Kutahya, Isparta, Burdur, Antalya, Konya
- 267: Adana, Mersin, Karaman, Hatay, Osmaniye, Kahramanmaras, Gaziantep, Kilis, Adiyaman, Sanliurfa, Diyarbakir, Mardin, Batman, Siirt, Sirnak
- 268: Kastamonu, Sinop, Samsun, Cankiri, Corum, Amasya, Tokat, Yozgat, Kirikkale, Kirsehir, Nevsehir, Nigde, Aksaray, Kayseri, Sivas, Ordu, Giresun, Trabzon, Rize, Artvin, Gumushane, Bayburt, Erzincan, Erzurum, Kars, Ardahan, Igdir, Agri, Malatya, Elazig, Tunceli, Bingol, Mus, Bitlis, Van, Hakkari (36)

Iran ADM1 -> seat:
- 269: Tehran, Alborz
- 270: Isfahan, Chaharmahal and Bakhtiari, Markazi, Lorestan, Kermanshah, Ilam, Khuzestan
- 271: Fars, Bushehr, Kohgiluyeh and Boyer-Ahmad, Hormozgan, Yazd, Kerman, Sistan and Baluchestan
- 272: Khorasan-e Razavi, North Khorasan, South Khorasan, Semnan, Qom, Golestan, Mazandaran
- 273: East Azerbaijan, West Azerbaijan, Ardabil, Zanjan, Gilan, Qazvin, Kurdistan, Hamadan

Verified programmatically from the CSV: 80 Turkish provinces + 39 Istanbul districts + 31 Iranian provinces each appear exactly once (81 Turkish provinces counting Istanbul). Nothing is missing or double-counted. Turkish names are ASCII transliterations of the geoBoundaries names.

## 2. Population sum vs scope total
- Sum of seat K = 197,200,000.
- Own scope estimate (UN WPP 2026 country totals used for scaling): Turkey 87.9m + Iran 92.2m + Azerbaijan 10.3m + Georgia 3.8m + Armenia 3.0m = 197.2m. Match within 0.1% (by construction of the scaling).
- Method: Turkey = ADNKS 2024 province figures (Istanbul districts approx. from memory) scaled to 87.9m; Iran = 2016 census provinces scaled to 92.2m; seat 292 = WPP country totals. Confidence Medium for all (sub-country shares are approximate; Istanbul shore split roughly 64/36).
- Seat range 16.94m - 19.21m, mean 17.93m.

## 3. Flags
- Beyond ADM2: none.
- Out of band (12.5-20.8m): none. Highest are 273 (19.21m), 270 (19.03m), 269 (18.43m), 265 (18.42m).
- Long sea links: none. Short crossings: Thrace-Anatolia via Canakkale bridge/ferry (264), Yalova-Gulf of Izmit ferry (265). Nakhchivan is a non-contiguous exclave of Azerbaijan (same ADM0) inside seat 292.
- Cross-country block: seat 292 Armenia + Azerbaijan + Georgia (rule 2, entire countries, culturally debatable). Azerbaijan was removed from the Iranian NW seat (old 29.1m, too big).
- Large reblocking vs old sheet: Turkey old "Central Anatolia" seat dissolved (Ankara to 265); Iran old Khuzestan seat repurposed to north-east (Khorasan etc.), Khuzestan into 270.
