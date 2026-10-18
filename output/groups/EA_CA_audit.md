# EA_CA audit (seats 251-263, 287-291)

## 1. Partition check
Scope ADM0s and seats:
- Japan: 251-258 (all 47 prefectures once each, all [entire ADM1]). 251 Hokkaido, Aomori, Iwate, Miyagi, Akita, Yamagata, Fukushima, Niigata; 252 Ibaraki, Tochigi, Gunma, Saitama; 253 Tokyo; 254 Kanagawa, Chiba; 255 Toyama, Ishikawa, Fukui, Yamanashi, Nagano, Gifu, Shizuoka, Aichi; 256 Mie, Shiga, Kyoto, Osaka, Nara, Wakayama; 257 Hyogo, Tottori, Shimane, Okayama, Hiroshima, Yamaguchi, Tokushima, Kagawa, Ehime, Kochi; 258 Fukuoka, Saga, Nagasaki, Kumamoto, Oita, Miyazaki, Kagoshima, Okinawa.
- South Korea: 259-261. Seoul, Incheon -> 259. Busan, Daegu, Ulsan, Gwangju, N/S Jeolla, N/S Gyeongsang, Jeju -> 261. Gangwon, N/S Chungcheong, Daejeon, Sejong -> 260. Gyeonggi (31 si/gun, ADM2) split: 11 in 259 (Goyang, Paju, Yangju, Yeoncheon, Dongducheon, Uijeongbu, Pocheon, Gimpo, Bucheon, Gwangmyeong, Siheung), the other 20 in 260 (written positively in T).
- North Korea (13 ADM1): 262 Pyongyang, Nampo, S Pyongan, N Pyongan, Chagang; 263 S Hwanghae, N Hwanghae, Kaesong, Kangwon, S Hamgyong, N Hamgyong, Ryanggang, Rason.
- Kazakhstan (20 ADM1): 287 Mangystau, Atyrau, West Kazakhstan, Aktobe, Kyzylorda, Turkistan, Shymkent; 288 Astana, Almaty city, Almaty Region, Zhetysu, Jambyl, Ulytau, Karaganda, Akmola, Kostanay, North Kazakhstan, Pavlodar, Abai, East Kazakhstan.
- Turkmenistan: 287 only (entire ADM0).
- Uzbekistan (14 ADM1): 289 Tashkent City, Tashkent Region, Syrdarya, Fergana, Andijan, Namangan; 290 Jizzakh, Samarkand, Kashkadarya, Surkhandarya, Bukhara, Navoi, Khorezm, Karakalpakstan.
- Kyrgyzstan, Tajikistan: 291 only (entire ADM0).
Nothing is missing and nothing is double-counted (checked programmatically for Japan, Korea ADM1/ADM2, DPRK, Kazakhstan, Uzbekistan).

## 2. Population
Sum of seat K = 284.69m vs scope estimate 284.70m (Japan 122.7, S Korea 51.7, N Korea 26.7, Kazakhstan 20.7, Uzbekistan 37.3, Turkmenistan 7.5, Kyrgyzstan 7.3, Tajikistan 10.8): within rounding (<0.01%). Unit shares are my estimates scaled to these WPP-style totals.

## 3. Flags
- Beyond ADM2: none. Gyeonggi split used ADM2 only (259/260).
- Out of band: none (min 12.90m seat 262, max 19.47m seat 290).
- Long sea links: 258 Okinawa-Kyushu (~600 km, accepted as in old sheet); 254 Chiba-Kanagawa across Tokyo Bay (short, Aqua-Line/ferry); 261 Jeju by ferry.
- Low confidence: 262, 263 (DPRK, 2008 census base).
- Cross-country block: 287 Turkmenistan [entire] + western/southern Kazakhstan; Kazakh-Turkmen land border (Mangystau) verified.
