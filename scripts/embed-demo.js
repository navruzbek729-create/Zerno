// data/seed.json ni public/index.html ichiga demo ma'lumot sifatida joylaydi.
// Ishlatish: node scripts/embed-demo.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'data/seed.json'), 'utf8'));
delete seed.stats;
const file = path.join(root, 'public/index.html');
const html = fs.readFileSync(file, 'utf8');
const json = JSON.stringify(seed).replace(/</g, '\\u003c');
const out = html.replace(/\/\*DEMO\*\/[\s\S]*?(?=;\n)/, `/*DEMO*/${json}`);
if (out === html && !html.includes('/*DEMO*/')) throw new Error('DEMO belgisi topilmadi');
fs.writeFileSync(file, out);
console.log('Demo ma\'lumotlar joylandi:', seed.tests.length, 'test,', seed.guides.length, 'qo\'llanma');
