#!/bin/sh
echo "Running Prisma db push..."
npx prisma db push --accept-data-loss
echo "Running database migration..."
node migrate.js
echo "Starting server..."
node server.js
