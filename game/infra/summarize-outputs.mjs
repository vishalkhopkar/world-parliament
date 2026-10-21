// Used by game-deploy.yml: prints the deployed URLs into the job summary and writes the site URL to site-url.txt.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const stage = process.env.STAGE ?? 'prod';
const o = JSON.parse(readFileSync('cdk-outputs.json', 'utf8'));
const web = o[`HungParliament-${stage}-Web`].CloudFrontUrl;
const api = o[`HungParliament-${stage}-Api`];
const md = `### Deployed (${stage})\n- Site: ${web}\n- REST: ${api.HttpApiUrl}\n- WebSocket: ${api.WebSocketUrl}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
writeFileSync('site-url.txt', web);
console.log(md);
