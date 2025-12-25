#!/bin/sh
echo "Running manual database migration first..."
node migrate.js
echo "Running Prisma db push..."
npx prisma db push --accept-data-loss
echo "Starting server..."
node server.js
