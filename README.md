# Sklad nazorati — Render.com'ga joylash qo'llanmasi

Bu loyiha oddiy Node.js (Express) server + statik frontend'dan iborat. Render.com bepul
tarifida ishga tushirish uchun quyidagi qadamlarni bajaring.

## 1-qadam: Loyihani GitHub'ga yuklash

Render.com kodni GitHub repozitoriyasidan oladi, shuning uchun avval shu loyihani
GitHub'ga yuklashingiz kerak.

1. https://github.com saytida yangi (bo'sh) repozitoriya yarating, masalan `sklad-nazorati`.
2. Kompyuteringizda ushbu papkani ochib, quyidagi buyruqlarni bajaring:

```bash
cd sklad-sayt
git init
git add .
git commit -m "Birinchi versiya"
git branch -M main
git remote add origin https://github.com/SIZNING_USERNAME/sklad-nazorati.git
git push -u origin main
```

(`SIZNING_USERNAME` o'rniga o'z GitHub foydalanuvchi nomingizni yozing.)

## 2-qadam: Render.com'da hisob ochish va loyihani ulash

1. https://render.com saytiga kirib, GitHub akkauntingiz orqali ro'yxatdan o'ting.
2. Dashboard'da **"New +"** → **"Web Service"** tugmasini bosing.
3. GitHub repozitoriyangizni (`sklad-nazorati`) tanlang va **"Connect"** bosing.
4. Quyidagi sozlamalarni tekshiring (odatda avtomatik to'g'ri aniqlanadi, chunki loyihada
   `render.yaml` fayli bor):
   - **Name**: xohlagan nom (masalan `sklad-nazorati`) — sayt manzili shu nomga bog'liq
     bo'ladi: `https://sklad-nazorati.onrender.com`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**
5. **"Create Web Service"** tugmasini bosing. Bir necha daqiqada sayt tayyor bo'ladi va
   sizga havola beriladi (masalan `https://sklad-nazorati.onrender.com`).

Shu havolani xodimlaringiz bilan baham ko'ring — barchasi shu bitta manzil orqali kirib,
bir xil ma'lumotni ko'radi va yangilaydi.

## Muhim eslatma: bepul tarifning ikkita cheklovi

1. **Uxlab qolish**: bepul tarifdagi server 15 daqiqa faoliyatsizlikdan so'ng "uxlaydi" va
   keyingi kirishda uyg'onishi uchun ~30-50 soniya vaqt ketadi. Bu normal holat, faqat
   birinchi kirish biroz sekin bo'lishi mumkin.
2. **Ma'lumotlar saqlanishi (muhimroq)**: hozirgi holatda ma'lumotlar oddiy faylda
   (`data/store.json`) saqlanadi. Render'ning bepul tarifidagi disk **doimiy emas** — agar
   server qayta joylansa (kodni yangilasangiz) yoki uzoq vaqt uxlab, qayta ishga tushsa,
   bu fayl **o'chib ketishi mumkin** va barcha ma'lumot yo'qoladi.

   Buning oldini olish uchun ikkita variant bor:
   - **Oddiy yechim**: Render'da kichik pullik "Persistent Disk" qo'shish (odatda oyiga
     bir necha dollar) — `data/` papkasini doimiy diskka bog'lab qo'yish kerak bo'ladi.
   - **Tavsiya etiladigan yechim**: bepul tashqi ma'lumotlar bazasidan foydalanish,
     masalan **MongoDB Atlas** (doimiy bepul 512 MB) yoki **Supabase** (bepul Postgres).
     Bu holda `server.js` faylidagi saqlash qismini o'sha bazaga ulash kerak bo'ladi.

   Agar buni ham men orqali qilishni xohlasangiz — ayting, `server.js`ni tanlagan bazangizga
   moslab beraman.

## Mahalliy kompyuterda sinab ko'rish

```bash
cd sklad-sayt
npm install
npm start
```

Keyin brauzerda `http://localhost:3000` manzilini oching.
