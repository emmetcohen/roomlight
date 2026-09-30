// Turns dist/ into ONE self-contained HTML fragment (title + inline CSS + inline module script),
// for hosts that wrap the page themselves (e.g. claude.ai artifacts). Output: dist-single/roomlight.html
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const assets = readdirSync('dist/assets');
const js = assets.find((f) => f.endsWith('.js'));
const css = assets.find((f) => f.endsWith('.css'));
const icon = readFileSync('index.html', 'utf8').match(/<link rel="icon"[^>]*>/)?.[0] ?? '';
const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
mkdirSync('dist-single', { recursive: true });
writeFileSync(
  'dist-single/roomlight.html',
  `<title>Roomlight</title>
${icon}
<style>${readFileSync(`dist/assets/${css}`, 'utf8')}</style>
<div id="root"></div>
<script type="module">${safe(readFileSync(`dist/assets/${js}`, 'utf8'))}</script>
`,
);
console.log('wrote dist-single/roomlight.html');
