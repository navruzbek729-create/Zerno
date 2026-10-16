# ZERNO. — Free Knowledge Hub

Bepul onlayn testlar va o'quv qo'llanmalari platformasi (0 so'm, 100% bepul).

## Tuzilishi

```
zerno/
├── server.js            ← Backend (Node.js + Express)
├── package.json
├── data/
│   ├── seed.json        ← Boshlang'ich (namuna) ma'lumotlar
│   └── db.json          ← Asosiy baza (birinchi ishga tushganda avtomatik yaratiladi)
├── uploads/             ← Admin yuklagan PDF fayllar
├── public/
│   ├── index.html       ← Sayt (frontend)
│   ├── admin.html       ← Admin panel (/admin)
│   └── assets/          ← Logotip va ikonkalar
└── scripts/embed-demo.js
```

## Kompyuterda ishga tushirish

1. [Node.js](https://nodejs.org) 18 yoki undan yangi versiyasini o'rnating.
2. Shu papkada terminal oching va quyidagilarni bajaring:

```bash
npm install
```

Windows (PowerShell):
```powershell
$env:ADMIN_TOKEN="kuchli-parol-yozing"; npm start
```

Linux / Mac:
```bash
ADMIN_TOKEN="kuchli-parol-yozing" npm start
```

3. Brauzerda oching:
   - Sayt: http://localhost:3000
   - Admin panel: http://localhost:3000/admin yoki saytdagi **Kirish → Admin sifatida kirish**
   - Standart admin paroli: **zerno2026** (`ADMIN_TOKEN` berilmasa). Serverda o'zgartirish tavsiya etiladi.

## Serverga (VPS) joylash

```bash
# serverda
git clone <repo>   # yoki papkani yuklang
cd zerno && npm install --omit=dev
npm i -g pm2
ADMIN_TOKEN="kuchli-parol" PORT=3000 pm2 start server.js --name zerno
pm2 save && pm2 startup
```

Nginx orqali domenga ulash (HTTPS uchun keyin `certbot --nginx`):

```nginx
server {
  server_name zerno.uz www.zerno.uz;
  client_max_body_size 60M;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
}
```

Render, Railway kabi hostinglarda: start buyrug'i `npm start`, muhit o'zgaruvchisi `ADMIN_TOKEN`. `data/` va `uploads/` papkalari doimiy diskda (persistent volume) turishi kerak.

## Render + MongoDB Atlas (bepul)

Render'ning bepul rejasida disk vaqtinchalik — shuning uchun ma'lumotlar MongoDB Atlas'da saqlanadi.
`MONGODB_URI` berilsa, server avtomatik MongoDB'dan foydalanadi (testlar, o'quvchilar, natijalar va PDF fayllar — GridFS).

Render → Environment o'zgaruvchilari:

| Kalit | Qiymat |
|---|---|
| `MONGODB_URI` | Atlas'dan olingan `mongodb+srv://...` manzil |
| `ADMIN_TOKEN` | Admin paroli (berilmasa: `zerno2026`) |
| `SITE_URL` | `https://zerno.onrender.com` (sitemap uchun) |

Atlas bepul klasteri 512 MB — minglab test va natijalar uchun yetadi; katta PDF'larni Google Drive havolasi orqali qo'yish tavsiya etiladi.

## O'quvchilar va natijalar

- Test boshlashdan oldin o'quvchi **ism-familiya va guruhini** kiritadi.
- Har bir yechilgan test natijasi serverda saqlanadi. O'quvchi yuqoridagi ismi ustiga bosib **"Mening natijalarim"**ni ko'radi.
- Boshqa qurilmada (telefonda) xuddi shu ism va guruhni kiritsa — barcha natijalari o'sha yerda ham chiqadi.
- **Admin panel → Natijalar**: guruh va test bo'yicha saralash, **Excel (.xlsx)** yuklab olish.

## Ma'lumot qo'shish

- **Admin panel → Testlar / Fanlar / Qo'llanmalar** — formalar orqali bittalab.
- **Admin panel → Import / Eksport** — ko'p ma'lumotni JSON orqali bir yo'la. Namuna shu sahifada bor.
- `correct` — to'g'ri variantning tartib raqami, **0 dan boshlanadi** (A=0, B=1, C=2, D=3).

## API

| Metod | Yo'l | Tavsif |
|---|---|---|
| GET | `/api/data` | Fanlar, testlar (javobsiz), qo'llanmalar, statistika |
| GET | `/api/tests/:id` | Test savollari (to'g'ri javoblarsiz) |
| POST | `/api/tests/:id/submit` | `{answers:[0,2,...], timeSpent}` + `x-participant` sarlavhasi → natija serverda hisoblanadi |
| POST | `/api/register` | `{name, group}` → ishtirokchi tokeni |
| GET | `/api/me` | `x-participant` sarlavhasi bilan — o'z natijalari |
| * | `/api/admin/...` | `x-admin-token` sarlavhasi bilan: fanlar, testlar, qo'llanmalar CRUD, import, eksport |

To'g'ri javoblar foydalanuvchi brauzeriga yuborilmaydi — tekshiruv serverda bo'ladi.

## Demo rejim

`index.html` server bo'lmasa ham ochiladi: unda `seed.json` dan olingan namuna ma'lumotlar ichki joylangan va footerda "Demo rejim" yozuvi chiqadi. `seed.json` o'zgarsa: `node scripts/embed-demo.js`.
