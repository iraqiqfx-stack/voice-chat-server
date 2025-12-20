FROM node:20-slim

RUN apt-get update && apt-get install -y openssl libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm install --ignore-scripts

RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push && node server.js"]
