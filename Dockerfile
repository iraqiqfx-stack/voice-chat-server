FROM node:20-slim

RUN apt-get update && apt-get install -y openssl libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

RUN npx prisma generate

COPY . .

RUN chmod +x start.sh

EXPOSE 3000

# Force rebuild: v2
CMD ["./start.sh"]
