FROM node:20-alpine

WORKDIR /app

# نسخ كل الملفات أولاً
COPY . .

# تثبيت التبعيات بدون تشغيل postinstall
RUN npm install --ignore-scripts

# توليد Prisma Client
RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && node server.js"]
