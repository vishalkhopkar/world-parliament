# agent-ticker
Built web/src/components/NewsTicker.tsx + newsTicker.css (marquee, 80px/s, pause on hover, reduced-motion static item, History dialog). Campaign.tsx now imports it; old NewsTicker in components/campaign.tsx and .ticker css left unused. e2e/browser.ts line ~196 still queries `.ticker` (now `.nt`). Screenshots: e2e/shots/ticker1.png, ticker2.png.
